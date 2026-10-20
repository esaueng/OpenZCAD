import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  adoptProjectDocument,
  appendRevision,
  createCheckpoint,
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  MAX_PROJECT_CHECKPOINTS,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  chooseProjectDocument,
  projectDescendsFrom,
  projectMatchesInterruptedAdoption,
  projectPreservesLocalWork,
  projectsHaveSameCanonicalContent,
  selectProjectDocument,
  withMatchingLocalDerived
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
  function fullSaveWindow() {
    let document = structuredClone(base);
    for (let index = 0; index < MAX_PROJECT_CHECKPOINTS; index += 1) {
      document = createCheckpoint(document, `Save ${index}`);
    }
    return document;
  }

  it.each([1, 3])(
    'recognizes %s saves that shift a full retention window',
    (count) => {
      const local = fullSaveWindow();
      let remote = local;
      for (let index = 0; index < count; index += 1) {
        remote = createCheckpoint(remote, `Account save ${index}`);
      }
      expect(projectPreservesLocalWork(local, remote)).toBe(true);
      expect(projectPreservesLocalWork(remote, local)).toBe(false);
      expect(chooseProjectDocument(local, remote).choice).toBe('remote');
      expect(chooseProjectDocument(remote, local).choice).toBe('local');
      const editedOverlap = structuredClone(remote);
      editedOverlap.checkpoints[0]!.reason = 'Different history';
      expect(projectPreservesLocalWork(local, editedOverlap)).toBe(false);
      const localBranch = createCheckpoint(local, 'Device save');
      expect(chooseProjectDocument(localBranch, remote).choice).toBe(
        'diverged'
      );
      expect(
        projectPreservesLocalWork(local, {
          ...remote,
          checkpoints: remote.checkpoints.slice(1)
        })
      ).toBe(false);
    }
  );

  it('recognizes interrupted adoption at the checkpoint limit without accepting other edits', () => {
    const local = fullSaveWindow();
    const remote = adoptProjectDocument(local, toUserId('user_account'));
    expect(remote.checkpoints).toHaveLength(MAX_PROJECT_CHECKPOINTS);
    expect(projectMatchesInterruptedAdoption(local, remote)).toBe(true);
    expect(chooseProjectDocument(local, remote).choice).toBe('remote');
    expect(
      projectMatchesInterruptedAdoption(
        { ...local, name: 'Device edit' },
        remote
      )
    ).toBe(false);
    const editedOverlap = structuredClone(remote);
    editedOverlap.checkpoints[0]!.reason = 'Different history';
    expect(projectMatchesInterruptedAdoption(local, editedOverlap)).toBe(false);
  });

  it('does not retry a richer local history behind the account version fence', () => {
    const remote = structuredClone(base);
    const local = {
      ...appendRevision(base, 'Saved locally'),
      version: base.version - 1
    };
    expect(chooseProjectDocument(local, remote)).toEqual({
      choice: 'diverged',
      local,
      remote
    });
  });
  it.each([null, base.version])(
    'adopts a saved-history extension at the same model version (baseline %s)',
    (baseline) => {
      const local = structuredClone(base);
      const remote = {
        ...structuredClone(base),
        checkpoints: [
          ...base.checkpoints,
          {
            checkpointId: 'cp_account',
            revisionId: base.revisions.at(-1)!.revisionId,
            documentVersion: base.version,
            reason: 'Before drilling',
            createdAt: '2026-10-05T05:00:00Z'
          }
        ]
      } as ProjectDocument;
      expect(chooseProjectDocument(local, remote, baseline)).toEqual({
        choice: 'remote',
        document: remote
      });
      expect(chooseProjectDocument(remote, local, baseline)).toEqual({
        choice: 'local',
        document: remote
      });
      const divergent = {
        ...local,
        checkpoints: [
          ...local.checkpoints,
          {
            ...remote.checkpoints.at(-1)!,
            checkpointId: 'cp_device',
            reason: 'Before rounding'
          }
        ]
      };
      expect(chooseProjectDocument(divergent, remote, baseline).choice).toBe(
        'diverged'
      );
    }
  );
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

  describe('a -0 coordinate, which the account copy stores as 0', () => {
    /** A circle centred a hair left of the Y axis, snapped to x = -0. */
    function withNegativeZero(): ProjectDocument {
      const manager = new CommandManager(
        createProjectDocument('Negative zero', owner),
        owner
      );
      manager.execute(
        commandFactories.addSketch({
          name: 'Sketch 01',
          planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
          objects: [
            { objectKind: 'circle', radius: 5, centerX: -0, centerY: 12 }
          ]
        })
      );
      return {
        ...manager.document,
        derived: { ...manager.document.derived, exportableBodyIds: ['marker'] }
      } as ProjectDocument;
    }
    /** IndexedDB keeps -0 (structured clone); the account stores JSON. */
    const accountCopy = (document: ProjectDocument) =>
      JSON.parse(
        JSON.stringify(withoutDerivedProjection(document))
      ) as ProjectDocument;

    it('compares as the same work', () => {
      const local = withNegativeZero();
      const circle = Object.values(local.nodes).find(
        (node) => node.kind === 'sketch-object'
      );
      expect(
        circle?.kind === 'sketch-object' &&
          circle.data.objectKind === 'circle' &&
          Object.is(circle.data.centerX, -0)
      ).toBe(true);
      expect(projectsHaveSameCanonicalContent(local, accountCopy(local))).toBe(
        true
      );
    });

    it('reopens an autosaved project without a conflict', () => {
      const local = withNegativeZero();
      expect(
        chooseProjectDocument(
          structuredClone(local),
          accountCopy(local),
          local.version
        ).choice
      ).toBe('remote');
    });

    it('keeps the device meshes on the save echo', () => {
      const local = withNegativeZero();
      expect(
        withMatchingLocalDerived(accountCopy(local), local).derived
          .exportableBodyIds
      ).toEqual(['marker']);
    });
  });

  it('keeps the device meshes for a room document that changed only drawings', () => {
    const local = {
      ...at(4),
      derived: {
        ...at(4).derived,
        exportableBodyIds: ['marker'],
        datumFrames: { feat_plane: { marker: true } },
        datumAxes: { feat_axis: { marker: true } }
      }
    } as unknown as ProjectDocument;
    const sheet = {
      sheetId: 'dsht_room',
      name: 'Sheet 1',
      paper: { size: 'A3', orientation: 'landscape' },
      scale: { numerator: 1, denominator: 1 },
      projectionAngle: 'first',
      titleBlock: {},
      source: { fingerprint: 'v1:room' },
      views: []
    } as unknown as NonNullable<ProjectDocument['drawings']>['sheets'][number];
    // A collaborator's sheet edit: the same model, a new sheet, the undo
    // entry that edit records, no meshes.
    const remote = {
      ...at(5, { name: 'Bracket v4' }),
      drawings: { sheets: [sheet] },
      editHistory: {
        undo: [{ actor: 'user_collaborator', kinds: ['drawing.sheet.add'] }],
        redo: []
      } as unknown as ProjectDocument['editHistory']
    } as ProjectDocument;
    const merged = withMatchingLocalDerived(remote, local);
    expect(merged.derived.exportableBodyIds).toEqual(['marker']);
    // Datum planes and axes are geometry the room strips too.
    expect(merged.derived.datumFrames).toEqual(local.derived.datumFrames);
    expect(merged.derived.datumAxes).toEqual(local.derived.datumAxes);
    expect(merged.drawings).toEqual(remote.drawings);
    // The drawing edit is still real work: not a metadata-only update.
    expect(projectPreservesLocalWork(local, remote)).toBe(false);
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
