import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

/** Two opposite vertical rounds; a straight bottom ridge ends on one of them. */
export async function chamferRoundedEdgeFixture(adapter: ExactKernelAdapter) {
  const base = addPrimitiveFeature(
    createProjectDocument(
      'Chamfer at a rounded corner',
      toUserId('user_fixture')
    ),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 36, height: 41, depth: 11.5 }
    }
  );
  const source = (await adapter.syncDocument(base)).bodyRepresentations[
    base.bodyOrder[0]!
  ]!;
  const verticals = source.topology!.edges.filter((edge) =>
    [
      [36, 0],
      [0, 41]
    ].some(
      ([x, y]) =>
        edge.points.every((v, i) =>
          i % 3 === 0
            ? Math.abs(v - x!) < 1e-7
            : i % 3 === 1
              ? Math.abs(v - y!) < 1e-7
              : true
        ) && Math.abs(edge.length! - 11.5) < 1e-7
    )
  );
  if (verticals.length !== 2)
    throw new Error('Expected two vertical round seeds.');
  const rounded = filletEdges(base, {
    name: 'End rounds',
    targetBodyId: source.bodyId,
    edgeHashes: verticals.map((edge) => edge.hash),
    edgeReferences: verticals.map((edge) => edge.reference!),
    size: 1
  });
  const geometry = await adapter.syncDocument(rounded.document);
  if (geometry.warnings.length) throw new Error(geometry.warnings.join('; '));
  const body = geometry.bodyRepresentations[rounded.bodyId]!;
  const edge = body.topology!.edges.find(
    (candidate) =>
      candidate.length! > 30 &&
      candidate.points.every((v, i) => i % 3 === 0 || Math.abs(v) < 1e-7)
  );
  if (!edge?.reference)
    throw new Error('Expected a referenced straight bottom edge.');
  return { document: rounded.document, bodyId: rounded.bodyId, body, edge };
}
