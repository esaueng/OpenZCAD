import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  createRoomContext,
  createTestRoom,
  fireAlarm,
  installWorkerSocketGlobals,
  settleRoom,
  type FakeRoomStorage
} from './collaboration-room-harness';

/**
 * A plaintext room that has neither committed nor held a socket for seven
 * days keeps only its latest version. The trim runs from the room's alarm,
 * which commits move out at most once a day, so the alarm costs a write per
 * day of activity and one invocation per idle week, never one per commit.
 */

const DAY = 24 * 60 * 60 * 1000;
const OWNER = 'user_room';

let globals: ReturnType<typeof installWorkerSocketGlobals>;
beforeAll(() => {
  globals = installWorkerSocketGlobals();
});
afterAll(() => {
  globals.restore();
});
afterEach(() => {
  vi.restoreAllMocks();
});

let clock = Date.UTC(2026, 10, 1);
function setNow(at: number): void {
  clock = at;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
}

function session(name: string) {
  const manager = new CommandManager(
    createProjectDocument(name, toUserId(OWNER))
  );
  return {
    manager,
    box(label: string): ProjectDocument {
      return manager.execute(
        commandFactories.addPrimitive({
          name: label,
          primitiveKind: 'box',
          dimensions: { width: 1, height: 1, depth: 1 }
        })
      );
    }
  };
}

function snapshot(
  room: ReturnType<typeof createTestRoom>,
  document: ProjectDocument,
  baseVersion: number | null
): Promise<Response> {
  return room.fetch(
    new Request(`https://room.test/?projectId=${document.projectId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openzcad-user-id': OWNER,
        'x-openzcad-display-name': 'Room user',
        'x-openzcad-project-role': 'owner'
      },
      body: JSON.stringify({
        clientId: 'client_trim',
        document,
        baseVersion
      })
    })
  );
}

async function commit(
  room: ReturnType<typeof createTestRoom>,
  document: ProjectDocument,
  baseVersion: number | null
): Promise<void> {
  const response = await snapshot(room, document, baseVersion);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    type: 'ack',
    version: document.version
  });
}

function historyKeys(storage: FakeRoomStorage): string[] {
  return [...storage.values.keys()]
    .filter((key) => key.startsWith('room:history:'))
    .sort();
}

/** A room holding three committed versions of one editing line. */
async function threeVersionRoom(name: string) {
  setNow(Date.UTC(2026, 10, 1));
  const storage = createRoomContext();
  const room = createTestRoom(storage.context, {});
  const a = session(name);
  const first = a.box('One');
  const second = a.box('Two');
  const third = a.box('Three');
  await commit(room, first, null);
  await commit(room, second, first.version);
  await commit(room, third, second.version);
  return { storage, room, a, first, second, third };
}

describe('collaboration room idle history trim', () => {
  it('schedules one alarm and moves it at most once a day while committing', async () => {
    setNow(Date.UTC(2026, 10, 1));
    const start = clock;
    const storage = createRoomContext();
    const room = createTestRoom(storage.context, {});
    const a = session('Alarm cadence');
    const first = a.box('One');
    await commit(room, first, null);
    // One version: nothing to trim, so no alarm is written or even read.
    expect(storage.alarm).toEqual({ at: null, sets: [], reads: 0 });

    const second = a.box('Two');
    await commit(room, second, first.version);
    expect(storage.alarm.sets).toEqual([start + 8 * DAY]);

    // Commits within the slack leave the alarm alone, and the cached time
    // means they do not read it again either.
    setNow(start + 12 * 60 * 60 * 1000);
    const third = a.box('Three');
    await commit(room, third, second.version);
    expect(storage.alarm.sets).toEqual([start + 8 * DAY]);
    expect(storage.alarm.reads).toBe(1);

    // Past a day, the next commit moves it so it stays 7 days out at least.
    setNow(start + DAY + 1);
    const fourth = a.box('Four');
    await commit(room, fourth, third.version);
    expect(storage.alarm.sets).toEqual([
      start + 8 * DAY,
      start + DAY + 1 + 8 * DAY
    ]);
  });

  it('keeps only the latest version once the room is idle', async () => {
    const { storage, room, third } = await threeVersionRoom('Idle trim');
    storage.values.set('room:edit-lease', { untouched: true });
    const latestBefore = storage.values.get('room:latest');
    expect(historyKeys(storage)).toHaveLength(3);

    setNow(clock + 8 * DAY);
    await fireAlarm(storage, room);

    expect(historyKeys(storage)).toEqual([`room:history:${third.version}`]);
    expect(storage.values.get('room:latest')).toEqual(latestBefore);
    expect(storage.values.get('room:meta')).toMatchObject({
      latestVersion: third.version,
      historyVersions: [third.version]
    });
    expect(storage.values.get('room:edit-lease')).toEqual({ untouched: true });
    // A trimmed room holds one version, so it schedules nothing further.
    expect(storage.alarm.at).toBeNull();

    // The trimmed room reopens with its latest document and index intact.
    const woken = createTestRoom(storage.context, {});
    await settleRoom(woken);
    expect(storage.alarm.at).toBeNull();
    const next = new CommandManager(third).execute(
      commandFactories.addPrimitive({
        name: 'After trim',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    await commit(woken, next, third.version);
    expect(storage.values.get('room:meta')).toMatchObject({
      latestVersion: next.version,
      historyVersions: [third.version, next.version]
    });
  });

  it('reschedules without trimming while a socket is open', async () => {
    const { storage, room, first } = await threeVersionRoom('Busy room');
    const accepted = await room.fetch(
      new Request(`https://room.test/?projectId=${first.projectId}`, {
        headers: {
          upgrade: 'websocket',
          'x-openzcad-user-id': OWNER,
          'x-openzcad-display-name': 'Room user',
          'x-openzcad-project-role': 'owner'
        }
      })
    );
    expect(accepted.status).toBe(101);

    setNow(clock + 8 * DAY);
    await fireAlarm(storage, room);

    expect(historyKeys(storage)).toHaveLength(3);
    expect(storage.alarm.at).toBe(clock + 8 * DAY);
  });

  it('answers a client returning on a trimmed base with a conflict, never an overwrite', async () => {
    const { storage, room, first, third } =
      await threeVersionRoom('Stale return');
    // A client that left at the first version and edited offline once.
    const stale = new CommandManager(first).execute(
      commandFactories.addPrimitive({
        name: 'Offline',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 1, depth: 1 }
      })
    );
    // Before the trim the room hands back that base for a browser merge.
    const before = await snapshot(room, stale, first.version);
    expect(before.status).toBe(409);
    const beforeBody = (await before.json()) as {
      document: ProjectDocument;
      base?: ProjectDocument;
    };
    expect(beforeBody.base?.version).toBe(first.version);

    setNow(clock + 8 * DAY);
    await fireAlarm(storage, room);

    // After it the base is gone: still a conflict on the room's latest, only
    // without a base, so the browser falls back to its manual resolution.
    const after = await snapshot(room, stale, first.version);
    expect(after.status).toBe(409);
    const afterBody = (await after.json()) as {
      type: string;
      document: ProjectDocument;
      base?: ProjectDocument;
    };
    expect(afterBody.type).toBe('conflict');
    expect(afterBody.document.version).toBe(third.version);
    expect(afterBody.base).toBeUndefined();

    // Edited far enough offline to outrank the room numerically: refused too.
    const offline = new CommandManager(first);
    let ahead = first;
    for (const label of ['B1', 'B2', 'B3', 'B4'])
      ahead = offline.execute(
        commandFactories.addPrimitive({
          name: label,
          primitiveKind: 'box',
          dimensions: { width: 3, height: 1, depth: 1 }
        })
      );
    expect(ahead.version).toBeGreaterThan(third.version);
    const outranking = await snapshot(room, ahead, first.version);
    expect(outranking.status).toBe(409);

    // The room kept its own latest throughout, after a reload as well.
    const reloaded = createTestRoom(storage.context, {});
    await settleRoom(reloaded);
    const resumed = await snapshot(reloaded, stale, first.version);
    expect(resumed.status).toBe(409);
    expect(
      ((await resumed.json()) as { document: ProjectDocument }).document.version
    ).toBe(third.version);
    expect(storage.values.get('room:meta')).toMatchObject({
      latestVersion: third.version,
      historyVersions: [third.version]
    });
  });

  it('schedules the trim for a stored room that predates it, without moving a set alarm', async () => {
    const { storage } = await threeVersionRoom('Legacy alarm');
    storage.alarm.at = null;
    storage.alarm.sets = [];

    setNow(clock + 2 * DAY);
    await settleRoom(createTestRoom(storage.context, {}));
    expect(storage.alarm.sets).toEqual([clock + 8 * DAY]);

    // A later wake only reads it: waking is not a commit.
    setNow(clock + 3 * DAY);
    await settleRoom(createTestRoom(storage.context, {}));
    expect(storage.alarm.sets).toHaveLength(1);
  });

  it('does not trim when a commit queued ahead of the alarm rescheduled it', async () => {
    const { storage, room, third } = await threeVersionRoom('Queued commit');
    setNow(clock + 8 * DAY);
    // Hold the next commit inside the room queue at its storage write.
    const target = storage.context.storage;
    const put = target.put.bind(target);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const atPut = new Promise<void>((resolve) => {
      reached = resolve;
    });
    target.put = async (keyOrEntries: unknown, value?: unknown) => {
      target.put = put;
      reached();
      await gate;
      return put(keyOrEntries, value);
    };
    const next = new CommandManager(third).execute(
      commandFactories.addPrimitive({
        name: 'Racing',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const committing = commit(room, next, third.version);
    await atPut;
    const alarm = fireAlarm(storage, room);
    release();
    await Promise.all([committing, alarm]);

    expect(historyKeys(storage)).toHaveLength(4);
    expect(storage.alarm.at).toBe(clock + 8 * DAY);
  });

  it('reschedules when the last socket closed moments before the alarm', async () => {
    const { storage, room, first } = await threeVersionRoom('Just closed');
    setNow(clock + 8 * DAY - 60_000);
    const accepted = await room.fetch(
      new Request(`https://room.test/?projectId=${first.projectId}`, {
        headers: {
          upgrade: 'websocket',
          'x-openzcad-user-id': OWNER,
          'x-openzcad-display-name': 'Room user',
          'x-openzcad-project-role': 'owner'
        }
      })
    );
    expect(accepted.status).toBe(101);
    const socket = globals.serverSockets.at(-1)!;
    socket.close(1000, 'done');
    room.webSocketClose(socket as unknown as WebSocket);

    setNow(clock + 60_000);
    await fireAlarm(storage, room);

    expect(historyKeys(storage)).toHaveLength(3);
    expect(storage.alarm.at).toBe(clock + 8 * DAY);
  });

  it('schedules and trims a migrated room whose latest has no history entry', async () => {
    setNow(Date.UTC(2026, 10, 1));
    const a = session('Legacy layout');
    const older = a.box('One');
    const latest = a.box('Two');
    const storage = createRoomContext(
      new Map<string, unknown>([
        [
          'room-state',
          {
            projectId: older.projectId,
            latestDocument: latest,
            history: [older]
          }
        ]
      ])
    );
    const room = createTestRoom(storage.context, {});
    await settleRoom(room);
    expect(historyKeys(storage)).toEqual([`room:history:${older.version}`]);
    expect(storage.alarm.sets).toEqual([clock + 8 * DAY]);

    setNow(clock + 8 * DAY);
    await fireAlarm(storage, room);
    expect(historyKeys(storage)).toEqual([]);
    expect(storage.values.get('room:latest')).toEqual(latest);
    expect(storage.values.get('room:meta')).toMatchObject({
      latestVersion: latest.version,
      historyVersions: []
    });
  });

  it('clears the alarm when the room is erased', async () => {
    const { storage, room, first } = await threeVersionRoom('Erased room');
    expect(storage.alarm.at).not.toBeNull();
    const erased = await room.fetch(
      new Request(`https://room.test/?projectId=${first.projectId}`, {
        method: 'DELETE',
        headers: { 'x-openzcad-internal-project-erasure': 'v1' }
      })
    );
    expect(erased.status).toBe(204);
    expect(storage.alarm.at).toBeNull();
    // A late alarm on an erased room writes nothing.
    await fireAlarm(storage, room);
    expect(storage.values.size).toBe(0);
    expect(storage.alarm.at).toBeNull();
  });
});
