import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
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
  toUserId,
  type CollaborationMember,
  type ProjectDocument
} from '@openzcad/shared';
import { loadLocalSaveState, saveLocalProject } from './localProjectStore';
import {
  commitUnitsConversion,
  unitsConversionCollaborationRefusal,
  type PreparedUnitsConversion,
  type UnitsConversionCollaborationState,
  type UnitsConversionPersistence
} from './unitsConversion';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
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

    const result = await commitUnitsConversion(manager, preparedFor(source), {
      persistence
    });
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
    const result = await commitUnitsConversion(manager, preparedFor(source), {
      persistence,
      deviceOnlyHistory: true
    });
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
      const result = await commitUnitsConversion(manager, preparedFor(source), {
        ...options,
        persistence
      });
      expect(result).toMatchObject({ ok: false, refusals: [{ code }] });
      expect(writes).toEqual([]);
      expect(manager.document).toBe(before);
    }
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
