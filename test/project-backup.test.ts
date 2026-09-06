import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createCheckpoint,
  createProjectDocument,
  importMeshBody,
  importStepBody,
  setParameter
} from '@openzcad/document-core';
import { toArtifactId, toUserId } from '@openzcad/shared';
import {
  backupFileBytes,
  importProjectCopy,
  packBackupFile,
  parseProjectBackup,
  type ProjectBackup
} from '../apps/web/src/lib/projectBackup';

function fixture(): ProjectBackup {
  let document = createProjectDocument(
    'Entire project ✓',
    toUserId('original'),
    'inch'
  );
  document = setParameter(document, { name: 'width', expression: '25' });
  document = addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 3 }
  });
  document = addSketchFeature(document, {
    name: 'Sketch',
    plane: 'XZ',
    offset: 2,
    object: { objectKind: 'circle', radius: 3, centerX: 0, centerY: 0 }
  }).document;
  document = importStepBody(document, {
    name: 'STEP',
    artifactId: 'inline',
    sourceName: 'source.step',
    stepText: 'ISO-10303-21;\nEND-ISO-10303-21;'
  }).document;
  document = importMeshBody(document, {
    name: 'Mesh',
    artifactId: 'inline',
    sourceName: 'source.stl',
    triangleCount: 1,
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2]
  }).document;
  document = createCheckpoint(document, 'Preserved save point');
  document.commandLog.push({
    kind: 'test',
    payload: { retained: true },
    replayVersion: 1,
    label: 'History',
    timestamp: new Date().toISOString()
  });
  return { format: 'openzcad-project', version: 1, document, files: [] };
}

describe('complete project backups', () => {
  it('round trips every document field, sources, units and history without normalization', async () => {
    const backup = fixture();
    expect(await parseProjectBackup(JSON.stringify(backup))).toEqual(backup);
  });
  it('imports as a new identity while preserving all model IDs and history', async () => {
    const backup = fixture();
    const copy = importProjectCopy(backup, toUserId('new-owner'));
    expect(copy.document.projectId).not.toBe(backup.document.projectId);
    expect(copy.document.ownerUserId).toBe('new-owner');
    expect(copy.document.featureOrder).toEqual(backup.document.featureOrder);
    expect(copy.document.revisions).toEqual(backup.document.revisions);
    expect(copy.document.commandLog).toEqual(backup.document.commandLog);
    expect(backup.document.ownerUserId).toBe('original');
    expect(await parseProjectBackup(JSON.stringify(copy))).toEqual(copy);
  });
  it('includes binary files exactly and rejects damaged content', async () => {
    const backup = fixture();
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    backup.files.push(
      await packBackupFile(
        {
          artifactId: toArtifactId('artifact_test'),
          projectId: backup.document.projectId,
          kind: 'stl-import',
          name: 'binary.stl',
          objectKey: 'remote/key',
          contentType: 'model/stl',
          createdAt: new Date().toISOString(),
          metadata: {}
        },
        bytes.buffer
      )
    );
    const restored = await parseProjectBackup(JSON.stringify(backup));
    expect(backupFileBytes(restored.files[0]!)).toEqual(bytes);
    expect(
      importProjectCopy(restored, toUserId('new')).files[0]?.artifact.objectKey
    ).toBe('');
    backup.files[0]!.base64 = 'AAAAAAA=';
    await expect(parseProjectBackup(JSON.stringify(backup))).rejects.toThrow(
      'damaged'
    );
  });
  it.each([
    (backup: ProjectBackup) => {
      backup.version = 99 as 1;
    },
    (backup: ProjectBackup) => {
      backup.document.schemaVersion = 99 as 4;
    },
    (backup: ProjectBackup) => {
      delete backup.document.nodes[backup.document.rootNodeId];
    },
    (backup: ProjectBackup) => {
      backup.document.featureOrder.push('missing' as never);
    },
    (backup: ProjectBackup) => {
      backup.document.units = 'feet' as never;
    }
  ])(
    'rejects unsupported or malformed backups before importing',
    async (mutate) => {
      const backup = fixture();
      mutate(backup);
      await expect(
        parseProjectBackup(JSON.stringify(backup))
      ).rejects.toThrow();
    }
  );
  it('allows empty projects', async () => {
    const backup = {
      ...fixture(),
      document: createProjectDocument('Empty', toUserId('owner'))
    };
    expect(await parseProjectBackup(JSON.stringify(backup))).toEqual(backup);
  });
});

it('rejects missing asset contents instead of accepting a partial backup', async () => {
  const backup = fixture();
  backup.document.assets['asset_missing' as never] = {
    assetId: 'asset_missing' as never,
    artifactId: toArtifactId('artifact_missing'),
    kind: 'step-source',
    name: 'missing.step',
    contentType: 'model/step',
    storage: 'remote',
    createdAt: new Date().toISOString()
  };
  await expect(parseProjectBackup(JSON.stringify(backup))).rejects.toThrow(
    'missing asset'
  );
});

it('rejects arbitrary JSON and missing required collections', async () => {
  await expect(parseProjectBackup('{')).rejects.toThrow();
  await expect(parseProjectBackup('{}')).rejects.toThrow('supported');
  const backup = fixture();
  delete (backup.document as Partial<typeof backup.document>).commandLog;
  await expect(parseProjectBackup(JSON.stringify(backup))).rejects.toThrow(
    'commandLog'
  );
});
