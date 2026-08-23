import type {
  RemusKernel
} from './remus-runtime';
import {
  resolveParamValue
} from '@openzcad/document-core';
import {
  type Vec3
} from '@openzcad/geometry';
import {
  type DirectEditOperation,
  type FaceGeometry,
  type FeatureId
} from '@openzcad/shared';
import type {
  DxfFaceSelector,
  ExactShape
} from './exact-types';
import {
  topologyCandidatesForSolid
} from './exact-lineage-builders';
import {
  blendCarrierSnapshot,
  classifyThroughHoleFace,
  measureFaceGeometry,
  measureOwnedFaceGeometry,
  requireThroughHole
} from './exact-measure';
import {
  coaxialCylinderRadii,
  cylinderAlongAxis,
  fillThroughHole,
  tryExactAnalyticCylinderCapOffset
} from './exact-cylinder-ops';
import {
  collapseShape
} from './exact-boolean-helpers';
import {
  assertDirectEditOperation
} from './exact-direct-edit-guards';
import {
  faceHandlesByFingerprint,
  faceWitnessOf
} from './exact-witnesses';
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
  type RemusLineageState
} from './remus-lineage';
import {
  resolveTopologyReference,
  topologyHashOfWitness,
  type TopologyResolutionCandidate
} from './topology-lineage';

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
    throw new Error('Direct-edit face resolved without a kernel handle.');
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
        ? `The kernel left the hole at its original diameter instead of resizing it to ${diameter}.`
        : `The kernel returned no analytic bore at diameter ${diameter} — the wall came back as a mesh approximation.`
    );
  }
  return { solid: output, changed: true };
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
    length(subtract(geometry.center, operation.sourceCenter)) >
      centerTolerance
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
  const { face, viaLineage } = resolveDirectEditFace(
    kernel,
    target,
    solid,
    operation
  );
  if (operation.kind === 'resize-through-hole') {
    const resized = resizeThroughHole(kernel, solid, face, operation, scope);
    // Keeping only the same solid handle would still discard the imported
    // semantic face map and make the next no-op binding stale.
    return resized.changed ? { solids: [resized.solid] } : target;
  }

  const geometry = measureFaceGeometry(kernel, face);

  if (operation.kind === 'remove-face-feature') {
    return {
      solids: [
        removeFaceFeature(kernel, solid, face, geometry, operation)
      ]
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
    const snapshot = blendCarrierSnapshot(
      measureOwnedFaceGeometry(kernel, solid, face)
    );
    if (!snapshot || snapshot.surfaceClass !== operation.surfaceClass) {
      throw new Error(
        `The selected face is no longer an analytic ${operation.surfaceClass} blend.`
      );
    }
    const radiusTolerance = Math.max(operation.recordedRadius * 1e-5, 1e-9);
    if (
      Math.abs(snapshot.radius - operation.recordedRadius) > radiusTolerance
    ) {
      throw new Error(
        'The selected blend no longer matches its recorded radius.'
      );
    }
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
          `The kernel returned no analytic blend at radius ${newRadius}.`
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
  if (Math.abs(geometry.radius - operation.sourceRadius) > radiusTolerance) {
    throw new Error(
      'The selected face no longer matches its recorded radius.'
    );
  }
  const axisTolerance = Math.max(
    geometry.axialLength * 1e-5,
    geometry.radius * 1e-5,
    1e-6
  );
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
  const newRadius = resolveParamValue(operation.radius, scope, 'radius');
  if (!Number.isFinite(newRadius) || newRadius <= GEOMETRY_EPSILON) {
    throw new Error('Radius must be greater than zero.');
  }
  if (Math.abs(newRadius - geometry.radius) <= radiusTolerance) {
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
        ? `The kernel left the face at its original size instead of resizing it to radius ${newRadius}.`
        : `The kernel returned no analytic cylinder at radius ${newRadius} — the wall came back as a mesh approximation.`
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
export function countFaceHandles(kernel: RemusKernel, solids: number[]): number {
  let count = 0;
  for (const solid of solids) {
    count += kernel.getSolidFaces(solid).length;
  }
  return count;
}
