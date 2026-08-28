import {
  type FaceEvolutionPayloadV1
}  from './remus-runtime';
import {
  findSketch,
  listFeaturesInOrder,
  resolveParamValue
}  from '@openzcad/document-core';
import {
  geometryTolerance
}  from '@openzcad/geometry';
import {
  FULL_REVOLVE_ANGLE_DEG,
  UNIT_TO_MM,
  type FeatureNode,
  type ParamValue
}  from '@openzcad/shared';
import type {
  ExactShape,
  ImportedStepDiagnostics
}  from './exact-types';
import {
  diagnoseImportedSolid,
  modifierChainRootsAtCylinder,
  rederiveCylinderModifierLineage,
  rederivePrimitiveDirectEditLineage,
  topologyCandidatesForSolid
}  from './exact-lineage-builders';
import {
  measureFaceGeometry
}  from './exact-measure';
import {
  drillHole,
  tryExactCoaxialCylinderCut
}  from './exact-cylinder-ops';
import {
  applyEdgeModifier,
  edgeModifierFailureMessage
}  from './exact-edge-modifiers';
import {
  collapseShape,
  exactUnionOffsetSuggestion,
  fuseUniformSolid,
  inferenceBodyForShape,
  isFaceConnectedSolid,
  sharedShapeVolume,
  shapesShareMaterialOrTouch,
  sharedSolidVolume,
  solidMeshIsClosed,
  tessellatedFaceBounds,
  unifyBooleanFaces,
  type UnionFuseOperand
}  from './exact-boolean-helpers';
import {
  resolveEdgeModifierEdges,
  resolveFeatureFaces
}  from './exact-reference-resolution';
import {
  bodyName,
  copyShape,
  copyShapeWithVerifiedLineage,
  formatMeasuredVolume,
  importMeshSolid,
  importStepWithOwnBudget,
  inheritMeshOrigin,
  resolveParametricPoint
}  from './exact-shape-utils';
import {
  MEASUREMENT_DEFLECTION
}  from './exact-witnesses';
import {
  isBlendFace
}  from './exact-brep';
import {
  DIRECT_EDIT_TOLERANCE,
  GEOMETRY_EPSILON,
  axisDirection,
  cross,
  dot,
  length,
  normalized,
  resolvePatternDirection,
  subtract,
  transformMatrix,
  uniformScaleMatrix
}  from './exact-math';
import {
  booleanFacetFallbackWarning,
  censusOfSolids,
  droppedUnionOperandWarning
}  from './boolean-result-validation';
import {
  importedMeshStl,
  meshBooleanUnsupportedError
}  from './imported-mesh';
import {
  extrudeVolumeTolerance,
  type ExtrudeInferenceBody
}  from './extrude-inference';
import {
  createRemusModelingOperations
}  from './remus-modeling-operations';
import {
  analyzeUnionConnectivity,
  disconnectedUnionWarning
}  from './union-connectivity';
import {
  remusHashOnlyLineage,
  createRemusImportedStepLineage,
  createRemusModifierEvolutionLineage,
  mergeRemusLineageStates,
  type RemusLineageState
}  from './remus-lineage';
import {
  classifyImportedSolid,
  importedStepNoSolidError
}  from './imported-step-validation';
import {
  resolveRevolveAngleDeg,
  buildPrimitive,
  buildSweep,
  buildLoft,
  buildProfileSweep,
  buildHelicalSweep,
  resolveSketchBasisAtHistory
}  from './exact-profile-builders';
import {
  applyDirectEdit
}  from './exact-direct-edit-ops';
import type {
  FeatureBuildContext,
  FeatureDataOf
}  from './exact-build-loop';

/**
 * A confirmed subtract must remove a material share of the volume its tools
 * demonstrably overlap. The deliberately loose half-overlap floor preserves
 * sequential multi-tool cuts, where earlier tools can remove material a later
 * tool would otherwise share, while rejecting the near-no-op results this
 * guard exists to catch.
 */
const MINIMUM_SUBTRACT_REMOVAL_RATIO = 0.5;


function buildSketchFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'sketch'>
): void {
  const { kernel, document, scope, result } = ctx;
  const sketch = findSketch(document, data.sketchId);
  if (!sketch) {
    throw new Error('Referenced sketch no longer exists.');
  }
  result.sketchBases.set(
    sketch.sketchId,
    resolveSketchBasisAtHistory(
      kernel,
      document,
      sketch,
      result,
      scope
    )
  );
}

function buildImportedMeshFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'imported-mesh'>
): void {
  const { kernel, result } = ctx;
  if (feature.bodyId) {
    // The kernel's own STL importer owns vertex welding and shell
    // orientation, so the document's triangle soup goes back through
    // it rather than being re-derived here.
    const solid = importMeshSolid(
      kernel,
      importedMeshStl(data)
    );
    result.meshBodies.add(feature.bodyId);
    result.shapes.set(feature.bodyId, {
      solids: [solid],
      lineage: remusHashOnlyLineage(
        'imported-mesh',
        'Imported meshes carry no feature provenance; every facet is source-file data.'
      )
    });
  }
}

function buildDirectEditFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'direct-edit'>
): void {
  const { kernel, document, scope, result } = ctx;
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Direct-edit target is unavailable.');
  }
  const edited = applyDirectEdit(
    kernel,
    target,
    data.operation,
    scope,
    feature.featureId
  );
  const targetBodyId = data.targetBodyId;
  const producer = listFeaturesInOrder(document).find(
    (candidate) => candidate.bodyId === targetBodyId
  );
  edited.lineage ??=
    rederivePrimitiveDirectEditLineage(kernel, edited, producer) ??
    remusHashOnlyLineage(
      'direct-edit',
      'Remus does not expose a complete direct-edit output relation.'
    );
  result.shapes.set(data.targetBodyId, edited);
}

function buildImportedStepFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'imported-step'>
): void {
  const { kernel, document, result, importSources, pinnedImports, importedSteps } = ctx;
  if (feature.bodyId) {
    const checksum =
      data.stepText === undefined
        ? data.stepSourceRef?.checksumSha256
        : undefined;
    const cached = checksum
      ? importedSteps?.lookup(checksum)
      : undefined;
    let solids: number[];
    let acceptedDeclaredIndices: number[];
    let diagnostics: ImportedStepDiagnostics;
    if (cached) {
      // The checksum determines the result, so restoring is exact.
      // Only the handles are new — they belong to this kernel.
      solids = cached.solids.map((blob) =>
        kernel.deserializeSolid(blob)
      );
      acceptedDeclaredIndices = cached.acceptedDeclaredIndices;
      diagnostics = cached.diagnostics;
    } else {
      let sourceBytes: Uint8Array;
      if (data.stepText !== undefined) {
        sourceBytes = new TextEncoder().encode(data.stepText);
      } else {
        const ref = data.stepSourceRef;
        const resolved = ref
          ? importSources.get(ref.checksumSha256)
          : undefined;
        if (!resolved) {
          throw new Error(
            `Import source for "${data.sourceName}" is not available on this device.`
          );
        }
        sourceBytes = resolved;
      }
      const declared = Array.from(
        importStepWithOwnBudget(kernel, sourceBytes)
      );
      if (declared.length === 0) {
        throw new Error('STEP file contains no solids.');
      }
      // K0.6. A shell that is not closed is not a solid, whatever
      // volume a divergence integral over its faces happens to
      // produce. Reject those before they become a body; keep the
      // rest and say which ones went, because an unreadable solid
      // that vanishes silently is the worst failure mode the parity
      // corpus records.
      const verdicts = declared.map((solid, index) =>
        classifyImportedSolid(
          diagnoseImportedSolid(kernel, solid, index + 1)
        )
      );
      solids = declared.filter(
        (_, index) => verdicts[index]!.kind !== 'not-a-solid'
      );
      acceptedDeclaredIndices = declared.flatMap((_, index) =>
        verdicts[index]!.kind !== 'not-a-solid' ? [index] : []
      );
      const rejections = verdicts.flatMap((verdict) =>
        verdict.kind === 'not-a-solid' ? [verdict.reason] : []
      );
      if (solids.length === 0) {
        throw new Error(importedStepNoSolidError(rejections));
      }
      diagnostics = {
        declaredSolidCount: declared.length,
        rejections,
        flagged: verdicts.flatMap((verdict) =>
          verdict.kind === 'flagged' ? [verdict.reason] : []
        )
      };
      if (checksum) {
        importedSteps?.store(
          checksum,
          kernel,
          solids,
          acceptedDeclaredIndices,
          diagnostics,
          pinnedImports
        );
      }
    }
    // Partial import: the selection names DECLARED indices — the
    // stable file order the diagnostics number — applied after the
    // file-level cache so every subset shares one cached parse.
    const selection = data.solidIndices;
    if (selection !== undefined) {
      const wanted = new Set(selection);
      solids = solids.filter((_, position) =>
        wanted.has(acceptedDeclaredIndices[position]!)
      );
      if (solids.length === 0) {
        throw new Error(
          `Import selection excludes every readable solid in "${data.sourceName}".`
        );
      }
    }
    // Remus's STEP reader normalizes every length to millimetres
    // using the file's declared unit, but the document speaks its
    // own unit everywhere downstream (exports multiply by
    // UNIT_TO_MM). A non-mm document must adopt the solids at
    // 1/UNIT_TO_MM — before lineage derivation, so the published
    // witnesses match the coordinates every later feature sees. The
    // checksum cache above stays in millimetre form, which keeps a
    // cached import correct across a document units change.
    const documentScale = 1 / UNIT_TO_MM[document.units];
    if (documentScale !== 1) {
      solids = solids.map((solid) =>
        kernel.copyAndTransformSolid(
          solid,
          uniformScaleMatrix(documentScale)
        )
      );
    }
    result.importedStepDiagnostics.set(feature.bodyId, diagnostics);
    result.shapes.set(feature.bodyId, {
      solids,
      lineage: createRemusImportedStepLineage(
        feature.featureId,
        solids.flatMap((solid) =>
          topologyCandidatesForSolid(kernel, solid)
        )
      )
    });
  }
}

function buildPrimitiveFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode
): void {
  const { kernel, scope, result } = ctx;
  if (feature.bodyId) {
    result.shapes.set(
      feature.bodyId,
      buildPrimitive(kernel, feature, scope)
    );
  }
}

function buildExtrudeFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'extrude'>
): void {
  const { kernel, document, scope, result } = ctx;
  if (feature.bodyId) {
    const extrusion = buildSweep(
      kernel,
      document,
      feature,
      scope,
      result.sketchBases,
      (message) =>
        result.warnings.push(`Feature "${feature.name}": ${message}`)
    );
    const operation = data.operation ?? 'new-body';
    if (operation === 'new-body') {
      result.shapes.set(feature.bodyId, extrusion);
      return;
    }
    const targetBodyId = data.targetBodyId;
    if (!targetBodyId) {
      throw new Error(
        `Stored ${operation} extrusion has no target body.`
      );
    }
    if (result.consumed.has(targetBodyId)) {
      throw new Error(
        `Stored ${operation} target ${bodyName(document, targetBodyId)} was already consumed.`
      );
    }
    if (result.meshBodies.has(targetBodyId)) {
      throw meshBooleanUnsupportedError(
        bodyName(document, targetBodyId)
      );
    }
    const target = result.shapes.get(targetBodyId);
    if (!target) {
      throw new Error(
        `Stored ${operation} target ${bodyName(document, targetBodyId)} is unavailable.`
      );
    }
    const targetBody = inferenceBodyForShape(
      kernel,
      target,
      targetBodyId,
      bodyName(document, targetBodyId)
    );
    const extrusionBody = inferenceBodyForShape(
      kernel,
      extrusion,
      feature.bodyId,
      feature.name
    );
    const sharedVolume = sharedShapeVolume(
      kernel,
      target,
      extrusion,
      targetBody,
      extrusionBody
    );
    // A cut needs shared material: with none there is nothing to remove, and
    // that can be settled before doing any work.
    if (operation === 'cut' && sharedVolume <= 0) {
      // Wording unchanged on purpose: `isMeasuredZeroOverlap` in the web app
      // matches this sentence to tell a measured zero-overlap candidate from
      // a kernel refusal.
      throw new Error(
        `Stored ${operation} extrusion no longer overlaps ${targetBody.name}; operation was not re-inferred.`
      );
    }
    const targetSolid = collapseShape(kernel, target);
    const extrusionSolid = collapseShape(kernel, extrusion);
    const solid =
      operation === 'add'
        ? fuseUniformSolid(kernel, [
            ...target.solids,
            ...extrusion.solids
          ])
        : unifyBooleanFaces(
            kernel,
            tryExactCoaxialCylinderCut(
              kernel,
              targetSolid,
              extrusionSolid
            ) ?? kernel.cut(targetSolid, extrusionSolid)
          );
    // An add only needs the two to meet. Shared volume cannot answer that —
    // a boss grown off the face it was sketched on meets its target exactly
    // there and shares none — so contact is measured by exact distance.
    if (
      operation === 'add' &&
      sharedVolume <= 0 &&
      !shapesShareMaterialOrTouch(kernel, target, extrusion)
    ) {
      throw new Error(
        `Stored ${operation} extrusion no longer overlaps ${targetBody.name}; operation was not re-inferred.`
      );
    }
    const resultBounds = kernel.boundingBox(solid);
    const resultBody: ExtrudeInferenceBody = {
      bodyId: feature.bodyId,
      name: feature.name,
      volume: kernel.volume(solid, MEASUREMENT_DEFLECTION),
      bbox: {
        min: {
          x: resultBounds[0]!,
          y: resultBounds[1]!,
          z: resultBounds[2]!
        },
        max: {
          x: resultBounds[3]!,
          y: resultBounds[4]!,
          z: resultBounds[5]!
        }
      }
    };
    if (
      operation === 'cut' &&
      resultBody.volume <=
        extrudeVolumeTolerance(targetBody, extrusionBody)
    ) {
      throw new Error(
        `Stored cut extrusion would remove all of ${targetBody.name}; operation was not changed.`
      );
    }
    result.consumed.add(targetBodyId);
    result.shapes.set(feature.bodyId, {
      solids: [solid],
      lineage: remusHashOnlyLineage(
        'boolean',
        `The stored extrusion ${operation} does not expose a verified output topology relation.`
      )
    });
  }
}

function buildRevolveFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'revolve'>
): void {
  const { kernel, document, scope, result } = ctx;
  if (feature.bodyId) {
    result.shapes.set(
      feature.bodyId,
      buildSweep(
        kernel,
        document,
        feature,
        scope,
        result.sketchBases,
        (message) =>
          result.warnings.push(
            `Feature "${feature.name}": ${message}`
          )
      )
    );
    if (
      resolveRevolveAngleDeg(data.angleDeg, scope) <
      FULL_REVOLVE_ANGLE_DEG
    ) {
      result.partialRevolveBodies.add(feature.bodyId);
    }
  }
}

function buildLoftFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode
): void {
  const { kernel, document, scope, result } = ctx;
  if (feature.bodyId) {
    result.shapes.set(
      feature.bodyId,
      buildLoft(
        kernel,
        document,
        feature,
        scope,
        result.sketchBases,
        (message) =>
          result.warnings.push(
            `Feature "${feature.name}": ${message}`
          )
      )
    );
  }
}

function buildSweepFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode
): void {
  const { kernel, document, scope, result } = ctx;
  if (feature.bodyId) {
    result.shapes.set(
      feature.bodyId,
      buildProfileSweep(
        kernel,
        document,
        feature,
        scope,
        result.sketchBases,
        (message) =>
          result.warnings.push(
            `Feature "${feature.name}": ${message}`
          )
      )
    );
  }
}

function buildHelicalSweepFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode
): void {
  const { kernel, document, scope, result } = ctx;
  if (feature.bodyId) {
    result.shapes.set(
      feature.bodyId,
      buildHelicalSweep(
        kernel,
        document,
        feature,
        scope,
        result.sketchBases,
        (message) =>
          result.warnings.push(
            `Feature "${feature.name}": ${message}`
          )
      )
    );
  }
}

function buildTransformFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'transform'>
): void {
  const { kernel, scope, result } = ctx;
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Transform target is unavailable.');
  }
  const translation = data.transform.translation;
  const rotation = data.transform.rotationDeg;
  const scaleFactor =
    data.transform.scale !== undefined
      ? resolveParamValue(
          data.transform.scale,
          scope,
          'scale'
        )
      : 1;
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error(
      'Transform scale must resolve to a positive number.'
    );
  }
  result.shapes.set(
    data.targetBodyId,
    copyShapeWithVerifiedLineage(
      kernel,
      target,
      transformMatrix(
        {
          x: resolveParamValue(translation.x, scope, 'X'),
          y: resolveParamValue(translation.y, scope, 'Y'),
          z: resolveParamValue(translation.z, scope, 'Z')
        },
        {
          x: resolveParamValue(rotation.x, scope, 'rotate X'),
          y: resolveParamValue(rotation.y, scope, 'rotate Y'),
          z: resolveParamValue(rotation.z, scope, 'rotate Z')
        },
        scaleFactor
      )
    )
  );
}

function buildMirrorFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'mirror'>
): void {
  const { kernel, scope, result } = ctx;
  if (!feature.bodyId) {
    throw new Error('Mirror has no result body.');
  }
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Mirror target is unavailable.');
  }
  const origin = data.plane.origin;
  const rawNormal = data.plane.normal;
  const planePoint = {
    x: resolveParamValue(origin.x, scope, 'mirror origin X'),
    y: resolveParamValue(origin.y, scope, 'mirror origin Y'),
    z: resolveParamValue(origin.z, scope, 'mirror origin Z')
  };
  const planeNormal = normalized({
    x: resolveParamValue(rawNormal.x, scope, 'mirror normal X'),
    y: resolveParamValue(rawNormal.y, scope, 'mirror normal Y'),
    z: resolveParamValue(rawNormal.z, scope, 'mirror normal Z')
  });
  if (!planeNormal) {
    throw new Error(
      'Mirror plane normal must be finite and non-zero.'
    );
  }
  const operations = createRemusModelingOperations(kernel);
  result.shapes.set(feature.bodyId, {
    solids: target.solids.map((targetSolid) =>
      operations.mirror({ targetSolid, planePoint, planeNormal })
    ),
    lineage: remusHashOnlyLineage(
      'mirror',
      'The pinned bridge does not expose a complete reflected topology relation.'
    )
  });
  inheritMeshOrigin(
    result,
    data.targetBodyId,
    feature.bodyId
  );
}

function buildHoleFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'hole'>
): void {
  const { kernel, scope, result } = ctx;
  if (!feature.bodyId) {
    throw new Error('Hole has no result body.');
  }
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Hole target is unavailable.');
  }
  // Face resolution works on a single solid; fuse a multi-solid
  // body first, exactly as an edge modifier would.
  const shape: ExactShape =
    target.solids.length === 1
      ? target
      : { solids: [collapseShape(kernel, target)] };
  const targetSolid = shape.solids[0]!;
  const faces = resolveFeatureFaces(
    kernel,
    shape,
    [data.faceHash],
    data.faceReference
      ? [data.faceReference]
      : undefined,
    'Hole'
  );
  const geometry = measureFaceGeometry(kernel, faces[0]!);
  if (
    geometry?.surfaceType !== 'plane' ||
    geometry.normal === undefined
  ) {
    throw new Error(
      'A hole needs a planar entry face with an analytic normal.'
    );
  }
  // The same frame construction as `frameFromFace` and the
  // kernel's cylinder frames, so the stored (u, v) re-derives the
  // identical world position on every rebuild.
  const zAxis = normalized(geometry.normal);
  if (!zAxis) {
    throw new Error('Hole entry face normal is degenerate.');
  }
  const reference =
    Math.abs(zAxis.z) < 0.9
      ? { x: 0, y: 0, z: 1 }
      : { x: 1, y: 0, z: 0 };
  const xAxis = normalized(cross(reference, zAxis))!;
  const yAxis = cross(zAxis, xAxis);
  const u = resolveParamValue(
    data.position.u,
    scope,
    'hole position U'
  );
  const v = resolveParamValue(
    data.position.v,
    scope,
    'hole position V'
  );
  const surfacePoint = {
    x: geometry.center.x + xAxis.x * u + yAxis.x * v,
    y: geometry.center.y + xAxis.y * u + yAxis.y * v,
    z: geometry.center.z + xAxis.z * u + yAxis.z * v
  };
  const axis = {
    x: -zAxis.x,
    y: -zAxis.y,
    z: -zAxis.z
  };
  const diameter = resolveParamValue(
    data.diameter,
    scope,
    'hole diameter'
  );
  if (!(diameter > 0)) {
    throw new Error('Hole diameter must be greater than zero.');
  }
  let depth: number;
  if (data.depthMode === 'through') {
    // Far enough to clear the body from this entry point, however
    // the body sits relative to the face.
    const bounds = kernel.boundingBox(targetSolid);
    const corners = [0, 1].flatMap((cx) =>
      [0, 1].flatMap((cy) =>
        [0, 1].map((cz) => ({
          x: bounds[cx * 3]!,
          y: bounds[cy * 3 + 1]!,
          z: bounds[cz * 3 + 2]!
        }))
      )
    );
    depth = corners.reduce(
      (maximum, corner) =>
        Math.max(maximum, dot(subtract(corner, surfacePoint), axis)),
      0
    );
    if (!(depth > 0)) {
      throw new Error('The hole points away from the body.');
    }
  } else {
    if (data.depth === undefined) {
      throw new Error('A blind hole needs a depth.');
    }
    depth = resolveParamValue(
      data.depth,
      scope,
      'hole depth'
    );
    if (!(depth > 0)) {
      throw new Error('Hole depth must be greater than zero.');
    }
  }
  // The overshoot heuristic resizeThroughHole already uses, so a
  // bore through a slanted opening trims identically.
  const extension = Math.max(
    DIRECT_EDIT_TOLERANCE * 10,
    depth * 0.02,
    diameter * 0.01
  );
  const style = data.style;
  const resolveOptional = (
    value: ParamValue | undefined,
    label: string
  ): number | undefined =>
    value === undefined
      ? undefined
      : resolveParamValue(value, scope, label);
  const countersinkAngleDeg = resolveOptional(
    data.countersinkAngleDeg,
    'countersink angle'
  );
  const counterboreDiameter = resolveOptional(
    data.counterboreDiameter,
    'counterbore diameter'
  );
  const drilled = drillHole(kernel, targetSolid, {
    surfacePoint,
    axis,
    radius: diameter / 2,
    depth,
    style,
    counterboreRadius:
      counterboreDiameter === undefined
        ? undefined
        : counterboreDiameter / 2,
    counterboreDepth: resolveOptional(
      data.counterboreDepth,
      'counterbore depth'
    ),
    countersinkRadius: (() => {
      const value = resolveOptional(
        data.countersinkDiameter,
        'countersink diameter'
      );
      return value === undefined ? undefined : value / 2;
    })(),
    countersinkAngle:
      countersinkAngleDeg === undefined
        ? undefined
        : (countersinkAngleDeg * Math.PI) / 180,
    entryExtension: extension,
    exitExtension:
      data.depthMode === 'through' ? extension : 0
  });
  result.consumed.add(data.targetBodyId);
  result.shapes.set(feature.bodyId, {
    solids: [drilled],
    lineage: remusHashOnlyLineage(
      'hole',
      'The compound cut does not report face ancestry through the bore.'
    )
  });
  inheritMeshOrigin(
    result,
    data.targetBodyId,
    feature.bodyId
  );
}

function buildSplitFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'split'>
): void {
  const { kernel, scope, result } = ctx;
  if (!feature.bodyId) {
    throw new Error('Split has no result body.');
  }
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Split target is unavailable.');
  }
  const origin = data.plane.origin;
  const rawNormal = data.plane.normal;
  const planePoint = {
    x: resolveParamValue(origin.x, scope, 'split origin X'),
    y: resolveParamValue(origin.y, scope, 'split origin Y'),
    z: resolveParamValue(origin.z, scope, 'split origin Z')
  };
  const planeNormal = normalized({
    x: resolveParamValue(rawNormal.x, scope, 'split normal X'),
    y: resolveParamValue(rawNormal.y, scope, 'split normal Y'),
    z: resolveParamValue(rawNormal.z, scope, 'split normal Z')
  });
  if (!planeNormal) {
    throw new Error(
      'Split plane normal must be finite and non-zero.'
    );
  }
  // A multi-solid target is fused first: the kernel splits one
  // solid, and each half must again be one body's worth of solids.
  const targetSolid = collapseShape(kernel, target);
  // The kernel refuses rather than approximates — a plane through
  // an edge, across a curved face, or missing the solid entirely
  // is a typed error that lands in the feature's warnings.
  const halves = kernel.split(
    targetSolid,
    planePoint.x,
    planePoint.y,
    planePoint.z,
    planeNormal.x,
    planeNormal.y,
    planeNormal.z
  );
  const positive = halves[0];
  const negative = halves[1];
  if (positive === undefined || negative === undefined) {
    throw new Error('Split did not return two halves.');
  }
  const lineageNote =
    'The kernel split does not report face ancestry across the cut.';
  result.shapes.set(feature.bodyId, {
    solids: [positive],
    lineage: remusHashOnlyLineage('split', lineageNote)
  });
  result.shapes.set(data.secondBodyId, {
    solids: [negative],
    lineage: remusHashOnlyLineage('split', lineageNote)
  });
  result.consumed.add(data.targetBodyId);
  inheritMeshOrigin(
    result,
    data.targetBodyId,
    feature.bodyId
  );
  inheritMeshOrigin(
    result,
    data.targetBodyId,
    data.secondBodyId
  );
}

function buildShellFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'shell'>
): void {
  const { kernel, scope, result } = ctx;
  if (!feature.bodyId) {
    throw new Error('Shell has no result body.');
  }
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Shell target is unavailable.');
  }
  const openingFaces = resolveFeatureFaces(
    kernel,
    target,
    data.openingFaceHashes,
    data.openingFaceReferences,
    'Shell opening'
  );
  const thickness = resolveParamValue(
    data.thickness,
    scope,
    'shell thickness'
  );
  const solid = createRemusModelingOperations(kernel).shell({
    targetSolid: target.solids[0]!,
    thickness,
    openingFaces
  });
  result.consumed.add(data.targetBodyId);
  result.shapes.set(feature.bodyId, {
    solids: [solid],
    lineage: remusHashOnlyLineage(
      'shell',
      'The pinned bridge does not expose removed, offset, and generated face relations.'
    )
  });
  inheritMeshOrigin(
    result,
    data.targetBodyId,
    feature.bodyId
  );
}

function buildSolidOffsetFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'solid-offset'>
): void {
  const { kernel, scope, result } = ctx;
  if (!feature.bodyId) {
    throw new Error('Solid offset has no result body.');
  }
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Solid-offset target is unavailable.');
  }
  const distance = resolveParamValue(
    data.distance,
    scope,
    'solid offset distance'
  );
  const operations = createRemusModelingOperations(kernel);
  const solids = target.solids.map((targetSolid) =>
    operations.offsetSolid({ targetSolid, distance })
  );
  result.consumed.add(data.targetBodyId);
  result.shapes.set(feature.bodyId, {
    solids,
    lineage: remusHashOnlyLineage(
      'solid-offset',
      'The pinned bridge does not expose a complete offset topology relation.'
    )
  });
  inheritMeshOrigin(
    result,
    data.targetBodyId,
    feature.bodyId
  );
}

function buildDraftFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'draft'>
): void {
  const { kernel, scope, result } = ctx;
  if (!feature.bodyId) {
    throw new Error('Draft has no result body.');
  }
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Draft target is unavailable.');
  }
  const faces = resolveFeatureFaces(
    kernel,
    target,
    data.faceHashes,
    data.faceReferences,
    'Draft'
  );
  const pullDirection = resolveParametricPoint(
    data.pullDirection,
    scope,
    'draft pull direction'
  );
  const neutralPoint = resolveParametricPoint(
    data.neutralPoint,
    scope,
    'draft neutral point'
  );
  const angleDegrees = resolveParamValue(
    data.angleDeg,
    scope,
    'draft angle'
  );
  const solid = createRemusModelingOperations(kernel).draft({
    targetSolid: target.solids[0]!,
    faces,
    pullDirection,
    neutralPoint,
    angleDegrees
  });
  result.consumed.add(data.targetBodyId);
  result.shapes.set(feature.bodyId, {
    solids: [solid],
    lineage: remusHashOnlyLineage(
      'draft',
      'Draft topology has no verified output evolution relation.'
    )
  });
  inheritMeshOrigin(
    result,
    data.targetBodyId,
    feature.bodyId
  );
}

function buildThickenFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'thicken'>
): void {
  const { kernel, scope, result } = ctx;
  if (!feature.bodyId) {
    throw new Error('Thicken has no result body.');
  }
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Thicken source body is unavailable.');
  }
  const [face] = resolveFeatureFaces(
    kernel,
    target,
    [data.faceHash],
    data.faceReference
      ? [data.faceReference]
      : undefined,
    'Thicken'
  );
  const thickness = resolveParamValue(
    data.thickness,
    scope,
    'thicken distance'
  );
  const solid = createRemusModelingOperations(kernel).thicken({
    sourceSolid: target.solids[0]!,
    face: face!,
    thickness
  });
  result.shapes.set(feature.bodyId, {
    solids: [solid],
    lineage: remusHashOnlyLineage(
      'thicken',
      'Thicken topology has no verified output evolution relation.'
    )
  });
  inheritMeshOrigin(
    result,
    data.targetBodyId,
    feature.bodyId
  );
}

function buildBooleanFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'boolean'>
): void {
  const { kernel, document, result } = ctx;
  if (!feature.bodyId || data.targetBodyIds.length < 2) {
    throw new Error('Boolean requires at least two bodies.');
  }
  const meshOperand = data.targetBodyIds.find((bodyId) =>
    result.meshBodies.has(bodyId)
  );
  if (meshOperand !== undefined) {
    throw meshBooleanUnsupportedError(
      bodyName(document, meshOperand)
    );
  }
  const operands = data.targetBodyIds.map((bodyId) => {
    const shape = result.shapes.get(bodyId);
    if (!shape) {
      throw new Error(`Boolean target ${bodyId} is unavailable.`);
    }
    return shape;
  });
  // Census the operands before the boolean consumes them. A faceted
  // fallback is only visible as a change in face count and surface
  // type, so both sides have to be measured.
  const operandCensus = censusOfSolids(
    kernel,
    operands.flatMap((shape) => shape.solids)
  );
  let solid: number;
  let unionFuseOperands: UnionFuseOperand[] | null = null;
  // A disconnected union is a different complaint with its own
  // remedy and its own warning; it must not also be reported as
  // non-manifold, nor be offered a move-to-overlap suggestion.
  let unionDisconnected = false;
  if (data.operation === 'union') {
    const unionOperands = data.targetBodyIds.flatMap(
      (bodyId, operandIndex) =>
        operands[operandIndex]!.solids.map((candidate) => {
          const bounds = kernel.boundingBox(candidate);
          return {
            solid: candidate,
            name: bodyName(document, bodyId),
            bounds: {
              min: {
                x: bounds[0]!,
                y: bounds[1]!,
                z: bounds[2]!
              },
              max: {
                x: bounds[3]!,
                y: bounds[4]!,
                z: bounds[5]!
              }
            }
          };
        })
    );
    unionFuseOperands = unionOperands;
    const unionSolids = unionOperands.map((operand) => operand.solid);
    const connectivity = analyzeUnionConnectivity(
      unionOperands,
      (left, right) =>
        kernel.solidToSolidDistance(left, right)[0] ?? NaN,
      (left, right) => {
        try {
          if (
            kernel.volume(
              kernel.intersect(left, right),
              MEASUREMENT_DEFLECTION
            ) > 0
          ) {
            return true;
          }
        } catch {
          // Face contact has no shared volume, so fall through to
          // the kernel's same-domain contact query.
        }
        try {
          const contacts = JSON.parse(
            kernel.detectCoincidentFaces(left, right)
          ) as unknown;
          return (
            Array.isArray(contacts) &&
            contacts.some(
              (contact) =>
                typeof contact === 'object' &&
                contact !== null &&
                (contact as { aabbOverlap?: unknown }).aabbOverlap ===
                  true
            )
          );
        } catch {
          return false;
        }
      }
    );
    solid = fuseUniformSolid(kernel, unionSolids);
    const resultBounds = kernel.boundingBox(solid);
    const droppedOperand = droppedUnionOperandWarning({
      operands: unionOperands.map((operand) => {
        const curvedExtents: {
          min: Partial<Record<'x' | 'y' | 'z', boolean>>;
          max: Partial<Record<'x' | 'y' | 'z', boolean>>;
        } = { min: {}, max: {} };
        const axes = ['x', 'y', 'z'] as const;
        for (const face of kernel.getSolidFaces(operand.solid)) {
          if (kernel.getSurfaceType(face) === 'plane') continue;
          const faceBounds = tessellatedFaceBounds(kernel, face);
          for (
            let axisIndex = 0;
            axisIndex < axes.length;
            axisIndex++
          ) {
            const axis = axes[axisIndex]!;
            const scale = Math.max(
              1,
              Math.abs(operand.bounds.min[axis]),
              Math.abs(operand.bounds.max[axis])
            );
            const tolerance = geometryTolerance(scale);
            if (
              Math.abs(
                faceBounds[axisIndex]! - operand.bounds.min[axis]
              ) <= tolerance
            ) {
              curvedExtents.min[axis] = true;
            }
            if (
              Math.abs(
                faceBounds[axisIndex + 3]! - operand.bounds.max[axis]
              ) <= tolerance
            ) {
              curvedExtents.max[axis] = true;
            }
          }
        }
        return {
          name: operand.name,
          bounds: operand.bounds,
          curvedExtents
        };
      }),
      result: {
        min: {
          x: resultBounds[0]!,
          y: resultBounds[1]!,
          z: resultBounds[2]!
        },
        max: {
          x: resultBounds[3]!,
          y: resultBounds[4]!,
          z: resultBounds[5]!
        }
      },
      units: document.units,
      approximationTolerance: MEASUREMENT_DEFLECTION
    });
    if (droppedOperand) {
      result.warnings.push(
        `Feature "${feature.name}": ${droppedOperand}`
      );
    }
    if (
      !connectivity.connected &&
      !isFaceConnectedSolid(kernel, solid)
    ) {
      unionDisconnected = true;
      result.warnings.push(
        `Feature "${feature.name}": ${disconnectedUnionWarning(
          connectivity,
          document.units
        )}`
      );
    }
  } else {
    solid = collapseShape(kernel, operands[0]!);
    const subtracting = data.operation === 'subtract';
    // Measured BEFORE any cutting, because afterwards there is
    // nothing left to compare against: a cut that silently does
    // nothing and a cut with nothing to do produce the same body.
    const volumeBeforeCut = subtracting
      ? kernel.volume(solid, MEASUREMENT_DEFLECTION)
      : 0;
    let sharedWithTools = 0;
    for (const operand of operands.slice(1)) {
      const tool = collapseShape(kernel, operand);
      if (subtracting) {
        try {
          sharedWithTools += kernel.volume(
            kernel.intersect(
              kernel.copySolid(solid),
              kernel.copySolid(tool)
            ),
            MEASUREMENT_DEFLECTION
          );
        } catch {
          // An intersect that refuses says nothing either way, and
          // a guard is not the place to turn that into a claim.
        }
      }
      solid = subtracting
        ? (tryExactCoaxialCylinderCut(kernel, solid, tool) ??
          kernel.cut(solid, tool))
        : kernel.intersect(solid, tool);
    }
    solid = unifyBooleanFaces(kernel, solid);
    // A cut that removes too little of the material it demonstrably
    // overlaps. A cross-drilled shaft can come back closed, valid,
    // and nearly unchanged even though its bore has positive-volume
    // overlap. Every structural check passes; only these two
    // measurements disagree.
    //
    // Keep measuring against the target as it changes through the
    // existing sequential tool loop. That is normal multi-tool
    // subtract semantics: a later tool is only credited with the
    // material that remains after the earlier cuts.
    //
    // Publishing the result would confirm a subtract whose own
    // measurements say it did not take. Throw before consuming the
    // operands or recording the result body, so rebuild keeps the
    // target and tools visible and exportable instead.
    if (subtracting && sharedWithTools > GEOMETRY_EPSILON) {
      const removed =
        volumeBeforeCut -
        kernel.volume(solid, MEASUREMENT_DEFLECTION);
      const minimumRemoved =
        sharedWithTools * MINIMUM_SUBTRACT_REMOVAL_RATIO;
      if (removed < minimumRemoved) {
        const toolSubject =
          operands.length === 2
            ? 'the tool overlaps'
            : 'the tools overlap';
        throw new Error(
          `Subtract refused: ${toolSubject} the target by ` +
            `${formatMeasuredVolume(sharedWithTools)} ${document.units}³, ` +
            `but the kernel removed ${formatMeasuredVolume(removed)} ${document.units}³; ` +
            `the accepted minimum is ${formatMeasuredVolume(minimumRemoved)} ${document.units}³ ` +
            `(${MINIMUM_SUBTRACT_REMOVAL_RATIO * 100}% of measured overlap). ` +
            'The target and tools were left unchanged.'
        );
      }
    }
  }
  // The face-count census. Mesh closure, validation and volume all
  // pass on a silently faceted boolean result; the faces do not.
  const facetFallback = booleanFacetFallbackWarning({
    operands: operandCensus,
    result: censusOfSolids(kernel, [solid])
  });
  // A tangency the fuse cannot resolve exactly does not always come
  // back faceted. Kernels differ on which way they fail it: one
  // drops to facets, another returns a body that is not a valid
  // solid at all. Both are the same complaint to the user, and both
  // are answered by the same move, so the refusal is classified on
  // either symptom rather than on faceting alone.
  const unionNotSolid =
    unionFuseOperands !== null &&
    !unionDisconnected &&
    (kernel.validateSolid(solid) !== 0 ||
      !solidMeshIsClosed(kernel, solid));
  // Which warning the proved move belongs to.
  //
  // This used to be the index of the feature's FIRST warning, on the
  // reasoning that a refused commit reports one reason and a remedy
  // filed behind it never gets read. That is true but it picked the
  // wrong warning: a dropped-operand or disconnected-union warning
  // can already sit there, and appending "moving X clears it" to one
  // of those attaches a remedy to a complaint it does not answer.
  // Track the refusal actually pushed here instead.
  let refusalIndex: number | null = null;
  if (facetFallback) {
    refusalIndex = result.warnings.length;
    result.warnings.push(
      `Feature "${feature.name}": ${facetFallback}`
    );
  } else if (unionNotSolid) {
    refusalIndex = result.warnings.length;
    // Deliberately the same sentence the strict validation pass
    // emits later. Saying it here instead means the proved move can
    // ride along with it — that pass runs far from the operands,
    // where they can no longer be probed. It also suppresses the
    // later copy, which declines once a feature-specific warning
    // exists.
    result.warnings.push(
      `Feature "${feature.name}": Union produced an open, ` +
        'non-manifold, or inconsistently oriented result. Adjust ' +
        'the overlap or placement and try again.'
    );
  }
  // Naming the move that works is only possible here, where the
  // operands are still addressable; by the time this reaches the
  // panel it is a sentence. Probing costs a fuse per candidate, so
  // it runs only for the failures it answers.
  // A disconnected union is a different complaint with its own
  // remedy, and closing that gap by sliding one body to the other's
  // centre is not advice anyone asked for.
  if (refusalIndex !== null && unionFuseOperands) {
    const suggestion = exactUnionOffsetSuggestion(
      kernel,
      unionFuseOperands,
      document.units
    );
    if (suggestion) {
      result.warnings[refusalIndex] =
        `${result.warnings[refusalIndex]!} ${suggestion}`;
    }
  }
  data.targetBodyIds.forEach((bodyId) =>
    result.consumed.add(bodyId)
  );
  result.shapes.set(feature.bodyId, {
    solids: [solid],
    lineage: remusHashOnlyLineage(
      'boolean',
      'The production boolean result may be face-unified after the kernel operation, so no unverified history payload is accepted.'
    )
  });
}

function buildEdgeModifierFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'fillet' | 'chamfer'>
): void {
  const { kernel, document, scope, result } = ctx;
  if (!feature.bodyId) {
    throw new Error('Edge modifier has no result body.');
  }
  const storedTarget = result.shapes.get(data.targetBodyId);
  if (!storedTarget) {
    throw new Error('Edge modifier target is unavailable.');
  }
  const target = collapseShape(kernel, storedTarget);
  const { handles: selected, repairedReferences } =
    resolveEdgeModifierEdges(
      kernel,
      storedTarget,
      target,
      data.edgeHashes,
      data.edgeReferences
    );
  const size = resolveParamValue(
    data.featureKind === 'fillet'
      ? data.radius
      : data.distance,
    scope,
    data.featureKind === 'fillet' ? 'radius' : 'distance'
  );
  if (size <= GEOMETRY_EPSILON) {
    throw new Error('Edge modifier size must be greater than zero.');
  }
  let chamferAngleRadians: number | undefined;
  if (
    data.featureKind === 'chamfer' &&
    data.angleDeg !== undefined
  ) {
    const angleDeg = resolveParamValue(
      data.angleDeg,
      scope,
      'angle'
    );
    // The kernel rejects angles at or past 90°; 45° exactly is the
    // symmetric chamfer, but an explicit 45 is honored as stored.
    if (!(angleDeg > 0 && angleDeg < 90)) {
      throw new Error(
        'Chamfer angle must be strictly between 0 and 90 degrees.'
      );
    }
    chamferAngleRadians = (angleDeg * Math.PI) / 180;
  }
  let reportedRefusal: string | null = null;
  let evolution: FaceEvolutionPayloadV1 | null = null;
  const sourceCandidates = topologyCandidatesForSolid(kernel, target);
  const modified = applyEdgeModifier(
    kernel,
    target,
    selected,
    data.featureKind,
    size,
    (message) => {
      reportedRefusal = message;
    },
    (payload) => {
      evolution = payload;
    },
    chamferAngleRadians
  );
  if (modified === null) {
    throw new Error(
      edgeModifierFailureMessage(
        kernel,
        target,
        selected,
        data.featureKind,
        size,
        result.partialRevolveBodies.has(data.targetBodyId),
        reportedRefusal
      )
    );
  }
  const cylinderFallbackLineage = modifierChainRootsAtCylinder(
    document,
    data.targetBodyId
  )
    ? rederiveCylinderModifierLineage(kernel, modified, feature)
    : null;
  const evolutionLineage = evolution
    ? createRemusModifierEvolutionLineage({
        producingFeatureId: feature.featureId,
        operation: data.featureKind,
        payload: evolution,
        sourceSolid: target,
        resultSolid: modified,
        sourceCandidates,
        resultCandidates: topologyCandidatesForSolid(
          kernel,
          modified
        ),
        sourceLineage: storedTarget.lineage,
        generatedBlendFaces: new Set(
          Array.from(kernel.getSolidFaces(modified)).filter((face) =>
            isBlendFace(kernel, modified, face)
          )
        )
      })
    : null;
  const verifiedLineages = [
    cylinderFallbackLineage,
    evolutionLineage
  ].filter((lineage): lineage is RemusLineageState => !!lineage);
  const verifiedLineage = mergeRemusLineageStates(verifiedLineages);
  result.consumed.add(data.targetBodyId);
  result.shapes.set(feature.bodyId, {
    solids: [modified],
    lineage:
      verifiedLineage.faceReferences.size > 0 ||
      verifiedLineage.edgeReferences.size > 0 ||
      verifiedLineage.diagnostics.length > 0
        ? verifiedLineage
        : remusHashOnlyLineage(
            data.featureKind,
            'No generated face passed the construction-history, exact support-witness, and uniqueness checks.'
          )
  });
  inheritMeshOrigin(
    result,
    data.targetBodyId,
    feature.bodyId
  );
  // Only a feature that actually rebuilt earns a repair: a thrown
  // modifier above skips this, and the legacy selection stays as it
  // was for the user to fix.
  if (repairedReferences) {
    result.referenceRepairs.push({
      featureId: feature.featureId,
      edgeReferences: repairedReferences
    });
  }
}

function buildPatternFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'pattern'>
): void {
  const { kernel, scope, result } = ctx;
  if (!feature.bodyId) {
    throw new Error('Pattern has no result body.');
  }
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Pattern target is unavailable.');
  }
  const count = Math.round(
    resolveParamValue(data.count, scope, 'count')
  );
  if (count < 2 || count > 100) {
    throw new Error('Pattern count must be between 2 and 100.');
  }
  // Grid instance counts multiply, so the solid cap is enforced on
  // the total rather than per axis.
  const count2 =
    data.patternKind === 'grid'
      ? Math.round(
          resolveParamValue(
            data.count2 ?? data.count,
            scope,
            'count 2'
          )
        )
      : 1;
  if (
    data.patternKind === 'grid' &&
    (count2 < 2 || count2 > 100)
  ) {
    throw new Error('Pattern count must be between 2 and 100.');
  }
  const totalInstances = count * count2;
  if (target.solids.length * totalInstances > 100) {
    throw new Error('A pattern may produce at most 100 solids.');
  }
  const direction =
    data.patternKind !== 'circular' && data.direction
      ? resolvePatternDirection(data.direction, scope)
      : axisDirection(data.axis);
  const solids = [...target.solids];
  if (data.patternKind === 'linear') {
    const spacing = resolveParamValue(
      data.spacing,
      scope,
      'spacing'
    );
    if (Math.abs(spacing) <= GEOMETRY_EPSILON) {
      throw new Error('Pattern spacing cannot be zero.');
    }
    for (let index = 1; index < count; index += 1) {
      const instance = copyShape(
        kernel,
        target,
        transformMatrix(
          {
            x: direction.x * spacing * index,
            y: direction.y * spacing * index,
            z: direction.z * spacing * index
          },
          { x: 0, y: 0, z: 0 }
        )
      );
      solids.push(...instance.solids);
    }
  } else if (data.patternKind === 'grid') {
    const spacing = resolveParamValue(
      data.spacing,
      scope,
      'spacing'
    );
    const spacing2 = resolveParamValue(
      data.spacing2 ?? data.spacing,
      scope,
      'spacing 2'
    );
    if (
      Math.abs(spacing) <= GEOMETRY_EPSILON ||
      Math.abs(spacing2) <= GEOMETRY_EPSILON
    ) {
      throw new Error('Pattern spacing cannot be zero.');
    }
    const direction2 = axisDirection(data.axis2 ?? 'y');
    const crossProduct = cross(direction, direction2);
    if (length(crossProduct) <= GEOMETRY_EPSILON) {
      throw new Error('Grid pattern directions cannot be parallel.');
    }
    for (let ix = 0; ix < count; ix += 1) {
      for (let iy = 0; iy < count2; iy += 1) {
        if (ix === 0 && iy === 0) {
          continue; // the original occupies (0, 0)
        }
        const instance = copyShape(
          kernel,
          target,
          transformMatrix(
            {
              x:
                direction.x * spacing * ix +
                direction2.x * spacing2 * iy,
              y:
                direction.y * spacing * ix +
                direction2.y * spacing2 * iy,
              z:
                direction.z * spacing * ix +
                direction2.z * spacing2 * iy
            },
            { x: 0, y: 0, z: 0 }
          )
        );
        solids.push(...instance.solids);
      }
    }
  } else {
    const angle = resolveParamValue(
      data.angleDeg,
      scope,
      'pattern angle'
    );
    if (Math.abs(angle) <= GEOMETRY_EPSILON) {
      throw new Error('Pattern angle cannot be zero.');
    }
    const angleStep =
      Math.abs(Math.abs(angle) - 360) <= GEOMETRY_EPSILON
        ? angle / count
        : angle / (count - 1);
    for (let index = 1; index < count; index += 1) {
      const rotation = {
        x: data.axis === 'x' ? angleStep * index : 0,
        y: data.axis === 'y' ? angleStep * index : 0,
        z: data.axis === 'z' ? angleStep * index : 0
      };
      const instance = copyShape(
        kernel,
        target,
        transformMatrix({ x: 0, y: 0, z: 0 }, rotation)
      );
      solids.push(...instance.solids);
    }
  }
  // Instances that interpenetrate have to become ONE solid before
  // anything measures them. Every consumer downstream — the volume
  // the Inspector prints, the STL writer, the mesh the viewport
  // draws — walks this list per solid and sums, so two overlapping
  // copies are counted twice and the interior walls are drawn. The
  // agreement between the reported volume and the enclosed mesh
  // volume is no defence: both sum the same list, so both are wrong
  // by exactly the same amount and neither can catch the other.
  //
  // Fusing is deliberately conditional. The disjoint case is the
  // overwhelmingly common one, it is already correct, and fusing it
  // would rebuild topology and re-key lineage for no change in any
  // number a user sees. So the fuse runs only where the sum is
  // actually wrong.
  const shared = sharedSolidVolume(kernel, solids);
  if (shared > 0) {
    const summed = solids.reduce(
      (total, instance) =>
        total + kernel.volume(instance, MEASUREMENT_DEFLECTION),
      0
    );
    const fused = fuseUniformSolid(kernel, solids);
    const removed =
      summed - kernel.volume(fused, MEASUREMENT_DEFLECTION);
    // The fuse is NOT guaranteed to merge. On shallow overlaps it
    // returns the operands essentially untouched — measured on three
    // r5 h10 cylinders, by overlap depth (2r - d):
    //
    //   depth 1.0, 4.0  ->  9 faces, 0.6 of 58.8 shared removed
    //   depth 7.0, 9.5  -> 41 and 33 faces, merged
    //
    // Testing "did the volume stay equal to the sum" is too weak:
    // the fuse perturbs it by ~0.03% while merging nothing, which is
    // enough to clear any equality bar. So the test is whether it
    // removed a real share of the material the instances are KNOWN
    // to share, which was measured on the way in.
    //
    // Half is a deliberately loose bar. The pairwise total
    // overstates the true correction wherever three instances meet,
    // so a correct merge can legitimately remove less than all of
    // it; nothing near a working fuse removes under half.
    //
    // The body still stands either way — the instances are real and
    // the user asked for them. Silence is the only outcome ruled
    // out, because this defect survived precisely by being silent:
    // the reported volume and the enclosed mesh agreed, both summing
    // the same list.
    if (removed < shared * 0.5) {
      result.warnings.push(
        `Feature "${feature.name}": instances overlap but the merge did not take, so the reported volume counts shared material more than once.`
      );
    }
    result.shapes.set(feature.bodyId, { solids: [fused] });
  } else {
    result.shapes.set(feature.bodyId, { solids });
  }
  // Consumed only once a shape exists, which is what the other eight consume
  // sites in this file do. The build loop is not transactional: it catches a
  // throw per feature, records a warning, and carries on with the same
  // mutable result — so a consume-mark set before the fallible fuse survived
  // the failure that cancelled the pattern, and the target vanished from the
  // viewport, the parts list and the STEP scope with nothing replacing it.
  result.consumed.add(data.targetBodyId);
  inheritMeshOrigin(
    result,
    data.targetBodyId,
    feature.bodyId
  );
}

/** Per-feature-kind dispatch: one builder owns each history feature. */
export function buildFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode
): void {
  switch (feature.data.featureKind) {
        case 'sketch':
          buildSketchFeature(ctx, feature, feature.data);
          break;
        case 'imported-mesh':
          buildImportedMeshFeature(ctx, feature, feature.data);
          break;
        case 'direct-edit':
          buildDirectEditFeature(ctx, feature, feature.data);
          break;
        case 'imported-step':
          buildImportedStepFeature(ctx, feature, feature.data);
          break;
        case 'primitive':
          buildPrimitiveFeature(ctx, feature);
          break;
        case 'extrude':
          buildExtrudeFeature(ctx, feature, feature.data);
          break;
        case 'revolve':
          buildRevolveFeature(ctx, feature, feature.data);
          break;
        case 'loft':
          buildLoftFeature(ctx, feature);
          break;
        case 'sweep':
          buildSweepFeature(ctx, feature);
          break;
        case 'helical-sweep':
          buildHelicalSweepFeature(ctx, feature);
          break;
        case 'transform':
          buildTransformFeature(ctx, feature, feature.data);
          break;
        case 'mirror':
          buildMirrorFeature(ctx, feature, feature.data);
          break;
        case 'hole':
          buildHoleFeature(ctx, feature, feature.data);
          break;
        case 'split':
          buildSplitFeature(ctx, feature, feature.data);
          break;
        case 'shell':
          buildShellFeature(ctx, feature, feature.data);
          break;
        case 'solid-offset':
          buildSolidOffsetFeature(ctx, feature, feature.data);
          break;
        case 'draft':
          buildDraftFeature(ctx, feature, feature.data);
          break;
        case 'thicken':
          buildThickenFeature(ctx, feature, feature.data);
          break;
        case 'boolean':
          buildBooleanFeature(ctx, feature, feature.data);
          break;
        case 'fillet':
        case 'chamfer':
          buildEdgeModifierFeature(ctx, feature, feature.data);
          break;
        case 'pattern':
          buildPatternFeature(ctx, feature, feature.data);
          break;
  }
}
