import type {
  AppSettings,
  AppSettingsResponse,
  UpdateAppSettingsRequest
} from '@openzcad/shared';
import { ApiError } from './api';

export const SETTINGS_AUTOSAVE_DELAY_MS = 450;
export const SETTINGS_AUTOSAVE_RETRY_DELAY_MS = 2_000;

export type CloudSettingsAutosaveStatus =
  | { state: 'pending' }
  | { state: 'offline' }
  | { state: 'saved'; revision: number }
  | { state: 'error'; error: unknown };

export interface CloudSettingsAutosaveConnectivity {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface CloudSettingsAutosaveOptions {
  initialSettings: AppSettings;
  initialSyncedRevision: number | null;
  api: {
    getSettings(): Promise<AppSettingsResponse>;
    updateSettings(
      request: UpdateAppSettingsRequest
    ): Promise<AppSettingsResponse>;
  };
  connectivity?: CloudSettingsAutosaveConnectivity;
  autosaveDelayMs?: number;
  retryDelayMs?: number;
  maxAutomaticRetries?: number;
  isConflict?: (error: unknown) => boolean;
  onAccountSettings?: (response: AppSettingsResponse) => void;
  onLocalSettings?: (
    settings: AppSettings,
    syncedRevision: number | null
  ) => void;
  onStatus?: (status: CloudSettingsAutosaveStatus) => void;
}

interface PendingSave {
  settings: AppSettings;
  editEpoch: number;
  userId: string | null;
}

interface ActiveSession {
  userId: string;
  epoch: number;
  account: AppSettingsResponse;
}

type SaveResult =
  | { state: 'saved'; response: AppSettingsResponse }
  | { state: 'failed' }
  | { state: 'stale' };

function browserConnectivity(): CloudSettingsAutosaveConnectivity {
  return {
    isOnline: () => globalThis.navigator?.onLine !== false,
    subscribe(listener) {
      if (typeof globalThis.addEventListener !== 'function') {
        return () => undefined;
      }
      const online = () => listener(true);
      const offline = () => listener(false);
      globalThis.addEventListener('online', online);
      globalThis.addEventListener('offline', offline);
      return () => {
        globalThis.removeEventListener('online', online);
        globalThis.removeEventListener('offline', offline);
      };
    }
  };
}

function defaultConflictCheck(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/**
 * Serializes and coalesces cloud settings writes while keeping the device copy
 * authoritative until the server acknowledges the latest edit.
 *
 * `connectSession` deliberately creates a fresh epoch on every call. Call it
 * only at an authentication boundary; use `updateAccountSettings` when another
 * account operation merely returns fresher metadata for the same session.
 */
export class CloudSettingsAutosave {
  readonly #options: CloudSettingsAutosaveOptions;
  readonly #connectivity: CloudSettingsAutosaveConnectivity;
  readonly #autosaveDelayMs: number;
  readonly #retryDelayMs: number;
  readonly #maxAutomaticRetries: number;
  readonly #isConflict: (error: unknown) => boolean;

  #session: ActiveSession | null = null;
  #sessionEpoch = 0;
  #editEpoch = 0;
  #currentSettings: AppSettings;
  #syncedRevision: number | null;
  #pending: PendingSave | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #queue: Promise<SaveResult> = Promise.resolve({ state: 'stale' });
  #automaticRetries = 0;
  #lastFailedEditEpoch: number | null = null;
  #disposed = false;
  #unsubscribeConnectivity: () => void;

  constructor(options: CloudSettingsAutosaveOptions) {
    this.#options = options;
    this.#connectivity = options.connectivity ?? browserConnectivity();
    this.#autosaveDelayMs =
      options.autosaveDelayMs ?? SETTINGS_AUTOSAVE_DELAY_MS;
    this.#retryDelayMs =
      options.retryDelayMs ?? SETTINGS_AUTOSAVE_RETRY_DELAY_MS;
    this.#maxAutomaticRetries = options.maxAutomaticRetries ?? 3;
    this.#isConflict = options.isConflict ?? defaultConflictCheck;
    this.#currentSettings = options.initialSettings;
    this.#syncedRevision = options.initialSyncedRevision;
    this.#unsubscribeConnectivity = this.#connectivity.subscribe((online) =>
      this.#handleConnectivityChange(online)
    );
  }

  get syncedRevision(): number | null {
    return this.#syncedRevision;
  }

  get hasPendingChanges(): boolean {
    return this.#pending !== null;
  }

  connectSession(userId: string, account: AppSettingsResponse): void {
    this.#assertUsable();
    const epoch = ++this.#sessionEpoch;
    if (this.#pending?.userId && this.#pending.userId !== userId) {
      // Never carry one account's queued write into another account. The local
      // copy remains dirty and continues to be the device source of truth.
      this.#pending = null;
    } else if (this.#pending) {
      this.#pending.userId = userId;
    }
    this.#session = { userId, epoch, account };
    this.#automaticRetries = 0;
    this.#lastFailedEditEpoch = null;
    if (this.#pending && this.#connectivity.isOnline()) {
      this.#armTimer(0);
    }
  }

  updateAccountSettings(account: AppSettingsResponse): void {
    if (this.#session) {
      this.#session.account = account;
    }
  }

  /** Adopts a server copy that the caller also selected as the device copy. */
  adoptSyncedSettings(
    settings: AppSettings,
    account: AppSettingsResponse
  ): void {
    this.#assertUsable();
    this.#clearTimer();
    this.#currentSettings = settings;
    this.#editEpoch += 1;
    this.#pending = null;
    this.#syncedRevision = account.revision;
    this.#automaticRetries = 0;
    this.#lastFailedEditEpoch = null;
    if (this.#session) {
      this.#session = {
        userId: this.#session.userId,
        epoch: ++this.#sessionEpoch,
        account
      };
    }
    this.#options.onLocalSettings?.(settings, account.revision);
  }

  /** Invalidates every outstanding response, including one for the same user. */
  endSession(): void {
    this.#clearTimer();
    const previousUserId = this.#session?.userId ?? null;
    this.#sessionEpoch += 1;
    this.#session = null;
    if (this.#syncedRevision === null && !this.#pending) {
      this.#pending = {
        settings: this.#currentSettings,
        editEpoch: this.#editEpoch,
        userId: previousUserId
      };
    }
  }

  schedule(settings: AppSettings, delay = this.#autosaveDelayMs): void {
    this.#assertUsable();
    this.#currentSettings = settings;
    this.#editEpoch += 1;
    this.#syncedRevision = null;
    this.#automaticRetries = 0;
    this.#lastFailedEditEpoch = null;
    this.#pending = {
      settings,
      editEpoch: this.#editEpoch,
      userId: this.#session?.userId ?? null
    };
    this.#options.onLocalSettings?.(settings, null);
    this.#clearTimer();

    if (!this.#session) {
      return;
    }
    if (!this.#connectivity.isOnline()) {
      this.#options.onStatus?.({ state: 'offline' });
      return;
    }
    this.#options.onStatus?.({ state: 'pending' });
    this.#armTimer(delay);
  }

  async flush(): Promise<AppSettingsResponse | null> {
    this.#assertUsable();
    this.#clearTimer();
    const next = this.#pending;
    if (!next) {
      const result = await this.#queue;
      return result.state === 'saved' ? result.response : null;
    }
    if (!this.#session || !this.#connectivity.isOnline()) {
      return null;
    }

    const sessionEpoch = this.#session.epoch;
    this.#pending = null;
    const savePromise = this.#queue.then(
      () => this.#persist(next, sessionEpoch),
      () => this.#persist(next, sessionEpoch)
    );
    this.#queue = savePromise;
    const result = await savePromise;
    this.#afterSave(next, result);
    return result.state === 'saved' ? result.response : null;
  }

  /**
   * Drains edits made before or during an in-flight request. A failed/offline
   * drain rejects so a logout caller cannot silently discard a device change.
   */
  async flushPending(): Promise<AppSettingsResponse | null> {
    this.#assertUsable();
    let latest: AppSettingsResponse | null = null;
    while (true) {
      const response = await this.flush();
      latest = response ?? latest;
      await this.#queue;
      if (!this.#pending) {
        return latest;
      }
      if (!this.#session) {
        throw new Error('Cloud settings cannot be flushed without a session.');
      }
      if (!this.#connectivity.isOnline()) {
        throw new Error('Cloud settings cannot be flushed while offline.');
      }
      if (this.#lastFailedEditEpoch === this.#pending.editEpoch) {
        throw new Error(
          'Cloud settings could not be saved. The device copy remains pending.'
        );
      }
      this.#clearTimer();
    }
  }

  async whenIdle(): Promise<void> {
    await this.#queue;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#clearTimer();
    this.#unsubscribeConnectivity();
    this.#sessionEpoch += 1;
    this.#session = null;
  }

  async #persist(next: PendingSave, sessionEpoch: number): Promise<SaveResult> {
    if (!this.#isActiveSession(sessionEpoch, next.userId)) {
      return { state: 'stale' };
    }

    try {
      let session = this.#session!;
      let response: AppSettingsResponse;
      try {
        response = await this.#options.api.updateSettings({
          settings: next.settings,
          expectedRevision: session.account.revision
        });
      } catch (error) {
        if (!this.#isConflict(error)) {
          throw error;
        }
        const currentAccount = await this.#options.api.getSettings();
        if (!this.#isActiveSession(sessionEpoch, next.userId)) {
          return { state: 'stale' };
        }
        session = this.#session!;
        session.account = currentAccount;
        this.#options.onAccountSettings?.(currentAccount);
        response = await this.#options.api.updateSettings({
          settings: next.settings,
          expectedRevision: currentAccount.revision
        });
      }

      if (!this.#isActiveSession(sessionEpoch, next.userId)) {
        return { state: 'stale' };
      }
      this.#session!.account = response;
      this.#options.onAccountSettings?.(response);
      return { state: 'saved', response };
    } catch (error) {
      if (!this.#isActiveSession(sessionEpoch, next.userId)) {
        return { state: 'stale' };
      }
      if (next.editEpoch === this.#editEpoch && !this.#pending) {
        this.#pending = next;
        this.#automaticRetries += 1;
        this.#lastFailedEditEpoch = next.editEpoch;
      }
      this.#syncedRevision = null;
      this.#options.onLocalSettings?.(this.#currentSettings, null);
      this.#options.onStatus?.({ state: 'error', error });
      return { state: 'failed' };
    }
  }

  #afterSave(next: PendingSave, result: SaveResult): void {
    if (result.state === 'saved') {
      this.#automaticRetries = 0;
      this.#lastFailedEditEpoch = null;
      if (next.editEpoch === this.#editEpoch && !this.#pending) {
        this.#syncedRevision = result.response.revision;
        this.#options.onLocalSettings?.(
          next.settings,
          result.response.revision
        );
        this.#options.onStatus?.({
          state: 'saved',
          revision: result.response.revision
        });
      }
      return;
    }

    if (
      result.state === 'failed' &&
      this.#pending &&
      this.#connectivity.isOnline() &&
      this.#automaticRetries <= this.#maxAutomaticRetries
    ) {
      this.#armTimer(this.#retryDelayMs);
    }
  }

  #handleConnectivityChange(online: boolean): void {
    if (this.#disposed) {
      return;
    }
    this.#clearTimer();
    if (!online) {
      if (this.#pending || this.#syncedRevision === null) {
        this.#options.onStatus?.({ state: 'offline' });
      }
      return;
    }
    this.#automaticRetries = 0;
    this.#lastFailedEditEpoch = null;
    if (this.#pending && this.#session) {
      this.#options.onStatus?.({ state: 'pending' });
      this.#armTimer(0);
    }
  }

  #isActiveSession(epoch: number, userId: string | null): boolean {
    return (
      this.#session !== null &&
      this.#session.epoch === epoch &&
      this.#session.userId === userId
    );
  }

  #armTimer(delay: number): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error('Cloud settings autosave has been disposed.');
    }
  }
}
