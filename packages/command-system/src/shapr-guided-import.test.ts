import { describe, expect, it } from 'vitest';

import {
  createProjectDocument,
  type ShaprGuidedImportInput
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

import { CommandManager, commandFactories, replayCommands } from './index';

const checksum = 'a'.repeat(64);

function payload(): ShaprGuidedImportInput {
  return {
    step: {
      name: 'Exact imported body',
      artifactId: checksum,
      sourceName: 'sample.step',
      stepSourceRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: checksum,
        logicalBytes: 1_024
      }
    },
    migration: {
      representation: 'openzcad-shapr-migration',
      version: 1,
      sourceName: 'sample.shapr',
      sourceChecksumSha256: 'b'.repeat(64),
      companionStepName: 'sample.step',
      companionStepChecksumSha256: checksum,
      createdAt: '2026-08-24T12:00:00.000Z',
      schema: {
        workspaceSchemaVersion: 269,
        schemaVersion: 307_000,
        historyVersion: 100,
        projectVersion: 249_000
      },
      units: {
        source: 'metre-candidate',
        evidence: 'inferred',
        documentScaleCandidate: 1_000
      },
      summary: {
        historyNodeCount: 1,
        sketchCount: 0,
        curveCount: 0,
        constraintCount: 0,
        importedBodyCount: 1,
        importedPrototypeCount: 1,
        revisionBlockCount: 0,
        revisionDeltaCount: 0
      },
      operations: [
        {
          sourceNodeId: 1,
          name: 'Import 01',
          kind: 'import',
          status: 'unsupported',
          numericCandidates: [],
          diagnostic: 'Preserved by exact STEP geometry.'
        }
      ],
      diagnostics: [],
      semanticReplay: {
        status: 'not-applied',
        reason: 'Topology correspondence is not proven.'
      },
      privateDataOmitted: true
    }
  };
}

describe('guided SHAPR import command', () => {
  it('stores exact geometry and sanitized evidence atomically and replays ids', () => {
    const root = createProjectDocument('SHAPR import', toUserId('user_shapr'));
    const manager = new CommandManager(root);
    const command = commandFactories.importShaprGuided(payload());

    const imported = manager.execute(command);
    const importId = imported.shaprImportOrder[0]!;
    const record = imported.shaprImports[importId]!;

    expect(imported.bodyOrder).toHaveLength(1);
    expect(record.exactGeometry.bodyId).toBe(imported.bodyOrder[0]);
    expect(record.exactGeometry.stepChecksumSha256).toBe(checksum);
    expect(record.semanticReplay.status).toBe('not-applied');

    const replayed = replayCommands(root, imported.commandLog);
    expect(replayed.bodyOrder).toEqual(imported.bodyOrder);
    expect(replayed.shaprImportOrder).toEqual(imported.shaprImportOrder);
    expect(replayed.shaprImports).toEqual(imported.shaprImports);

    const undone = manager.undo();
    expect(undone.bodyOrder).toEqual([]);
    expect(undone.shaprImportOrder).toEqual([]);
    const redone = manager.redo();
    expect(redone.shaprImports).toEqual(imported.shaprImports);

    const deleted = manager.execute(
      commandFactories.deleteFeature({
        featureId: record.exactGeometry.featureId
      })
    );
    expect(deleted.shaprImportOrder).toEqual([]);
    expect(deleted.shaprImports).toEqual({});
    expect(manager.undo().shaprImports).toEqual(imported.shaprImports);
  });
});
