import type { BodyId, BodyTopology, TopologySelection } from '@openzcad/shared';

export interface HoleFacePick {
  bodyId: BodyId;
  hash: number;
}

export function resolveHoleFacePick(
  targetBodyId: BodyId,
  selection: TopologySelection | null,
  topology: BodyTopology | undefined
):
  | { ok: true; selection: TopologySelection; pick: HoleFacePick }
  | { ok: false; reason: string } {
  if (!selection || selection.kind !== 'face') {
    return {
      ok: false,
      reason: 'Hole: pick a planar face on the target body.'
    };
  }
  if (selection.bodyId !== targetBodyId) {
    return {
      ok: false,
      reason:
        'Hole: pick a face on the current target body, or change Target body first.'
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
      reason:
        'Hole: that face is no longer available. Pick a current face on the target body.'
    };
  }
  if (face.geometry?.surfaceType !== 'plane') {
    return {
      ok: false,
      reason:
        'Hole: the entry face must be planar. Pick a flat face on the target body.'
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
