import type { BodyId, BodyTopology, TopologySelection } from '@openzcad/shared';

/**
 * The modeling operations whose form collects faces. While one of these forms
 * is open, a viewport face click belongs to the form, not to the selection
 * tools: it fills the face field the user would otherwise have to find in the
 * pick list.
 */
export type FacePickOperation = 'hole' | 'shell' | 'draft' | 'thicken';

export function modelingOperationPicksFaces(
  operation: string | null | undefined
): operation is FacePickOperation {
  return (
    operation === 'hole' ||
    operation === 'shell' ||
    operation === 'draft' ||
    operation === 'thicken'
  );
}

/** Hole drills and draft tapers from planar faces only; shell and thicken take any exact face. */
export function modelingOperationNeedsPlanarFaces(
  operation: FacePickOperation
): boolean {
  return operation === 'hole' || operation === 'draft';
}

/** Shell and draft collect several faces, so a viewport click toggles membership. */
export function modelingOperationPicksManyFaces(
  operation: FacePickOperation
): boolean {
  return operation === 'shell' || operation === 'draft';
}

const PICK_LABELS: Record<FacePickOperation, string> = {
  hole: 'Hole',
  shell: 'Shell',
  draft: 'Draft',
  thicken: 'Thicken'
};

export interface FormFacePick {
  bodyId: BodyId;
  hash: number;
}

/** @deprecated Use FormFacePick; kept for the Hole-era name. */
export type HoleFacePick = FormFacePick;

export function resolveFormFacePick(
  operation: FacePickOperation,
  targetBodyId: BodyId,
  selection: TopologySelection | null,
  topology: BodyTopology | undefined
):
  | { ok: true; selection: TopologySelection; pick: FormFacePick }
  | { ok: false; reason: string } {
  const label = PICK_LABELS[operation];
  const planar = modelingOperationNeedsPlanarFaces(operation);
  const faceWord = planar ? 'planar face' : 'face';
  if (!selection || selection.kind !== 'face') {
    return {
      ok: false,
      reason: `${label}: pick a ${faceWord} on the target body.`
    };
  }
  if (selection.bodyId !== targetBodyId) {
    return {
      ok: false,
      reason: `${label}: pick a face on the current target body, or change Target body first.`
    };
  }
  const face = topology?.faces.find((candidate) =>
    selection.topologyId !== undefined
      ? candidate.topologyId === selection.topologyId &&
        (selection.hash === undefined || candidate.hash === selection.hash)
      : selection.hash !== undefined && candidate.hash === selection.hash
  );
  if (!face) {
    return {
      ok: false,
      reason: `${label}: that face is no longer available. Pick a current face on the target body.`
    };
  }
  if (planar && face.geometry?.surfaceType !== 'plane') {
    return {
      ok: false,
      reason:
        operation === 'hole'
          ? 'Hole: the entry face must be planar. Pick a flat face on the target body.'
          : 'Draft: only planar faces can be drafted. Pick a flat face on the target body.'
    };
  }
  return {
    ok: true,
    pick: { bodyId: targetBodyId, hash: face.hash },
    selection: {
      bodyId: targetBodyId,
      kind: 'face',
      topologyId: face.topologyId,
      hash: face.hash,
      ...(face.reference ? { reference: face.reference } : {})
    }
  };
}

export function resolveHoleFacePick(
  targetBodyId: BodyId,
  selection: TopologySelection | null,
  topology: BodyTopology | undefined
): ReturnType<typeof resolveFormFacePick> {
  return resolveFormFacePick('hole', targetBodyId, selection, topology);
}
