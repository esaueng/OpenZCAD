import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyRepresentation } from '@openzcad/shared';

export function threeCornerEdges(body: BodyRepresentation) {
  return (body.topology?.edges ?? []).filter((edge) => {
    const { points } = edge;
    return [0, points.length - 3].some(
      (i) =>
        Math.hypot(points[i]!, points[i + 1]!, points[i + 2]! - 11.5) < 1e-7
    );
  });
}

/** Two existing r1 rounds, ending on the selected 35 + 40 + 11.5 mm edges. */
export async function filletedCornerDocument(adapter: ExactKernelAdapter) {
  const base = addPrimitiveFeature(
    createProjectDocument('Corner chamfer regression', toUserId('user_corner')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 36, height: 41, depth: 11.5 }
    }
  );
  const derived = await adapter.syncDocument(base);
  const bodyId = base.bodyOrder[0]!;
  const edges = derived.bodyRepresentations[bodyId]!.topology!.edges.filter(
    ({ points: p }) =>
      [
        [36, 0],
        [0, 41]
      ].some(
        ([x, y]) =>
          Math.hypot(p[0]! - x!, p[1]! - y!, p.at(-3)! - x!, p.at(-2)! - y!) <
          1e-7
      ) && Math.abs(p[2]! - p.at(-1)!) > 10
  );
  if (edges.length !== 2)
    throw new Error('The corner fixture needs two far-end edges.');
  return filletEdges(base, {
    name: 'Earlier fillets',
    targetBodyId: bodyId,
    edgeHashes: edges.map((edge) => edge.hash),
    edgeReferences: edges.map((edge) => edge.reference!),
    size: 1
  });
}

export const CORNER_CHAMFER_VOLUME =
  36 * 41 * 11.5 - 2 * (1 - Math.PI / 4) * 11.5 - 43.25;
