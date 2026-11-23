import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type ImportedSourceReference,
  type ProjectDocument,
  type SerializedCommand
} from '@openzcad/shared';

/**
 * Where a saved command can carry an imported mesh's `payloadUnits` (I03,
 * v153) while every node stays free of it: an `import.mesh` input, a
 * `feature.update` patch, either nested in a transaction, or a command list
 * an undo entry restores.
 */
export const MESH_PAYLOAD_UNITS_COMMAND_CARRIERS = [
  'import.mesh',
  'feature.update',
  'transaction',
  'history'
] as const;
export type MeshPayloadUnitsCommandCarrier =
  (typeof MESH_PAYLOAD_UNITS_COMMAND_CARRIERS)[number];

/**
 * An inch document with one referenced mesh whose node states no payload
 * units, plus one serialized command, in `carrier`, that does.
 */
export function meshPayloadUnitsCommandDocument(
  schemaVersion: number,
  carrier: MeshPayloadUnitsCommandCarrier,
  meshPayloadRef: ImportedSourceReference,
  owner = 'owner'
): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Converted part', toUserId(owner))
  );
  manager.execute(
    commandFactories.importMesh({
      name: 'Mesh',
      artifactId: 'artifact_mesh',
      sourceName: 'part.stl',
      triangleCount: 1,
      meshPayloadRef
    })
  );
  manager.execute(
    commandFactories.renameNode({
      nodeId: manager.document.rootNodeId,
      name: 'Renamed'
    })
  );
  const document = structuredClone(manager.document);
  document.units = 'inch';
  const feature = Object.values(document.nodes).find(
    (node) => node.kind === 'feature'
  );
  if (feature?.kind !== 'feature') throw new Error('Missing fixture');
  const last = document.commandLog.at(-1)!;
  const command = (kind: string, payload: unknown): SerializedCommand => ({
    ...last,
    kind,
    payload
  });
  const update = command('feature.update', {
    featureId: feature.featureId,
    data: { payloadUnits: 'mm' }
  });
  if (carrier === 'import.mesh')
    document.commandLog.push(
      command('import.mesh', {
        name: 'Mesh',
        artifactId: 'artifact_mesh_2',
        sourceName: 'part.stl',
        triangleCount: 1,
        meshPayloadRef,
        payloadUnits: 'mm'
      })
    );
  else if (carrier === 'feature.update') document.commandLog.push(update);
  else if (carrier === 'transaction')
    document.commandLog.push(command('transaction', [update]));
  else
    document.editHistory!.entries[0]!.changes.push({
      kind: 'splice',
      field: 'commandLog',
      index: document.commandLog.length,
      before: [],
      after: [update]
    });
  return { ...document, schemaVersion } as ProjectDocument;
}
