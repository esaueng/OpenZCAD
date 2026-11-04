import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type EdgeTopology } from '@openzcad/shared';

const close = (a: number, b: number) => Math.abs(a - b) < 1e-7;

function endpoints(
  edge: EdgeTopology,
  test: (x: number, y: number, z: number) => boolean
) {
  const p = edge.points;
  return test(p[0]!, p[1]!, p[2]!) && test(p.at(-3)!, p.at(-2)!, p.at(-1)!);
}

/** A block whose sharp edges terminate on two earlier sets of rounds. */
export async function roundedBlockDocument(adapter: ExactKernelAdapter) {
  let document = addPrimitiveFeature(
    createProjectDocument(
      'Rounded block chamfer regression',
      toUserId('user_chamfer')
    ),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 32, height: 28, depth: 24 }
    }
  );
  let bodyId = document.bodyOrder.at(-1)!;
  let derived = await adapter.syncDocument(document);
  let edges = derived.bodyRepresentations[bodyId]!.topology!.edges.filter(
    (edge) => endpoints(edge, (x, y) => close(x, 32) && close(y, 0))
  );
  if (edges.length !== 1)
    throw new Error('Expected one vertical edge for the first round.');
  document = filletEdges(document, {
    name: 'Large round',
    targetBodyId: bodyId,
    size: 8,
    edgeHashes: edges.map((edge) => edge.hash),
    edgeReferences: edges.map((edge) => edge.reference!)
  }).document;
  bodyId = document.bodyOrder.at(-1)!;
  derived = await adapter.syncDocument(document);
  edges = derived.bodyRepresentations[bodyId]!.topology!.edges.filter((edge) =>
    endpoints(
      edge,
      (x, y, z) =>
        (close(y, 28) && close(z, 24)) ||
        (close(x, 32) && close(y, 28)) ||
        (close(x, 32) && close(z, 24))
    )
  );
  if (edges.length !== 3)
    throw new Error('Expected three edges for the second round.');
  return filletEdges(document, {
    name: 'Small rounds',
    targetBodyId: bodyId,
    size: 3,
    edgeHashes: edges.map((edge) => edge.hash),
    edgeReferences: edges.map((edge) => edge.reference!)
  });
}

export function remainingVerticalEdge(edge: EdgeTopology) {
  return endpoints(edge, (x, y) => close(x, 0) && close(y, 28));
}
