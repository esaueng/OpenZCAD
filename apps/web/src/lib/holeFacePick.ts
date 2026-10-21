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

const PICK_LABELS: Record<FacePickOperation, string> = {
  hole: 'Hole',
  shell: 'Shell',
  draft: 'Draft',
  thicken: 'Thicken'
};

export interface FormFacePick {
  bodyId: BodyId;
  hash: number;
  /**
   * Hole only: where on the face the click landed, as the card's U and V
   * text. Absent for a pick with no click point (a face seeded from the
   * selection, a keyboard pick), which leaves the typed position alone.
   */
  position?: { u: string; v: string };
  /**
   * A box sweep: every face it took on the target body, `hash` among them.
   * Shell and Draft add them all to their list rather than toggling, so a
   * second sweep over the same faces cannot quietly take them back out.
   */
  hashes?: readonly number[];
}

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

/** Operations whose card holds a list of faces rather than one. */
export function formFaceListOperation(operation: FacePickOperation): boolean {
  return operation === 'shell' || operation === 'draft';
}

/**
 * The faces a box sweep hands an open face-collecting card: those on its
 * target body that the card can take. A one-face card (Hole, Thicken) takes a
 * sweep only when exactly one usable face is in it.
 */
export function resolveFormFaceBox(
  operation: FacePickOperation,
  targetBodyId: BodyId,
  selections: readonly TopologySelection[],
  topology: BodyTopology | undefined
):
  | { ok: true; pick: FormFacePick; added: number; skipped: number }
  | { ok: false; reason: string } {
  const label = PICK_LABELS[operation];
  const resolved = selections
    .filter((selection) => selection.bodyId === targetBodyId)
    .map((selection) =>
      resolveFormFacePick(operation, targetBodyId, selection, topology)
    );
  const usable = resolved.flatMap((result) => (result.ok ? [result.pick] : []));
  const skipped = selections.length - usable.length;
  if (usable.length === 0) {
    const refusal = resolved.find((result) => !result.ok);
    return {
      ok: false,
      reason:
        refusal && !refusal.ok
          ? refusal.reason
          : `${label}: the box took no faces on the target body.`
    };
  }
  if (!formFaceListOperation(operation)) {
    return usable.length === 1
      ? { ok: true, pick: usable[0]!, added: 1, skipped }
      : {
          ok: false,
          reason: `${label} takes one face: click it, or box just that face.`
        };
  }
  return {
    ok: true,
    pick: {
      bodyId: targetBodyId,
      hash: usable[0]!.hash,
      hashes: usable.map((pick) => pick.hash)
    },
    added: usable.length,
    skipped
  };
}
