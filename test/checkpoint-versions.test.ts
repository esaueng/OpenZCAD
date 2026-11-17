import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createAdvancingSavePoint,
  createCheckpoint,
  createProjectDocument,
  createSavePoint,
  createSavedRevision,
  normalizeDocument,
  renameCheckpoint
} from '@openzcad/document-core';
import { assertClientSavePoint } from '@openzcad/persistence';
import {
  MAX_CHECKPOINT_NAME_LENGTH,
  checkpointLabel,
  isProjectCheckpoint,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';

const owner = toUserId('user_versions');
const author = {
  userId: 'user_versions',
  name: 'Ada',
  device: 'Firefox on Linux'
};

function saved(): ProjectDocument {
  return createSavePoint(
    createProjectDocument('Bracket', owner),
    'Before fillets',
    author
  );
}

describe('L03 save-point names and authors', () => {
  it('records who saved and where on every way a save point is made', () => {
    const base = createProjectDocument('Bracket', owner);
    for (const document of [
      createCheckpoint(base, 'Manual save', author),
      createSavePoint(base, 'Manual save', author),
      createSavedRevision(base, 'Manual save', author),
      createAdvancingSavePoint(base, 'Manual save', author)
    ])
      expect(document.checkpoints.at(-1)?.author).toEqual(author);
    // A save without one records none: older callers are unchanged.
    expect(
      createCheckpoint(base, 'Manual save').checkpoints.at(-1)
    ).not.toHaveProperty('author');
  });

  it('bounds author text and drops what is empty', () => {
    const document = createCheckpoint(
      createProjectDocument('Bracket', owner),
      'Manual save',
      { name: `  ${'n'.repeat(400)}\n`, device: '   ', userId: '' }
    );
    const recorded = document.checkpoints.at(-1)!;
    expect(recorded.author?.name).toHaveLength(120);
    expect(recorded.author).not.toHaveProperty('device');
    expect(recorded.author).not.toHaveProperty('userId');
    expect(isProjectCheckpoint(recorded)).toBe(true);
  });

  it('renames a save point as a forward write and clears the name again', () => {
    const document = saved();
    const point = document.checkpoints.at(-1)!;
    const renamed = renameCheckpoint(
      document,
      point.checkpointId,
      '  Release candidate  '
    );
    const after = renamed.checkpoints.at(-1)!;
    expect(after.name).toBe('Release candidate');
    expect(checkpointLabel(after)).toBe('Release candidate');
    // The reason, author and identity of the save are untouched.
    expect(after).toMatchObject({
      checkpointId: point.checkpointId,
      revisionId: point.revisionId,
      documentVersion: point.documentVersion,
      reason: 'Before fillets',
      author
    });
    // It advances the version and records a revision, so it syncs.
    expect(renamed.version).toBe(document.version + 1);
    expect(renamed.revisions.at(-1)?.reason).toBe('Rename save point');
    // The same name again changes nothing.
    expect(
      renameCheckpoint(renamed, point.checkpointId, 'Release candidate')
    ).toBe(renamed);
    // An empty name, or the reason itself, clears it.
    for (const cleared of ['  ', 'Before fillets']) {
      const back = renameCheckpoint(renamed, point.checkpointId, cleared);
      expect(back.checkpoints.at(-1)).not.toHaveProperty('name');
      expect(checkpointLabel(back.checkpoints.at(-1)!)).toBe('Before fillets');
    }
    // A long name is bounded to what validation accepts.
    const long = renameCheckpoint(
      document,
      point.checkpointId,
      'x'.repeat(500)
    );
    expect(long.checkpoints.at(-1)?.name).toHaveLength(
      MAX_CHECKPOINT_NAME_LENGTH
    );
    expect(isProjectCheckpoint(long.checkpoints.at(-1))).toBe(true);
    expect(() => renameCheckpoint(document, 'checkpoint_missing', 'x')).toThrow(
      'not in this project'
    );
  });

  it('keeps a rename through undo, which never rewinds the save points', () => {
    const manager = new CommandManager(saved());
    manager.execute(
      commandFactories.setParameter({ name: 'width', expression: '40' })
    );
    const pointId = manager.document.checkpoints.at(-1)!.checkpointId;
    const renamed = manager.renameCheckpoint(pointId, 'Wide');
    expect(renamed.checkpoints.at(-1)?.name).toBe('Wide');
    // No undo entry of its own: undo takes back the parameter, not the name.
    manager.undo();
    expect(manager.document.checkpoints.at(-1)?.name).toBe('Wide');
    expect(
      Object.values(manager.document.nodes).some(
        (node) => node.kind === 'parameter'
      )
    ).toBe(false);
  });

  it('survives normalization, and a malformed field never costs the save point', () => {
    const base = saved();
    const own = renameCheckpoint(
      base,
      base.checkpoints.at(-1)!.checkpointId,
      'Kept'
    );
    expect(normalizeDocument(own).checkpoints.at(-1)).toMatchObject({
      name: 'Kept',
      author
    });
    const point = own.checkpoints.at(-1)!;
    const hostile = {
      ...own,
      checkpoints: [
        {
          ...point,
          name: 'x'.repeat(1000),
          author: { name: 42, device: 'Phone', extra: true }
        }
      ]
    } as unknown as ProjectDocument;
    expect(isProjectCheckpoint(hostile.checkpoints[0])).toBe(false);
    const normalized = normalizeDocument(hostile).checkpoints;
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).not.toHaveProperty('name');
    expect(normalized[0]).not.toHaveProperty('author');
    expect(normalized[0]?.checkpointId).toBe(point.checkpointId);
  });

  it('is a save point the account accepts as minted by the browser', () => {
    const minted = createSavedRevision(
      createProjectDocument('Bracket', owner),
      'Manual save',
      author
    );
    expect(() =>
      assertClientSavePoint(minted, {
        revisionId: minted.revisions.at(-1)!.revisionId,
        reason: 'Manual save'
      })
    ).not.toThrow();
  });
});
