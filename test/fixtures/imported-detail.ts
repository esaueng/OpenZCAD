import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, filletEdges } from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { nativeDetail } from './native-detail';

/** Export/reimport deliberately discards every native feature identity. */
export async function importedDetail(
  adapter: ExactKernelAdapter,
  kind: 'hole' | 'chamfer' | 'fillet'
) {
  const fixture = await nativeDetail(
    adapter,
    kind === 'hole' ? 'hole' : 'chamfer'
  );
  let document = fixture.document;
  let bodyId = fixture.bodyId;
  if (kind === 'fillet') {
    const source = await adapter.syncDocument(fixture.source);
    const edge =
      source.bodyRepresentations[fixture.sourceId]!.topology!.edges[0]!;
    const rounded = filletEdges(fixture.source, {
      name: 'Fillet',
      targetBodyId: fixture.sourceId,
      edgeHashes: [edge.hash],
      size: 2
    });
    document = rounded.document;
    bodyId = rounded.bodyId;
  }
  const step = await adapter.exportStep(document, [bodyId]);
  const manager = new CommandManager(
    createProjectDocument('Imported detail', toUserId('user_fixture'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Imported part',
      artifactId: 'artifact_imported_detail',
      sourceName: `${kind}.step`,
      stepText: step
    })
  );
  const derived = await adapter.syncDocument(manager.document);
  const importedDocument = { ...manager.document, derived };
  const body = derived.bodyRepresentations[importedDocument.bodyOrder[0]!]!;
  const face = body.topology!.faces.find((candidate) =>
    kind === 'hole'
      ? candidate.geometry?.featureType === 'through-hole'
      : kind === 'fillet'
        ? candidate.geometry?.featureType === 'blend'
        : candidate.geometry?.normal &&
          [
            candidate.geometry.normal.x,
            candidate.geometry.normal.y,
            candidate.geometry.normal.z
          ].filter((value) => Math.abs(value) > 0.1).length === 2
  );
  if (!face) throw new Error(`Imported ${kind} fixture has no detail face.`);
  return { document: importedDocument, body, face, step };
}
