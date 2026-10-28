import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { documentNodesWithHistory, toUserId } from '@openzcad/shared';
import { localConflictCopy } from './conflictLocalCopy';

const sourceOwner = toUserId('user_shared_source_owner');

describe('Keep both creates an ordinary owned project', () => {
  it.each([
    ['signed-in viewer', toUserId('user_current_viewer')],
    ['signed-in editor', toUserId('user_current_editor')],
    ['device-only visitor', toUserId('user_local_browser')]
  ] as const)(
    'assigns the copy and its undo history to the %s',
    (_role, creator) => {
      const original = new CommandManager(
        createProjectDocument('Shared part', sourceOwner)
      );
      original.execute(
        commandFactories.renameNode({
          nodeId: original.document.rootNodeId,
          name: 'My local changes'
        })
      );
      const source = structuredClone(original.document);
      const copy = localConflictCopy(
        source,
        ['My local changes (copy)'],
        creator
      );
      expect(copy.ownerUserId).toBe(creator);
      expect(copy.editHistory?.actorUserId).toBe(creator);
      expect(copy.projectId).not.toBe(source.projectId);
      expect(copy.name).toBe('My local changes (copy 2)');
      expect(copy.checkpoints).toHaveLength(1);
      expect(copy.revisions).toHaveLength(1);
      expect(copy.checkpoints[0]?.revisionId).toBe(
        copy.revisions[0]?.revisionId
      );
      for (const node of documentNodesWithHistory(copy)) {
        if (node.kind === 'project')
          expect(node.projectId).toBe(copy.projectId);
      }
      const reopened = new CommandManager(copy, creator);
      expect(reopened.canUndo).toBe(true);
      reopened.undo();
      expect(reopened.document.name).toBe('Shared part');
      expect(reopened.document.ownerUserId).toBe(creator);
      expect(reopened.document.projectId).toBe(copy.projectId);
      reopened.redo();
      expect(reopened.document.name).toBe('My local changes (copy 2)');
      expect(reopened.document.ownerUserId).toBe(creator);
      reopened.execute(
        commandFactories.renameNode({
          nodeId: copy.rootNodeId,
          name: 'My independent part'
        })
      );
      expect(reopened.document.name).toBe('My independent part');
      expect(original.document).toEqual(source);
      expect(source.ownerUserId).toBe(sourceOwner);
    }
  );

  it('also assigns ownership when a legacy source has no undo history', () => {
    const source = createProjectDocument('Legacy shared part', sourceOwner);
    const creator = toUserId('user_current_owner');
    const copy = localConflictCopy(source, [], creator);
    expect(copy.ownerUserId).toBe(creator);
    expect(copy.name).toBe('Legacy shared part (copy)');
    expect(new CommandManager(copy, creator).document.ownerUserId).toBe(
      creator
    );
    expect(source.ownerUserId).toBe(sourceOwner);
  });
});
