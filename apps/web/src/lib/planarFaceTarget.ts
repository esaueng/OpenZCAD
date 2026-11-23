import type {
  BodyId,
  ProjectDocument,
  TopologySelection
} from '@openzcad/shared';
import { faceLabel } from './topologyLabels';

/** A selected face that is an exact plane: what Normal to face and face DXF act on. */
export interface PlanarFaceTarget {
  bodyId: BodyId;
  topologyId: string;
  label: string;
}

/**
 * The selected face, when it is an exact plane with a drawn mesh in
 * `representations`. Read from the bodies on screen: in View showing
 * another configuration row, that row's, where a face of its own exists.
 */
export function planarFaceTarget(
  representations: ProjectDocument['derived']['bodyRepresentations'],
  selection: TopologySelection | null
): PlanarFaceTarget | null {
  if (selection?.kind !== 'face' || !selection.topologyId) return null;
  const body = representations[selection.bodyId];
  const face = body?.topology?.faces.find(
    (candidate) =>
      candidate.topologyId === selection.topologyId ||
      (selection.hash !== undefined && candidate.hash === selection.hash)
  );
  const geometry = face?.geometry;
  if (
    !body ||
    !face ||
    face.triangleCount <= 0 ||
    geometry?.surfaceType !== 'plane' ||
    !geometry.normal ||
    ![
      geometry.center.x,
      geometry.center.y,
      geometry.center.z,
      geometry.normal.x,
      geometry.normal.y,
      geometry.normal.z
    ].every(Number.isFinite) ||
    Math.hypot(geometry.normal.x, geometry.normal.y, geometry.normal.z) < 1e-12
  )
    return null;
  return {
    bodyId: body.bodyId,
    topologyId: face.topologyId,
    label: faceLabel(body, face.hash, face.topologyId)
  };
}

/**
 * F06: the bodies a selection is picked on. A preview replaces the model
 * wholesale; otherwise View showing another row draws that row's bodies, so
 * a face picked there (one the active row may not have) resolves on them.
 */
export function selectionBodies(
  rendered: ProjectDocument['derived']['bodyRepresentations'],
  previewing: boolean,
  shownRow: ProjectDocument | null
): ProjectDocument['derived']['bodyRepresentations'] {
  return (!previewing && shownRow?.derived.bodyRepresentations) || rendered;
}
