import type { RemusKernel } from './remus-runtime';
import { resolveParamValue } from '@openzcad/document-core';
import { type Vec3 } from '@openzcad/geometry';
import {
  type DirectEditOperation,
  type FaceGeometry,
  type FaceTopologyReferenceV5,
  type FeatureId
} from '@openzcad/shared';
import type { DxfFaceSelector, ExactShape } from './exact-types';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import {
  classifyThroughHoleFace,
  measureFaceGeometry,
  requireBlendRegion,
  requireThroughHole
} from './exact-measure';
import {
  coaxialCylinderRadii,
  cylinderAlongAxis,
  drillHole,
  fillThroughHole,
  tryExactAnalyticCylinderCapOffset
} from './exact-cylinder-ops';
import { recognizeImportedFeatureOnSolid } from './imported-feature-query';
import type {
  BlindCylindricalHoleProof,
  CounterboreProof,
  CountersinkProof,
  ImportedFeatureProof
} from './imported-feature-recognition';
import { collapseShape } from './exact-boolean-helpers';
import { assertDirectEditOperation } from './exact-direct-edit-guards';
import { faceHandlesByFingerprint, faceWitnessOf } from './exact-witnesses';
import {
  DIRECT_EDIT_TOLERANCE,
  GEOMETRY_EPSILON,
  dot,
  length,
  normalized,
  subtract
} from './exact-math';
import {
  censusOfSolids,
  directEditFacetFallbackWarning
} from './boolean-result-validation';
import {
  ambiguousReferenceError,
  unresolvedReferenceError
} from './topology-fingerprint';
import {
  createRemusSemanticLineage,
  propagateRemusUnchangedDirectEditLineage,
  type RemusLineageState
} from './remus-lineage';
import {
  importedStepLineageName,
  resolveTopologyReference,
  topologyHashOfWitness,
  type TopologyResolutionCandidate
} from './topology-lineage';
import {
  measuredOpposingPlanarFacePair,
  rebuildFaceDistance
} from './exact-face-distance';

/** Resolves a fingerprint to exactly one face handle, failing closed. */
/**
 * Reference-first per ADR-013, exactly like fillet/chamfer edges: a stored
 * face hash embeds radius-dependent measurements (a cap's perimeter, a
 * wall's radius), so only the lineage identity survives an upstream
 * parametric edit. Operations saved without a v5 reference keep the hash
 * resolver and its diagnostics byte-for-byte; a v5 lineage failure is
 * terminal rather than falling back, so a stale reference can never land
 * silently on a neighbouring face.
 */
export function resolveDirectEditFace(
  kernel: RemusKernel,
  target: ExactShape,
  solid: number,
  operation: Pick<DxfFaceSelector, 'faceHash' | 'faceReference'>
): { face: number; viaLineage: boolean } {
  const reference = operation.faceReference;
  const lineage = target.solids.length === 1 ? target.lineage : undefined;
  if (!reference || !lineage) {
    return {
      face: resolveFaceByFingerprint(kernel, solid, operation.faceHash),
      viaLineage: false
    };
  }
  const candidates: TopologyResolutionCandidate[] = Array.from(
    kernel.getSolidFaces(solid),
    (handle) => {
      const witness = faceWitnessOf(kernel, handle);
      const lineageReference = lineage.faceReferences.get(handle);
      return {
        kind: 'face' as const,
        currentHash: topologyHashOfWitness('face', witness),
        witnessVersion: 1 as const,
        witness,
        ...(lineageReference
          ? {
              lineage: {
                source: 'semantic' as const,
                identity: {
                  producingFeatureId: lineageReference.producingFeatureId,
                  lineageName: lineageReference.lineageName
                }
              }
            }
          : {}),
        value: handle
      };
    }
  );
  const resolution = resolveTopologyReference(reference, candidates);
  if (resolution.status === 'failed') {
    throw new Error(`Direct-edit face is stale: ${resolution.message}`);
  }
  if (typeof resolution.candidate.value !== 'number') {
    throw new Error(
      'The selected face could not be found on the rebuilt body.'
    );
  }
  return { face: resolution.candidate.value, viaLineage: true };
}

export function resolveFaceByFingerprint(
  kernel: RemusKernel,
  solid: number,
  faceHash: number
): number {
  const matches = faceHandlesByFingerprint(kernel, solid).get(faceHash) ?? [];
  if (matches.length === 0) {
    throw unresolvedReferenceError(
      'face',
      faceHash,
      Array.from(kernel.getSolidFaces(solid)).length
    );
  }
  if (matches.length > 1) {
    throw ambiguousReferenceError('face');
  }
  return matches[0]!;
}

/**
 * Replace a through-hole's bore with one at the requested diameter.
 *
 * OpenCascade plugs the bore and then cuts the new one through the closed
 * body. That is `(body ∪ bore) \ newBore`, and because the bore is void in
 * `body` and the extension past each end sits outside it, the same set is
 * reached with a single boolean: cutting the new bore straight through when
 * it is wider, or fusing the annulus between the two radii when it is
 * narrower. Both forms are exact and produce identical volumes — see the
 * cross-kernel agreement test — but the single boolean skips the plug fuse,
 * which Remus frequently declines to do analytically. The extension past
 * both ends is OpenCascade's, so a hole through a slanted opening is trimmed
 * identically on either kernel.
 */
export function resizeThroughHole(
  kernel: RemusKernel,
  solid: number,
  face: number,
  operation: Extract<DirectEditOperation, { kind: 'resize-through-hole' }>,
  scope: Record<string, number>
): { solid: number; changed: boolean } {
  const geometry = requireThroughHole(
    kernel,
    solid,
    face,
    operation.sourceDiameter,
    operation.sourceAxisStart,
    operation.sourceAxisEnd
  );
  const diameter = resolveParamValue(
    operation.diameter,
    scope,
    'through-hole diameter'
  );
  if (!Number.isFinite(diameter) || diameter <= DIRECT_EDIT_TOLERANCE) {
    throw new Error('Through-hole diameter must be greater than zero.');
  }
  const radius = diameter / 2;
  const radiusTolerance = Math.max(
    DIRECT_EDIT_TOLERANCE,
    geometry.radius * 1e-6
  );
  if (Math.abs(radius - geometry.radius) <= radiusTolerance) {
    if (operation.parameterBinding) {
      return { solid, changed: false };
    }
    throw new Error(
      'Through-hole diameter must differ from its current diameter.'
    );
  }
  const extension = Math.max(
    DIRECT_EDIT_TOLERANCE * 10,
    geometry.axialLength * 0.02,
    diameter * 0.01
  );
  const newBore = cylinderAlongAxis(
    kernel,
    geometry.axisStart,
    geometry.axisEnd,
    radius,
    extension
  );
  let output: number;
  try {
    output =
      radius > geometry.radius
        ? kernel.cut(solid, newBore)
        : kernel.fuse(
            solid,
            kernel.cut(
              cylinderAlongAxis(
                kernel,
                geometry.axisStart,
                geometry.axisEnd,
                geometry.radius
              ),
              newBore
            )
          );
  } catch (error) {
    throw new Error(
      `Through-hole diameter ${diameter} does not fit this body: ${
        error instanceof Error ? error.message : 'the kernel rejected the cut'
      }.`,
      { cause: error }
    );
  }
  kernel.unifyFaces(output);
  if (kernel.validateSolid(output) !== 0) {
    throw new Error(
      `Resizing the through-hole to diameter ${diameter} does not produce a valid solid.`
    );
  }
  // The kernel can clear its own gates and still hand back a degraded
  // result: a boolean that meets a coaxial cylindrical face may return the
  // untouched original, and the mesh fallback encloses the right space with
  // a wall of triangles instead of a cylinder. Read the bore back and insist
  // it is an analytic cylinder at the new radius, so either failure surfaces
  // as a failed feature rather than a gesture that looked like it worked.
  const axis = normalized(subtract(geometry.axisEnd, geometry.axisStart));
  if (!axis) {
    throw new Error('The selected face has a degenerate axis.');
  }
  const axisTolerance = Math.max(
    DIRECT_EDIT_TOLERANCE,
    geometry.axialLength * 1e-5,
    geometry.radius * 1e-5
  );
  const coaxialRadii = coaxialCylinderRadii(
    kernel,
    output,
    geometry.axisStart,
    axis,
    axisTolerance
  );
  const atRadius = (candidate: number): boolean =>
    coaxialRadii.some(
      (measured) => Math.abs(measured - candidate) <= radiusTolerance
    );
  if (!atRadius(radius)) {
    throw new Error(
      atRadius(geometry.radius)
        ? `The hole kept its original diameter instead of resizing to Ø${diameter}.`
        : `The hole could not be resized to Ø${diameter} exactly; its wall would become an approximation.`
    );
  }
  return { solid: output, changed: true };
}

type ImportedBlindHoleOperation = Extract<
  DirectEditOperation,
  { kind: 'resize-imported-blind-hole' }
>;
type ImportedCounterboreOperation = Extract<
  DirectEditOperation,
  { kind: 'resize-imported-counterbore' }
>;
type ImportedCountersinkOperation = Extract<
  DirectEditOperation,
  { kind: 'resize-imported-countersink' }
>;
type ImportedHoleOperation =
  | ImportedBlindHoleOperation
  | ImportedCounterboreOperation
  | ImportedCountersinkOperation;

function importedProofTolerance(...dimensions: number[]): number {
  return Math.max(
    DIRECT_EDIT_TOLERANCE,
    ...dimensions.map((dimension) => Math.abs(dimension) * 1e-6)
  );
}

function requireImportedProofKind<K extends ImportedFeatureProof['kind']>(
  kernel: RemusKernel,
  solid: number,
  face: number,
  kind: K
): Extract<ImportedFeatureProof, { kind: K }> {
  const recognition = recognizeImportedFeatureOnSolid(kernel, solid, face);
  if (recognition.status !== 'recognized' || recognition.proof.kind !== kind) {
    throw new Error(
      recognition.status === 'unsupported'
        ? `The imported feature can no longer be proved: ${recognition.message}`
        : `The selected face now proves a ${recognition.proof.kind}, not a ${kind}.`
    );
  }
  return recognition.proof as Extract<ImportedFeatureProof, { kind: K }>;
}

function requireImportedHoleFrame(
  openingPoint: Vec3,
  directionIntoBody: Vec3,
  sourceOpeningPoint: Vec3,
  sourceAxisDirection: Vec3,
  tolerance: number
): void {
  if (length(subtract(openingPoint, sourceOpeningPoint)) > tolerance) {
    throw new Error(
      'The imported hole no longer matches its recorded opening point.'
    );
  }
  const sourceDirection = normalized(sourceAxisDirection);
  const rebuiltDirection = normalized(directionIntoBody);
  if (
    !sourceDirection ||
    !rebuiltDirection ||
    dot(sourceDirection, rebuiltDirection) < 1 - 1e-6
  ) {
    throw new Error('The imported hole no longer matches its recorded axis.');
  }
}

function requireRecordedDimension(
  actual: number,
  expected: number,
  label: string,
  tolerance: number
): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `The imported hole no longer matches its recorded ${label}.`
    );
  }
}

export function requireImportedBlindHole(
  kernel: RemusKernel,
  solid: number,
  face: number,
  operation: ImportedBlindHoleOperation
): BlindCylindricalHoleProof {
  const proof = requireImportedProofKind(
    kernel,
    solid,
    face,
    'blind-cylindrical-hole'
  );
  const tolerance = importedProofTolerance(
    operation.sourceDiameter,
    operation.sourceDepth
  );
  requireImportedHoleFrame(
    {
      x: proof.openingPoint[0],
      y: proof.openingPoint[1],
      z: proof.openingPoint[2]
    },
    {
      x: proof.directionIntoBody[0],
      y: proof.directionIntoBody[1],
      z: proof.directionIntoBody[2]
    },
    operation.sourceOpeningPoint,
    operation.sourceAxisDirection,
    tolerance
  );
  requireRecordedDimension(
    proof.diameter,
    operation.sourceDiameter,
    'diameter',
    tolerance
  );
  requireRecordedDimension(
    proof.depth,
    operation.sourceDepth,
    'depth',
    tolerance
  );
  return proof;
}

export function requireImportedCounterbore(
  kernel: RemusKernel,
  solid: number,
  face: number,
  operation: ImportedCounterboreOperation
): CounterboreProof {
  const proof = requireImportedProofKind(kernel, solid, face, 'counterbore');
  const tolerance = importedProofTolerance(
    operation.sourceBoreDiameter,
    operation.sourceCounterboreDiameter,
    operation.sourceCounterboreDepth,
    operation.sourceTotalDepth
  );
  requireImportedHoleFrame(
    {
      x: proof.openingPoint[0],
      y: proof.openingPoint[1],
      z: proof.openingPoint[2]
    },
    {
      x: proof.directionIntoBody[0],
      y: proof.directionIntoBody[1],
      z: proof.directionIntoBody[2]
    },
    operation.sourceOpeningPoint,
    operation.sourceAxisDirection,
    tolerance
  );
  requireRecordedDimension(
    proof.innerDiameter,
    operation.sourceBoreDiameter,
    'bore diameter',
    tolerance
  );
  requireRecordedDimension(
    proof.outerDiameter,
    operation.sourceCounterboreDiameter,
    'counterbore diameter',
    tolerance
  );
  requireRecordedDimension(
    proof.counterboreDepth,
    operation.sourceCounterboreDepth,
    'counterbore depth',
    tolerance
  );
  requireRecordedDimension(
    proof.totalDepth,
    operation.sourceTotalDepth,
    'total depth',
    tolerance
  );
  if (
    (proof.entryChamferFaceId !== undefined) !==
    operation.sourceEntryChamfered
  ) {
    throw new Error(
      'The imported counterbore no longer matches its recorded entry chamfer.'
    );
  }
  return proof;
}

export function requireImportedCountersink(
  kernel: RemusKernel,
  solid: number,
  face: number,
  operation: ImportedCountersinkOperation
): CountersinkProof {
  const proof = requireImportedProofKind(kernel, solid, face, 'countersink');
  const tolerance = importedProofTolerance(
    operation.sourceBoreDiameter,
    operation.sourceSinkDiameter,
    operation.sourceCountersinkDepth,
    operation.sourceTotalDepth
  );
  requireImportedHoleFrame(
    {
      x: proof.openingPoint[0],
      y: proof.openingPoint[1],
      z: proof.openingPoint[2]
    },
    {
      x: proof.directionIntoBody[0],
      y: proof.directionIntoBody[1],
      z: proof.directionIntoBody[2]
    },
    operation.sourceOpeningPoint,
    operation.sourceAxisDirection,
    tolerance
  );
  requireRecordedDimension(
    proof.holeDiameter,
    operation.sourceBoreDiameter,
    'bore diameter',
    tolerance
  );
  requireRecordedDimension(
    proof.openingDiameter,
    operation.sourceSinkDiameter,
    'sink diameter',
    tolerance
  );
  requireRecordedDimension(
    proof.angleRadians,
    operation.sourceAngleRadians,
    'included angle',
    Math.max(1e-10, Math.abs(operation.sourceAngleRadians) * 1e-9)
  );
  requireRecordedDimension(
    proof.countersinkDepth,
    operation.sourceCountersinkDepth,
    'countersink depth',
    tolerance
  );
  requireRecordedDimension(
    proof.totalDepth,
    operation.sourceTotalDepth,
    'total depth',
    tolerance
  );
  return proof;
}

function fillImportedHole(
  kernel: RemusKernel,
  solid: number,
  openingPoint: Vec3,
  axisDirection: Vec3,
  totalDepth: number,
  maximumRadius: number
): number {
  const end = {
    x: openingPoint.x + axisDirection.x * totalDepth,
    y: openingPoint.y + axisDirection.y * totalDepth,
    z: openingPoint.z + axisDirection.z * totalDepth
  };
  const facesBefore = kernel.getSolidFaces(solid).length;
  let filled: number;
  try {
    filled = kernel.fuse(
      solid,
      cylinderAlongAxis(kernel, openingPoint, end, maximumRadius)
    );
  } catch (error) {
    throw new Error(
      `Filling the imported hole before resizing failed: ${
        error instanceof Error ? error.message : 'the kernel rejected the fuse'
      }.`,
      { cause: error }
    );
  }
  kernel.unifyFaces(filled);
  if (kernel.validateSolid(filled) !== 0) {
    throw new Error(
      'Filling the imported hole before resizing did not produce a valid solid.'
    );
  }
  if (kernel.getSolidFaces(filled).length >= facesBefore) {
    throw new Error(
      'This imported hole cannot be resized exactly: filling it would need an approximate operation.'
    );
  }
  return filled;
}

function positiveImportedDimension(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= GEOMETRY_EPSILON) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return value;
}

function applyImportedHoleEdit(
  kernel: RemusKernel,
  solid: number,
  face: number,
  operation: ImportedHoleOperation,
  scope: Record<string, number>
): { solid: number; changed: boolean } {
  if (operation.kind === 'resize-imported-blind-hole') {
    const proof = requireImportedBlindHole(kernel, solid, face, operation);
    const diameter = positiveImportedDimension(
      resolveParamValue(
        operation.diameter,
        scope,
        'imported blind-hole diameter'
      ),
      'Imported blind-hole diameter'
    );
    const depth = positiveImportedDimension(
      resolveParamValue(operation.depth, scope, 'imported blind-hole depth'),
      'Imported blind-hole depth'
    );
    const tolerance = importedProofTolerance(proof.diameter, proof.depth);
    if (Math.abs(depth - proof.depth) > tolerance) {
      throw new Error(
        'Changing an imported blind-hole depth is not yet supported; its diameter can be edited.'
      );
    }
    if (Math.abs(diameter - proof.diameter) <= tolerance) {
      if (operation.parameterBinding) {
        return { solid, changed: false };
      }
      throw new Error(
        'Imported blind-hole diameter must differ from its current diameter.'
      );
    }
    const filled = fillImportedHole(
      kernel,
      solid,
      operation.sourceOpeningPoint,
      operation.sourceAxisDirection,
      proof.depth,
      proof.diameter / 2
    );
    return {
      solid: drillHole(kernel, filled, {
        surfacePoint: operation.sourceOpeningPoint,
        axis: operation.sourceAxisDirection,
        radius: diameter / 2,
        depth: proof.depth,
        style: 'simple',
        entryExtension: Math.max(
          DIRECT_EDIT_TOLERANCE * 10,
          proof.depth * 0.02,
          diameter * 0.01
        ),
        exitExtension: 0
      }),
      changed: true
    };
  }

  if (operation.kind === 'resize-imported-counterbore') {
    const proof = requireImportedCounterbore(kernel, solid, face, operation);
    const boreDiameter = positiveImportedDimension(
      resolveParamValue(
        operation.boreDiameter,
        scope,
        'imported counterbore bore diameter'
      ),
      'Imported counterbore bore diameter'
    );
    const counterboreDiameter = positiveImportedDimension(
      resolveParamValue(
        operation.counterboreDiameter,
        scope,
        'imported counterbore diameter'
      ),
      'Imported counterbore diameter'
    );
    const counterboreDepth = positiveImportedDimension(
      resolveParamValue(
        operation.counterboreDepth,
        scope,
        'imported counterbore depth'
      ),
      'Imported counterbore depth'
    );
    if (!(counterboreDiameter > boreDiameter)) {
      throw new Error(
        'Imported counterbore diameter must be larger than its bore diameter.'
      );
    }
    const tolerance = importedProofTolerance(
      proof.innerDiameter,
      proof.outerDiameter,
      proof.counterboreDepth
    );
    if (Math.abs(counterboreDepth - proof.counterboreDepth) > tolerance) {
      throw new Error(
        'Changing an imported counterbore depth is not yet supported; its bore and counterbore diameters can be edited.'
      );
    }
    if (
      Math.abs(boreDiameter - proof.innerDiameter) <= tolerance &&
      Math.abs(counterboreDiameter - proof.outerDiameter) <= tolerance
    ) {
      if (operation.parameterBinding) {
        return { solid, changed: false };
      }
      throw new Error('Imported counterbore dimensions must change.');
    }
    if (proof.entryChamferFaceId !== undefined) {
      throw new Error(
        'Changing diameters on an imported counterbore with a chamfered entry is not yet supported; its grouped parameter binding remains geometry-preserving.'
      );
    }
    const filled = fillImportedHole(
      kernel,
      solid,
      operation.sourceOpeningPoint,
      operation.sourceAxisDirection,
      proof.totalDepth,
      proof.outerDiameter / 2
    );
    return {
      solid: drillHole(kernel, filled, {
        surfacePoint: operation.sourceOpeningPoint,
        axis: operation.sourceAxisDirection,
        radius: boreDiameter / 2,
        depth: proof.totalDepth,
        style: 'counterbore',
        counterboreRadius: counterboreDiameter / 2,
        counterboreDepth: proof.counterboreDepth,
        entryExtension: Math.max(
          DIRECT_EDIT_TOLERANCE * 10,
          proof.totalDepth * 0.02,
          counterboreDiameter * 0.01
        ),
        exitExtension: 0
      }),
      changed: true
    };
  }

  const proof = requireImportedCountersink(kernel, solid, face, operation);
  const boreDiameter = positiveImportedDimension(
    resolveParamValue(
      operation.boreDiameter,
      scope,
      'imported countersink bore diameter'
    ),
    'Imported countersink bore diameter'
  );
  const sinkDiameter = positiveImportedDimension(
    resolveParamValue(
      operation.sinkDiameter,
      scope,
      'imported countersink diameter'
    ),
    'Imported countersink diameter'
  );
  const angleRadians = resolveParamValue(
    operation.angleRadians,
    scope,
    'imported countersink included angle'
  );
  if (!(sinkDiameter > boreDiameter)) {
    throw new Error(
      'Imported countersink diameter must be larger than its bore diameter.'
    );
  }
  if (!(angleRadians > 0 && angleRadians < Math.PI)) {
    throw new Error(
      'Imported countersink included angle must be strictly between 0 and pi radians.'
    );
  }
  const tolerance = importedProofTolerance(
    proof.holeDiameter,
    proof.openingDiameter,
    proof.countersinkDepth
  );
  if (
    Math.abs(angleRadians - proof.angleRadians) >
    Math.max(1e-10, proof.angleRadians * 1e-9)
  ) {
    throw new Error(
      'Changing an imported countersink angle is not yet supported; its bore and sink diameters can be edited.'
    );
  }
  if (
    Math.abs(boreDiameter - proof.holeDiameter) <= tolerance &&
    Math.abs(sinkDiameter - proof.openingDiameter) <= tolerance
  ) {
    if (operation.parameterBinding) {
      return { solid, changed: false };
    }
    throw new Error('Imported countersink dimensions must change.');
  }
  const filled = fillImportedHole(
    kernel,
    solid,
    operation.sourceOpeningPoint,
    operation.sourceAxisDirection,
    proof.totalDepth,
    proof.openingDiameter / 2
  );
  return {
    solid: drillHole(kernel, filled, {
      surfacePoint: operation.sourceOpeningPoint,
      axis: operation.sourceAxisDirection,
      radius: boreDiameter / 2,
      depth: proof.totalDepth,
      style: 'countersink',
      countersinkRadius: sinkDiameter / 2,
      countersinkAngle: proof.angleRadians,
      entryExtension: Math.max(
        DIRECT_EDIT_TOLERANCE * 10,
        proof.totalDepth * 0.02,
        sinkDiameter * 0.01
      ),
      exitExtension: 0
    }),
    changed: true
  };
}

/**
 * Remove the feature the selected face belongs to.
 *
 * A through-hole is closed by fusing a plug of its own radius, exactly as
 * OpenCascade does. Anything else goes to Remus's `defeature`, which
 * rebuilds the body from the planes of the faces it keeps and therefore
 * only accepts a body whose every remaining face is planar. That
 * precondition is checked before the call so an unsupported selection is
 * named rather than silently reassembled, and the reassembly itself is held
 * to strict solid validation because its failure mode is a closed-looking
 * body with the wrong walls.
 */
export function removeFaceFeature(
  kernel: RemusKernel,
  solid: number,
  face: number,
  geometry: FaceGeometry | undefined,
  operation: Extract<DirectEditOperation, { kind: 'remove-face-feature' }>
): number {
  if (geometry?.surfaceType !== operation.sourceSurfaceType) {
    throw new Error('Selected face no longer matches its recorded surface.');
  }
  // Face area comes from Remus's bounded-deflection integration rather
  // than an exact surface integral, so it is compared at the same relative
  // tolerance the planar offset uses. The centre is a vertex centroid and
  // is exact, so it keeps the direct-edit tolerance.
  const areaTolerance = Math.max(operation.sourceArea * 1e-5, 1e-9);
  const centerTolerance = Math.max(
    DIRECT_EDIT_TOLERANCE,
    Math.sqrt(Math.max(operation.sourceArea, 1)) * 1e-6
  );
  if (
    Math.abs(geometry.area - operation.sourceArea) > areaTolerance ||
    length(subtract(geometry.center, operation.sourceCenter)) > centerTolerance
  ) {
    throw new Error('Selected face no longer matches its recorded geometry.');
  }

  const isThroughHole =
    classifyThroughHoleFace(kernel, solid, face, geometry).status ===
    'through-hole';
  if (isThroughHole) {
    return fillThroughHole(
      kernel,
      solid,
      requireThroughHole(
        kernel,
        solid,
        face,
        operation.sourceDiameter,
        operation.sourceAxisStart,
        operation.sourceAxisEnd
      )
    );
  }

  const keptFaces = Array.from(kernel.getSolidFaces(solid)).filter(
    (handle) => handle !== face
  );
  const nonPlanar = new Set(
    keptFaces
      .map((handle) => kernel.getSurfaceType(handle))
      .filter((surfaceType) => surfaceType !== 'plane')
  );
  if (nonPlanar.size > 0) {
    throw new Error(
      `Removing a ${geometry.surfaceType} face needs Remus's defeature operation, which only supports bodies whose every remaining face is planar; this body still has ${[...nonPlanar].sort().join(', ')} faces.`
    );
  }
  if (keptFaces.length < 4) {
    throw new Error(
      'Removing the selected face would leave too few faces to bound a solid.'
    );
  }
  let output: number;
  try {
    output = kernel.defeature(solid, Uint32Array.from([face]));
  } catch (error) {
    throw new Error(
      `Removing the selected face failed: ${
        error instanceof Error
          ? error.message
          : 'the kernel rejected the defeature'
      }.`,
      { cause: error }
    );
  }
  kernel.unifyFaces(output);
  if (kernel.validateSolid(output) !== 0) {
    throw new Error(
      'Removing the selected face did not produce a valid solid.'
    );
  }
  return output;
}

function resolveFaceDistanceEndpoint(
  kernel: RemusKernel,
  target: ExactShape,
  solid: number,
  faceHash: number,
  faceReference: FaceTopologyReferenceV5 | undefined
): number {
  try {
    return resolveDirectEditFace(kernel, target, solid, {
      faceHash,
      faceReference
    }).face;
  } catch (error) {
    const followsFaceDistanceMove = target.lineage?.diagnostics.some(
      (diagnostic) => diagnostic.operation === 'direct-edit'
    );
    const analytic = faceReference?.witness.analytic;
    const canonicalImportedReference =
      faceReference?.lineageName ===
      importedStepLineageName('face', faceReference?.currentHash ?? -1);
    if (
      !followsFaceDistanceMove ||
      !canonicalImportedReference ||
      analytic?.kind !== 'plane'
    ) {
      throw error;
    }
    const matches = Array.from(kernel.getSolidFaces(solid)).filter((face) => {
      const candidate = faceWitnessOf(kernel, face).analytic;
      return (
        candidate.kind === 'plane' &&
        candidate.offset === analytic.offset &&
        candidate.normal[0] === analytic.normal[0] &&
        candidate.normal[1] === analytic.normal[1] &&
        candidate.normal[2] === analytic.normal[2]
      );
    });
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'Direct-edit face is stale: its exact planar carrier no longer exists after an upstream face-distance edit.'
          : 'Direct-edit face is stale: its exact planar carrier is ambiguous after an upstream face-distance edit.',
        { cause: error }
      );
    }
    return matches[0]!;
  }
}

function setFaceDistance(
  kernel: RemusKernel,
  target: ExactShape,
  solid: number,
  face: number,
  operation: Extract<DirectEditOperation, { kind: 'set-face-distance' }>,
  scope: Record<string, number>
): ExactShape {
  const oppositeFace = resolveFaceDistanceEndpoint(
    kernel,
    target,
    solid,
    operation.oppositeFaceHash,
    operation.oppositeFaceReference
  );
  if (oppositeFace === face) {
    throw new Error('A face-distance edit requires two distinct faces.');
  }
  const proof = measuredOpposingPlanarFacePair(
    kernel,
    solid,
    face,
    oppositeFace
  );
  const sourceTolerance = Math.max(
    DIRECT_EDIT_TOLERANCE,
    operation.sourceDistance * 1e-6
  );
  if (Math.abs(proof.distance - operation.sourceDistance) > sourceTolerance) {
    throw new Error(
      'The selected face pair no longer matches its recorded source distance.'
    );
  }
  const distance = resolveParamValue(
    operation.distance,
    scope,
    'face distance'
  );
  if (!Number.isFinite(distance) || distance <= DIRECT_EDIT_TOLERANCE) {
    throw new Error('Face distance must be greater than zero.');
  }
  if (Math.abs(distance - proof.distance) <= sourceTolerance) {
    if (operation.parameterBinding) {
      return target;
    }
    throw new Error('Face distance must differ from its current distance.');
  }
  const output = rebuildFaceDistance(
    kernel,
    solid,
    proof,
    operation.moveMode,
    distance
  );
  const lineage = propagateRemusUnchangedDirectEditLineage(
    target.lineage,
    topologyCandidatesForSolid(kernel, output)
  );
  return { solids: [output], ...(lineage ? { lineage } : {}) };
}

/**
 * History-backed direct edits on the Remus path. Planar offsets and
 * cylindrical resizes are the kernel's own `pushPullFace` and
 * `resizeCylindricalFace`; through-hole resizes and feature removals build
 * their own tools from the selected face's analytic geometry. Each derives
 * its tool from the selected face, merges the seams the boolean leaves
 * behind, and refuses any result whose shell is not closed or whose surfaces
 * are not the ones the edit is defined to produce. Every source measurement
 * is re-validated against the rebuilt body first, so a drifted rebuild fails
 * closed instead of editing the wrong face.
 */
export function applyDirectEdit(
  kernel: RemusKernel,
  target: ExactShape,
  operation: DirectEditOperation,
  scope: Record<string, number>,
  producingFeatureId?: FeatureId
): ExactShape {
  assertDirectEditOperation(operation);
  const solid = collapseShape(kernel, target);
  const resolved =
    operation.kind === 'set-face-distance'
      ? {
          face: resolveFaceDistanceEndpoint(
            kernel,
            target,
            solid,
            operation.faceHash,
            operation.faceReference
          ),
          viaLineage: false
        }
      : resolveDirectEditFace(kernel, target, solid, operation);
  const { face, viaLineage } = resolved;
  if (operation.kind === 'resize-through-hole') {
    const resized = resizeThroughHole(kernel, solid, face, operation, scope);
    // Keeping only the same solid handle would still discard the imported
    // semantic face map and make the next no-op binding stale.
    return resized.changed ? { solids: [resized.solid] } : target;
  }
  if (
    operation.kind === 'resize-imported-blind-hole' ||
    operation.kind === 'resize-imported-counterbore' ||
    operation.kind === 'resize-imported-countersink'
  ) {
    const resized = applyImportedHoleEdit(
      kernel,
      solid,
      face,
      operation,
      scope
    );
    return resized.changed ? { solids: [resized.solid] } : target;
  }
  if (operation.kind === 'set-face-distance') {
    return setFaceDistance(kernel, target, solid, face, operation, scope);
  }

  const geometry = measureFaceGeometry(kernel, face);

  if (operation.kind === 'remove-face-feature') {
    return {
      solids: [removeFaceFeature(kernel, solid, face, geometry, operation)]
    };
  }

  if (operation.kind === 'offset-face') {
    if (geometry?.surfaceType !== 'plane' || !geometry.normal) {
      throw new Error('The selected face is no longer planar.');
    }
    // The recorded-area pin proves a hash-resolved face is really the one
    // the user picked. A cap's area scales with the primitive radius, so
    // under a lineage-resolved face — where identity is already proven by
    // role — the pin would only forbid the parametric edits this operation
    // is defined to survive.
    const areaTolerance = Math.max(operation.sourceArea * 1e-5, 1e-9);
    if (
      !viaLineage &&
      Math.abs(geometry.area - operation.sourceArea) > areaTolerance
    ) {
      throw new Error(
        'The selected face no longer matches its recorded measurements.'
      );
    }
    const alignment =
      geometry.normal.x * operation.sourceNormal.x +
      geometry.normal.y * operation.sourceNormal.y +
      geometry.normal.z * operation.sourceNormal.z;
    if (Math.abs(alignment) < 1 - 1e-6) {
      throw new Error(
        'The selected face no longer matches its recorded orientation.'
      );
    }
    const offset = resolveParamValue(operation.offset, scope, 'offset');
    if (!Number.isFinite(offset) || Math.abs(offset) <= GEOMETRY_EPSILON) {
      throw new Error('Face offset must be a non-zero distance.');
    }
    // `pushPullFace` walks the face along the solid's own outward normal,
    // which is the direction the stored normal holds too — it came from the
    // picked triangle, not from the surface parameterization, so the sign
    // carries through unchanged even where the two disagree. A prismatic
    // move is worth exactly `offset * area`, and the kernel gates the result
    // on that, so a tool that reached material it should not have is
    // rejected rather than returned.
    const sourceCensus = censusOfSolids(kernel, [solid]);
    const output =
      tryExactAnalyticCylinderCapOffset(kernel, solid, face, offset) ??
      kernel.pushPullFace(solid, face, offset);
    if (kernel.validateSolidRelaxed(output) !== 0) {
      throw new Error(
        `Offsetting the face by ${offset} does not produce a valid solid.`
      );
    }
    // Closure and volume checks still accept Remus's triangulated fallback.
    // Preserve the last exact body instead of committing/exporting its facets.
    const facetFallback = directEditFacetFallbackWarning({
      operands: sourceCensus,
      result: censusOfSolids(kernel, [output])
    });
    if (facetFallback) {
      throw new Error(facetFallback);
    }
    return { solids: [output] };
  }

  if (operation.kind === 'resize-blend') {
    const snapshot = requireBlendRegion(
      kernel,
      solid,
      face,
      operation.recordedRadius
    );
    if (snapshot.surfaceClass !== operation.surfaceClass) {
      throw new Error(
        `The selected face is no longer an analytic ${operation.surfaceClass} blend.`
      );
    }
    const radiusTolerance = Math.max(operation.recordedRadius * 1e-5, 1e-9);
    const carrierTolerance = Math.max(operation.recordedRadius * 1e-5, 1e-6);
    if (
      length(subtract(snapshot.center, operation.recordedCenter)) >
      carrierTolerance
    ) {
      throw new Error(
        'The selected blend no longer matches its recorded carrier center.'
      );
    }
    const recordedAxis = normalized(operation.recordedAxis);
    if (
      !recordedAxis ||
      Math.abs(dot(snapshot.axis, recordedAxis)) < 1 - 1e-6
    ) {
      throw new Error(
        'The selected blend no longer matches its recorded carrier axis.'
      );
    }
    const newRadius = resolveParamValue(
      operation.newRadius,
      scope,
      'blend radius'
    );
    if (!Number.isFinite(newRadius) || newRadius < 0) {
      throw new Error('Blend radius must be zero or greater.');
    }
    if (Math.abs(newRadius - snapshot.radius) <= radiusTolerance) {
      if (operation.parameterBinding) {
        return target;
      }
      throw new Error('Blend radius must differ from its current radius.');
    }
    const output = kernel.resizeBlend(
      solid,
      face,
      operation.recordedRadius,
      newRadius
    );
    if (kernel.validateSolid(output) !== 0) {
      throw new Error(
        `Resizing the blend to radius ${newRadius} does not produce a valid solid.`
      );
    }
    let lineage: RemusLineageState | undefined;
    if (newRadius > GEOMETRY_EPSILON) {
      const candidates = topologyCandidatesForSolid(kernel, output);
      const matching = candidates.filter((candidate) => {
        if (candidate.kind !== 'face') {
          return false;
        }
        const rebuilt = measureFaceGeometry(kernel, candidate.handle);
        const rebuiltRadius =
          rebuilt?.surfaceType === 'torus'
            ? rebuilt.minorRadius
            : rebuilt?.surfaceType === 'cylinder'
              ? rebuilt.radius
              : undefined;
        return (
          rebuilt?.surfaceType === operation.surfaceClass &&
          rebuiltRadius !== undefined &&
          Math.abs(rebuiltRadius - newRadius) <=
            Math.max(newRadius * 1e-5, 1e-9)
        );
      });
      if (matching.length === 0) {
        throw new Error(
          `The blend could not be rebuilt exactly at radius ${newRadius}.`
        );
      }
      if (matching.length === 1 && producingFeatureId) {
        lineage = createRemusSemanticLineage(
          producingFeatureId,
          'direct-edit',
          [
            {
              ...matching[0]!,
              lineageName: 'direct-edit.resize-blend.band'
            }
          ]
        );
      }
    }
    return { solids: [output], ...(lineage ? { lineage } : {}) };
  }

  // resize-cylindrical-face
  if (
    geometry?.surfaceType !== 'cylinder' ||
    geometry.radius === undefined ||
    !geometry.axisStart ||
    !geometry.axisEnd ||
    geometry.axialLength === undefined
  ) {
    throw new Error('The selected face is no longer cylindrical.');
  }
  const radiusTolerance = Math.max(operation.sourceRadius * 1e-5, 1e-9);
  const axisTolerance = Math.max(
    geometry.axialLength * 1e-5,
    geometry.radius * 1e-5,
    1e-6
  );
  // The recorded radius and axis prove that a hash-resolved face is really
  // the wall the user picked. Under a lineage-resolved face identity is
  // already proven by role, and those pins would only forbid the upstream
  // edits — a taller cylinder, a moved body, a re-sized source radius — that
  // "set this wall to radius R" is defined to survive.
  if (!viaLineage) {
    if (Math.abs(geometry.radius - operation.sourceRadius) > radiusTolerance) {
      throw new Error(
        'The selected face no longer matches its recorded radius.'
      );
    }
    const nearlyEqual = (a: Vec3, b: Vec3): boolean =>
      Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= axisTolerance;
    const sameAxis =
      (nearlyEqual(geometry.axisStart, operation.sourceAxisStart) &&
        nearlyEqual(geometry.axisEnd, operation.sourceAxisEnd)) ||
      (nearlyEqual(geometry.axisStart, operation.sourceAxisEnd) &&
        nearlyEqual(geometry.axisEnd, operation.sourceAxisStart));
    if (!sameAxis) {
      throw new Error('The selected face no longer matches its recorded axis.');
    }
  }
  const newRadius = resolveParamValue(operation.radius, scope, 'radius');
  if (!Number.isFinite(newRadius) || newRadius <= GEOMETRY_EPSILON) {
    throw new Error('Radius must be greater than zero.');
  }
  if (Math.abs(newRadius - geometry.radius) <= radiusTolerance) {
    // A gesture that lands on the current radius is a no-op the user should
    // hear about; an upstream edit that happens to bring the wall to the
    // stored radius has simply already done this feature's work.
    if (viaLineage) {
      return target;
    }
    throw new Error('Radius must differ from the current radius.');
  }
  const axisVector = {
    x: geometry.axisEnd.x - geometry.axisStart.x,
    y: geometry.axisEnd.y - geometry.axisStart.y,
    z: geometry.axisEnd.z - geometry.axisStart.z
  };
  const axisDir = normalized(axisVector);
  if (!axisDir) {
    throw new Error('The selected face has a degenerate axis.');
  }
  // `resizeCylindricalFace` reads the concavity off the face's own
  // orientation and builds the sleeve between the two radii itself — a
  // plain cylinder when the wall sweeps outward, an annular tube when it
  // sweeps back through material — so growing and shrinking are the same
  // call. The recorded `concavity` is now only a record of what the gesture
  // meant, and shrinking no longer has to fail closed.
  const output = kernel.resizeCylindricalFace(solid, face, newRadius);
  if (kernel.validateSolidRelaxed(output) !== 0) {
    throw new Error(
      `Resizing the face to radius ${newRadius} does not produce a valid solid.`
    );
  }
  // The kernel gates on a closed shell and on the volume the resize is
  // defined to produce, and a degraded result can still clear both: a
  // boolean that meets a coaxial cylindrical face may hand back the
  // untouched original, and a mesh-boolean fallback encloses the right
  // space with a wall of triangles instead of a cylinder. Read the wall
  // back and insist it is an analytic cylinder at the new radius, so either
  // failure surfaces as a failed feature rather than a gesture that looked
  // like it worked.
  const coaxialRadii = coaxialCylinderRadii(
    kernel,
    output,
    geometry.axisStart,
    axisDir,
    axisTolerance
  );
  const atRadius = (radius: number): boolean =>
    coaxialRadii.some(
      (candidate) => Math.abs(candidate - radius) <= radiusTolerance
    );
  if (!atRadius(newRadius)) {
    throw new Error(
      atRadius(geometry.radius)
        ? `The wall kept its original radius instead of resizing to ${newRadius}.`
        : `The wall could not be resized to radius ${newRadius} exactly; it would become an approximation.`
    );
  }
  return { solids: [output] };
}

/**
 * Total face handles across a body's solids — the measured-shape cache's
 * paranoia probe. One cheap kernel call per solid, against a stored count,
 * so an in-place mutation of a cached solid (which the handle-identity
 * invariant forbids) surfaces as a cache miss rather than a stale mesh.
 */
export function countFaceHandles(
  kernel: RemusKernel,
  solids: number[]
): number {
  let count = 0;
  for (const solid of solids) {
    count += kernel.getSolidFaces(solid).length;
  }
  return count;
}
