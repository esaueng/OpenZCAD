import {
  DEFAULT_APP_SETTINGS,
  deepClone,
  type AppSettings,
  type AppSettingsResponse,
  type UpdateAppSettingsRequest
} from '@openzcad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  CloudSettingsAutosave,
  type CloudSettingsAutosaveConnectivity,
  type CloudSettingsAutosaveStatus
} from './cloudSettingsAutosave';

function settings(index: number): AppSettings {
  const value = deepClone(DEFAULT_APP_SETTINGS);
  value.assistant.customInstructions = `edit-${index}`;
  return value;
}

function account(value: AppSettings, revision: number): AppSettingsResponse {
  return {
    settings: value,
    revision,
    synced: true,
    credential: { stored: false, storageAvailable: true },
    effectiveAssistant: {
      configured: false,
      source: 'deployment',
      provider: value.assistant.provider,
      model: value.assistant.model,
      reasoningEffort: value.assistant.reasoningEffort
    }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestConnectivity implements CloudSettingsAutosaveConnectivity {
  online = true;
  #listeners = new Set<(online: boolean) => void>();

  isOnline(): boolean {
    return this.online;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setOnline(online: boolean): void {
    this.online = online;
    for (const listener of this.#listeners) {
      listener(online);
    }
  }
}

interface Harness {
  autosave: CloudSettingsAutosave;
  updateSettings: ReturnType<
    typeof vi.fn<
      (request: UpdateAppSettingsRequest) => Promise<AppSettingsResponse>
    >
  >;
  getSettings: ReturnType<typeof vi.fn<() => Promise<AppSettingsResponse>>>;
  connectivity: TestConnectivity;
  accountChanges: AppSettingsResponse[];
  localWrites: Array<{ settings: AppSettings; revision: number | null }>;
  statuses: CloudSettingsAutosaveStatus[];
}

function harness(
  updateImplementation: (
    request: UpdateAppSettingsRequest
  ) => Promise<AppSettingsResponse> = async (request) =>
    account(request.settings, request.expectedRevision + 1),
  getImplementation: () => Promise<AppSettingsResponse> = async () =>
    account(settings(0), 0)
): Harness {
  const initial = settings(0);
  const connectivity = new TestConnectivity();
  const updateSettings = vi.fn(updateImplementation);
  const getSettings = vi.fn(getImplementation);
  const accountChanges: AppSettingsResponse[] = [];
  const localWrites: Array<{
    settings: AppSettings;
    revision: number | null;
  }> = [];
  const statuses: CloudSettingsAutosaveStatus[] = [];
  const autosave = new CloudSettingsAutosave({
    initialSettings: initial,
    initialSyncedRevision: 0,
    api: { updateSettings, getSettings },
    connectivity,
    autosaveDelayMs: 25,
    retryDelayMs: 100,
    onAccountSettings: (response) => accountChanges.push(response),
    onLocalSettings: (value, revision) =>
      localWrites.push({ settings: value, revision }),
    onStatus: (status) => statuses.push(status)
  });
  autosave.connectSession('user_test', account(initial, 0));
  return {
    autosave,
    updateSettings,
    getSettings,
    connectivity,
    accountChanges,
    localWrites,
    statuses
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cloud settings autosave', () => {
  it('coalesces ten rapid edits into one PATCH containing the final edit', async () => {
    const test = harness();
    for (let index = 1; index <= 10; index += 1) {
      test.autosave.schedule(settings(index));
    }

    await vi.advanceTimersByTimeAsync(25);
    await test.autosave.whenIdle();

    expect(test.updateSettings).toHaveBeenCalledOnce();
    const request = test.updateSettings.mock.calls[0]?.[0];
    expect(request?.settings.assistant.customInstructions).toBe('edit-10');
    expect(request?.expectedRevision).toBe(0);
    expect(test.autosave.syncedRevision).toBe(1);
  });

  it('exposes the revision of an adopted account copy', () => {
    const test = harness();
    const remoteSettings = settings(7);

    test.autosave.adoptSyncedSettings(
      remoteSettings,
      account(remoteSettings, 12)
    );

    expect(test.autosave.syncedRevision).toBe(12);
    expect(test.localWrites.at(-1)).toEqual({
      settings: remoteSettings,
      revision: 12
    });
  });

  it('serializes an edit made during a PATCH into one subsequent PATCH', async () => {
    const first = deferred<AppSettingsResponse>();
    const update = vi
      .fn<(request: UpdateAppSettingsRequest) => Promise<AppSettingsResponse>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (request) =>
        account(request.settings, request.expectedRevision + 1)
      );
    const test = harness(update);
    const firstEdit = settings(1);
    const secondEdit = settings(2);

    test.autosave.schedule(firstEdit);
    await vi.advanceTimersByTimeAsync(25);
    test.autosave.schedule(secondEdit);
    await vi.advanceTimersByTimeAsync(25);
    expect(update).toHaveBeenCalledOnce();

    first.resolve(account(firstEdit, 1));
    await test.autosave.whenIdle();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]?.[0]).toMatchObject({
      settings: secondEdit,
      expectedRevision: 1
    });
    expect(test.autosave.syncedRevision).toBe(2);
  });

  it('performs one GET and one revision-safe retry after a 409', async () => {
    const remote = account(settings(90), 7);
    const update = vi
      .fn<(request: UpdateAppSettingsRequest) => Promise<AppSettingsResponse>>()
      .mockRejectedValueOnce(new ApiError(409, 'conflict'))
      .mockImplementationOnce(async (request) =>
        account(request.settings, request.expectedRevision + 1)
      );
    const test = harness(update, async () => remote);
    const edited = settings(1);

    test.autosave.schedule(edited);
    const response = await test.autosave.flush();

    expect(test.getSettings).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0]?.[0].expectedRevision).toBe(0);
    expect(update.mock.calls[1]?.[0]).toEqual({
      settings: edited,
      expectedRevision: 7
    });
    expect(response?.revision).toBe(8);
    expect(test.accountChanges).toEqual([remote, response]);
  });

  it('pauses a failed write offline and retries on reconnect without another edit', async () => {
    const failedRequest = deferred<AppSettingsResponse>();
    const update = vi
      .fn<(request: UpdateAppSettingsRequest) => Promise<AppSettingsResponse>>()
      .mockImplementationOnce(() => failedRequest.promise)
      .mockImplementationOnce(async (request) =>
        account(request.settings, request.expectedRevision + 1)
      );
    const test = harness(update);
    test.autosave.schedule(settings(1));
    await vi.advanceTimersByTimeAsync(25);
    expect(update).toHaveBeenCalledOnce();

    test.connectivity.setOnline(false);
    failedRequest.reject(new Error('network unavailable'));
    await test.autosave.whenIdle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(update).toHaveBeenCalledOnce();
    expect(test.autosave.hasPendingChanges).toBe(true);

    test.connectivity.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    await test.autosave.whenIdle();

    expect(update).toHaveBeenCalledTimes(2);
    expect(test.autosave.syncedRevision).toBe(1);
  });

  it('flushes a debounced pending change before logout', async () => {
    const test = harness();
    test.autosave.schedule(settings(1), 60_000);

    await expect(test.autosave.flushPending()).resolves.toMatchObject({
      revision: 1
    });

    expect(test.updateSettings).toHaveBeenCalledOnce();
    expect(test.autosave.hasPendingChanges).toBe(false);
  });

  it('refuses a logout flush when the cloud write fails', async () => {
    const test = harness(async () => {
      throw new Error('network unavailable');
    });
    test.autosave.schedule(settings(1), 60_000);

    await expect(test.autosave.flushPending()).rejects.toThrow(
      'device copy remains pending'
    );

    expect(test.autosave.hasPendingChanges).toBe(true);
    expect(test.autosave.syncedRevision).toBeNull();
  });

  it('discards a response from an earlier session epoch for the same user', async () => {
    const oldRequest = deferred<AppSettingsResponse>();
    const update = vi.fn(() => oldRequest.promise);
    const test = harness(update);
    const edited = settings(1);

    test.autosave.schedule(edited);
    await vi.advanceTimersByTimeAsync(25);
    test.autosave.endSession();
    test.autosave.connectSession('user_test', account(settings(50), 50));
    oldRequest.resolve(account(edited, 1));
    await test.autosave.whenIdle();

    expect(test.accountChanges).toEqual([]);
    expect(test.statuses).not.toContainEqual({ state: 'saved', revision: 1 });
    expect(test.autosave.syncedRevision).toBeNull();
  });

  it('keeps a failed device copy pending without stale success or rejection', async () => {
    const test = harness(async () => {
      throw new Error('network unavailable');
    });
    test.autosave.schedule(settings(1));

    await vi.advanceTimersByTimeAsync(25);
    await expect(test.autosave.whenIdle()).resolves.toBeUndefined();

    expect(test.autosave.hasPendingChanges).toBe(true);
    expect(test.autosave.syncedRevision).toBeNull();
    expect(test.statuses.at(-1)).toMatchObject({ state: 'error' });
    expect(test.statuses.some((status) => status.state === 'saved')).toBe(
      false
    );
    expect(test.localWrites.at(-1)?.revision).toBeNull();
  });
});
