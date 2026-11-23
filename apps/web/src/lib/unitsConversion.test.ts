import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  convertDocumentUnits,
  createCheckpoint,
  createProjectDocument,
  estimateUnitsConvertUndo,
  restoreFromSaveState,
  unitsConvertFactor
} from '@openzcad/document-core';
import { CommandManager } from '@openzcad/command-system';
import {
  MAX_UNDO_BYTES,
  toUserId,
  type CollaborationMember,
  type ProjectDocument
} from '@openzcad/shared';
import { loadLocalSaveState, saveLocalProject } from './localProjectStore';
import { claimProjectOwnership } from './projectTabOwnership';
import { withLockManager } from '../test/fakeLockManager';
import {
  commitUnitsConversion,
  unitsConversionCollaborationRefusal,
  unitsConversionWriteAccess,
  type PreparedUnitsConversion,
  type ProjectStorageOwnership,
  type UnitsConversionCollaborationState,
  type UnitsConversionPersistence
} from './unitsConversion';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER = toUserId('user_units_commit');

/** A box with no persisted references: its payload needs no kernel. */
function boxDocument(): ProjectDocument {
  return createCheckpoint(
    addPrimitiveFeature(createProjectDocument('Bracket', USER, 'mm'), {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 10, depth: 20 }
    }),
    'First save'
  );
}

/** What the worker would return for `document` → inches. */
function preparedFor(document: ProjectDocument): PreparedUnitsConversion {
  const converted = convertDocumentUnits(document, 'inch');
  if (!converted.ok) throw new Error('refused');
  const payload = {
    from: 'mm' as const,
    to: 'inch' as const,
    factor: unitsConvertFactor('mm', 'inch'),
    references: {}
  };
  return {
    ok: true,
    payload,
    sourceVersion: document.version,
    report: converted.report,
    references: {
      factor: 1 / 25.4,
      sites: { topology: 0, hash: 0, profileId: 0, edgeEnd: 0 },
      geometry: { bodies: 1, volumes: 1, areas: 1, datums: 0, faces: 0 },
      timings: { source: 0, translate: 0, verify: 0 }
    },
    undo: estimateUnitsConvertUndo(document, payload, USER)
  };
}

/** Records each write together with what the manager held at that moment. */
function recordingPersistence(manager: CommandManager): {
  persistence: UnitsConversionPersistence;
  writes: { kind: string; document: ProjectDocument; managerUnits: string }[];
} {
  const writes: {
    kind: string;
    document: ProjectDocument;
    managerUnits: string;
  }[] = [];
  return {
    writes,
    persistence: {
      async saveProject(document) {
        writes.push({
          kind: 'project',
          document,
          managerUnits: manager.document.units
        });
        await saveLocalProject(document);
      },
      async saveSaveStates(documents) {
        for (const document of documents)
          writes.push({
            kind: 'save-state',
            document,
            managerUnits: manager.document.units
          });
      }
    }
  };
}

const member = (
  clientId: string,
  displayName: string
): CollaborationMember => ({
  clientId,
  userId: toUserId(`user_${clientId}`),
  displayName,
  status: 'active'
});

function liveRoom(
  overrides: Partial<UnitsConversionCollaborationState> = {}
): UnitsConversionCollaborationState {
  return {
    enabled: true,
    status: 'live',
    role: 'owner',
    lease: {
      leaseId: 'lease_1',
      projectId: 'project',
      clientId: 'me',
      userId: USER,
      expiresAt: 2_000
    },
    members: [member('me', 'Me')],
    clientId: 'me',
    ...overrides
  };
}

describe('commitUnitsConversion: the safety checkpoint (plan §5.3)', () => {
  it('persists "Before unit conversion (mm → in)" before applying, and restoring it restores millimetres', async () => {
    const source = boxDocument();
    await saveLocalProject(source);
    const manager = new CommandManager(source, USER);
    const { persistence, writes } = recordingPersistence(manager);

    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence
      }
    );
    if (!result.ok) throw new Error(result.refusals[0]!.message);

    // Written once, while the manager still held the millimetre document.
    expect(writes.map((write) => [write.kind, write.managerUnits])).toEqual([
      ['project', 'mm']
    ]);
    const checkpoint = result.checkpoint.checkpoints.at(-1)!;
    expect(checkpoint.reason).toBe('Before unit conversion (mm → in)');
    expect(result.checkpoint.units).toBe('mm');
    expect(result.checkpoint.revisions.at(-1)!.reason).toBe(
      'Before unit conversion (mm → in)'
    );

    // Converted after it: one more revision, the version still moving on.
    expect(manager.document.units).toBe('inch');
    expect(manager.document.version).toBeGreaterThan(result.checkpoint.version);
    expect(manager.document.revisions.at(-1)!.reason).toBe(
      'Convert stored units mm → in'
    );
    expect(manager.document.checkpoints.at(-1)).toEqual(checkpoint);
    expect(manager.document.commandLog.at(-1)!.kind).toBe('units.convert');
    expect(manager.undoLabel).toBe('Convert stored units mm → in');

    // The checkpoint is on disk, and restoring it brings millimetres back.
    const stored = await loadLocalSaveState(
      source.projectId,
      checkpoint.checkpointId
    );
    expect(stored?.units).toBe('mm');
    const restored = restoreFromSaveState(
      manager.document,
      stored!,
      'Restored “Before unit conversion (mm → in)”'
    );
    expect(restored.units).toBe('mm');
    expect(restored.nodes).toEqual(source.nodes);
    expect(restored.version).toBeGreaterThan(manager.document.version);
  });

  it('keeps a device-only checkpoint out of the shared document', async () => {
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    const { persistence, writes } = recordingPersistence(manager);
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        deviceOnlyHistory: true
      }
    );
    expect(result.ok).toBe(true);
    expect(writes.map((write) => [write.kind, write.managerUnits])).toEqual([
      ['save-state', 'mm']
    ]);
    expect(writes[0]!.document.checkpoints.at(-1)!.reason).toBe(
      'Before unit conversion (mm → in)'
    );
    expect(manager.document.checkpoints).toEqual(source.checkpoints);
    expect(manager.document.units).toBe('inch');
  });

  it('writes nothing and logs nothing when it refuses', async () => {
    const source = boxDocument();
    const cases: [
      string,
      ProjectDocument,
      Parameters<typeof commitUnitsConversion>[2]
    ][] = [
      [
        'other-editors',
        source,
        {
          collaboration: liveRoom({
            members: [member('me', 'Me'), member('b', 'Bo')]
          }),
          now: 1_000
        }
      ],
      // Prepared from an older version of the document.
      [
        'stale',
        addPrimitiveFeature(source, {
          name: 'Late',
          primitiveKind: 'box',
          dimensions: { width: 1, height: 1, depth: 1 }
        }),
        {}
      ]
    ];
    for (const [code, document, options] of cases) {
      const manager = new CommandManager(document, USER);
      const before = manager.document;
      const { persistence, writes } = recordingPersistence(manager);
      const result = await commitUnitsConversion(
        () => manager,
        preparedFor(source),
        {
          ...options,
          persistence
        }
      );
      expect(result).toMatchObject({ ok: false, refusals: [{ code }] });
      expect(writes).toEqual([]);
      expect(manager.document).toBe(before);
    }
  });
});

describe('commitUnitsConversion: eligibility while the checkpoint saves', () => {
  /** A persistence whose write runs `during` before it resolves. */
  function writing(
    manager: CommandManager,
    during: () => void
  ): ReturnType<typeof recordingPersistence> {
    const recording = recordingPersistence(manager);
    const { saveProject } = recording.persistence;
    return {
      ...recording,
      persistence: {
        ...recording.persistence,
        async saveProject(document) {
          await saveProject(document);
          during();
        }
      }
    };
  }

  it('refuses when another tab joins during the write, keeping the checkpoint', async () => {
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    // The workspace's room state, updated in place as presence arrives.
    const room = liveRoom();
    const { persistence, writes } = writing(manager, () => {
      room.members = [member('me', 'Me'), member('tab2', 'Me')];
    });
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        collaboration: room,
        now: 1_000
      }
    );
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ stage: 'collaboration', code: 'other-editors' }]
    });
    // The checkpoint was written and stays: it names the unconverted model.
    expect(writes).toHaveLength(1);
    if (result.ok) return;
    expect(result.checkpoint?.units).toBe('mm');
    expect(result.checkpoint?.checkpoints.at(-1)!.reason).toBe(
      'Before unit conversion (mm → in)'
    );
    expect(manager.document).toBe(source);
    expect(manager.document.commandLog.at(-1)?.kind).not.toBe('units.convert');
  });

  it('refuses when the lease expires during the write', async () => {
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    let clock = 1_000;
    const { persistence, writes } = writing(manager, () => {
      clock = 2_500;
    });
    // Read through functions, as the workspace passes its latest state.
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        collaboration: () => liveRoom(),
        now: () => clock
      }
    );
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ stage: 'collaboration', code: 'editor-lock' }]
    });
    expect(writes).toHaveLength(1);
    expect(manager.document).toBe(source);
  });

  it('converts when nothing changed during the write', async () => {
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    const { persistence } = writing(manager, () => {});
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        collaboration: () => liveRoom(),
        now: () => 1_000
      }
    );
    expect(result.ok).toBe(true);
    expect(manager.document.units).toBe('inch');
  });

  it('refuses when a sync revision replaces the workspace manager during the write', async () => {
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    let active = manager;
    // An incoming revision, hydrated into a new manager as the workspace
    // does; the detached one still holds the captured document.
    const incoming = addPrimitiveFeature(source, {
      name: 'Remote',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 2, depth: 2 }
    });
    const { persistence, writes } = writing(manager, () => {
      active = new CommandManager(incoming, USER);
    });
    const result = await commitUnitsConversion(
      () => active,
      preparedFor(source),
      { persistence }
    );
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ stage: 'payload', code: 'stale' }]
    });
    expect(writes).toHaveLength(1);
    // Nothing applied: neither the detached manager nor the active one.
    expect(manager.document).toBe(source);
    expect(active.document).toBe(incoming);
    expect(active.document.units).toBe('mm');
  });

  it('refuses when there is no active manager to convert', async () => {
    const source = boxDocument();
    const { persistence, writes } = recordingPersistence(
      new CommandManager(source, USER)
    );
    const result = await commitUnitsConversion(
      () => null,
      preparedFor(source),
      {
        persistence
      }
    );
    expect(result).toMatchObject({ ok: false, refusals: [{ code: 'stale' }] });
    expect(writes).toEqual([]);
  });
});

describe('commitUnitsConversion: bound to the project it was prepared for', () => {
  /** Another project, same version and unit: phase 5's other checks pass. */
  function twin() {
    const source = boxDocument();
    const other = boxDocument();
    expect(other.projectId).not.toBe(source.projectId);
    expect(other.version).toBe(source.version);
    return { source, other };
  }

  it('converts another project with the same version when nothing binds it', async () => {
    // The hazard the binding closes: without it, a project switched to
    // while the worker ran is accepted.
    const { source, other } = twin();
    const manager = new CommandManager(other, USER);
    const { persistence } = recordingPersistence(manager);
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      { persistence }
    );
    expect(result.ok).toBe(true);
  });

  it('refuses another project before writing the checkpoint', async () => {
    const { source, other } = twin();
    const manager = new CommandManager(other, USER);
    const { persistence, writes } = recordingPersistence(manager);
    const confirmWriteAccess = vi.fn(async () => null);
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        expectedProjectId: source.projectId,
        confirmWriteAccess
      }
    );
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ stage: 'payload', code: 'stale' }]
    });
    expect(result).not.toHaveProperty('checkpoint');
    expect(writes).toEqual([]);
    expect(confirmWriteAccess).not.toHaveBeenCalled();
    expect(manager.document).toBe(other);
  });

  it('refuses another document of the same project and version', async () => {
    const source = boxDocument();
    // A hydrated revision: equal content, a different document.
    const manager = new CommandManager(structuredClone(source), USER);
    const { persistence, writes } = recordingPersistence(manager);
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        expectedProjectId: source.projectId,
        expectedDocument: source
      }
    );
    expect(result).toMatchObject({ ok: false, refusals: [{ code: 'stale' }] });
    expect(writes).toEqual([]);
    expect(manager.document.units).toBe('mm');
  });

  it('converts the prepared document after a rebuild re-attached its derived state', async () => {
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    // What the workspace's geometry sync does while the worker checks.
    manager.commitDerivedState({ ...source.derived, updatedAt: 'later' });
    expect(manager.document).not.toBe(source);
    const { persistence } = recordingPersistence(manager);
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        expectedProjectId: source.projectId,
        expectedDocument: source
      }
    );
    expect(result.ok).toBe(true);
  });

  it('converts the document it was prepared from', async () => {
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    const { persistence } = recordingPersistence(manager);
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        expectedProjectId: source.projectId,
        expectedDocument: source,
        confirmWriteAccess: async () => null
      }
    );
    expect(result.ok).toBe(true);
    expect(manager.document.units).toBe('inch');
  });
});

describe('commitUnitsConversion: storage ownership before the checkpoint', () => {
  it('writes nothing when this tab does not own the project', async () => {
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    const { persistence, writes } = recordingPersistence(manager);
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        confirmWriteAccess: async () => ({
          stage: 'collaboration',
          code: 'second-tab',
          subject: 'document',
          message: 'Open in another tab.'
        })
      }
    );
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ code: 'second-tab' }]
    });
    expect(writes).toEqual([]);
    expect(manager.document).toBe(source);
  });

  it('refuses, writing nothing, when the project switches while ownership is confirmed', async () => {
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    let active = manager;
    const { persistence, writes } = recordingPersistence(manager);
    const result = await commitUnitsConversion(
      () => active,
      preparedFor(source),
      {
        persistence,
        expectedProjectId: source.projectId,
        async confirmWriteAccess() {
          active = new CommandManager(boxDocument(), USER);
          return null;
        }
      }
    );
    expect(result).toMatchObject({ ok: false, refusals: [{ code: 'stale' }] });
    expect(writes).toEqual([]);
    expect(active.document.units).toBe('mm');
  });
});

describe('unitsConversionWriteAccess', () => {
  const claim = (
    projectId: string,
    settle: (record: ProjectStorageOwnership) => void
  ) => {
    const record: ProjectStorageOwnership & { holds: number } = {
      projectId,
      owned: false,
      settled: Promise.resolve(),
      holds: 0,
      retain: () => {
        if (!record.owned) return null;
        record.holds += 1;
        return () => (record.holds -= 1);
      }
    };
    record.settled = Promise.resolve().then(() => settle(record));
    return record;
  };

  it('grants the write, holding the claim, once this tab’s claim is confirmed held', async () => {
    const record = claim('copy', (r) => (r.owned = true));
    const access = await unitsConversionWriteAccess(() => record, 'copy', 'no');
    expect(access).toMatchObject({ kind: 'write-access' });
    if (!('held' in access)) throw new Error('refused');
    expect(record.holds).toBe(1);
    expect(access.held()).toBe(true);
    access.release();
    expect(record.holds).toBe(0);
    // Given up by the workspace: no longer held.
    record.owned = false;
    expect(access.held()).toBe(false);
  });

  it('refuses when the claim settles owned by another tab', async () => {
    // The second tab opened the copy first: this tab's claim is pending
    // when asked, and answers "not owned".
    const record = claim('copy', () => undefined);
    expect(
      await unitsConversionWriteAccess(() => record, 'copy', 'Elsewhere.')
    ).toMatchObject({ code: 'second-tab', message: 'Elsewhere.' });
    expect(record.holds).toBe(0);
  });

  it('refuses a claim for another project, or none, without waiting', async () => {
    const record = claim('original', (r) => (r.owned = true));
    expect(
      await unitsConversionWriteAccess(() => record, 'copy', 'no')
    ).toMatchObject({ code: 'second-tab' });
    expect(
      await unitsConversionWriteAccess(() => null, 'copy', 'no')
    ).toMatchObject({ code: 'second-tab' });
  });

  it('refuses when the claim was replaced while it settled', async () => {
    let current: ProjectStorageOwnership | null = null;
    const record = claim('copy', (r) => {
      r.owned = true;
      current = null;
    });
    current = record;
    expect(
      await unitsConversionWriteAccess(() => current, 'copy', 'no')
    ).toMatchObject({ code: 'second-tab' });
    expect(record.holds).toBe(0);
  });
});

describe('commitUnitsConversion: the storage claim is held until the command runs', () => {
  /** The workspace's claim record, as App builds it over a real claim. */
  async function workspaceClaim(projectId: string) {
    let given: Awaited<ReturnType<typeof claimProjectOwnership>> | null = null;
    const ownership: ProjectStorageOwnership = {
      projectId,
      owned: false,
      settled: Promise.resolve(),
      retain: () => (ownership.owned && given ? given.retain() : null)
    };
    ownership.settled = claimProjectOwnership(projectId, () => undefined).then(
      (result) => {
        given = result;
        ownership.owned = result.owned;
      }
    );
    let current: ProjectStorageOwnership | null = ownership;
    await ownership.settled;
    return {
      read: () => current,
      /** What App's cleanup does when the tab leaves the project. */
      giveUp() {
        ownership.owned = false;
        current = null;
        given?.release();
      }
    };
  }

  it('refuses, writing nothing, when the claim is given up after it was confirmed', async () => {
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    const { persistence, writes } = recordingPersistence(manager);
    let given = false;
    const release = vi.fn();
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        writeAccessLostMessage: 'Open in another tab.',
        async confirmWriteAccess() {
          // Confirmed held; the tab then navigates away before the commit
          // continues.
          queueMicrotask(() => (given = true));
          return { kind: 'write-access', held: () => !given, release };
        }
      }
    );
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ code: 'second-tab', message: 'Open in another tab.' }]
    });
    expect(result).not.toHaveProperty('checkpoint');
    expect(writes).toEqual([]);
    expect(release).toHaveBeenCalled();
    expect(manager.document).toBe(source);
  });

  it('does not execute when the claim is given up while the checkpoint is written', async () => {
    withLockManager();
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    const tab = await workspaceClaim(source.projectId);
    // A second tab waiting for the project, as one opened beside it is.
    const promoted = vi.fn();
    const other = await claimProjectOwnership(source.projectId, promoted);
    expect(other.owned).toBe(false);

    let finishWrite: () => void = () => undefined;
    const writes: ProjectDocument[] = [];
    const persistence: UnitsConversionPersistence = {
      async saveProject(document) {
        writes.push(document);
        await new Promise<void>((resolve) => (finishWrite = resolve));
      },
      async saveSaveStates() {}
    };
    const committing = commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        writeAccessLostMessage: 'Open in another tab.',
        confirmWriteAccess: (document) =>
          unitsConversionWriteAccess(tab.read, document.projectId, 'no')
      }
    );
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    // The tab leaves the project mid-write: the waiting tab must not take
    // it (and save) before this write has landed.
    tab.giveUp();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promoted).not.toHaveBeenCalled();

    finishWrite();
    const result = await committing;
    expect(result).toMatchObject({
      ok: false,
      checkpoint: writes[0],
      refusals: [{ code: 'second-tab', message: 'Open in another tab.' }]
    });
    expect(manager.document).toBe(source);
    expect(manager.document.units).toBe('mm');
    // The write landed; only now is the project handed on.
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));
    other.release();
  });

  it('converts, and lets the claim go after the write, while the claim stays held', async () => {
    withLockManager();
    const source = boxDocument();
    const manager = new CommandManager(source, USER);
    const tab = await workspaceClaim(source.projectId);
    const { persistence } = recordingPersistence(manager);
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      {
        persistence,
        confirmWriteAccess: (document) =>
          unitsConversionWriteAccess(tab.read, document.projectId, 'no')
      }
    );
    expect(result.ok).toBe(true);
    expect(manager.document.units).toBe('inch');
    // Nothing still retains the lock: giving the project up hands it on.
    const promoted = vi.fn();
    const other = await claimProjectOwnership(source.projectId, promoted);
    tab.giveUp();
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));
    other.release();
  });
});

describe('commitUnitsConversion: the undo step is kept (plan §5.2)', () => {
  /** A longer member id: the history envelope carries the actor once. */
  const MEMBER = toUserId(`user_units_member_${'m'.repeat(40)}`);

  /**
   * The box document padded so the conversion's undo history, measured for
   * the owner, is exactly `MAX_UNDO_BYTES`: kept for the owner, one actor
   * id too long for the member.
   */
  function documentAtBound(): ProjectDocument {
    const plain = boxDocument();
    const boxId = Object.keys(plain.nodes).find(
      (id) => plain.nodes[id]!.name === 'Box'
    )!;
    const named = (length: number) =>
      ({
        ...plain,
        nodes: {
          ...plain.nodes,
          [boxId]: { ...plain.nodes[boxId]!, name: 'x'.repeat(length) }
        }
      }) as ProjectDocument;
    const bytes = (length: number) => {
      const document = named(length);
      return estimateUnitsConvertUndo(
        document,
        preparedFor(document).payload,
        USER
      ).historyBytes;
    };
    const base = 3_000_000;
    const slope = (bytes(base + 1_000) - bytes(base)) / 1_000;
    const length = base + Math.floor((MAX_UNDO_BYTES - bytes(base)) / slope);
    const document = named(length);
    const measured = bytes(length);
    if (
      measured > MAX_UNDO_BYTES ||
      measured + (MEMBER.length - USER.length) <= MAX_UNDO_BYTES
    )
      throw new Error(`padding missed the bound: ${measured}`);
    return document;
  }

  it('refuses when the committing actor’s undo history could not keep the entry', async () => {
    const source = documentAtBound();
    // Prepared (and measured) for the owner; committed by a member.
    const prepared = preparedFor(source);
    expect(prepared.undo.exceedsLimit).toBe(false);
    const manager = new CommandManager(source, MEMBER);
    const { persistence, writes } = recordingPersistence(manager);
    const result = await commitUnitsConversion(() => manager, prepared, {
      persistence,
      deviceOnlyHistory: true
    });
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ stage: 'payload', code: 'undo-too-large' }]
    });
    expect(manager.document).toBe(source);
    expect(manager.document.units).toBe('mm');
    // Refused before the checkpoint was written.
    expect(writes).toEqual([]);
  });

  it('converts for the owner the same entry fits, keeping one undo step', async () => {
    const source = documentAtBound();
    const manager = new CommandManager(source, USER);
    const { persistence } = recordingPersistence(manager);
    const result = await commitUnitsConversion(
      () => manager,
      preparedFor(source),
      { persistence, deviceOnlyHistory: true }
    );
    expect(result.ok).toBe(true);
    expect(manager.document.units).toBe('inch');
    expect(manager.undoLabel).toBe('Convert stored units mm → in');
  });

  it('refuses when the history changed after preparation so the entry no longer fits', async () => {
    const source = documentAtBound();
    const prepared = preparedFor(source);
    // This actor's history moved on after preparation: its trimmed counter
    // now takes 15 more digits of the envelope the bound measures.
    const manager = new CommandManager(
      {
        ...source,
        editHistory: {
          schemaVersion: 1,
          projectId: source.projectId,
          actorUserId: USER,
          entries: [],
          cursor: 0,
          trimmed: 1_000_000_000_000_000
        }
      },
      USER
    );
    const before = manager.document;
    const { persistence } = recordingPersistence(manager);
    const result = await commitUnitsConversion(() => manager, prepared, {
      persistence,
      deviceOnlyHistory: true
    });
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ code: 'undo-too-large' }]
    });
    expect(manager.document).toBe(before);
  });
});

describe('unitsConversionCollaborationRefusal (ADR-007, ADR-019)', () => {
  it('lets a project without a room convert', () => {
    expect(unitsConversionCollaborationRefusal(null)).toBeNull();
    expect(
      unitsConversionCollaborationRefusal(
        liveRoom({ enabled: false, status: 'offline', members: [] })
      )
    ).toBeNull();
  });

  it('lets the only live editor with the lock convert', () => {
    expect(unitsConversionCollaborationRefusal(liveRoom(), 1_000)).toBeNull();
    // A room that does not enforce leases grants none: presence decides.
    expect(
      unitsConversionCollaborationRefusal(liveRoom({ lease: null }), 1_000)
    ).toBeNull();
  });

  it('refuses viewers, a room that is not live, and a lock held elsewhere', () => {
    const code = (state: UnitsConversionCollaborationState, now = 1_000) =>
      unitsConversionCollaborationRefusal(state, now)?.code;
    expect(code(liveRoom({ role: 'viewer' }))).toBe('viewer');
    expect(code(liveRoom({ status: 'connecting' }))).toBe('not-live');
    expect(code(liveRoom({ status: 'offline' }))).toBe('not-live');
    expect(code(liveRoom({ status: 'conflict' }))).toBe('not-live');
    expect(code(liveRoom({ status: 'lease-denied' }))).toBe('editor-lock');
    expect(code(liveRoom(), 3_000)).toBe('editor-lock');
  });

  it('refuses while anyone else has the project open, naming them', () => {
    const refusal = unitsConversionCollaborationRefusal(
      liveRoom({
        members: [
          member('me', 'Me'),
          { ...member('b', 'Bo'), status: 'idle' },
          member('c', 'Cy')
        ]
      }),
      1_000
    );
    expect(refusal).toMatchObject({
      stage: 'collaboration',
      code: 'other-editors',
      subject: 'document'
    });
    expect(refusal!.message).toContain('Bo, Cy have this project open');
    // The same account in another tab is another client.
    expect(
      unitsConversionCollaborationRefusal(
        liveRoom({ members: [member('me', 'Me'), member('tab2', 'Me')] }),
        1_000
      )?.code
    ).toBe('other-editors');
  });
});
