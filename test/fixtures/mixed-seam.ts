import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

/** Synthetic cylinder/block junction, including the already-rounded top rim. */
export async function mixedSeamFixture(adapter: ExactKernelAdapter) {
  let document = addPrimitiveFeature(
    createProjectDocument('Mixed seam fillet', toUserId('user_fixture')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 18, depth: 26 }
    }
  );
  const block = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Boss',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: 35 }
  });
  const boss = document.bodyOrder.at(-1)!;
  const initial = await adapter.syncDocument(document);
  const rim = initial.bodyRepresentations[boss]!.topology!.edges.find(
    (e) => e.curve?.type === 'CIRCLE' && Math.abs(e.points[2]! - 35) < 1e-5
  )!;
  const rounded = filletEdges(document, {
    name: 'Boss top round',
    targetBodyId: boss,
    edgeHashes: [rim.hash],
    size: 2
  });
  const union = booleanBodies(rounded.document, {
    name: 'Union',
    operation: 'union',
    targetBodyIds: [block, rounded.bodyId]
  });
  document = union.document;
  const built = await adapter.syncDocument(document);
  if (built.warnings.length) throw new Error(built.warnings.join('; '));
  const body = built.bodyRepresentations[union.bodyId]!;
  const edges = body.topology!.edges;
  const at = (points: number[], axis: number, value: number) =>
    points.every((v, i) => i % 3 !== axis || Math.abs(v - value) < 1e-5);
  const arc = edges.find(
    (e) =>
      e.curve?.type === 'CIRCLE' &&
      Math.abs((e.length ?? 0) - Math.PI * 3) < 1e-5 &&
      at(e.points, 2, 26)
  );
  const vertical = edges.find(
    (e) =>
      e.curve?.type === 'LINE' &&
      at(e.points, 0, 6) &&
      at(e.points, 1, 0) &&
      Math.abs((e.length ?? 0) - 26) < 1e-5
  );
  const top = edges.find(
    (e) =>
      e.curve?.type === 'LINE' &&
      at(e.points, 1, 0) &&
      at(e.points, 2, 26) &&
      Math.abs((e.length ?? 0) - 24) < 1e-5
  );
  if (!arc || !vertical || !top)
    throw new Error('Mixed seam fixture must expose the three distinct edges.');
  return {
    document,
    bodyId: union.bodyId,
    edges: [arc, vertical, top] as const,
    volume: body.volume
  };
}
