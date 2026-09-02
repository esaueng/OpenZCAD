import { describe, expect, it } from 'vitest';
import {
  adoptProjectDocument,
  appendRevision,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  chooseProjectDocument,
  projectDescendsFrom,
  projectMatchesInterruptedAdoption,
  projectsHaveSameCanonicalContent,
  selectProjectDocument
} from '../apps/web/src/lib/localProjectStore';

const owner = toUserId('user_owner');
const base = createProjectDocument('Bracket', owner);

function at(
  version: number,
  {
    name = `Bracket v${version}`,
    updatedAt = '2026-01-01T00:00:00.000Z',
    ownerUserId = owner
  }: {
    name?: string;
    updatedAt?: string;
    ownerUserId?: typeof owner;
  } = {}
) {
  const root = base.nodes[base.rootNodeId];
  return {
    ...base,
    name,
    ownerUserId,
    version,
    nodes:
      root?.kind === 'project'
        ? { ...base.nodes, [base.rootNodeId]: { ...root, name } }
        : base.nodes,
    derived: { ...base.derived, updatedAt }
  } satisfies ProjectDocument;
}

describe('choosing between the two copies of a project', () => {
  it('takes whichever copy exists when only one does', () => {
    expect(chooseProjectDocument(at(3), null)).toMatchObject({
      choice: 'local'
    });
    expect(chooseProjectDocument(null, at(3))).toMatchObject({
      choice: 'remote'
    });
    expect(chooseProjectDocument(null, null)).toEqual({ choice: 'none' });
  });

  it('treats equal canonical content as agreement without consulting a clock', () => {
    const local = at(4, {
      name: 'Same work',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    const remote = at(4, {
      name: 'Same work',
      updatedAt: '2030-01-01T00:00:00.000Z'
    });
    expect(chooseProjectDocument(local, remote, 4)).toMatchObject({
      choice: 'remote'
    });
  });

  it('ignores account ownership, versions, and rebuilt derived geometry when comparing work', () => {
    const local = at(4, { name: 'Same work' });
    const remote = at(9, {
      name: 'Same work',
      ownerUserId: toUserId('user_account')
    });
    remote.derived.warnings = ['rebuilt elsewhere'];

    expect(projectsHaveSameCanonicalContent(local, remote)).toBe(true);
    expect(chooseProjectDocument(local, remote, null)).toMatchObject({
      choice: 'remote'
    });
  });

  it('recognizes the server checkpoint left by an interrupted adoption', () => {
    const local = at(4, { name: 'Offline part' });
    const remote = adoptProjectDocument(local, toUserId('user_account'));

    expect(projectMatchesInterruptedAdoption(local, remote)).toBe(true);
    expect(chooseProjectDocument(local, remote, null)).toMatchObject({
      choice: 'remote'
    });
    expect(
      projectMatchesInterruptedAdoption(
        { ...local, name: 'Different device work' },
        remote
      )
    ).toBe(false);
  });

  it('takes the account copy when only the account moved', () => {
    expect(chooseProjectDocument(at(4), at(9), 4)).toMatchObject({
      choice: 'remote'
    });
  });

  it('keeps the device copy when only the device moved', () => {
    expect(chooseProjectDocument(at(9), at(4), 4)).toMatchObject({
      choice: 'local'
    });
  });

  it('reports divergence instead of picking a winner when both moved', () => {
    // The case that used to be settled by comparing timestamps, which discards
    // one side on the authority of a device clock.
    const outcome = chooseProjectDocument(at(7), at(9), 4);
    expect(outcome.choice).toBe('diverged');
    if (outcome.choice === 'diverged') {
      expect(outcome.local.version).toBe(7);
      expect(outcome.remote.version).toBe(9);
    }
  });

  it('reports divergence even when the device is behind the account', () => {
    // Being behind is not the same as being in agreement: a device at 5 with a
    // baseline of 4 has its own unsent edit, whatever the account did.
    expect(chooseProjectDocument(at(5), at(9), 4).choice).toBe('diverged');
  });

  it('reports divergence instead of guessing when no baseline is recorded', () => {
    expect(chooseProjectDocument(at(4), at(9), null).choice).toBe('diverged');
    expect(chooseProjectDocument(at(9), at(4), null).choice).toBe('diverged');
  });

  it('reports divergence when equal versions contain different work', () => {
    expect(
      chooseProjectDocument(
        at(7, { name: 'Device edit' }),
        at(7, { name: 'Account edit' }),
        5
      ).choice
    ).toBe('diverged');
  });

  it('reports divergence when both copies claim the baseline but their work differs', () => {
    expect(
      chooseProjectDocument(
        at(4, { name: 'Device edit' }),
        at(4, { name: 'Account edit' }),
        4
      ).choice
    ).toBe('diverged');
  });
});

describe('selectProjectDocument', () => {
  it('still answers with a single document for callers that want one', () => {
    expect(selectProjectDocument(at(9), at(4), 4)?.version).toBe(9);
    expect(selectProjectDocument(at(4), at(9), 4)?.version).toBe(9);
    expect(selectProjectDocument(null, null)).toBeNull();
  });

  it('keeps the device copy when it collapses a divergence', () => {
    // Safe, but lossy — which is why callers that can act on divergence are
    // told to use chooseProjectDocument instead.
    expect(selectProjectDocument(at(7), at(9), 4)?.version).toBe(7);
  });
});

describe('descent between the two copies', () => {
  // The live room hands a device documents at versions the account has never
  // seen; the next device to extend that document reaches the account with
  // this one's last revision in its history. Version fences alone call that
  // a divergence, and it used to be asked about — with the same work on both
  // sides of the question.
  it('takes the account copy that was built on top of this device’s', () => {
    const local = appendRevision(appendRevision(base, 'edit'), 'edit');
    const remote = appendRevision(local, 'edit on another device');

    expect(chooseProjectDocument(local, remote, base.version)).toMatchObject({
      choice: 'remote',
      document: remote
    });
    // Losing the baseline does not lose the proof.
    expect(chooseProjectDocument(local, remote, null)).toMatchObject({
      choice: 'remote'
    });
  });

  it('pushes this device’s copy when it was built on top of the account’s', () => {
    const remote = appendRevision(base, 'edit on another device');
    const local = appendRevision(appendRevision(remote, 'edit'), 'edit');

    expect(chooseProjectDocument(local, remote, base.version)).toMatchObject({
      choice: 'local',
      document: local
    });
  });

  it('still asks when neither copy descends from the other', () => {
    const local = appendRevision(base, 'edit here');
    const remote = appendRevision(base, 'edit there');

    expect(chooseProjectDocument(local, remote, base.version)).toMatchObject({
      choice: 'diverged'
    });
    expect(projectDescendsFrom(local, remote)).toBe(false);
    expect(projectDescendsFrom(remote, local)).toBe(false);
  });

  it('never takes a lower version as a descendant, whatever its history says', () => {
    const remote = appendRevision(base, 'edit');
    const rewound = { ...remote, version: base.version };

    expect(projectDescendsFrom(rewound, base)).toBe(false);
  });
});
