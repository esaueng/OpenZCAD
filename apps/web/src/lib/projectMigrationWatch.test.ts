import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  E2eeMigrationState,
  E2eeProjectMigrationResponse
} from '@openzcad/shared';
import {
  migrationElsewhere,
  migrationLockedProjects,
  noteProjectMigrating,
  setMigratingProjects
} from './migrationStatus';
import {
  MIGRATION_WATCH_INTERVAL_MS,
  watchProjectMigration
} from './projectMigrationWatch';

const PROJECT = 'proj_watched';

function answer(
  state: E2eeMigrationState | null
): E2eeProjectMigrationResponse {
  return {
    migration:
      state === null
        ? null
        : ({ projectId: PROJECT, direction: 'encrypt', state } as never)
  };
}

class Target {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function watch(
  state: () => E2eeMigrationState | null,
  open = true,
  options: { visible?: () => boolean } = {}
) {
  const status = vi.fn(async (_projectId: string) => answer(state()));
  const focus = new Target();
  const visibility = new Target();
  const stop = watchProjectMigration({
    projectId: PROJECT,
    status,
    migrationOpen: async () => open,
    focusTarget: focus,
    visibilityTarget: visibility,
    isVisible: options.visible ?? (() => true)
  });
  return { status, focus, visibility, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setMigratingProjects([]);
});

describe('watching an open plaintext project for a migration elsewhere', () => {
  it('locks at once when the room closes for the move, and lifts after an abandon', async () => {
    // Migration is not open to this account by the config's word, so it
    // polls nothing; the room closing is news enough to ask.
    let state: E2eeMigrationState | null = 'staging';
    const { status, focus, stop } = watch(() => state, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(status).not.toHaveBeenCalled();

    noteProjectMigrating(PROJECT);
    // Read-only before any answer: nothing is edited meanwhile.
    expect([...migrationLockedProjects()]).toEqual([PROJECT]);
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    expect([...migrationLockedProjects()]).toEqual([PROJECT]);

    // Abandoned: the next look (on focus, while it is locked) lifts it.
    state = 'abandoned';
    await vi.advanceTimersByTimeAsync(6_000);
    focus.fire('focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(2);
    expect([...migrationLockedProjects()]).toEqual([]);
    stop();
  });

  it('locks when the status asked on open reports a staging, and lifts once it is abandoned', async () => {
    let state: E2eeMigrationState | null = 'staging';
    const { status, stop } = watch(() => state);
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledWith(PROJECT);
    expect([...migrationElsewhere()]).toEqual([PROJECT]);
    expect([...migrationLockedProjects()]).toEqual([PROJECT]);

    // Still staging at the next poll; abandoned at the one after.
    await vi.advanceTimersByTimeAsync(MIGRATION_WATCH_INTERVAL_MS);
    expect(status).toHaveBeenCalledTimes(2);
    expect([...migrationLockedProjects()]).toEqual([PROJECT]);
    state = 'abandoned';
    await vi.advanceTimersByTimeAsync(MIGRATION_WATCH_INTERVAL_MS);
    expect(status).toHaveBeenCalledTimes(3);
    expect([...migrationLockedProjects()]).toEqual([]);
    stop();
  });

  it('locks on a cutover or purge as well, and on nothing else', async () => {
    let state: E2eeMigrationState | null = null;
    const { status, focus, stop } = watch(() => state);
    await vi.advanceTimersByTimeAsync(0);
    expect([...migrationLockedProjects()]).toEqual([]);
    for (const [next, locked] of [
      ['cutover', true],
      ['abandoned', false],
      ['purging', true]
    ] as const) {
      state = next;
      await vi.advanceTimersByTimeAsync(10_000);
      focus.fire('focus');
      await vi.advanceTimersByTimeAsync(0);
      expect(migrationElsewhere().has(PROJECT), next).toBe(locked);
    }
    expect(status).toHaveBeenCalledTimes(4);
    stop();
  });

  it('asks again when the page regains focus or becomes visible, at most every few seconds', async () => {
    let state: E2eeMigrationState | null = null;
    const { status, focus, visibility, stop } = watch(() => state);
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    state = 'staging';
    // Too soon after the last question.
    focus.fire('focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    visibility.fire('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(2);
    expect([...migrationLockedProjects()]).toEqual([PROJECT]);
    stop();
  });

  it('sends nothing for an account migration is not open to', async () => {
    const { status, focus, stop } = watch(() => 'staging', false);
    await vi.advanceTimersByTimeAsync(MIGRATION_WATCH_INTERVAL_MS * 4);
    focus.fire('focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(status).not.toHaveBeenCalled();
    expect([...migrationLockedProjects()]).toEqual([]);
    stop();
  });

  it('polls nothing while the page is hidden', async () => {
    let visible = true;
    const { status, stop } = watch(() => null, true, {
      visible: () => visible
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    visible = false;
    await vi.advanceTimersByTimeAsync(MIGRATION_WATCH_INTERVAL_MS * 3);
    expect(status).toHaveBeenCalledTimes(1);
    stop();
  });

  it('drops an answer from before the room closed, and asks again', async () => {
    // A poll in flight when the staging begins answers "none": it must not
    // lift the lock the room's close just set.
    let release!: () => void;
    let first = true;
    const status = vi.fn(async () => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return answer(null);
      }
      return answer('staging');
    });
    const stop = watchProjectMigration({
      projectId: PROJECT,
      status,
      migrationOpen: async () => true,
      focusTarget: null,
      visibilityTarget: null,
      isVisible: () => true
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(1);
    noteProjectMigrating(PROJECT);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(status).toHaveBeenCalledTimes(2);
    expect([...migrationLockedProjects()]).toEqual([PROJECT]);
    stop();
  });

  it('asks again when this page’s own run stops locking the project', async () => {
    // A cancel here abandoned the staging another tab's lock came from.
    let state: E2eeMigrationState | null = 'staging';
    const { status, stop } = watch(() => state);
    setMigratingProjects([], [PROJECT]);
    await vi.advanceTimersByTimeAsync(0);
    expect([...migrationElsewhere()]).toEqual([PROJECT]);
    const asked = status.mock.calls.length;
    state = 'abandoned';
    setMigratingProjects([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(status.mock.calls.length).toBe(asked + 1);
    expect([...migrationLockedProjects()]).toEqual([]);
    stop();
  });

  it('forgets its lock once the project closes', async () => {
    const { stop } = watch(() => 'staging');
    await vi.advanceTimersByTimeAsync(0);
    expect([...migrationLockedProjects()]).toEqual([PROJECT]);
    stop();
    expect([...migrationLockedProjects()]).toEqual([]);
  });
});
