import { describe, expect, it, vi } from 'vitest';
import {
  createProjectDocument,
  listParameters,
  setParameter
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  commitCheckedPatch,
  patchApplyReport,
  patchBaseMoved
} from './checkedPatchCommit';

function withWidth(document: ProjectDocument, width: string): ProjectDocument {
  return setParameter(document, {
    name: 'width',
    expression: width,
    quantity: 'length'
  });
}

function widthOf(document: ProjectDocument): string | undefined {
  return listParameters(document).find(
    (parameter) => parameter.name === 'width'
  )?.expression;
}

const MOVED = 'The model changed while the history text was checked.';

/**
 * The command manager's document, replaced during the exact check by a copy
 * with the same project and version and another width: an adopted account
 * copy or a resolved sync conflict.
 */
function replacedDuringCheck(exact: boolean) {
  const base = withWidth(
    createProjectDocument('Bracket', toUserId('owner')),
    '40 mm'
  );
  const replacement: ProjectDocument = {
    ...withWidth(base, '55 mm'),
    projectId: base.projectId,
    version: base.version
  };
  const manager = { document: base };
  const commit = vi.fn((width: string) => {
    manager.document = withWidth(manager.document, width);
    return true;
  });
  const run = commitCheckedPatch({
    base,
    live: () => manager.document,
    exact,
    moved: MOVED,
    check: async () => {
      // Checked against `base`: 40 → 45 mm.
      await Promise.resolve();
      manager.document = replacement;
      return '45 mm';
    },
    commit
  });
  return { run, manager, commit };
}

describe('commitCheckedPatch', () => {
  it('refuses a same-version replacement adopted during the check', async () => {
    const { run, manager, commit } = replacedDuringCheck(true);
    await expect(run).rejects.toThrow(MOVED);
    expect(commit).not.toHaveBeenCalled();
    expect(widthOf(manager.document)).toBe('55 mm');
  });

  it('shows why the project and version alone were not enough', async () => {
    // The assistant's guard: the replacement passes it and is overwritten.
    const { run, manager } = replacedDuringCheck(false);
    await expect(run).resolves.toBe(true);
    expect(widthOf(manager.document)).toBe('45 mm');
  });

  it('commits while the document checked is still the one held', async () => {
    const base = withWidth(
      createProjectDocument('Bracket', toUserId('owner')),
      '40 mm'
    );
    const manager = { document: base };
    await expect(
      commitCheckedPatch({
        base,
        live: () => manager.document,
        exact: true,
        moved: MOVED,
        check: async () => '45 mm',
        commit: (width) => {
          manager.document = withWidth(manager.document, width);
          return true;
        }
      })
    ).resolves.toBe(true);
    expect(widthOf(manager.document)).toBe('45 mm');
  });

  it('treats a closed project as moved', () => {
    const base = createProjectDocument('Bracket', toUserId('owner'));
    expect(patchBaseMoved(base, null, false)).toBe(true);
    expect(patchBaseMoved(base, { ...base }, false)).toBe(false);
    expect(patchBaseMoved(base, { ...base }, true)).toBe(true);
  });
});

describe('patchApplyReport', () => {
  it('reports to its own open project', () => {
    expect(
      patchApplyReport({
        projectId: 'a',
        openProjectId: 'a',
        latest: true,
        opening: false
      })
    ).toEqual({ status: true, clearBusy: true });
  });

  it('leaves another project status and its opening spinner alone', () => {
    expect(
      patchApplyReport({
        projectId: 'a',
        openProjectId: 'b',
        latest: true,
        opening: true
      })
    ).toEqual({ status: false, clearBusy: false });
  });

  it('still clears its own busy flag once another project is open', () => {
    expect(
      patchApplyReport({
        projectId: 'a',
        openProjectId: 'b',
        latest: true,
        opening: false
      })
    ).toEqual({ status: false, clearBusy: true });
  });

  it('leaves the busy flag to a newer Apply', () => {
    expect(
      patchApplyReport({
        projectId: 'a',
        openProjectId: 'b',
        latest: false,
        opening: false
      }).clearBusy
    ).toBe(false);
  });
});
