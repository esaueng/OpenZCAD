import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, AppSettingsResponse } from '@openzcad/shared';
import type * as AppSettingsModule from '../lib/appSettings';
import {
  defaultAppSettings,
  loadLocalAppSettingsRecord,
  saveLocalAppSettings,
  type LocalAppSettingsRecord
} from '../lib/appSettings';
import type {
  CloudSettingsAutosaveOptions,
  CloudSettingsAutosaveStatus
} from '../lib/cloudSettingsAutosave';
import {
  useAppSettingsSync,
  type AppSettingsSyncInput
} from './useAppSettingsSync';

/**
 * The autosave controller stands in for the real one: the hook's contract with
 * it is which method it calls and what it does with the options it passed, and
 * a stub pins both without the timers and request queue of the real class.
 */
interface ControllerStub {
  options: CloudSettingsAutosaveOptions;
  connectSession: ReturnType<typeof vi.fn>;
  updateAccountSettings: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
  schedule: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  syncedRevision: number | null;
  hasPendingChanges: boolean;
}

const { controllers } = vi.hoisted(() => ({
  controllers: [] as ControllerStub[]
}));

vi.mock('../lib/appSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof AppSettingsModule>();
  return {
    ...actual,
    saveLocalAppSettings: vi.fn(() => true),
    loadLocalAppSettingsRecord: vi.fn((): LocalAppSettingsRecord | null => null)
  };
});

vi.mock('../lib/cloudSettingsAutosave', () => {
  class CloudSettingsAutosaveStub {
    readonly options: CloudSettingsAutosaveOptions;
    readonly connectSession = vi.fn();
    readonly updateAccountSettings = vi.fn();
    readonly endSession = vi.fn();
    readonly schedule = vi.fn();
    readonly dispose = vi.fn();

    constructor(options: CloudSettingsAutosaveOptions) {
      this.options = options;
      controllers.push(this);
    }

    get syncedRevision(): number | null {
      return this.options.initialSyncedRevision;
    }

    get hasPendingChanges(): boolean {
      return false;
    }
  }
  return { CloudSettingsAutosave: CloudSettingsAutosaveStub };
});

const loadRecord = vi.mocked(loadLocalAppSettingsRecord);
const saveSettings = vi.mocked(saveLocalAppSettings);

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...defaultAppSettings(), ...overrides };
}

function accountResponse(revision: number): AppSettingsResponse {
  return {
    settings: defaultAppSettings(),
    revision,
    synced: true,
    credential: { stored: false, storageAvailable: true },
    effectiveAssistant: {
      configured: false,
      source: 'deployment',
      provider: 'openrouter',
      model: 'openai/gpt-5.6-sol',
      reasoningEffort: 'high'
    }
  };
}

const api: AppSettingsSyncInput['api'] = {
  getSettings: vi.fn(() => Promise.resolve(accountResponse(1))),
  updateSettings: vi.fn(() => Promise.resolve(accountResponse(2)))
};

interface HarnessOptions {
  cloudEnabled?: boolean;
  accountSession?: boolean;
}

function render(options: HarnessOptions = {}) {
  const setSettingsMessage = vi.fn();
  const onAccountSettings = vi.fn();
  const hook = renderHook(() =>
    useAppSettingsSync({
      api,
      isCloudEnabled: () => options.cloudEnabled ?? false,
      hasAccountSession: () => options.accountSession ?? false,
      onAccountSettings,
      setSettingsMessage
    })
  );
  return { ...hook, setSettingsMessage, onAccountSettings };
}

function latestController(): ControllerStub {
  const controller = controllers.at(-1);
  if (!controller) {
    throw new Error('No autosave controller was constructed.');
  }
  return controller;
}

beforeEach(() => {
  controllers.length = 0;
  loadRecord.mockReturnValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.reducedMotion;
  delete document.documentElement.dataset.theme;
});

describe('boot state', () => {
  it('adopts the stored record and its synced revision', () => {
    const stored = settings({
      appearance: {
        theme: 'light',
        density: 'comfortable',
        reducedMotion: true
      }
    });
    const record: LocalAppSettingsRecord = {
      settings: stored,
      syncedRevision: 7
    };
    loadRecord.mockReturnValue(record);

    const { result } = render();

    expect(result.current.appSettings).toBe(stored);
    expect(result.current.appSettingsRef.current).toBe(stored);
    expect(result.current.syncedRevisionRef.current).toBe(7);
    expect(result.current.bootSettingsRef.current).toBe(record);
  });

  it('falls back to the defaults with no stored record', () => {
    const { result } = render();

    expect(result.current.appSettings).toEqual(defaultAppSettings());
    expect(result.current.syncedRevisionRef.current).toBeNull();
    expect(result.current.bootSettingsRef.current).toBeNull();
  });
});

describe('device persistence and chrome', () => {
  it('writes the device copy and paints density, motion and theme', () => {
    const stored = settings({
      appearance: {
        theme: 'light',
        density: 'comfortable',
        reducedMotion: true
      }
    });
    loadRecord.mockReturnValue({ settings: stored, syncedRevision: 7 });

    render();

    expect(saveSettings).toHaveBeenCalledWith(stored, 7);
    expect(document.documentElement.dataset.density).toBe('comfortable');
    expect(document.documentElement.dataset.reducedMotion).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('settings changes', () => {
  it('marks the device copy dirty when cloud is off', () => {
    loadRecord.mockReturnValue({
      settings: defaultAppSettings(),
      syncedRevision: 7
    });
    const { result, setSettingsMessage } = render({ cloudEnabled: false });
    saveSettings.mockClear();
    setSettingsMessage.mockClear();

    const next = settings({
      general: {
        reopenLastProject: false,
        defaultUnits: 'inch',
        confirmDestructiveActions: true
      }
    });
    act(() => result.current.handleAppSettingsChange(next));

    expect(result.current.syncedRevisionRef.current).toBeNull();
    expect(saveSettings).toHaveBeenCalledWith(next, null);
    expect(latestController().schedule).not.toHaveBeenCalled();
    expect(setSettingsMessage).toHaveBeenCalledWith('Saved on this device.');
  });

  it('schedules a cloud save when cloud is on with an account', () => {
    const { result, setSettingsMessage } = render({
      cloudEnabled: true,
      accountSession: true
    });
    setSettingsMessage.mockClear();

    const next = settings({
      viewport: { ...defaultAppSettings().viewport, showGrid: false }
    });
    act(() => result.current.handleAppSettingsChange(next));

    expect(latestController().schedule).toHaveBeenCalledWith(next);
    expect(setSettingsMessage).toHaveBeenCalledWith(
      'Saved on this device · saving to cloud profile…'
    );
  });
});

describe('panel widths', () => {
  it('ignores a commit at the width already saved', () => {
    const { result, setSettingsMessage } = render();
    const saved = result.current.appSettings.layout.sidebarWidth;
    saveSettings.mockClear();
    setSettingsMessage.mockClear();

    act(() => result.current.commitPanelWidth('sidebar', saved));

    expect(saveSettings).not.toHaveBeenCalled();
    expect(setSettingsMessage).not.toHaveBeenCalled();
  });

  it('keeps a new width and leaves the other panel alone', () => {
    const { result } = render();
    const before = result.current.appSettings.layout;

    act(() =>
      result.current.commitPanelWidth('sidebar', before.sidebarWidth + 40)
    );

    expect(result.current.appSettings.layout).toEqual({
      sidebarWidth: before.sidebarWidth + 40,
      assistantWidth: before.assistantWidth
    });
  });
});

describe('cloud session lifecycle', () => {
  it('connects, updates and ends in step with the account', () => {
    const { result } = render();
    const controller = latestController();
    const account = accountResponse(3);

    act(() => result.current.syncCloudSettingsSession('u1', account));
    expect(controller.connectSession).toHaveBeenCalledTimes(1);
    expect(controller.connectSession).toHaveBeenCalledWith('u1', account);

    const fresher = accountResponse(4);
    act(() => result.current.syncCloudSettingsSession('u1', fresher));
    expect(controller.updateAccountSettings).toHaveBeenCalledWith(fresher);
    expect(controller.connectSession).toHaveBeenCalledTimes(1);

    act(() => result.current.syncCloudSettingsSession('u2', fresher));
    expect(controller.endSession).toHaveBeenCalledTimes(1);
    expect(controller.connectSession).toHaveBeenCalledTimes(2);
    expect(controller.connectSession).toHaveBeenLastCalledWith('u2', fresher);
  });

  it('ends the session when either the user or the account goes away', () => {
    const { result } = render();
    const controller = latestController();
    const account = accountResponse(3);

    act(() => result.current.syncCloudSettingsSession('u1', account));
    act(() => result.current.syncCloudSettingsSession(null, account));
    expect(controller.endSession).toHaveBeenCalledTimes(1);

    act(() => result.current.syncCloudSettingsSession('u1', account));
    act(() => result.current.syncCloudSettingsSession('u2', null));
    expect(controller.endSession).toHaveBeenCalledTimes(2);
  });

  it('ends only while a session is connected', () => {
    const { result } = render();
    const controller = latestController();

    act(() => result.current.endCloudSettingsAutosave());
    expect(controller.endSession).not.toHaveBeenCalled();

    act(() =>
      result.current.syncCloudSettingsSession('u1', accountResponse(3))
    );
    act(() => result.current.endCloudSettingsAutosave());
    expect(controller.endSession).toHaveBeenCalledTimes(1);

    act(() => result.current.endCloudSettingsAutosave());
    expect(controller.endSession).toHaveBeenCalledTimes(1);
  });
});

describe('controller status messages', () => {
  function reportStatus(
    controller: ControllerStub,
    status: CloudSettingsAutosaveStatus
  ): void {
    const onStatus = controller.options.onStatus;
    if (!onStatus) {
      throw new Error('The hook did not pass an onStatus handler.');
    }
    act(() => onStatus(status));
  }

  it('reports a paused sync while offline', () => {
    const { setSettingsMessage } = render();

    reportStatus(latestController(), { state: 'offline' });

    expect(setSettingsMessage).toHaveBeenCalledWith(
      'Saved on this device · cloud sync paused until you are online.'
    );
  });

  it('reports the failure text from an autosave error', () => {
    const { setSettingsMessage } = render();

    reportStatus(latestController(), {
      state: 'error',
      error: new Error('boom')
    });

    expect(setSettingsMessage).toHaveBeenCalledWith(
      expect.stringContaining('boom')
    );
  });
});
