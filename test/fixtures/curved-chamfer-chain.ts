import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyRepresentation } from '@openzcad/shared';

const WIDTH = 20;
const HEIGHT = 15;
const DEPTH = 30;
const ROUND = 3;
export const CURVED_CHAIN_LENGTH =
  WIDTH + HEIGHT - 2 * ROUND + (Math.PI * ROUND) / 2;
export const ROUNDED_BLOCK_VOLUME =
  DEPTH * (WIDTH * HEIGHT - (1 - Math.PI / 4) * ROUND ** 2);

/** Integral of S*t - pi*t^2/4 across the d-wide bevel, t from zero to d. */
export const curvedChainVolume = (distance: number) =>
  ROUNDED_BLOCK_VOLUME -
  (CURVED_CHAIN_LENGTH * distance ** 2) / 2 +
  (Math.PI * distance ** 3) / 12;
export const CURVED_CHAIN_VOLUME = curvedChainVolume(1);

export function curvedChamferChain(body: Pick<BodyRepresentation, 'topology'>) {
  return body.topology!.edges.filter(
    ({ points: p, curve }) =>
      Math.abs(p[0]!) < 1e-7 &&
      Math.abs(p.at(-3)!) < 1e-7 &&
      (curve?.type === 'CIRCLE' ||
        (Math.abs(p[1]!) < 1e-7 && Math.abs(p.at(-2)!) < 1e-7) ||
        (Math.abs(p[2]! - HEIGHT) < 1e-7 &&
          Math.abs(p.at(-1)! - HEIGHT) < 1e-7))
  );
}

/** A planar end bounded by a line, an R3 quarter-circle and a tangent line. */
export async function curvedChainDocument(adapter: ExactKernelAdapter) {
  const base = addPrimitiveFeature(
    createProjectDocument('Curved chamfer regression', toUserId('user_chain')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: DEPTH, height: WIDTH, depth: HEIGHT }
    }
  );
  const derived = await adapter.syncDocument(base);
  const bodyId = base.bodyOrder[0]!;
  const edges = derived.bodyRepresentations[bodyId]!.topology!.edges.filter(
    ({ points: p }) =>
      Math.abs(p[1]!) < 1e-7 &&
      Math.abs(p.at(-2)!) < 1e-7 &&
      Math.abs(p[2]! - HEIGHT) < 1e-7 &&
      Math.abs(p.at(-1)! - HEIGHT) < 1e-7
  );
  if (edges.length !== 1)
    throw new Error('The fixture needs exactly one longitudinal top edge.');
  return filletEdges(base, {
    name: 'Earlier R3 round',
    targetBodyId: bodyId,
    edgeHashes: edges.map((e) => e.hash),
    edgeReferences: edges.map((e) => e.reference!),
    size: ROUND
  });
}
