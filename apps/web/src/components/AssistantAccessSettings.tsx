import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ASSISTANT_CONSENT_FINALITY,
  ASSISTANT_CONSENT_TRANSIT
} from '../lib/assistant/consentCopy';
import {
  assistantConsentContext,
  consentFloor,
  createAssistantConsentApi,
  localStorageConsentPins,
  saveAssistantConsent,
  verifyListedConsent,
  type AssistantConsentApi,
  type AssistantConsentState,
  type ConsentPinStore
} from '../lib/e2ee/assistantConsent';
import { verifyShelfEntries } from '../lib/e2ee/progressiveShelf';
import { isRateLimitError } from '../lib/rateLimit';
import { Group, Notice, SettingRow, Status } from './settingsControls';

interface Listed {
  readonly projectId: string;
  readonly route: string;
  readonly state: AssistantConsentState;
}

/**
 * "v2|deployment|openrouter|model|<digest>" → "OpenZCAD’s key · openrouter ·
 * model". The readable parts may be cut short; the digest is not shown.
 */
export function routeWords(route: string): string {
  const [version, source, provider, model] = route.split('|');
  if (version !== 'v2' || !provider) return 'Unknown provider';
  return `${source === 'personal' ? 'Your key' : 'OpenZCAD’s key'} · ${provider} · ${model ?? ''}`;
}

const defaultLoadProjectName = async (projectId: string) =>
  (await import('../lib/e2ee/encryptedProjects')).readEncryptedProjectName(
    projectId
  );

/**
 * Settings › Encryption › "Assistant access" (ADR-024 Phase 6, slice 6-1):
 * the encrypted projects this account lets the assistant read, each
 * verified against the account key and this device's pin, with Revoke.
 * Shown only when the Worker stores consent for this account and this
 * device holds the unlocked account key. Kept apart from EncryptionSettings
 * so it mounts there with one line.
 */
export function AssistantAccessSettings({
  userId,
  unlocked,
  api: injectedApi,
  pins: injectedPins,
  loadProjectName = defaultLoadProjectName
}: {
  userId: string;
  unlocked: boolean;
  api?: AssistantConsentApi;
  pins?: ConsentPinStore;
  loadProjectName?: (projectId: string) => Promise<string | undefined>;
}) {
  const api = useMemo(
    () => injectedApi ?? createAssistantConsentApi(),
    [injectedApi]
  );
  const pins = useMemo(
    () => injectedPins ?? localStorageConsentPins(),
    [injectedPins]
  );
  const [available, setAvailable] = useState<boolean | null>(null);
  const [listed, setListed] = useState<Listed[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const context = useCallback(
    () => assistantConsentContext(userId, api, pins),
    [api, pins, userId]
  );

  const reload = useCallback(async () => {
    const ctx = context();
    if (!ctx) return;
    setError(null);
    try {
      // Closed to this account, the consent routes only answer 501: ask
      // the config first, as the encryption preference does.
      if (api.config) {
        const config = await api.config();
        if (!config.enabled || config.projectsEnabled !== true) {
          setAvailable(false);
          return;
        }
      }
      const { consents } = await api.list();
      setAvailable(true);
      const entries = await Promise.all(
        consents.map(async (stored) => ({
          projectId: stored.projectId,
          route: stored.route,
          state: await verifyListedConsent(ctx, stored)
        }))
      );
      setListed(entries);
      const visible = entries.filter(
        ({ state }) =>
          state.kind === 'refused' ||
          (state.kind === 'verified' && state.allowed)
      );
      const resolved = new Map<string, string>();
      // A missing or rate-limited name leaves the project ID visible.
      await verifyShelfEntries(
        visible,
        ({ projectId }) => loadProjectName(projectId),
        ({ projectId }, name) => {
          if (name !== undefined) resolved.set(projectId, name);
        },
        () => context() !== null,
        isRateLimitError
      ).catch(() => {});
      setNames(resolved);
    } catch (caught) {
      const status = (caught as { status?: unknown } | null)?.status;
      if (status === 501 || status === 503 || status === 404) {
        setAvailable(false);
        return;
      }
      setError(
        caught instanceof Error
          ? caught.message
          : 'Assistant access is unavailable right now.'
      );
    }
  }, [api, context, loadProjectName]);

  useEffect(() => {
    if (unlocked) void reload();
  }, [reload, unlocked]);

  if (!unlocked || available !== true || !context()) return null;

  const revoke = async (entry: Listed) => {
    const ctx = context();
    if (!ctx) return;
    setBusy(entry.projectId);
    setError(null);
    try {
      const state = await saveAssistantConsent(
        ctx,
        entry.projectId,
        { allowed: false, route: '' },
        consentFloor(entry.state)
      );
      setListed((entries) =>
        entries.map((candidate) =>
          candidate.projectId === entry.projectId
            ? { ...candidate, route: '', state }
            : candidate
        )
      );
    } catch (caught) {
      if (!isRateLimitError(caught)) await reload();
      setError(
        caught instanceof Error
          ? caught.message
          : 'The assistant could not be stopped for this project.'
      );
    } finally {
      setBusy(null);
    }
  };

  const allowed = listed.filter(
    (entry) => entry.state.kind === 'verified' && entry.state.allowed
  );
  const untrusted = listed.filter((entry) => entry.state.kind === 'refused');

  return (
    <Group title="Assistant access">
      {error ? (
        <Notice tone="warning" role="alert">
          {error}
        </Notice>
      ) : null}
      <SettingRow
        title="Encrypted projects the assistant may read"
        hint="It asks first, one project at a time."
        details={{
          summary: 'What the server sees',
          body: ASSISTANT_CONSENT_TRANSIT
        }}
      >
        <Status tone={allowed.length ? 'warning' : undefined}>
          {allowed.length ? `${allowed.length} allowed` : 'None'}
        </Status>
      </SettingRow>
      {allowed.map((entry) => (
        <SettingRow
          key={entry.projectId}
          title={names.get(entry.projectId) ?? entry.projectId}
          hint={`Allowed · ${routeWords(entry.route)}. ${ASSISTANT_CONSENT_FINALITY}`}
        >
          <button
            type="button"
            className="secondary"
            disabled={busy !== null}
            aria-label={`Revoke assistant access to ${names.get(entry.projectId) ?? entry.projectId}`}
            onClick={() => void revoke(entry)}
          >
            {busy === entry.projectId ? 'Revoking…' : 'Revoke'}
          </button>
        </SettingRow>
      ))}
      {untrusted.map((entry) => (
        <SettingRow
          key={entry.projectId}
          title={names.get(entry.projectId) ?? entry.projectId}
          hint={
            entry.state.kind === 'refused'
              ? `${entry.state.message} Revoke to replace it.`
              : undefined
          }
        >
          <button
            type="button"
            className="secondary"
            disabled={busy !== null}
            aria-label={`Revoke assistant access to ${names.get(entry.projectId) ?? entry.projectId}`}
            onClick={() => void revoke(entry)}
          >
            Revoke
          </button>
        </SettingRow>
      ))}
    </Group>
  );
}
