import { describe, it, expect, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, toArtifactId } from '@openzcad/shared';
import {
  archiveAccountImportSources,
  applyAccountSourceArchives,
  sourceUploadMessage
} from './accountImportSources';
import { listLocalOnlyImportSources } from './importArchival';

function imported() {
  const manager = new CommandManager(
    createProjectDocument('Imported part', toUserId('owner'))
  );
  for (const name of ['holder', 'text'])
    manager.execute(
      commandFactories.importStep({
        name,
        sourceName: `${name}.step`,
        artifactId: `artifact_local_${name}`,
        stepSourceRef: {
          marker: 'openzcad-source-ref',
          version: 1,
          hashAlgorithm: 'sha256',
          checksumSha256: name,
          logicalBytes: 4
        }
      })
    );
  return manager.document;
}

describe('account import sources', () => {
  it('uploads current and undo sources without mutating the editor snapshot', async () => {
    const document = imported();
    const original = structuredClone(document);
    const { document: ready, result } = await archiveAccountImportSources(
      document,
      {
        loadSourceBytes: async () => new Uint8Array([1, 2, 3, 4]),
        archive: async (input) => `artifact_cloud_${input.fileName}`
      }
    );
    expect(document).toEqual(original);
    expect(listLocalOnlyImportSources(ready)).toEqual([]);
    expect(ready.featureOrder).toEqual(document.featureOrder);
    expect(ready.editHistory?.cursor).toBe(document.editHistory?.cursor);
    const undo = new CommandManager(ready);
    undo.undo();
    expect(listLocalOnlyImportSources(undo.document)).toEqual([]);
    expect(sourceUploadMessage(result)).toBeNull();
  });
  it('keeps successful uploads and retries only failed sources', async () => {
    const first = await archiveAccountImportSources(imported(), {
      loadSourceBytes: async () => new Uint8Array([1, 2, 3, 4]),
      archive: async (input) => {
        if (input.fileName === 'text.step') throw new Error('unavailable');
        return 'artifact_cloud_holder';
      }
    });
    expect(first.result.failed).toEqual(['text.step']);
    expect(sourceUploadMessage(first.result)).toContain('Use Save to retry');
    const upload = vi.fn(async () => 'artifact_cloud_text');
    const retry = await archiveAccountImportSources(first.document, {
      loadSourceBytes: async () => new Uint8Array([1, 2, 3, 4]),
      archive: upload
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(listLocalOnlyImportSources(retry.document)).toEqual([]);
  });
  it('reports missing bytes without claiming a completed source upload', async () => {
    const upload = vi.fn();
    const { result } = await archiveAccountImportSources(imported(), {
      loadSourceBytes: async () => null,
      archive: upload
    });
    expect(upload).not.toHaveBeenCalled();
    expect(sourceUploadMessage(result)).toContain(
      'Missing on this device: holder.step, text.step'
    );
  });
});

it('applies uploaded source locations to concurrent edits without reverting them', async () => {
  const initial = imported();
  const uploaded = await archiveAccountImportSources(initial, {
    loadSourceBytes: async () => new Uint8Array([1, 2, 3, 4]),
    archive: async (input) => `artifact_cloud_${input.fileName}`
  });
  const editor = new CommandManager(initial);
  editor.execute(
    commandFactories.renameNode({
      nodeId: initial.rootNodeId,
      name: 'Edited while uploading'
    })
  );
  const merged = applyAccountSourceArchives(editor.document, uploaded.document);
  expect(merged.name).toBe('Edited while uploading');
  expect(merged.editHistory?.entries).toHaveLength(
    editor.document.editHistory!.entries.length
  );
  expect(listLocalOnlyImportSources(merged)).toEqual([]);
  expect(applyAccountSourceArchives(imported(), uploaded.document).name).toBe(
    'Imported part'
  );
});

it('does not relabel a replaced source as the old uploaded bytes', async () => {
  const initial = imported();
  const uploaded = await archiveAccountImportSources(initial, {
    loadSourceBytes: async () => new Uint8Array([1, 2, 3, 4]),
    archive: async () => 'artifact_cloud_old'
  });
  const changed = structuredClone(initial);
  for (const node of Object.values(changed.nodes)) {
    if (
      node.kind === 'feature' &&
      node.data.featureKind === 'imported-step' &&
      node.data.sourceName === 'holder.step'
    ) {
      node.data.stepSourceRef!.checksumSha256 = 'replacement';
      node.data.artifactId = toArtifactId('artifact_local_replacement');
    }
  }
  const merged = applyAccountSourceArchives(changed, uploaded.document);
  expect(
    listLocalOnlyImportSources(merged).some(
      (s) => s.checksumSha256 === 'replacement'
    )
  ).toBe(true);
});
