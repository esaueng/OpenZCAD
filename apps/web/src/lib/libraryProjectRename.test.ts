import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  LibraryRenameRefusal,
  renameLibraryProject
} from './libraryProjectRename';
import { projectNameProblem, sameNamedProject } from './projectNameHints';

const owner = toUserId('owner');

describe('renameLibraryProject', () => {
  it('renames a device-only project as the workspace title would', async () => {
    const local = createProjectDocument('Lid', owner);
    const saved: ProjectDocument[] = [];
    const next = await renameLibraryProject(local.projectId, '  Lid v2 ', {
      actorUserId: owner,
      loadLocal: async () => local,
      saveLocal: async (document) => {
        saved.push(document);
      }
    });
    expect(next.name).toBe('Lid v2');
    expect(next.nodes[next.rootNodeId]?.name).toBe('Lid v2');
    expect(next.version).toBeGreaterThan(local.version);
    // Recorded as an edit, so the workspace can undo it.
    expect(next.editHistory?.entries.at(-1)?.label).toBe('Rename to Lid v2');
    expect(saved).toEqual([next]);
  });

  it('writes the account first, fenced on the version it read', async () => {
    const remote = createProjectDocument('Bracket', owner);
    const local = { ...remote, derived: { ...remote.derived } };
    const save = vi.fn(async (input: { expectedVersion: number }) => ({
      projectId: remote.projectId,
      version: input.expectedVersion + 1,
      updatedAt: new Date().toISOString()
    }));
    const markSynced = vi.fn(async () => undefined);
    const saveLocal = vi.fn(async () => undefined);
    const stored = await renameLibraryProject(remote.projectId, 'Bracket B', {
      actorUserId: owner,
      loadLocal: async () => local,
      saveLocal,
      account: { load: async () => remote, save, markSynced }
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      projectId: remote.projectId,
      expectedVersion: remote.version
    });
    expect(stored.name).toBe('Bracket B');
    expect(stored.version).toBe(remote.version + 1);
    expect(stored.derived).toBe(local.derived);
    expect(saveLocal).toHaveBeenCalledWith(stored);
    expect(markSynced).toHaveBeenCalledWith(remote.projectId, stored.version);
  });

  it('refuses when this device holds changes the account has not seen', async () => {
    const remote = createProjectDocument('Bracket', owner);
    const local = { ...remote, version: remote.version + 2 };
    const save = vi.fn();
    const saveLocal = vi.fn();
    await expect(
      renameLibraryProject(remote.projectId, 'Bracket B', {
        actorUserId: owner,
        loadLocal: async () => local,
        saveLocal,
        account: {
          load: async () => remote,
          save,
          markSynced: async () => undefined
        }
      })
    ).rejects.toBeInstanceOf(LibraryRenameRefusal);
    expect(save).not.toHaveBeenCalled();
    expect(saveLocal).not.toHaveBeenCalled();
  });

  it('keeps nothing on the device when the account refuses the write', async () => {
    const remote = createProjectDocument('Bracket', owner);
    const saveLocal = vi.fn();
    await expect(
      renameLibraryProject(remote.projectId, 'Bracket B', {
        actorUserId: owner,
        loadLocal: async () => null,
        saveLocal,
        account: {
          load: async () => remote,
          save: async () => {
            throw new Error('Version conflict');
          },
          markSynced: async () => undefined
        }
      })
    ).rejects.toThrow('Version conflict');
    expect(saveLocal).not.toHaveBeenCalled();
  });

  it('refuses an empty name before reading anything', async () => {
    const loadLocal = vi.fn();
    await expect(
      renameLibraryProject('p', '   ', {
        actorUserId: owner,
        loadLocal,
        saveLocal: vi.fn()
      })
    ).rejects.toThrow('A project needs a name.');
    expect(loadLocal).not.toHaveBeenCalled();
  });
});

describe('project name hints', () => {
  it('names the problem with a typed name', () => {
    expect(projectNameProblem('')).toBe('A project needs a name.');
    expect(projectNameProblem('x'.repeat(201))).toMatch(/200 characters/);
    expect(projectNameProblem(' Lid ')).toBeNull();
  });

  it('finds another project of the same name, ignoring case and spaces', () => {
    const projects = [
      { projectId: 'a', name: 'Bracket A' },
      { projectId: 'b', name: 'Lid' }
    ];
    expect(sameNamedProject(' bracket a ', projects)).toBe('Bracket A');
    expect(sameNamedProject('Bracket A', projects, 'a')).toBeNull();
    expect(sameNamedProject('Bracket', projects)).toBeNull();
    expect(sameNamedProject('  ', projects)).toBeNull();
  });
});
