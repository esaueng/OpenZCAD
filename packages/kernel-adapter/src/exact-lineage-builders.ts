/**
 * Semantic lineage construction for the proved subset: primitives, extrudes,
 * revolves, and the rederivations that keep direct-edited and modifier-chained
 * cylinders resolvable. Everything here builds ADR-013 lineage records from
 * live kernel handles; resolution of stored references lives in
 * `topology-lineage`, and the fail-closed hash-only fallback in
 * `remus-lineage`.
 */
import type { RemusKernel } from './remus-runtime';
import { listFeaturesInOrder, resolveParamValue } from '@openzcad/document-core';
import type { ExactShape } from './exact-types';
import type { ImportedSolidDiagnosis } from './imported-step-validation';
import type { PlaneBasis, Vec3 } from '@openzcad/geometry';
import type {
  BodyId,
  EdgeWitnessV1,
  FaceWitnessV1,
  FeatureNode,
  ProjectDocument,
  QuantizedTopologyPoint,
  SketchObjectData
} from '@openzcad/shared';
import {
  createRemusSemanticLineage,
  mergeRemusLineageStates,
  remusHashOnlyLineage,
  type RemusLineageState,
  type RemusSemanticAssignment,
  type RemusTopologyCandidate
} from './remus-lineage';
import { topologyWitnessesEqual } from './topology-lineage';
import { canonicalDirection, quantizeCoordinate } from './topology-fingerprint';
import {
  edgeWitnessOf,
  faceWitnessOf,
  quantizedDirectionOf,
  quantizedPoint
} from './exact-witnesses';
import {
  pointAt,
  pointOnPlane,
  profilePoints,
  cross,
  dot,
  normalized,
  scale,
  subtract
} from './exact-math';

/**
 * Measure one imported solid for the K0.6 validator.
 *
 * Closure and manifoldness are read from the EXACT B-rep — `edgeToFaceMap`
 * lists one entry per face use of an edge, so a closed manifold shell uses
 * every edge exactly twice. This is deliberately not `meshQuality`, which
 * reports `isWatertight: false` for a valid analytic cone because the apex
 * does not weld; see `imported-step-validation.ts` for that measurement.
 *
 * The strict validator is used rather than the relaxed one because the
 * relaxation exists for booleans and blends, and an import has not been
 * through either — it is what the file declares.
 */
export function diagnoseImportedSolid(
  kernel: RemusKernel,
  solid: number,
  index: number
): ImportedSolidDiagnosis {
  const edgeToFaces = JSON.parse(kernel.edgeToFaceMap(solid)) as Record<
    string,
    number[]
  >;
  let openEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  let edgeCount = 0;
  for (const uses of Object.values(edgeToFaces)) {
    edgeCount += 1;
    const count = Array.isArray(uses) ? uses.length : 0;
    if (count < 2) {
      openEdgeCount += 1;
    } else if (count > 2) {
      nonManifoldEdgeCount += 1;
    }
  }
  return {
    index,
    faceCount: Array.from(kernel.getSolidFaces(solid)).length,
    edgeCount,
    openEdgeCount,
    nonManifoldEdgeCount,
    shellCount: Array.from(kernel.getSolidShells(solid)).length,
    strictErrorCount: kernel.validateSolid(solid),
    relaxedErrorCount: kernel.validateSolidRelaxed(solid)
  };
}

export function topologyCandidatesForSolid(
  kernel: RemusKernel,
  solid: number
): RemusTopologyCandidate[] {
  return [
    ...Array.from(kernel.getSolidFaces(solid), (handle) => ({
      handle,
      kind: 'face' as const,
      witness: faceWitnessOf(kernel, handle)
    })),
    ...Array.from(kernel.getSolidEdges(solid), (handle) => ({
      handle,
      kind: 'edge' as const,
      witness: edgeWitnessOf(kernel, handle)
    }))
  ];
}

export function samePoint(
  left: QuantizedTopologyPoint,
  right: QuantizedTopologyPoint
): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

export function sameAnalyticCarrier(
  left: FaceWitnessV1['analytic'],
  right: FaceWitnessV1['analytic']
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'none' || right.kind === 'none') {
    return left.kind === right.kind;
  }
  if (left.kind === 'plane' && right.kind === 'plane') {
    return samePoint(left.normal, right.normal) && left.offset === right.offset;
  }
  if (left.kind === 'cylinder' && right.kind === 'cylinder') {
    return (
      samePoint(left.axis, right.axis) &&
      samePoint(left.axisFoot, right.axisFoot) &&
      left.radius === right.radius
    );
  }
  return false;
}

export function addUniqueSemanticAssignment(
  candidates: readonly RemusTopologyCandidate[],
  kind: 'edge' | 'face',
  lineageName: string,
  predicate: (candidate: RemusTopologyCandidate) => boolean,
  assignments: RemusSemanticAssignment[],
  diagnostics: RemusLineageState[],
  operation: 'primitive' | 'sweep' | 'fillet' | 'chamfer'
) {
  const matches = candidates.filter(
    (candidate) => candidate.kind === kind && predicate(candidate)
  );
  if (matches.length !== 1) {
    diagnostics.push(
      remusHashOnlyLineage(
        operation,
        `Semantic role ${lineageName} matched ${matches.length} exact candidates.`
      )
    );
    return;
  }
  assignments.push({ ...matches[0]!, lineageName });
}

export function primitiveBoxEdgeRole(
  witness: EdgeWitnessV1,
  bounds: {
    min: QuantizedTopologyPoint;
    max: QuantizedTopologyPoint;
  }
): string | null {
  if (witness.closed) {
    return null;
  }
  const deltas = witness.endpoints[0].map(
    (value, axis) => witness.endpoints[1][axis]! - value
  );
  const varyingAxes = deltas
    .map((delta, axis) => ({ delta, axis }))
    .filter(({ delta }) => delta !== 0);
  if (varyingAxes.length !== 1) {
    return null;
  }
  const axis = varyingAxes[0]!.axis;
  const labels = ['x', 'y', 'z'] as const;
  const fixed: string[] = [];
  for (let fixedAxis = 0; fixedAxis < 3; fixedAxis += 1) {
    if (fixedAxis === axis) {
      continue;
    }
    const coordinate = witness.endpoints[0][fixedAxis]!;
    const bound =
      coordinate === bounds.min[fixedAxis]
        ? 'min'
        : coordinate === bounds.max[fixedAxis]
          ? 'max'
          : null;
    if (!bound || witness.endpoints[1][fixedAxis] !== coordinate) {
      return null;
    }
    fixed.push(`${labels[fixedAxis]}-${bound}`);
  }
  return `primitive.box.edge.${labels[axis]}.${fixed.join('.')}`;
}

export function buildPrimitiveLineage(
  kernel: RemusKernel,
  solid: number,
  feature: FeatureNode
): RemusLineageState {
  if (feature.data.featureKind !== 'primitive') {
    return remusHashOnlyLineage(
      'primitive',
      'Feature is not a primitive construction.'
    );
  }
  const candidates = topologyCandidatesForSolid(kernel, solid);
  const assignments: RemusSemanticAssignment[] = [];
  const diagnostics: RemusLineageState[] = [];
  const faces = candidates.filter((candidate) => candidate.kind === 'face');
  const edges = candidates.filter((candidate) => candidate.kind === 'edge');
  const boundsValues = Array.from(kernel.boundingBox(solid));
  const bounds = {
    min: quantizedPoint({
      x: boundsValues[0]!,
      y: boundsValues[1]!,
      z: boundsValues[2]!
    }),
    max: quantizedPoint({
      x: boundsValues[3]!,
      y: boundsValues[4]!,
      z: boundsValues[5]!
    })
  };

  switch (feature.data.primitiveKind) {
    case 'box': {
      const faceRoles = new Map<number, string>();
      for (const candidate of faces) {
        const normal = Array.from(kernel.getFaceNormal(candidate.handle));
        const unit = normalized(pointAt(normal, 0));
        if (!unit) {
          continue;
        }
        const direction = [
          Math.round(unit.x),
          Math.round(unit.y),
          Math.round(unit.z)
        ];
        const role =
          direction[0] === -1
            ? 'x-min'
            : direction[0] === 1
              ? 'x-max'
              : direction[1] === -1
                ? 'y-min'
                : direction[1] === 1
                  ? 'y-max'
                  : direction[2] === -1
                    ? 'z-min'
                    : direction[2] === 1
                      ? 'z-max'
                      : null;
        if (role) {
          faceRoles.set(candidate.handle, role);
        }
      }
      for (const role of [
        'x-min',
        'x-max',
        'y-min',
        'y-max',
        'z-min',
        'z-max'
      ]) {
        addUniqueSemanticAssignment(
          faces,
          'face',
          `primitive.box.face.${role}`,
          (candidate) => faceRoles.get(candidate.handle) === role,
          assignments,
          diagnostics,
          'primitive'
        );
      }
      const edgeRoles = new Map<number, string>();
      for (const candidate of edges) {
        const role = primitiveBoxEdgeRole(
          candidate.witness as EdgeWitnessV1,
          bounds
        );
        if (role) {
          edgeRoles.set(candidate.handle, role);
        }
      }
      const expectedEdgeRoles = ['x', 'y', 'z'].flatMap((varyingAxis) => {
        const fixedAxes = ['x', 'y', 'z'].filter(
          (axis) => axis !== varyingAxis
        );
        return ['min', 'max'].flatMap((firstBound) =>
          ['min', 'max'].map(
            (secondBound) =>
              `primitive.box.edge.${varyingAxis}.${fixedAxes[0]}-${firstBound}.${fixedAxes[1]}-${secondBound}`
          )
        );
      });
      for (const role of expectedEdgeRoles) {
        addUniqueSemanticAssignment(
          edges,
          'edge',
          role,
          (candidate) => edgeRoles.get(candidate.handle) === role,
          assignments,
          diagnostics,
          'primitive'
        );
      }
      break;
    }
    case 'cylinder':
    case 'cone': {
      const kind = feature.data.primitiveKind;
      addUniqueSemanticAssignment(
        faces,
        'face',
        `primitive.${kind}.face.wall`,
        (candidate) =>
          (candidate.witness as FaceWitnessV1).surfaceType === kind,
        assignments,
        diagnostics,
        'primitive'
      );
      for (const [role, coordinate] of [
        ['start', bounds.min[2]],
        ['end', bounds.max[2]]
      ] as const) {
        addUniqueSemanticAssignment(
          faces,
          'face',
          `primitive.${kind}.face.cap.${role}`,
          (candidate) => {
            const witness = candidate.witness as FaceWitnessV1;
            return (
              witness.surfaceType === 'plane' &&
              witness.centroid?.[2] === coordinate
            );
          },
          assignments,
          diagnostics,
          'primitive'
        );
        addUniqueSemanticAssignment(
          edges,
          'edge',
          `primitive.${kind}.edge.rim.${role}`,
          (candidate) => {
            const witness = candidate.witness as EdgeWitnessV1;
            return witness.closed && witness.center[2] === coordinate;
          },
          assignments,
          diagnostics,
          'primitive'
        );
      }
      break;
    }
    case 'torus':
      addUniqueSemanticAssignment(
        faces,
        'face',
        'primitive.torus.face.shell',
        (candidate) =>
          (candidate.witness as FaceWitnessV1).surfaceType === 'torus',
        assignments,
        diagnostics,
        'primitive'
      );
      diagnostics.push(
        remusHashOnlyLineage(
          'primitive',
          'Torus seam edges are parameterization artifacts.'
        )
      );
      break;
    case 'sphere':
      diagnostics.push(
        remusHashOnlyLineage(
          'primitive',
          'Remus sphere hemispheres share the same exact witness and cannot be named one-to-one.'
        )
      );
      break;
  }

  return mergeRemusLineageStates([
    createRemusSemanticLineage(feature.featureId, 'primitive', assignments),
    ...diagnostics
  ]);
}

/**
 * A direct edit reports no output relation, so its result normally drops to
 * hash-only lineage — which is what makes every downstream reference brittle
 * under parametric edits. When the edited body is still the single solid of a
 * primitive whose semantic roles are purely geometric (a capped cylinder
 * keeps its wall/cap/rim roles across a cap offset or wall resize), those
 * roles re-identify the topology exactly, published under the ORIGINAL
 * producing feature so stored references keep matching. A role that is no
 * longer one-to-one publishes nothing (`createRemusSemanticLineage` keeps
 * that fail-closed), and a shape with no recognizable role at all stays
 * hash-only as before.
 */
export function rederivePrimitiveDirectEditLineage(
  kernel: RemusKernel,
  shape: ExactShape,
  producer: FeatureNode | undefined
): RemusLineageState | null {
  if (
    !producer ||
    producer.data.featureKind !== 'primitive' ||
    shape.solids.length !== 1
  ) {
    return null;
  }
  const lineage = buildPrimitiveLineage(kernel, shape.solids[0]!, producer);
  return lineage.faceReferences.size > 0 || lineage.edgeReferences.size > 0
    ? lineage
    : null;
}

/**
 * True when the modifier chain roots at a cylinder primitive — the one shape
 * whose fillet/chamfer result the role recognizer below can name. Anything
 * else in the producer chain (booleans, patterns, transforms with their own
 * result bodies) keeps the modifier hash-only.
 */
/**
 * The primitive kind an uninterrupted fillet/chamfer chain descends from, or
 * null when the chain crosses any other feature. Only these two primitives
 * have a modifier role vocabulary to republish.
 */
export function modifierChainRootPrimitive(
  document: ProjectDocument,
  targetBodyId: BodyId
): 'box' | 'cylinder' | null {
  const features = listFeaturesInOrder(document);
  const producerByBodyId = new Map(
    features.flatMap((feature) =>
      feature.bodyId ? [[feature.bodyId, feature] as const] : []
    )
  );
  const seen = new Set<BodyId>();
  let bodyId = targetBodyId;
  while (!seen.has(bodyId)) {
    seen.add(bodyId);
    const producer = producerByBodyId.get(bodyId);
    if (!producer) {
      return null;
    }
    if (producer.data.featureKind === 'primitive') {
      return producer.data.primitiveKind === 'cylinder' ||
        producer.data.primitiveKind === 'box'
        ? producer.data.primitiveKind
        : null;
    }
    if (
      producer.data.featureKind !== 'fillet' &&
      producer.data.featureKind !== 'chamfer'
    ) {
      return null;
    }
    bodyId = producer.data.targetBodyId;
  }
  return null;
}

export function modifierChainRootsAtCylinder(
  document: ProjectDocument,
  targetBodyId: BodyId
): boolean {
  return modifierChainRootPrimitive(document, targetBodyId) === 'cylinder';
}

const BOX_AXES = ['x', 'y', 'z'] as const;
const BOX_MODIFIER_SURFACES = new Set([
  'plane',
  'cylinder',
  'torus',
  'cone',
  'sphere'
]);

/**
 * The box counterpart of {@link rederiveCylinderModifierLineage}: a filleted
 * or chamfered box keeps six axis-aligned planar faces on its bounding box,
 * one per side, and those are the faces a dimension edit moves. Publishing
 * `modifier.box.face.<axis>-<min|max>` for them is what lets a face drag on
 * the modified body resolve back to the primitive dimension instead of
 * push-pulling the trimmed remainder and leaving a step in the blend rim.
 *
 * Blend and chamfer faces get no role here: chamfer planes are tilted off the
 * axes and blends are not planar, so neither can match a side predicate. A
 * side with no unique planar face — a fillet wide enough to consume it —
 * publishes nothing for that side; a foreign surface type returns null and
 * the body stays hash-only.
 */
export function rederiveBoxModifierLineage(
  kernel: RemusKernel,
  solid: number,
  feature: FeatureNode
): RemusLineageState | null {
  if (
    feature.data.featureKind !== 'fillet' &&
    feature.data.featureKind !== 'chamfer'
  ) {
    return null;
  }
  const operation = feature.data.featureKind;
  const faces = topologyCandidatesForSolid(kernel, solid).filter(
    (candidate) => candidate.kind === 'face'
  );
  const witnessOf = (candidate: RemusTopologyCandidate): FaceWitnessV1 =>
    candidate.witness as FaceWitnessV1;
  if (
    faces.some(
      (candidate) => !BOX_MODIFIER_SURFACES.has(witnessOf(candidate).surfaceType)
    )
  ) {
    return null;
  }
  const boundsValues = Array.from(kernel.boundingBox(solid));
  const min = quantizedPoint({
    x: boundsValues[0]!,
    y: boundsValues[1]!,
    z: boundsValues[2]!
  });
  const max = quantizedPoint({
    x: boundsValues[3]!,
    y: boundsValues[4]!,
    z: boundsValues[5]!
  });
  if (BOX_AXES.some((_axis, index) => min[index]! >= max[index]!)) {
    return null;
  }

  const assignments: RemusSemanticAssignment[] = [];
  const diagnostics: RemusLineageState[] = [];
  const sideFace = (
    candidate: RemusTopologyCandidate,
    axisIndex: number,
    bound: number
  ): boolean => {
    const witness = witnessOf(candidate);
    if (witness.surfaceType !== 'plane' || witness.analytic.kind !== 'plane') {
      return false;
    }
    // The witness normal is canonicalised (it may point either way) and
    // quantized (not unit length), so axis alignment is "only this component
    // is non-zero", and the side is read from the centroid sitting on the
    // bound rather than from the normal's sign.
    const normal = witness.analytic.normal;
    return (
      normal.every((component, index) =>
        index === axisIndex ? component !== 0 : component === 0
      ) &&
      witness.centroid !== null &&
      witness.centroid[axisIndex] === bound
    );
  };
  for (const [axisIndex, axis] of BOX_AXES.entries()) {
    for (const side of ['min', 'max'] as const) {
      const bound = side === 'min' ? min[axisIndex]! : max[axisIndex]!;
      const lineageName = `modifier.box.face.${axis}-${side}`;
      if (!faces.some((candidate) => sideFace(candidate, axisIndex, bound))) {
        continue;
      }
      addUniqueSemanticAssignment(
        faces,
        'face',
        lineageName,
        (candidate) => sideFace(candidate, axisIndex, bound),
        assignments,
        diagnostics,
        operation
      );
    }
  }
  if (assignments.length === 0) {
    return null;
  }
  return mergeRemusLineageStates([
    createRemusSemanticLineage(feature.featureId, operation, assignments),
    ...diagnostics
  ]);
}

/**
 * Fillet/chamfer results report no output relation, so they dropped to
 * hash-only lineage — which meant nothing stacked on a filleted body could
 * re-resolve across an upstream parametric edit. For a capped-cylinder chain
 * the modified topology is still fully role-recognizable: one Z-up
 * cylindrical wall, planar caps at the axial extremes, blend surfaces
 * between them, and closed circles classified by height. Republishing those
 * roles under the modifier feature keeps downstream picks resolvable. Every
 * predicate is radius-independent; a role that is not one-to-one publishes
 * nothing (fail-closed in `createRemusSemanticLineage`), a role with no
 * candidate is simply absent, and an unrecognizable shape — a tilted axis, a
 * foreign surface type, a vanished wall — returns null and stays hash-only.
 */
export function rederiveCylinderModifierLineage(
  kernel: RemusKernel,
  solid: number,
  feature: FeatureNode
): RemusLineageState | null {
  if (
    feature.data.featureKind !== 'fillet' &&
    feature.data.featureKind !== 'chamfer'
  ) {
    return null;
  }
  const operation = feature.data.featureKind;
  const candidates = topologyCandidatesForSolid(kernel, solid);
  const faces = candidates.filter((candidate) => candidate.kind === 'face');
  const edges = candidates.filter((candidate) => candidate.kind === 'edge');
  const surfaceOf = (candidate: RemusTopologyCandidate): string =>
    (candidate.witness as FaceWitnessV1).surfaceType;
  const walls = faces.filter(
    (candidate) => surfaceOf(candidate) === 'cylinder'
  );
  const knownSurfaces = new Set(['cylinder', 'plane', 'torus', 'cone']);
  const wallAnalytic = (walls[0]?.witness as FaceWitnessV1 | undefined)
    ?.analytic;
  if (
    walls.length !== 1 ||
    wallAnalytic?.kind !== 'cylinder' ||
    wallAnalytic.axis[0] !== 0 ||
    wallAnalytic.axis[1] !== 0 ||
    faces.some((candidate) => !knownSurfaces.has(surfaceOf(candidate)))
  ) {
    return null;
  }
  const boundsValues = Array.from(kernel.boundingBox(solid));
  const zMin = quantizedPoint({
    x: boundsValues[0]!,
    y: boundsValues[1]!,
    z: boundsValues[2]!
  })[2];
  const zMax = quantizedPoint({
    x: boundsValues[3]!,
    y: boundsValues[4]!,
    z: boundsValues[5]!
  })[2];
  if (zMin >= zMax) {
    return null;
  }
  const zMid = (zMin + zMax) / 2;

  const assignments: RemusSemanticAssignment[] = [];
  const diagnostics: RemusLineageState[] = [];
  const addRole = (
    kind: 'edge' | 'face',
    lineageName: string,
    predicate: (candidate: RemusTopologyCandidate) => boolean
  ) => {
    const pool = kind === 'face' ? faces : edges;
    // A role with no candidate is legitimately absent (a single-rim fillet
    // has one blend); only present-but-ambiguous roles should diagnose.
    if (!pool.some(predicate)) {
      return;
    }
    addUniqueSemanticAssignment(
      pool,
      kind,
      lineageName,
      predicate,
      assignments,
      diagnostics,
      operation
    );
  };
  const planeAtZ = (candidate: RemusTopologyCandidate, z: number): boolean => {
    const witness = candidate.witness as FaceWitnessV1;
    return witness.surfaceType === 'plane' && witness.centroid?.[2] === z;
  };
  const blendInHalf = (
    candidate: RemusTopologyCandidate,
    lower: boolean
  ): boolean => {
    const witness = candidate.witness as FaceWitnessV1;
    if (witness.surfaceType !== 'torus' && witness.surfaceType !== 'cone') {
      return false;
    }
    const z = witness.centroid?.[2];
    return z !== undefined && z !== null && (lower ? z < zMid : z >= zMid);
  };
  const circleAt = (
    candidate: RemusTopologyCandidate,
    matches: (z: number) => boolean
  ): boolean => {
    const witness = candidate.witness as EdgeWitnessV1;
    return witness.closed && matches(witness.center[2]);
  };

  addRole(
    'face',
    'modifier.cylinder.face.wall',
    (candidate) => surfaceOf(candidate) === 'cylinder'
  );
  addRole('face', 'modifier.cylinder.face.cap.start', (candidate) =>
    planeAtZ(candidate, zMin)
  );
  addRole('face', 'modifier.cylinder.face.cap.end', (candidate) =>
    planeAtZ(candidate, zMax)
  );
  addRole('face', 'modifier.cylinder.face.blend.start', (candidate) =>
    blendInHalf(candidate, true)
  );
  addRole('face', 'modifier.cylinder.face.blend.end', (candidate) =>
    blendInHalf(candidate, false)
  );
  addRole('edge', 'modifier.cylinder.edge.rim.start', (candidate) =>
    circleAt(candidate, (z) => z === zMin)
  );
  addRole('edge', 'modifier.cylinder.edge.rim.end', (candidate) =>
    circleAt(candidate, (z) => z === zMax)
  );
  addRole('edge', 'modifier.cylinder.edge.tangent.start', (candidate) =>
    circleAt(candidate, (z) => z > zMin && z < zMid)
  );
  addRole('edge', 'modifier.cylinder.edge.tangent.end', (candidate) =>
    circleAt(candidate, (z) => z >= zMid && z < zMax)
  );

  if (assignments.length === 0) {
    return null;
  }
  return mergeRemusLineageStates([
    createRemusSemanticLineage(feature.featureId, operation, assignments),
    ...diagnostics
  ]);
}

export function planeCarrier(
  normal: Vec3,
  point: Vec3
): Extract<FaceWitnessV1['analytic'], { kind: 'plane' }> | null {
  const unit = normalized(normal);
  if (!unit) {
    return null;
  }
  const canonical = canonicalDirection(unit);
  return {
    kind: 'plane',
    normal: quantizedDirectionOf(canonical)!,
    offset: quantizeCoordinate(dot(canonical, point))
  };
}

export function cylinderCarrier(
  axisPoint: Vec3,
  axisDirection: Vec3,
  radius: number
): Extract<FaceWitnessV1['analytic'], { kind: 'cylinder' }> | null {
  const unit = normalized(axisDirection);
  if (!unit) {
    return null;
  }
  const axis = canonicalDirection(unit);
  const along = dot(axisPoint, axis);
  return {
    kind: 'cylinder',
    axis: quantizedDirectionOf(axis)!,
    axisFoot: quantizedPoint(subtract(axisPoint, scale(axis, along))),
    radius: quantizeCoordinate(radius)
  };
}

export function expectedLineWitness(start: Vec3, end: Vec3): EdgeWitnessV1 {
  const endpoints = [quantizedPoint(start), quantizedPoint(end)].sort(
    (left, right) => {
      for (let index = 0; index < 3; index += 1) {
        const difference = left[index]! - right[index]!;
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    }
  ) as [QuantizedTopologyPoint, QuantizedTopologyPoint];
  return {
    curveType: 'LINE',
    length: quantizeCoordinate(
      Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z)
    ),
    closed: false,
    endpoints,
    midpoint: quantizedPoint({
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
      z: (start.z + end.z) / 2
    })
  };
}

export function expectedCircleWitness(
  center: Vec3,
  axis: Vec3,
  radius: number
): EdgeWitnessV1 {
  return {
    curveType: 'CIRCLE',
    length: quantizeCoordinate(Math.PI * 2 * radius),
    closed: true,
    center: quantizedPoint(center),
    axis: quantizedDirectionOf(axis)
  };
}

export function addFaceCarrierRole(
  candidates: readonly RemusTopologyCandidate[],
  carrier: FaceWitnessV1['analytic'] | null,
  lineageName: string,
  assignments: RemusSemanticAssignment[],
  diagnostics: RemusLineageState[]
) {
  if (!carrier) {
    diagnostics.push(
      remusHashOnlyLineage(
        'sweep',
        `Semantic role ${lineageName} has no exact analytic carrier.`
      )
    );
    return;
  }
  addUniqueSemanticAssignment(
    candidates,
    'face',
    lineageName,
    (candidate) =>
      sameAnalyticCarrier(
        (candidate.witness as FaceWitnessV1).analytic,
        carrier
      ),
    assignments,
    diagnostics,
    'sweep'
  );
}

export function addEdgeWitnessRole(
  candidates: readonly RemusTopologyCandidate[],
  witness: EdgeWitnessV1,
  lineageName: string,
  assignments: RemusSemanticAssignment[],
  diagnostics: RemusLineageState[]
) {
  addUniqueSemanticAssignment(
    candidates,
    'edge',
    lineageName,
    (candidate) => topologyWitnessesEqual('edge', candidate.witness, witness),
    assignments,
    diagnostics,
    'sweep'
  );
}

export function buildExtrudeLineage(
  kernel: RemusKernel,
  solid: number,
  feature: FeatureNode,
  objectId: string,
  data: SketchObjectData,
  basis: PlaneBasis,
  distance: number,
  scope: Record<string, number>
): RemusLineageState {
  const candidates = topologyCandidatesForSolid(kernel, solid);
  const assignments: RemusSemanticAssignment[] = [];
  const diagnostics: RemusLineageState[] = [];
  const startOrigin = basis.origin;
  const endOrigin = {
    x: basis.origin.x + basis.normal.x * distance,
    y: basis.origin.y + basis.normal.y * distance,
    z: basis.origin.z + basis.normal.z * distance
  };
  addFaceCarrierRole(
    candidates,
    planeCarrier(basis.normal, startOrigin),
    `sweep.face.cap.start.${objectId}`,
    assignments,
    diagnostics
  );
  addFaceCarrierRole(
    candidates,
    planeCarrier(basis.normal, endOrigin),
    `sweep.face.cap.end.${objectId}`,
    assignments,
    diagnostics
  );

  if (data.objectKind === 'circle') {
    const center = pointOnPlane(
      basis,
      {
        x: resolveParamValue(data.centerX, scope, 'center X'),
        y: resolveParamValue(data.centerY, scope, 'center Y')
      },
      0
    );
    const radius = resolveParamValue(data.radius, scope, 'radius');
    addFaceCarrierRole(
      candidates,
      cylinderCarrier(center, basis.normal, radius),
      `sweep.face.side.${objectId}.circle`,
      assignments,
      diagnostics
    );
    const endCenter = {
      x: center.x + basis.normal.x * distance,
      y: center.y + basis.normal.y * distance,
      z: center.z + basis.normal.z * distance
    };
    addEdgeWitnessRole(
      candidates,
      expectedCircleWitness(center, basis.normal, radius),
      `sweep.edge.cap.start.${objectId}.circle`,
      assignments,
      diagnostics
    );
    addEdgeWitnessRole(
      candidates,
      expectedCircleWitness(endCenter, basis.normal, radius),
      `sweep.edge.cap.end.${objectId}.circle`,
      assignments,
      diagnostics
    );
  } else {
    const localPoints = profilePoints(data, scope);
    const startPoints = localPoints.map((point) =>
      pointOnPlane(basis, point, 0)
    );
    const endPoints = startPoints.map((point) => ({
      x: point.x + basis.normal.x * distance,
      y: point.y + basis.normal.y * distance,
      z: point.z + basis.normal.z * distance
    }));
    const sweepDirection = scale(basis.normal, distance);
    for (let index = 0; index < startPoints.length; index += 1) {
      const next = (index + 1) % startPoints.length;
      const start = startPoints[index]!;
      const startNext = startPoints[next]!;
      const end = endPoints[index]!;
      const endNext = endPoints[next]!;
      const edgeDirection = subtract(startNext, start);
      addFaceCarrierRole(
        candidates,
        planeCarrier(cross(edgeDirection, sweepDirection), start),
        `sweep.face.side.${objectId}.${index}`,
        assignments,
        diagnostics
      );
      addEdgeWitnessRole(
        candidates,
        expectedLineWitness(start, startNext),
        `sweep.edge.cap.start.${objectId}.${index}`,
        assignments,
        diagnostics
      );
      addEdgeWitnessRole(
        candidates,
        expectedLineWitness(end, endNext),
        `sweep.edge.cap.end.${objectId}.${index}`,
        assignments,
        diagnostics
      );
      addEdgeWitnessRole(
        candidates,
        expectedLineWitness(start, end),
        `sweep.edge.side.${objectId}.vertex.${index}`,
        assignments,
        diagnostics
      );
    }
  }

  return mergeRemusLineageStates([
    createRemusSemanticLineage(feature.featureId, 'sweep', assignments),
    ...diagnostics
  ]);
}

export function buildRevolveLineage(
  kernel: RemusKernel,
  solid: number,
  feature: FeatureNode,
  objectId: string,
  data: SketchObjectData,
  basis: PlaneBasis,
  axisDirection: Vec3,
  axisPoint: Vec3,
  scope: Record<string, number>
): RemusLineageState {
  const candidates = topologyCandidatesForSolid(kernel, solid);
  const assignments: RemusSemanticAssignment[] = [];
  const diagnostics: RemusLineageState[] = [];
  if (data.objectKind === 'circle') {
    addUniqueSemanticAssignment(
      candidates,
      'face',
      `sweep.face.side.${objectId}.circle`,
      (candidate) =>
        (candidate.witness as FaceWitnessV1).surfaceType === 'torus',
      assignments,
      diagnostics,
      'sweep'
    );
  } else {
    const points = profilePoints(data, scope).map((point) =>
      pointOnPlane(basis, point, 0)
    );
    const axis = normalized(axisDirection)!;
    const axisFoot = subtract(axisPoint, scale(axis, dot(axisPoint, axis)));
    const decomposition = (point: Vec3) => {
      const fromAxisPoint = subtract(point, axisPoint);
      const along = dot(fromAxisPoint, axis);
      const center = {
        x: axisPoint.x + axis.x * along,
        y: axisPoint.y + axis.y * along,
        z: axisPoint.z + axis.z * along
      };
      const radial = subtract(point, center);
      return {
        along,
        center,
        radial,
        radius: Math.hypot(radial.x, radial.y, radial.z)
      };
    };
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]!;
      const next = points[(index + 1) % points.length]!;
      const a = decomposition(current);
      const b = decomposition(next);
      const sameRadial =
        samePoint(quantizedPoint(a.radial), quantizedPoint(b.radial)) &&
        quantizeCoordinate(a.radius) > 0;
      const sameAlong =
        quantizeCoordinate(a.along) === quantizeCoordinate(b.along);
      const carrier = sameRadial
        ? cylinderCarrier(axisFoot, axis, a.radius)
        : sameAlong
          ? planeCarrier(axis, a.center)
          : null;
      addFaceCarrierRole(
        candidates,
        carrier,
        `sweep.face.side.${objectId}.${index}`,
        assignments,
        diagnostics
      );
      if (quantizeCoordinate(a.radius) > 0) {
        addEdgeWitnessRole(
          candidates,
          expectedCircleWitness(a.center, axis, a.radius),
          `sweep.edge.profile.${objectId}.vertex.${index}`,
          assignments,
          diagnostics
        );
      }
    }
  }
  return mergeRemusLineageStates([
    createRemusSemanticLineage(feature.featureId, 'sweep', assignments),
    ...diagnostics
  ]);
}
