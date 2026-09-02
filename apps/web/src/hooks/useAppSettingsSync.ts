import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, AppSettingsResponse } from '@openzcad/shared';
import {
  defaultAppSettings,
  loadLocalAppSettingsRecord,
  resolvedAppTheme,
  saveLocalAppSettings
} from '../lib/appSettings';
import {
  CloudSettingsAutosave,
  type CloudSettingsAutosaveOptions
} from '../lib/cloudSettingsAutosave';
import { errorMessage } from '../lib/errors';
import { savedPanelWidths } from '../lib/panelWidths';

export interface AppSettingsSyncInput {
  api: CloudSettingsAutosaveOptions['api'];
  /** Whether cloud features are on for this device, read at call time. */
  isCloudEnabled(): boolean;
  /** Whether a signed-in account with settings is present, read at call time. */
  hasAccountSession(): boolean;
  /** The account copy the autosave just wrote or read back. */
  onAccountSettings(response: AppSettingsResponse): void;
  setSettingsMessage(message: string): void;
}

/**
 * Application settings and how they persist: the device copy written on
 * every change, the chrome theme and density painted from them, and the
 * cloud autosave that mirrors them to the account profile while a session
 * is connected. The account session itself — who is signed in, what the
 * server said — stays with the caller; this owns only what happens to the
 * settings once it knows.
 */
export function useAppSettingsSync({
  api,
  isCloudEnabled,
  hasAccountSession,
  onAccountSettings,
  setSettingsMessage
}: AppSettingsSyncInput) {
  /**
   * What was on this device at mount, read once. The account fetch resolves
   * long after the settings-persistence effect has already written to storage,
   * so re-reading it there would always look locally-edited.
   */
  const bootSettingsRef = useRef(loadLocalAppSettingsRecord());
  const [appSettings, setAppSettings] = useState<AppSettings>(
    () => bootSettingsRef.current?.settings ?? defaultAppSettings()
  );
  const appSettingsRef = useRef(appSettings);
  appSettingsRef.current = appSettings;
  /**
   * The account revision `appSettings` is in step with, or null once edited
   * here without being saved. Persisted with the settings so a reload can tell
   * an unsaved local change from a stale cache of the account copy.
   */
  const syncedRevisionRef = useRef<number | null>(
    bootSettingsRef.current?.syncedRevision ?? null
  );
  const cloudSettingsAutosaveRef = useRef<CloudSettingsAutosave | null>(null);
  const cloudSettingsSessionUserRef = useRef<string | null>(null);
  const callbacksRef = useRef({
    isCloudEnabled,
    hasAccountSession,
    onAccountSettings,
    setSettingsMessage
  });
  callbacksRef.current = {
    isCloudEnabled,
    hasAccountSession,
    onAccountSettings,
    setSettingsMessage
  };

  useEffect(() => {
    saveLocalAppSettings(appSettings, syncedRevisionRef.current);
    globalThis.document.documentElement.dataset.density =
      appSettings.appearance.density;
    globalThis.document.documentElement.dataset.reducedMotion = appSettings
      .appearance.reducedMotion
      ? 'true'
      : 'false';
  }, [appSettings]);

  useEffect(() => {
    // Resolves the theme setting to the palette actually painted. 'system'
    // tracks the host's preference live, so an OS appearance change mid-
    // session re-themes the chrome without a reload; an explicit choice
    // needs no listener. The 3D viewport keeps its dark stage either way —
    // only the chrome tokens switch (see theme/tokens.css).
    const root = globalThis.document.documentElement;
    const theme = appSettings.appearance.theme;
    if (theme !== 'system') {
      root.dataset.theme = theme;
      return;
    }
    const media = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    if (!media) {
      root.dataset.theme = 'dark';
      return;
    }
    const apply = () => {
      root.dataset.theme = resolvedAppTheme('system', media.matches);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [appSettings.appearance.theme]);

  useEffect(() => {
    const controller = new CloudSettingsAutosave({
      initialSettings: appSettingsRef.current,
      initialSyncedRevision: syncedRevisionRef.current,
      api,
      onAccountSettings(response) {
        callbacksRef.current.onAccountSettings(response);
      },
      onLocalSettings(settings, syncedRevision) {
        syncedRevisionRef.current = syncedRevision;
        saveLocalAppSettings(settings, syncedRevision);
      },
      onStatus(status) {
        const { setSettingsMessage } = callbacksRef.current;
        switch (status.state) {
          case 'pending':
            setSettingsMessage(
              'Saved on this device · saving to cloud profile…'
            );
            break;
          case 'offline':
            setSettingsMessage(
              'Saved on this device · cloud sync paused until you are online.'
            );
            break;
          case 'saved':
            setSettingsMessage('Saved to this device and cloud profile.');
            break;
          case 'error':
            setSettingsMessage(
              errorMessage(
                status.error,
                'Cloud autosave failed · changes remain saved on this device.'
              )
            );
            break;
        }
      }
    });
    cloudSettingsAutosaveRef.current = controller;
    return () => {
      controller.dispose();
      if (cloudSettingsAutosaveRef.current === controller) {
        cloudSettingsAutosaveRef.current = null;
      }
      cloudSettingsSessionUserRef.current = null;
    };
  }, [api]);

  /** Ends the account session's autosave, if one was connected. */
  const endCloudSettingsAutosave = useCallback(() => {
    if (cloudSettingsSessionUserRef.current !== null) {
      cloudSettingsAutosaveRef.current?.endSession();
      cloudSettingsSessionUserRef.current = null;
    }
  }, []);

  /**
   * Keeps the autosave's session in step with the account: connects when a
   * signed-in user with settings appears, ends when either goes away, and
   * otherwise hands it the account copy it just learned about.
   */
  const syncCloudSettingsSession = useCallback(
    (userId: string | null, accountSettings: AppSettingsResponse | null) => {
      const controller = cloudSettingsAutosaveRef.current;
      if (!controller) {
        return;
      }
      if (!userId || !accountSettings) {
        endCloudSettingsAutosave();
        return;
      }
      if (cloudSettingsSessionUserRef.current !== userId) {
        if (cloudSettingsSessionUserRef.current !== null) {
          controller.endSession();
        }
        controller.connectSession(userId, accountSettings);
        cloudSettingsSessionUserRef.current = userId;
        return;
      }
      controller.updateAccountSettings(accountSettings);
    },
    [endCloudSettingsAutosave]
  );

  function handleAppSettingsChange(next: AppSettings) {
    appSettingsRef.current = next;
    setAppSettings(next);
    const controller = cloudSettingsAutosaveRef.current;
    const { isCloudEnabled, hasAccountSession, setSettingsMessage } =
      callbacksRef.current;
    if (isCloudEnabled() && controller) {
      controller.schedule(next);
    } else {
      syncedRevisionRef.current = null;
      saveLocalAppSettings(next, null);
    }
    if (isCloudEnabled() && hasAccountSession()) {
      setSettingsMessage('Saved on this device · saving to cloud profile…');
    } else {
      setSettingsMessage('Saved on this device.');
    }
  }

  /**
   * Keeps a resized panel. It goes down the same road as every other
   * preference: the device copy is written immediately, and a signed-in session
   * syncs it to the account profile, so the width follows the person rather
   * than the browser they set it in.
   */
  function commitPanelWidth(panel: 'sidebar' | 'assistant', width: number) {
    const current = appSettingsRef.current;
    const saved = savedPanelWidths(current);
    if (saved[panel] === width) {
      return;
    }
    handleAppSettingsChange({
      ...current,
      layout: {
        sidebarWidth: panel === 'sidebar' ? width : saved.sidebar,
        assistantWidth: panel === 'assistant' ? width : saved.assistant
      }
    });
  }

  return {
    bootSettingsRef,
    appSettings,
    setAppSettings,
    appSettingsRef,
    syncedRevisionRef,
    cloudSettingsAutosaveRef,
    handleAppSettingsChange,
    commitPanelWidth,
    endCloudSettingsAutosave,
    syncCloudSettingsSession
  };
}
