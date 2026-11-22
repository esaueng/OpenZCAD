import { describe, expect, it } from 'vitest';
import type { ProjectDocument } from '@openzcad/shared';
import { toUserId } from '@openzcad/shared';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  createRoomContext,
  createTestRoom,
  settleRoom,
  type FakeRoomStorage
} from './collaboration-room-harness';

/**
 * Each plaintext commit stores the new version's history key, `room:latest`
 * and `room:meta` in one batch. The previous latest was stored under its own
 * history key by the commit that made it latest, so a later commit must not
 * write that unchanged value again (one row and one full-document write per
 * commit) unless storage is not known to hold it.
 */

const MAX_ROOM_HISTORY = 20;

function roomRequest(
  document: ProjectDocument,
  body: Record<string, unknown>
): Request {
  return new Request(`https://room.test/?projectId=${document.projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openzcad-user-id': 'user_room',
      'x-openzcad-display-name': 'Room user',
      'x-openzcad-project-role': 'owner'
    },
    body: JSON.stringify(body)
  });
}

interface StorageLog {
  puts: string[][];
  deletes: string[][];
  reset(): void;
}

/** Records the keys of every `put` batch and `delete` the room issues. */
function countWrites(storage: FakeRoomStorage): StorageLog {
  const log: StorageLog = {
    puts: [],
    deletes: [],
    reset() {
      log.puts = [];
      log.deletes = [];
    }
  };
  const target = storage.context.storage;
  const put = target.put.bind(target);
  const remove = target.delete.bind(target);
  target.put = async (keyOrEntries: unknown, value?: unknown) => {
    log.puts.push(
      typeof keyOrEntries === 'string'
        ? [keyOrEntries]
        : Object.keys(keyOrEntries as Record<string, unknown>).sort()
    );
    return put(keyOrEntries, value);
  };
  target.delete = async (keyOrKeys: string | string[]) => {
    log.deletes.push(Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]);
    return remove(keyOrKeys);
  };
  return log;
}

function seed(name: string): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_room')),
    {
      name: 'Seed',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    }
  );
}

function nextVersion(document: ProjectDocument, step: number): ProjectDocument {
  return addPrimitiveFeature(
    { ...document },
    {
      name: `Step ${step}`,
      primitiveKind: 'box',
      dimensions: { width: step + 1, height: 1, depth: 1 }
    }
  );
}

async function commit(
  room: ReturnType<typeof createTestRoom>,
  document: ProjectDocument
): Promise<void> {
  const response = await room.fetch(
    roomRequest(document, {
      clientId: 'client_history',
      document,
      baseVersion: null
    })
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    type: 'ack',
    version: document.version
  });
}

function commitKeys(version: number): string[] {
  return [`room:history:${version}`, 'room:latest', 'room:meta'].sort();
}

describe('collaboration room history writes', () => {
  it('writes only the new version, latest and meta on a later commit', async () => {
    const storage = createRoomContext();
    const log = countWrites(storage);
    const room = createTestRoom(storage.context, {});
    const first = seed('History Room');
    const second = nextVersion(first, 1);
    const third = nextVersion(second, 2);
    await commit(room, first);
    await commit(room, second);

    log.reset();
    await commit(room, third);

    expect(log.puts).toEqual([commitKeys(third.version)]);
    expect(log.deletes).toEqual([]);
    // The skipped key still holds the version, exactly as committed.
    expect(storage.values.get(`room:history:${second.version}`)).toEqual(
      second
    );
  });

  it('skips the rewrite after a reload, before history was loaded', async () => {
    const storage = createRoomContext();
    const log = countWrites(storage);
    const first = seed('Woken Room');
    const second = nextVersion(first, 1);
    const third = nextVersion(second, 2);
    const room = createTestRoom(storage.context, {});
    await commit(room, first);
    await commit(room, second);

    const woken = createTestRoom(storage.context, {});
    await settleRoom(woken);
    log.reset();
    await commit(woken, third);

    expect(log.puts).toEqual([commitKeys(third.version)]);
    expect(storage.values.get('room:meta')).toMatchObject({
      latestVersion: third.version,
      historyVersions: [first.version, second.version, third.version]
    });
  });

  it('still writes a previous latest that storage has no history key for', async () => {
    const storage = createRoomContext();
    const log = countWrites(storage);
    const first = seed('Missing Key Room');
    const second = nextVersion(first, 1);
    const third = nextVersion(second, 2);
    const room = createTestRoom(storage.context, {});
    await commit(room, first);
    await commit(room, second);
    // The index advertises the version, but its key is gone.
    storage.values.delete(`room:history:${second.version}`);

    const woken = createTestRoom(storage.context, {});
    await settleRoom(woken);
    log.reset();
    await commit(woken, third);

    expect(log.puts).toEqual([
      [
        `room:history:${second.version}`,
        `room:history:${third.version}`,
        'room:latest',
        'room:meta'
      ].sort()
    ]);
    expect(storage.values.get(`room:history:${second.version}`)).toEqual(
      second
    );
  });

  it('writes a legacy latest that the migrated history lacks', async () => {
    const base = seed('Legacy Latest Room');
    const latest = nextVersion(base, 1);
    const next = nextVersion(latest, 2);
    const storage = createRoomContext(
      new Map<string, unknown>([
        [
          'room-state',
          {
            projectId: base.projectId,
            latestDocument: latest,
            history: [base]
          }
        ]
      ])
    );
    const room = createTestRoom(storage.context, {});
    await settleRoom(room);
    expect(storage.values.has(`room:history:${latest.version}`)).toBe(false);

    const log = countWrites(storage);
    await commit(room, next);

    expect(log.puts).toEqual([
      [
        `room:history:${latest.version}`,
        `room:history:${next.version}`,
        'room:latest',
        'room:meta'
      ].sort()
    ]);
    expect(storage.values.get(`room:history:${latest.version}`)).toEqual(
      latest
    );
    expect(storage.values.get('room:meta')).toMatchObject({
      historyVersions: [base.version, latest.version, next.version]
    });
  });

  it('skips a legacy latest that the migrated history already holds', async () => {
    const base = seed('Legacy Room');
    const latest = nextVersion(base, 1);
    const next = nextVersion(latest, 2);
    const storage = createRoomContext(
      new Map<string, unknown>([
        [
          'room-state',
          {
            projectId: base.projectId,
            latestDocument: latest,
            history: [base, latest]
          }
        ]
      ])
    );
    const room = createTestRoom(storage.context, {});
    await settleRoom(room);

    const log = countWrites(storage);
    await commit(room, next);

    expect(log.puts).toEqual([commitKeys(next.version)]);
    expect(storage.values.get(`room:history:${latest.version}`)).toEqual(
      latest
    );
  });

  it('keeps history and merge bases intact across a reload', async () => {
    const storage = createRoomContext();
    const room = createTestRoom(storage.context, {});
    const committed: ProjectDocument[] = [];
    let document = seed('Reload Room');
    for (let step = 0; step < 5; step += 1) {
      await commit(room, document);
      committed.push(document);
      document = nextVersion(document, step + 1);
    }

    for (const version of committed) {
      expect(storage.values.get(`room:history:${version.version}`)).toEqual(
        version
      );
    }
    expect(storage.values.get('room:meta')).toMatchObject({
      latestVersion: committed.at(-1)!.version,
      historyVersions: committed.map((entry) => entry.version)
    });

    const reloaded = createTestRoom(storage.context, {});
    const base = committed[1]!;
    const divergent = addPrimitiveFeature(base, {
      name: 'Divergent',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const conflict = (await (
      await reloaded.fetch(
        roomRequest(divergent, {
          clientId: 'client_stale',
          document: divergent,
          baseVersion: base.version
        })
      )
    ).json()) as { type: string; base?: ProjectDocument };
    // A clean three-way merge would also be acceptable, but either way the
    // room must have found this exact ancestor.
    if (conflict.type === 'conflict') expect(conflict.base).toEqual(base);
    else expect(conflict.type).toBe('ack');
  });

  it('evicts the oldest history key once the cap is reached', async () => {
    const storage = createRoomContext();
    const log = countWrites(storage);
    const room = createTestRoom(storage.context, {});
    const committed: ProjectDocument[] = [];
    let document = seed('Capped Room');
    for (let step = 0; step < MAX_ROOM_HISTORY; step += 1) {
      await commit(room, document);
      committed.push(document);
      document = nextVersion(document, step + 1);
    }

    log.reset();
    await commit(room, document);

    expect(log.puts).toEqual([commitKeys(document.version)]);
    expect(log.deletes).toEqual([[`room:history:${committed[0]!.version}`]]);
    const meta = storage.values.get('room:meta') as {
      historyVersions: number[];
    };
    expect(meta.historyVersions).toEqual(
      [...committed.slice(1), document].map((entry) => entry.version)
    );
    for (const version of meta.historyVersions)
      expect(storage.values.has(`room:history:${version}`)).toBe(true);
    expect(
      Array.from(storage.values.keys()).filter((key) =>
        key.startsWith('room:history:')
      )
    ).toHaveLength(MAX_ROOM_HISTORY);
  });
});
