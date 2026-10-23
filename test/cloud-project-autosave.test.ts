import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendRevision,
  assertStorableDocument,
  createProjectDocument,
  createSavedRevision,
  UnstorableDocumentError
} from '@openzcad/document-core';
import {
  JsonComplexityGuard,
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  MAX_CLOUD_PROJECT_WRITE_BYTES,
  MAX_DOCUMENT_VALUES,
  documentStructureError,
  toUserId,
  type ProjectDocument,
  type SaveProjectDocumentResponse
} from '@openzcad/shared';
import { api, ApiError } from '../apps/web/src/lib/api';
import worker from '../apps/web/worker/index';
import {
  CloudProjectAutosave,
  PROJECT_AUTOSAVE_IDLE_MS,
  PROJECT_AUTOSAVE_IDLE_RETRY_MS,
  PROJECT_AUTOSAVE_MAX_WAIT_MS,
  PROJECT_TOO_LARGE_FOR_ACCOUNT,
  type CloudProjectAutosaveConnectivity,
  type CloudProjectAutosaveStatus
} from '../apps/web/src/lib/cloudProjectAutosave';
import {
  parseSaveProjectDocumentRequest,
  type HttpError
} from '../apps/web/worker/validation';

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

describe('explicit checkpoints', () => {
  it('reads the latest document after draining edits made during autosave', async () => {
    const held = gate();
    const started = gate();
    const { controller, saves } = harness({
      respond: async ({ document }) => {
        if (document.version === 2) {
          started.open();
          await held.wait;
        }
        return {
          projectId: document.projectId,
          version: document.version,
          updatedAt: ''
        };
      }
    });
    let live = documentAt(2);
    controller.openProject(live.projectId, 1);
    controller.schedule(live);
    const checkpoint = vi.fn(
      async ({ document }: { document: ProjectDocument }) => document
    );
    const saving = controller.saveCheckpoint(
      live.projectId,
      () => live,
      checkpoint
    );
    await started.wait;
    live = documentAt(3, live);
    controller.schedule(live);
    held.open();
    await saving;
    expect(saves).toEqual([
      { expectedVersion: 1, version: 2 },
      { expectedVersion: 2, version: 3 }
    ]);
    expect(checkpoint).toHaveBeenCalledWith({
      projectId: live.projectId,
      expectedVersion: 3,
      document: live
    });
    controller.dispose();
  });

  it('serializes a newer autosave behind a checkpoint without dropping the edit', async () => {
    const { controller, saves } = harness();
    let live = documentAt(2);
    controller.openProject(live.projectId, 1);
    const held = gate();
    const started = gate();
    const saving = controller.saveCheckpoint(
      live.projectId,
      () => live,
      async ({ document, expectedVersion }) => {
        expect(expectedVersion).toBe(1);
        started.open();
        await held.wait;
        expect(saves).toEqual([]);
        return document;
      }
    );
    await started.wait;
    live = documentAt(3, live);
    controller.schedule(live);
    const autosave = controller.flush();
    held.open();
    await saving;
    await autosave;
    expect(saves).toEqual([{ expectedVersion: 2, version: 3 }]);
    expect(controller.syncedVersion).toBe(3);
    controller.dispose();
  });

  it('keeps a debounced edit made during a checkpoint queued', async () => {
    const { controller, saves } = harness();
    let live = documentAt(2);
    controller.openProject(live.projectId, 1);
    const held = gate();
    const started = gate();
    const saving = controller.saveCheckpoint(
      live.projectId,
      () => live,
      async ({ document }) => {
        started.open();
        await held.wait;
        return document;
      }
    );
    await started.wait;
    live = documentAt(3, live);
    controller.schedule(live);
    held.open();
    await saving;
    expect(controller.hasPendingChanges).toBe(true);
    await controller.flushPending();
    expect(saves).toEqual([{ expectedVersion: 2, version: 3 }]);
    controller.dispose();
  });

  it('carries the save point a checkpoint minted into edits queued behind it', async () => {
    const sent: ProjectDocument[] = [];
    const { controller } = harness({
      respond: async ({ document }) => {
        sent.push(document);
        return {
          projectId: document.projectId,
          version: document.version,
          updatedAt: ''
        };
      }
    });
    let live = documentAt(2);
    controller.openProject(live.projectId, 1);
    const held = gate();
    const started = gate();
    const saving = controller.saveCheckpoint(
      live.projectId,
      () => live,
      async ({ document }) => {
        started.open();
        await held.wait;
        // The account checkpoints the document it was sent.
        return createSavedRevision(document, 'Client review');
      }
    );
    await started.wait;
    // Two edits land while the request is in flight: the first one's
    // debounce expires, queueing its write behind the checkpoint; the
    // second is still debouncing when the echo arrives.
    live = appendRevision(live, 'Edit 1');
    controller.schedule(live);
    const queued = controller.flush();
    live = appendRevision(live, 'Edit 2');
    controller.schedule(live);
    held.open();
    const echo = await saving;
    await queued;
    await controller.flushPending();

    expect(sent.map((document) => document.version)).toEqual([3, 4]);
    const savePoint = echo!.checkpoints.at(-1)!;
    expect(savePoint.reason).toBe('Client review');
    for (const [index, document] of sent.entries()) {
      // Neither write may replace the account copy without the save point.
      expect(document.checkpoints.at(-1)).toEqual(savePoint);
      expect(document.revisions.map((revision) => revision.reason)).toEqual([
        ...echo!.revisions.map((revision) => revision.reason),
        ...['Edit 1', 'Edit 2'].slice(0, index + 1)
      ]);
    }
    controller.dispose();
  });

  it('allows an explicit checkpoint while automatic saves are disabled', async () => {
    const { controller, saves } = harness();
    const live = documentAt(2);
    controller.openProject(live.projectId, 1);
    controller.configure({ enabled: false });
    controller.schedule(live);
    const write = vi.fn(
      async ({ document }: { document: ProjectDocument }) => document
    );
    await controller.saveCheckpoint(live.projectId, () => live, write);
    expect(write).toHaveBeenCalledOnce();
    expect(saves).toEqual([]);
    expect(controller.hasPendingChanges).toBe(false);
    controller.dispose();
  });

  it('skips a checkpoint after navigation and recovers its queue after rejection', async () => {
    const { controller, saves } = harness();
    const live = documentAt(2);
    controller.openProject(live.projectId, 1);
    const write = vi.fn();
    expect(
      await controller.saveCheckpoint(live.projectId, () => null, write)
    ).toBeNull();
    expect(write).not.toHaveBeenCalled();
    await expect(
      controller.saveCheckpoint(
        live.projectId,
        () => live,
        async () => {
          throw new Error('offline');
        }
      )
    ).rejects.toThrow('offline');
    controller.schedule(live);
    await controller.flushPending();
    expect(saves).toEqual([{ expectedVersion: 1, version: 2 }]);
    controller.dispose();
  });
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('resumes a failed departure without losing a later durable edit', async () => {
    const { controller, saves } = harness();
    const baseline = documentAt(2);
    controller.openProject(baseline.projectId, baseline.version);
    controller.schedule(documentAt(3, baseline));
    controller.closeProject();
    // A local save can finish while session revocation is in flight.
    controller.schedule(documentAt(4, baseline));
    controller.openProject(baseline.projectId, baseline.version);
    await controller.flushPending();
    expect(saves).toEqual([{ expectedVersion: 2, version: 4 }]);
    controller.dispose();
  });

  it('recognises the document the account already holds', () => {
    const { controller } = harness();
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);

    expect(controller.holdsDocument(document)).toBe(true);
    expect(controller.holdsDocument(documentAt(3, document))).toBe(false);
    // Same version number, different project: two documents that have both
    // been edited twice are not the same document.
    expect(
      controller.holdsDocument(
        Object.assign(createProjectDocument('Other', owner), { version: 2 })
      )
    ).toBe(false);
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

  it('halts on an unreadable account document instead of retrying writes', async () => {
    let attempts = 0;
    const { controller, statuses } = harness({
      respond: () => {
        attempts += 1;
        return Promise.reject(
          new ApiError(
            503,
            'The account copy is unavailable.',
            'PROJECT_DOCUMENT_UNAVAILABLE'
          )
        );
      }
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS * 20);
    await controller.whenIdle();

    expect(attempts).toBe(1);
    expect(lastState(statuses)).toBe('repair');
    expect(controller.hasPendingChanges).toBe(true);
    expect(controller.isHalted).toBe(true);
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

  it('ignores an adoption for a project that is no longer open', async () => {
    // Adoption is called from async work — a pull, a conflict resolution, the
    // freshness poll — so it can land after the user opened another project.
    // It used to re-point the controller unconditionally, leaving it
    // mirroring a document no longer on screen and fencing the open project's
    // next push against a version it never held.
    const saves: { projectId: string; expectedVersion: number }[] = [];
    const { controller } = harness({
      respond: (input) => {
        saves.push({
          projectId: input.document.projectId,
          expectedVersion: input.expectedVersion
        });
        return Promise.resolve({
          projectId: input.document.projectId,
          version: input.document.version,
          updatedAt: '2026-01-01T00:00:00.000Z'
        });
      }
    });
    const stale = documentAt(2);
    const open = documentAt(2, createProjectDocument('Open', owner));
    controller.openProject(open.projectId, 2);

    // The stale project's pull answers late.
    controller.adoptAccountVersion(stale.projectId, 9);

    controller.schedule(documentAt(3, open));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();

    expect(saves).toHaveLength(1);
    expect(saves[0]?.projectId).toBe(open.projectId);
    // Based on the version the OPEN project holds, not the stale adoption's.
    expect(saves[0]?.expectedVersion).toBe(2);
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

  it('stops on a document over the value ceiling instead of retrying it as offline', async () => {
    // The save edge refuses a document over MAX_DOCUMENT_VALUES — an imported
    // mesh of ~21k triangles is enough — with a 400, not a 413. No retry can
    // store it, and "offline" promised one would, for as long as the tab ran.
    const document = documentAt(2);
    let refusal: HttpError | null = null;
    try {
      parseSaveProjectDocumentRequest(
        {
          projectId: document.projectId,
          expectedVersion: 2,
          document: { ...document, padding: new Array(500_001).fill(0) }
        },
        document.projectId
      );
    } catch (error) {
      refusal = error as HttpError;
    }
    expect(refusal?.status).toBe(400);
    let attempts = 0;
    const { controller, statuses } = harness({
      respond: () => {
        attempts += 1;
        return Promise.reject(new ApiError(400, refusal!.message));
      }
    });
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_RETRY_MS * 3);
    await controller.whenIdle();

    expect(attempts).toBe(1);
    expect(lastState(statuses)).toBe('refused');
    expect((statuses.at(-1)?.error as Error | undefined)?.message).toBe(
      PROJECT_TOO_LARGE_FOR_ACCOUNT
    );
    // Refused, not dropped: the edit stays queued against an explicit retry.
    expect(controller.hasPendingChanges).toBe(true);
    controller.dispose();
  });

  it('resumes the same open project after reducing a value-limit refusal', async () => {
    const document = documentAt(2);
    const oversized = {
      ...document,
      version: 3,
      padding: new Array(500_001).fill(0)
    };
    const attempts: number[] = [];
    const { controller, statuses } = harness({
      respond: async (input) => {
        attempts.push(input.document.version);
        try {
          parseSaveProjectDocumentRequest(
            { ...input, projectId: input.document.projectId },
            input.document.projectId
          );
        } catch (error) {
          throw new ApiError(
            (error as HttpError).status,
            (error as Error).message
          );
        }
        return {
          projectId: input.document.projectId,
          version: input.document.version,
          updatedAt: '2026-01-01T00:00:00.000Z'
        };
      }
    });
    controller.openProject(document.projectId, 2);
    controller.schedule(oversized);
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();
    expect(lastState(statuses)).toBe('refused');

    // Neither unchanged content nor another oversized edit can retry.
    controller.schedule(oversized);
    controller.schedule({ ...oversized, version: 4 });
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_RETRY_MS * 2);
    expect(attempts).toEqual([3]);
    controller.schedule(documentAt(5, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();
    expect(attempts).toEqual([3, 5]);
    expect(controller.syncedVersion).toBe(5);
    expect(controller.hasPendingChanges).toBe(false);
    expect(lastState(statuses)).toBe('synced');
    controller.dispose();
  });

  it('halts on an edit the browser refuses to upload and resumes with one it accepts', async () => {
    // ADR-024 Phase 1: the browser runs the account's content checks itself
    // before uploading. A refusal is permanent for that edit, not an outage.
    const document = documentAt(2);
    const unopenable = {
      ...document,
      version: 3,
      objectFolders: 'folders'
    } as unknown as ProjectDocument;
    const attempts: number[] = [];
    const { controller, statuses } = harness({
      respond: async (input) => {
        attempts.push(input.document.version);
        assertStorableDocument(input.document);
        return {
          projectId: input.document.projectId,
          version: input.document.version,
          updatedAt: '2026-01-01T00:00:00.000Z'
        };
      }
    });
    controller.openProject(document.projectId, 2);
    controller.schedule(unopenable);
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();
    expect(lastState(statuses)).toBe('refused');
    expect(statuses).not.toContain('offline');
    expect(controller.isHalted).toBe(true);

    // Another edit that is still unopenable does not retry.
    controller.schedule({ ...unopenable, version: 4 });
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_RETRY_MS * 2);
    expect(attempts).toEqual([3]);
    controller.schedule(documentAt(5, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();
    expect(attempts).toEqual([3, 5]);
    expect(controller.syncedVersion).toBe(5);
    expect(lastState(statuses)).toBe('synced');
    controller.dispose();
  });

  it('resumes only below the byte limit reported for a document-size refusal', async () => {
    const document = documentAt(2);
    const oversized = { ...document, version: 3, padding: 'x'.repeat(5_000) };
    const respond = vi
      .fn<
        (input: {
          expectedVersion: number;
          document: ProjectDocument;
        }) => Promise<SaveProjectDocumentResponse>
      >()
      .mockRejectedValueOnce(
        new ApiError(413, 'Document is too large.', 'DOCUMENT_TOO_LARGE', {
          limitBytes: 4_000
        })
      )
      .mockImplementation(async (input) => ({
        projectId: input.document.projectId,
        version: input.document.version,
        updatedAt: '2026-01-01T00:00:00.000Z'
      }));
    const { controller, statuses } = harness({ respond });
    controller.openProject(document.projectId, 2);
    controller.schedule(oversized);
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();
    controller.schedule({ ...oversized, version: 4 });
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS * 2);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(lastState(statuses)).toBe('refused');
    controller.schedule(documentAt(5, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1]![0].expectedVersion).toBe(2);
    expect(controller.syncedVersion).toBe(5);
    controller.dispose();
  });

  it('keeps the reduced edit scheduled before the oversized response arrives', async () => {
    const held = gate();
    const document = documentAt(2);
    const respond = vi
      .fn<
        (input: {
          expectedVersion: number;
          document: ProjectDocument;
        }) => Promise<SaveProjectDocumentResponse>
      >()
      .mockImplementationOnce(async () => {
        await held.wait;
        throw new ApiError(
          400,
          'Project document holds more than 500000 values.'
        );
      })
      .mockImplementation(async (input) => ({
        projectId: input.document.projectId,
        version: input.document.version,
        updatedAt: '2026-01-01T00:00:00.000Z'
      }));
    const { controller } = harness({ respond });
    controller.openProject(document.projectId, 2);
    controller.schedule({
      ...document,
      version: 3,
      padding: new Array(500_001).fill(0)
    } as ProjectDocument);
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    controller.schedule(documentAt(4, document));
    held.open();
    await controller.whenIdle();
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1]![0]).toMatchObject({
      expectedVersion: 2,
      document: { version: 4 }
    });
    expect(controller.hasPendingChanges).toBe(false);
    controller.dispose();
  });

  it.each([
    [403, 'FORBIDDEN'],
    [403, 'PROJECT_UPDATE_REQUIRED'],
    [403, 'DOCUMENT_TOO_LARGE'],
    [403, 'DOCUMENT_TOO_COMPLEX'],
    [409, 'DOCUMENT_TOO_COMPLEX'],
    [409, 'LEASE_REQUIRED'],
    [413, 'PROJECT_STORAGE_QUOTA'],
    [413, 'PROJECT_COUNT_QUOTA'],
    [413, undefined],
    [401, 'SESSION_EXPIRED']
  ] as const)(
    'does not resume a %s/%s refusal when another edit fits',
    async (status, code) => {
      const respond = vi.fn().mockRejectedValue(
        new ApiError(status, 'Account write refused.', code, {
          limitBytes: 4_000
        })
      );
      const { controller } = harness({ respond });
      const document = documentAt(2);
      controller.openProject(document.projectId, 2);
      controller.schedule(documentAt(3, document));
      await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
      await controller.whenIdle();
      controller.schedule(documentAt(4, document));
      await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_RETRY_MS * 2);
      await controller.whenIdle();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(controller.hasPendingChanges).toBe(true);
      controller.dispose();
    }
  );

  it.each([
    {
      path: 'canonical document',
      limitBytes: MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
      contentLength: false
    },
    {
      path: 'declared request length',
      limitBytes: MAX_CLOUD_PROJECT_WRITE_BYTES,
      contentLength: true
    },
    {
      path: 'streamed request bytes',
      limitBytes: MAX_CLOUD_PROJECT_WRITE_BYTES,
      contentLength: false
    }
  ])(
    'resumes after the actual Worker $path size refusal',
    async ({ limitBytes, contentLength }) => {
      const user = toUserId(`user_wire_${crypto.randomUUID()}`);
      vi.stubGlobal(
        'fetch',
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(
            new URL(
              typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url,
              'https://example.com'
            ),
            init
          );
          request.headers.set('x-openzcad-development-user', user);
          if (contentLength && typeof init?.body === 'string') {
            request.headers.set(
              'content-length',
              String(new TextEncoder().encode(init.body).byteLength)
            );
          }
          return worker.fetch(request, {
            ENVIRONMENT: 'development',
            AUTH_MODE: 'development'
          });
        }
      );
      const created = await api.createProject({ name: 'Wire size recovery' });
      const document = created.document;
      const errors: unknown[] = [];
      const respond = vi.fn(
        async (input: {
          expectedVersion: number;
          document: ProjectDocument;
        }) => {
          try {
            return await api.saveProjectDocument({
              ...input,
              projectId: document.projectId
            });
          } catch (error) {
            errors.push(error);
            throw error;
          }
        }
      );
      const { controller, statuses } = harness({ respond });
      try {
        controller.openProject(document.projectId, document.version);
        controller.schedule({
          ...document,
          version: document.version + 1,
          padding: 'x'.repeat(limitBytes + 8_192)
        } as ProjectDocument);
        await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
        await controller.whenIdle();
        expect(errors[0]).toBeInstanceOf(ApiError);
        expect((errors[0] as ApiError).status).toBe(413);
        expect(lastState(statuses)).toBe('refused');
        if (limitBytes > MAX_CLOUD_PROJECT_DOCUMENT_BYTES) {
          // A request that fits may still exceed the canonical 24 MiB cap.
          controller.schedule({
            ...document,
            version: document.version + 2,
            padding: 'x'.repeat(MAX_CLOUD_PROJECT_DOCUMENT_BYTES + 8_192)
          } as ProjectDocument);
          await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
          await controller.whenIdle();
          expect(respond).toHaveBeenCalledTimes(1);
        }
        const reduced = documentAt(document.version + 3, document);
        controller.schedule(reduced);
        await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
        await controller.whenIdle();
        expect(respond).toHaveBeenCalledTimes(2);
        expect(errors[0]).toMatchObject({
          code: 'DOCUMENT_TOO_LARGE',
          details: { limitBytes }
        });
        expect(lastState(statuses)).toBe('synced');
        expect(await api.loadProject(document.projectId)).toMatchObject({
          version: reduced.version
        });
      } finally {
        controller.dispose();
      }
    },
    15_000
  );

  it.each(['separators', 'depth'] as const)(
    'resumes after an actual Worker lexical %s refusal only when all structure limits fit',
    async (constraint) => {
      const user = toUserId(`user_complexity_${crypto.randomUUID()}`);
      vi.stubGlobal(
        'fetch',
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(
            new URL(
              typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url,
              'https://example.com'
            ),
            init
          );
          request.headers.set('x-openzcad-development-user', user);
          return worker.fetch(request, {
            ENVIRONMENT: 'development',
            AUTH_MODE: 'development'
          });
        }
      );
      const { document } = await api.createProject({
        name: 'Complexity recovery'
      });
      const nested = (levels: number): unknown => {
        let value: unknown = 0;
        for (let i = 0; i < levels; i++) value = { child: value };
        return value;
      };
      const fields = (count: number): Record<string, object> => {
        const value: Record<string, object> = {};
        for (let i = 0; i < count; i++) value[String(i)] = {};
        return value;
      };
      let padding: unknown;
      let stillComplex: unknown;
      if (constraint === 'separators') {
        const base = {
          ...document,
          version: document.version + 1,
          padding: {}
        };
        const text = JSON.stringify(base);
        // Derive the existing guard's count without duplicating its lexer.
        let lower = 0;
        let upper = MAX_DOCUMENT_VALUES * 2;
        while (lower < upper) {
          const middle = Math.floor((lower + upper) / 2);
          try {
            new JsonComplexityGuard(undefined, middle).consume(text);
            upper = middle;
          } catch {
            lower = middle + 1;
          }
        }
        // Empty-object fields add three separators each (two for the first).
        const count = Math.floor((MAX_DOCUMENT_VALUES * 2 - lower + 1) / 3);
        padding = fields(count);
        stillComplex = fields(count - 1);
        const canonical = { ...base, padding };
        expect(documentStructureError(canonical)).toBeNull();
        expect(() =>
          new JsonComplexityGuard().consume(JSON.stringify(canonical))
        ).not.toThrow();
        // Only the complete request envelope exceeds the lexical ceiling.
        expect(() =>
          new JsonComplexityGuard().consume(
            JSON.stringify({
              projectId: document.projectId,
              expectedVersion: document.version,
              document: canonical
            })
          )
        ).toThrow();
      } else {
        padding = nested(72);
        stillComplex = nested(64);
      }
      const errors: unknown[] = [];
      const respond = vi.fn(
        async (input: {
          expectedVersion: number;
          document: ProjectDocument;
        }) => {
          try {
            return await api.saveProjectDocument({
              ...input,
              projectId: document.projectId
            });
          } catch (error) {
            errors.push(error);
            throw error;
          }
        }
      );
      const { controller, statuses } = harness({ respond });
      try {
        controller.openProject(document.projectId, document.version);
        controller.schedule({
          ...document,
          version: document.version + 1,
          padding
        } as ProjectDocument);
        await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
        await controller.whenIdle();
        if (constraint === 'depth') {
          // The browser runs the structure guards itself before uploading
          // (ADR-024 Phase 1), so an over-deep document never reaches the
          // Worker; the refusal halts the same way.
          expect(errors[0]).toBeInstanceOf(UnstorableDocumentError);
          expect((errors[0] as Error).message).toMatch(/deeper than/);
        } else {
          expect(errors[0]).toBeInstanceOf(ApiError);
          expect(errors[0]).toMatchObject({
            status: 413,
            message: 'Request JSON is too complex.',
            code: 'DOCUMENT_TOO_COMPLEX'
          });
          expect((errors[0] as ApiError).details).not.toHaveProperty(
            'limitBytes'
          );
        }
        expect(lastState(statuses)).toBe('refused');
        for (const refusedPadding of [
          padding,
          stillComplex,
          new Array(MAX_DOCUMENT_VALUES + 1).fill(0)
        ]) {
          controller.schedule({
            ...document,
            version: document.version + 2,
            padding: refusedPadding
          } as ProjectDocument);
          await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
          await controller.whenIdle();
          expect(respond).toHaveBeenCalledTimes(1);
        }
        controller.schedule(documentAt(document.version + 3, document));
        await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
        await controller.whenIdle();
        expect(respond).toHaveBeenCalledTimes(2);
        expect(lastState(statuses)).toBe('synced');
        expect(await api.loadProject(document.projectId)).toMatchObject({
          version: document.version + 3
        });
      } finally {
        controller.dispose();
      }
    },
    15_000
  );

  it('leaves generic request-complexity refusals unclassified', async () => {
    let padding: unknown = 0;
    for (let i = 0; i < 72; i++) padding = { child: padding };
    const response = await worker.fetch(
      new Request('https://example.com/api/projects', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openzcad-development-user': toUserId(
            `user_generic_${crypto.randomUUID()}`
          )
        },
        body: JSON.stringify({ name: 'Generic complexity', padding })
      }),
      { ENVIRONMENT: 'development', AUTH_MODE: 'development' }
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'Request JSON is too complex.'
    });
  });

  it('retries a transient failure quickly, then slows down rather than spinning', async () => {
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
    await vi.advanceTimersByTimeAsync(10_000);
    await controller.whenIdle();

    const quickAttempts = attempts;
    expect(quickAttempts).toBeGreaterThan(1);
    expect(quickAttempts).toBeLessThanOrEqual(5);

    // The connection never dropped, so no `online` event is coming to restart
    // this. Without a slow heartbeat the edit would simply stop being offered
    // to the account for the rest of the session.
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_RETRY_MS + 1_000);
    await controller.whenIdle();
    expect(attempts).toBeGreaterThan(quickAttempts);
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
  it('rechecks edits when a drain begins with a write already in flight', async () => {
    const held = gate();
    const started = gate();
    const { controller, saves } = harness({
      respond: async (input) => {
        if (input.document.version === 3) {
          started.open();
          await held.wait;
        }
        return { projectId: input.document.projectId, version: input.document.version, updatedAt: '2026-01-01T00:00:00.000Z' };
      }
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    const first = controller.flush();
    await started.wait;
    expect(controller.hasPendingChanges).toBe(false);
    const draining = controller.flushPending();
    controller.schedule(documentAt(4, document));
    held.open();
    await Promise.all([first, draining]);

    expect(saves.map((save) => save.version)).toEqual([3, 4]);
    expect(controller.hasPendingChanges).toBe(false);
    controller.dispose();
  });

  it.each(['paused', 'offline', 'conflict'] as const)('rechecks %s eligibility before a queued write starts', async (state) => {
    const held = gate();
    const h = harness({
      respond: async (input) => {
        if (input.document.version === 3) await held.wait;
        return { projectId: input.document.projectId, version: input.document.version, updatedAt: '2026-01-01T00:00:00.000Z' };
      }
    });
    const document = documentAt(2);
    h.controller.openProject(document.projectId, 2);
    h.controller.schedule(documentAt(3, document));
    const first = h.controller.flush();
    await vi.advanceTimersByTimeAsync(0);
    h.controller.schedule(documentAt(4, document));
    const queued = h.controller.flush();
    if (state === 'paused') h.controller.configure({ enabled: false });
    else if (state === 'offline') h.setConnectivity(false);
    else h.controller.haltForConflict(document.projectId);
    held.open();
    await Promise.all([first, queued]);

    expect(h.saves.map((save) => save.version)).toEqual([3]);
    expect(h.controller.hasPendingChanges).toBe(true);
    expect(lastState(h.statuses)).toBe(state);
    await h.controller.flushPending();
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_MAX_WAIT_MS * 2);
    expect(h.saves).toHaveLength(1);
    h.controller.dispose();
  });

  it('preserves a newer edit over an ineligible queued snapshot and resumes with the acknowledged fence', async () => {
    const held = gate();
    const { controller, saves } = harness({
      respond: async (input) => {
        if (input.document.version === 3) await held.wait;
        return { projectId: input.document.projectId, version: input.document.version, updatedAt: '2026-01-01T00:00:00.000Z' };
      }
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    const first = controller.flush();
    await vi.advanceTimersByTimeAsync(0);
    controller.schedule(documentAt(4, document));
    const queued = controller.flush();
    controller.configure({ enabled: false });
    controller.schedule(documentAt(5, document));
    held.open();
    await Promise.all([first, queued]);
    expect(saves.map((save) => save.version)).toEqual([3]);
    controller.configure({ enabled: true });
    await vi.advanceTimersByTimeAsync(0);
    await controller.whenIdle();
    expect(saves).toEqual([{ version: 3, expectedVersion: 2 }, { version: 5, expectedVersion: 3 }]);
    expect(controller.hasPendingChanges).toBe(false);
    controller.dispose();
  });

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

  it('asks for keepalive only during a page-teardown drain', async () => {
    // The pagehide flush must survive the page; ordinary saves must not pay
    // the keepalive body-size budget.
    const keepaliveFlags: Array<boolean | undefined> = [];
    const controller = new CloudProjectAutosave({
      connectivity: testConnectivity(true).connectivity,
      api: {
        async saveProjectDocument(input, options) {
          keepaliveFlags.push(options?.keepalive);
          return {
            projectId: input.document.projectId,
            version: input.document.version,
            updatedAt: '2026-01-01T00:00:00.000Z'
          };
        }
      }
    });
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.schedule(documentAt(3, document));
    await controller.flushPending({ keepalive: true });

    controller.schedule(documentAt(4, document));
    await controller.flushPending();

    expect(keepaliveFlags).toEqual([true, false]);
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

  it('does not write while cloud autosave is switched off', async () => {
    const { controller, saves, statuses } = harness();
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.configure({ enabled: false });

    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_MAX_WAIT_MS * 2);
    await controller.whenIdle();

    expect(saves).toHaveLength(0);
    expect(lastState(statuses)).toBe('paused');
    controller.dispose();
  });

  it('does not sneak a write out on a flush while switched off', async () => {
    // "Off" has to mean off. A page-hide drain is still this controller
    // deciding to write, not the user asking it to.
    const { controller, saves } = harness();
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.configure({ enabled: false });
    controller.schedule(documentAt(3, document));

    await controller.flushPending();
    expect(saves).toHaveLength(0);
    controller.dispose();
  });

  it('sends the held edit as soon as autosave is switched back on', async () => {
    const { controller, saves } = harness();
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.configure({ enabled: false });
    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    expect(saves).toHaveLength(0);

    controller.configure({ enabled: true });
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS);
    await controller.whenIdle();

    expect(saves).toHaveLength(1);
    expect(saves[0]?.version).toBe(3);
    controller.dispose();
  });

  it('takes a new idle delay without losing the queued edit', async () => {
    const { controller, saves } = harness();
    const document = documentAt(2);
    controller.openProject(document.projectId, 2);
    controller.configure({ idleDelayMs: 10_000 });

    controller.schedule(documentAt(3, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_IDLE_MS * 2);
    expect(saves).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    await controller.whenIdle();
    expect(saves).toHaveLength(1);
    controller.dispose();
  });

  it('refuses to be used after disposal', () => {
    const { controller } = harness();
    controller.dispose();
    expect(() => controller.schedule(documentAt(3))).toThrow(/disposed/);
  });
});

describe('a divergence the reconciler found rather than the account', () => {
  const conflictedProject = () => documentAt(12);

  it('does not write the local copy while the user is being asked', async () => {
    // The regression. A fenced 409 halts the writer on its own, but a
    // divergence detected while opening the project did not — and the
    // `openProject` effect runs on its own schedule, clearing any halt. The
    // debounced writer then sent the local copy up, so the account version
    // regressed to the losing side before the dialog was answered.
    const { controller, saves, statuses } = harness();
    const document = conflictedProject();

    controller.haltForConflict(document.projectId);
    controller.openProject(document.projectId, 14);
    controller.schedule(document);
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_MAX_WAIT_MS * 4);

    expect(saves).toEqual([]);
    expect(lastState(statuses)).toBe('conflict');
  });

  it('holds the halt across a repeated openProject for the same project', async () => {
    const { controller, saves } = harness();
    const document = conflictedProject();

    controller.openProject(document.projectId, 14);
    controller.haltForConflict(document.projectId);
    controller.schedule(document);
    // The effect re-runs — a re-render is all it takes.
    controller.openProject(document.projectId, 14);
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_MAX_WAIT_MS * 4);

    expect(saves).toEqual([]);
  });

  it('writes again once the conflict is resolved', async () => {
    const { controller, saves } = harness();
    const document = conflictedProject();

    controller.openProject(document.projectId, 14);
    controller.haltForConflict(document.projectId);
    controller.schedule(document);
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_MAX_WAIT_MS * 2);
    expect(saves).toEqual([]);

    // Resolution re-establishes a baseline both copies agree on.
    controller.adoptAccountVersion(document.projectId, 14);
    controller.openProject(document.projectId, 14);
    controller.schedule(documentAt(15, document));
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_MAX_WAIT_MS * 2);

    expect(saves).toHaveLength(1);
  });

  it('leaves a different project free to keep syncing', async () => {
    const { controller, saves } = harness();
    const diverged = conflictedProject();
    const other = documentAt(3, createProjectDocument('Other', owner));

    controller.haltForConflict(diverged.projectId);
    controller.openProject(other.projectId, 3);
    controller.schedule(other);
    await vi.advanceTimersByTimeAsync(PROJECT_AUTOSAVE_MAX_WAIT_MS * 2);

    expect(saves).toHaveLength(1);
  });
});
