import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type SaveProjectDocumentResponse
} from '@openzcad/shared';
import { ApiError } from '../apps/web/src/lib/api';
import {
  CloudProjectAutosave,
  PROJECT_AUTOSAVE_IDLE_MS,
  PROJECT_AUTOSAVE_MAX_WAIT_MS,
  type CloudProjectAutosaveConnectivity,
  type CloudProjectAutosaveStatus
} from '../apps/web/src/lib/cloudProjectAutosave';

const owner = toUserId('user_owner');

function documentAt(version: number, base?: ProjectDocument): ProjectDocument {
  const source = base ?? createProjectDocument('Bracket', owner);
  return { ...source, version };
}

/** A promise the test releases by hand, to hold a save in flight. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => undefined as void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** A connectivity source the test drives, rather than the browser's. */
function testConnectivity(online = true) {
  const listeners = new Set<(online: boolean) => void>();
  let current = online;
  return {
    connectivity: {
      isOnline: () => current,
      subscribe(listener: (value: boolean) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    } satisfies CloudProjectAutosaveConnectivity,
    set(next: boolean) {
      current = next;
      for (const listener of listeners) {
        listener(next);
      }
    }
  };
}

interface Harness {
  controller: CloudProjectAutosave;
  saves: Array<{ expectedVersion: number; version: number }>;
  statuses: CloudProjectAutosaveStatus[];
  conflicts: Array<{ projectId: string; accountVersion: number }>;
  sessionExpiries: number;
  inFlight(): number;
  setConnectivity(online: boolean): void;
}

function harness(
  options: {
    respond?: (input: {
      expectedVersion: number;
      document: ProjectDocument;
    }) => Promise<SaveProjectDocumentResponse>;
    online?: boolean;
  } = {}
): Harness {
  const saves: Harness['saves'] = [];
  const statuses: CloudProjectAutosaveStatus[] = [];
  const conflicts: Harness['conflicts'] = [];
  const connection = testConnectivity(options.online ?? true);
  let concurrent = 0;
  let peak = 0;
  let sessionExpiries = 0;

  const controller = new CloudProjectAutosave({
    connectivity: connection.connectivity,
    idleDelayMs: PROJECT_AUTOSAVE_IDLE_MS,
    maxWaitMs: PROJECT_AUTOSAVE_MAX_WAIT_MS,
    retryDelayMs: 1_000,
    now: () => Date.now(),
    api: {
      async saveProjectDocument(input) {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        try {
          const response = options.respond
            ? await options.respond(input)
            : {
                projectId: input.document.projectId,
                version: input.document.version,
                updatedAt: '2026-01-01T00:00:00.000Z'
              };
          saves.push({
            expectedVersion: input.expectedVersion,
            version: response.version
          });
          return response;
        } finally {
          concurrent -= 1;
        }
      }
    },
    onStatus: (status) => statuses.push(status),
    onConflict: ({ projectId, accountVersion }) =>
      conflicts.push({ projectId, accountVersion }),
    onSessionExpired: () => {
      sessionExpiries += 1;
    }
  });

  return {
    controller,
    saves,
    statuses,
    conflicts,
    get sessionExpiries() {
      return sessionExpiries;
    },
    inFlight: () => peak,
    setConnectivity: connection.set
  };
}

const lastState = (statuses: CloudProjectAutosaveStatus[]) =>
  statuses.at(-1)?.state;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cloud project autosave — cadence', () => {
  it('waits out the idle delay before writing', async () => {
    const { controller, saves } = harness();
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);

    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS - 1);
    expect(saves).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await controller.whenIdle();
    expect(saves).toHaveLength(1);
    controller.dispose();
  });

  it('coalesces a burst of edits into one write of the newest document', async () => {
    const { controller, saves } = harness();
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);

    for (const version of [3, 4, 5, 6]) {
      controller.schedule(documentAt(version, document));
      await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS / 2);
    }
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();

    expect(saves).toHaveLength(1);
    expect(saves[0]?.version).toBe(6);
    controller.dispose();
  });

  it('writes anyway once the max wait elapses under continuous editing', async () => {
    // A two-minute drag never goes idle. Without the ceiling it would also
    // never sync, which is the failure this exists to prevent.
    const { controller, saves } = harness();
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);

    // Edits arrive twice per idle window, so the idle timer alone would never
    // fire. Over 1.5 max-wait windows exactly one write should be forced out.
    let version = 2;
    for (let elapsed = 0; elapsed < PROJECT_AUTOSAVE_MAX_WAIT_MS * 1.5;) {
      controller.schedule(documentAt(++version, document));
      await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS / 2);
      elapsed += PROJECT_AUTOSAVE_IDLE_MS / 2;
    }
    await controller.whenIdle();

    expect(saves).toHaveLength(1);
    expect(saves[0]?.expectedVersion).toBe(2);
    controller.dispose();
  });

  it('never runs two writes at once', async () => {
    const held = gate();
    const { controller, inFlight } = harness({
      respond: async (input) => {
        await held.wait;
        return {
          projectId: input.document.projectId,
          version: input.document.version,
          updatedAt: '2026-01-01T00:00:00.000Z'
        };
      }
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);

    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    controller.schedule(documentAt(4, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    held.open();
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();

    expect(inFlight()).toBe(1);
    controller.dispose();
  });

  it('fences each write against the version the account last acknowledged', async () => {
    const { controller, saves } = harness();
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);

    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();
    controller.schedule(documentAt(4, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();

    expect(saves.map((save) => save.expectedVersion)).toEqual([2, 3]);
    controller.dispose();
  });
});

describe('cloud project autosave — what it declines to do', () => {
  it('does not write a project the account does not hold', async () => {
    const { controller, saves, statuses } = harness();
    controller.schedule(documentAt(3));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS * 2);

    expect(saves).toHaveLength(0);
    expect(lastState(statuses)).toBe('local');
    controller.dispose();
  });

  it('drops a queued edit belonging to a project that was closed', async () => {
    const { controller, saves } = harness();
    const first = documentAt(2);
    const second = createProjectDocument('Other', owner);
    controller.openProject(first.projectId, 2);
    controller.schedule(documentAt(3, first));

    controller.openProject(second.projectId, 1);
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS * 2);
    await controller.whenIdle();

    expect(saves).toHaveLength(0);
    controller.dispose();
  });

  it('holds edits while offline and sends them on reconnect', async () => {
    const { controller, saves, statuses, setConnectivity } = harness({
      online: false
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS * 2);
    expect(saves).toHaveLength(0);
    expect(lastState(statuses)).toBe('offline');

    setConnectivity(true);
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();

    expect(saves).toHaveLength(1);
    expect(lastState(statuses)).toBe('synced');
    controller.dispose();
  });
});

describe('cloud project autosave — refusals', () => {
  it('stops on a fenced write and reports the account version', async () => {
    const { controller, saves, statuses, conflicts } = harness({
      respond: () =>
        Promise.reject(
          new ApiError(409, 'Newer remote revision.', 'REVISION_CONFLICT', {
            currentVersion: 9
          })
        )
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();

    expect(saves).toHaveLength(0);
    expect(lastState(statuses)).toBe('conflict');
    expect(conflicts).toEqual([
      { projectId: document.projectId, accountVersion: 9 }
    ]);
    expect(controller.isHalted).toBe(true);
    controller.dispose();
  });

  it('does not keep retrying after a conflict', async () => {
    // A blind retry either fails identically or, worse, succeeds against a
    // version the user never saw.
    let attempts = 0;
    const { controller } = harness({
      respond: () => {
        attempts += 1;
        return Promise.reject(
          new ApiError(409, 'Newer remote revision.', 'REVISION_CONFLICT', {
            currentVersion: 9
          })
        );
      }
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();

    controller.schedule(documentAt(4, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS * 10);
    await controller.whenIdle();

    expect(attempts).toBe(1);
    controller.dispose();
  });

  it('resumes once a resolution re-establishes a baseline', async () => {
    let failNext = true;
    const { controller, saves } = harness({
      respond: (input) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(
            new ApiError(409, 'Newer remote revision.', 'REVISION_CONFLICT', {
              currentVersion: 9
            })
          );
        }
        return Promise.resolve({
          projectId: input.document.projectId,
          version: input.document.version,
          updatedAt: '2026-01-01T00:00:00.000Z'
        });
      }
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();
    expect(controller.isHalted).toBe(true);

    controller.adoptAccountVersion(document.projectId, 9);
    expect(controller.isHalted).toBe(false);
    controller.schedule(documentAt(10, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();

    expect(saves).toHaveLength(1);
    expect(saves[0]?.expectedVersion).toBe(9);
    controller.dispose();
  });

  it('stops permanently on a document the account will not store', async () => {
    let attempts = 0;
    const { controller, statuses } = harness({
      respond: () => {
        attempts += 1;
        return Promise.reject(
          new ApiError(413, 'Document is too large.', 'DOCUMENT_TOO_LARGE', {
            limitBytes: 1_500_000
          })
        );
      }
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS * 20);
    await controller.whenIdle();

    expect(attempts).toBe(1);
    expect(lastState(statuses)).toBe('refused');
    controller.dispose();
  });

  it('retries a transient failure, then gives up rather than spinning', async () => {
    let attempts = 0;
    const { controller } = harness({
      respond: () => {
        attempts += 1;
        return Promise.reject(new Error('network down'));
      }
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();
    await vi.advanceTimersByTimeAsync(60_000);
    await controller.whenIdle();

    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(5);
    controller.dispose();
  });

  it('reports an expired session once and stops writing', async () => {
    const state = harness({
      respond: () =>
        Promise.reject(new ApiError(401, 'Sign in again.', 'AUTH_REQUIRED'))
    });
    const document = documentAt(2);
    state.controller.openProject(document.projectId, 2);
    state.controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS * 5);
    await state.controller.whenIdle();

    expect(state.sessionExpiries).toBe(1);
    expect(lastState(state.statuses)).toBe('local');
    state.controller.dispose();
  });
});

describe('cloud project autosave — flushing', () => {
  it('writes immediately on flush rather than waiting out the delay', async () => {
    const { controller, saves } = harness();
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));

    await controller.flushPending();
    expect(saves).toHaveLength(1);
    controller.dispose();
  });

  it('drains an edit that lands while a write is in flight', async () => {
    const held = gate();
    const { controller, saves } = harness({
      respond: async (input) => {
        if (input.document.version === 3) {
          await held.wait;
        }
        return {
          projectId: input.document.projectId,
          version: input.document.version,
          updatedAt: '2026-01-01T00:00:00.000Z'
        };
      }
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));

    const flushing = controller.flushPending();
    await vi.advanceTimersByTimeAsync(0);
    controller.schedule(documentAt(4, document));
    held.open();
    await vi.advanceTimersByTimeAsync(0);
    await flushing;

    expect(saves.map((save) => save.version)).toEqual([3, 4]);
    controller.dispose();
  });

  it('resolves rather than throwing when it cannot reach the account', async () => {
    // Logout and page-hide both call this. A document that cannot be uploaded
    // is not a lost document, and neither caller can be blocked by one.
    const { controller } = harness({ online: false });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    await expect(controller.flushPending()).resolves.toBeUndefined();
    controller.dispose();
  });

  it('refuses to be used after disposal', () => {
    const { controller } = harness();
    controller.dispose();
    expect(() => controller.schedule(documentAt(3))).toThrow(/disposed/);
  });
});
