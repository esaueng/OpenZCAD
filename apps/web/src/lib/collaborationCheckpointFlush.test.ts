import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  createSavedRevision
} from '@openzcad/document-core';
import { reconcileCopiedImportSources } from '@openzcad/persistence';
import { toArtifactId, toUserId, type ProjectDocument } from '@openzcad/shared';
import { reconcileCheckpointFlush } from './collaborationProtocol';

function documents() {
  const manager = new CommandManager(
    createProjectDocument('Clicked import', toUserId('owner'))
  );
  manager.execute(
    commandFactories.importMesh({
      name: 'Local mesh',
      sourceName: 'copy.stl',
      artifactId: 'artifact_local_mesh',
      triangleCount: 1,
      meshPayloadRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: 'd'.repeat(64),
        logicalBytes: 100
      }
    })
  );
  const clicked = manager.document;
  const archives = [
    {
      projectId: clicked.projectId,
      artifactId: toArtifactId('artifact_owned_mesh'),
      kind: 'mesh-payload' as const,
      checksumSha256: 'd'.repeat(64),
      logicalBytes: 100
    }
  ];
  const acknowledged = {
    ...reconcileCopiedImportSources(clicked, archives),
    version: clicked.version + 1
  };
  const live = createSavedRevision(
    addPrimitiveFeature(clicked, {
      name: 'Buffered box',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 2, depth: 2 }
    }),
    'Buffered note'
  );
  return { clicked, acknowledged, live, archives };
}

describe('checkpoint-owned ordinary ACK reconciliation', () => {
  it('rewrites only trusted source aliases while preserving buffered graph, undo, names and derived state', () => {
    const { clicked, live, acknowledged, archives } = documents();
    const expected = reconcileCopiedImportSources(live, archives);
    const result = reconcileCheckpointFlush(clicked, live, acknowledged)!;
    expect(result.nodes).toEqual(expected.nodes);
    expect(result.editHistory).toEqual(expected.editHistory);
    expect(result.checkpoints).toEqual(live.checkpoints);
    expect(result.revisions).toEqual(live.revisions);
    expect(result.derived).toBe(live.derived);
    expect(result.version).toBeGreaterThan(acknowledged.version);
    expect(result.version).toBeGreaterThan(live.version);
    expect(JSON.stringify(result)).not.toContain('artifact_local_mesh');
  });

  it('reuses a complete clicked echo without inventing a model version', () => {
    const { clicked, acknowledged } = documents();
    const result = reconcileCheckpointFlush(clicked, clicked, acknowledged)!;
    expect(result.version).toBe(acknowledged.version);
    expect(result.nodes).toEqual(acknowledged.nodes);
    expect(result.derived).toBe(clicked.derived);
  });

  it.each([
    'owner',
    'project',
    'version',
    'graph',
    'history',
    'source identity'
  ] as const)('refuses ACKs with changed %s', (difference) => {
    const { clicked, live, acknowledged } = documents();
    let changed: ProjectDocument = structuredClone(acknowledged);
    if (difference === 'owner') changed.ownerUserId = toUserId('other-owner');
    if (difference === 'project')
      changed.projectId = createProjectDocument(
        'Other',
        toUserId('owner')
      ).projectId;
    if (difference === 'version') changed.version = clicked.version - 1;
    if (difference === 'graph')
      changed = addPrimitiveFeature(changed, {
        name: 'Unexpected box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      });
    if (difference === 'history')
      changed = createSavedRevision(changed, 'Unexpected note');
    if (difference === 'source identity')
      changed = JSON.parse(
        JSON.stringify(changed).replaceAll('d'.repeat(64), 'e'.repeat(64))
      ) as ProjectDocument;
    expect(reconcileCheckpointFlush(clicked, live, changed)).toBeNull();
  });

  it('returns refusal rather than throwing if one local ID names inconsistent content', () => {
    const { clicked, acknowledged } = documents();
    const manager = new CommandManager(clicked);
    manager.execute(
      commandFactories.importMesh({
        name: 'Different mesh',
        sourceName: 'other.stl',
        artifactId: 'artifact_local_mesh',
        triangleCount: 1,
        meshPayloadRef: {
          marker: 'openzcad-source-ref',
          version: 1,
          hashAlgorithm: 'sha256',
          checksumSha256: 'f'.repeat(64),
          logicalBytes: 100
        }
      })
    );
    expect(
      reconcileCheckpointFlush(clicked, manager.document, acknowledged)
    ).toBeNull();
  });
});
