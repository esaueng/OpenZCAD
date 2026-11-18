import { ownEntry } from '@openzcad/shared';
import {
  fatLineDepthBiasForExtent,
  sectionClippingPlane,
  type SectionViewSettings
} from '@openzcad/viewport';
import type { ResolvedExtrude } from './extrudeInference';
import { refusingWarning } from './featureValidation';

const AXES = ['x', 'y', 'z'] as const;
const FLOAT32_CLIP_SLACK = 16 * 2 ** -23;

/** Whether the accepted sweep's whole change lies clear of the kept half-space. */
export function isExtrudeChangeClipped(
  resolved: ResolvedExtrude,
  section: SectionViewSettings
): boolean {
  const { command, derived, toolBounds } = resolved;
  const { ids, name, targetBodyId } = command.payload;
  if (!ids || !toolBounds || !Number.isFinite(section.offset)) return false;

  const result = ownEntry(derived.bodyRepresentations, ids.bodyId);
  if (
    !result ||
    result.consumed ||
    result.meshReference ||
    result.displayQuality === 'draft' ||
    !(Number.isFinite(result.volume) && result.volume > 0) ||
    result.mesh.vertices.length < 9 ||
    result.mesh.indices.length < 3 ||
    refusingWarning(
      name,
      derived.warnings,
      derived.featureWarnings,
      ids.featureId
    )
  ) {
    return false;
  }

  const bounds = [toolBounds, result.solidBounds];
  if (targetBodyId) {
    bounds.push(
      ownEntry(derived.bodyRepresentations, targetBodyId)?.solidBounds
    );
  }
  let scale = Math.max(1, Math.abs(section.offset));
  let extent = 0;
  for (const box of bounds) {
    if (!box) return false;
    for (const axis of AXES) {
      const min = box.min[axis];
      const max = box.max[axis];
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
        return false;
      }
      scale = Math.max(scale, Math.abs(min), Math.abs(max));
    }
    // The diagonal bounds the topology edge span and the fallback mesh's
    // bounding-sphere diameter, including the target before the boolean.
    extent = Math.max(
      extent,
      Math.hypot(...AXES.map((axis) => box.max[axis] - box.min[axis]))
    );
  }
  if (!Number.isFinite(Math.fround(scale + extent))) return false;

  // The line shader can move an endpoint toward the camera by the depth
  // bias, including along the section axis. Leave room for that shift and
  // Float32 mesh, edge and clipping arithmetic. A tangent box stays silent.
  const clearance =
    fatLineDepthBiasForExtent(extent) + scale * FLOAT32_CLIP_SLACK;
  const { normal, constant } = sectionClippingPlane(section);
  // Canonical sections only have one nonzero normal component, so the two
  // opposite box corners include the closest point to the kept side.
  const signedDistance =
    Math.max(normal.dot(toolBounds.min), normal.dot(toolBounds.max)) + constant;
  return signedDistance < -clearance;
}
