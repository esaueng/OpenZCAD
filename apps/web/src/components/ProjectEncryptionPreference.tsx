import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import {
  createProjectPreferenceApi,
  loadProjectPreference,
  localStoragePreferencePins,
  preferenceFloor,
  saveProjectPreference,
  type PreferencePinStore,
  type ProjectPreferenceApi,
  type ProjectPreferenceState
} from '../lib/e2ee/projectPreferences';
import { unlockedAccount } from '../lib/e2ee/unlockedKeys';
import {
  isSupportedProjectFormat,
  PROJECT_STORAGE_FORMAT_E2EE_V1
} from '@openzcad/shared';
import { Group, Notice, SettingRow, Toggle } from './settingsControls';

/** This build can write encrypted projects only once it can open them. */
const CAN_CREATE_ENCRYPTED = isSupportedProjectFormat(
  PROJECT_STORAGE_FORMAT_E2EE_V1
);

/**
 * Settings › Encryption › "Encrypt new projects" (ADR-024 Phase 4, decision
 * D2). Shown only when the Worker opens encrypted projects to this account
 * (E2EE_PROJECTS_ENABLED and migration 0031) and this device holds the
 * unlocked account key, which MACs the record. Kept apart from
 * EncryptionSettings so it mounts there with one line.
 */
export function ProjectEncryptionPreference({
  userId,
  unlocked,
  api: injectedApi,
  pins: injectedPins
}: {
  userId: string;
  /** This device holds the account key (keys set up and unlocked here). */
  unlocked: boolean;
  api?: ProjectPreferenceApi;
  pins?: PreferencePinStore;
}) {
  const api = useMemo(
    () => injectedApi ?? createProjectPreferenceApi(),
    [injectedApi]
  );
  const pins = useMemo(
    () => injectedPins ?? localStoragePreferencePins(),
    [injectedPins]
  );
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [required, setRequired] = useState(false);
  const [state, setState] = useState<ProjectPreferenceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const context = useCallback(() => {
    const account = unlockedAccount(userId);
    return account
      ? { userId, accountKey: account.accountKey, api, pins }
      : null;
  }, [api, pins, userId]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const config = await api.config();
      const open = config.enabled && config.projectsEnabled === true;
      setEnabled(open);
      setRequired(config.defaultOn === true);
      const ctx = context();
      if (!open || !ctx) return;
      setState(await loadProjectPreference(ctx));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The encryption setting is unavailable right now.'
      );
    }
  }, [api, context]);

  useEffect(() => {
    if (unlocked) void reload();
  }, [reload, unlocked]);

  if (!unlocked || enabled !== true || !context()) return null;

  const choose = async (encryptNewProjects: boolean) => {
    const ctx = context();
    if (!ctx || !state || required) return;
    setBusy(true);
    setError(null);
    try {
      setState(
        await saveProjectPreference(
          ctx,
          encryptNewProjects,
          preferenceFloor(state)
        )
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The encryption setting could not be saved.'
      );
      // A newer record elsewhere, or a refused write: show what is stored.
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const checked =
    required || (state?.kind === 'verified' && state.encryptNewProjects);
  return (
    <Group title="Projects">
      {error ? (
        <Notice
          tone="warning"
          role="alert"
          action={
            <button
              className="secondary"
              type="button"
              onClick={() => void reload()}
            >
              <RefreshCcw size={13} aria-hidden="true" />
              Retry
            </button>
          }
        >
          {error}
        </Notice>
      ) : null}
      {state?.kind === 'refused' ? (
        <Notice tone="warning" role="alert">
          {state.message}
        </Notice>
      ) : null}
      <SettingRow
        title="Encrypt new projects"
        hint={
          required
            ? 'Encryption is required for new cloud projects on this server.'
            : state?.kind === 'refused'
              ? 'Unknown: the stored setting was not trusted.'
              : CAN_CREATE_ENCRYPTED
                ? 'New cloud projects are end-to-end encrypted. Existing projects stay as they are; the assistant is off on encrypted projects for now.'
                : 'While this is on, your account accepts only end-to-end encrypted new projects, which this version of OpenZCAD cannot create yet. Existing projects stay as they are.'
        }
      >
        <Toggle
          label="Encrypt new projects"
          checked={checked}
          disabled={required || busy || state === null}
          onChange={(next) => void choose(next)}
        />
      </SettingRow>
    </Group>
  );
}
