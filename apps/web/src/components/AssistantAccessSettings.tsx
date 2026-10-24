import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProjectSummary } from '@openzcad/shared';
import { api as appApi } from '../lib/api';
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
import { Group, Notice, SettingRow, Status } from './settingsControls';

interface Listed {
  readonly projectId: string;
  readonly route: string;
  readonly state: AssistantConsentState;
}

/** "deployment|openrouter|model" → "OpenZCAD’s key · openrouter · model". */
function routeWords(route: string): string {
  const [source, provider, model] = route.split('|');
  if (!provider) return 'Unknown provider';
  return `${source === 'personal' ? 'Your key' : 'OpenZCAD’s key'} · ${provider} · ${model ?? ''}`;
}

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
  listProjects = () => appApi.listProjects()
}: {
  userId: string;
  unlocked: boolean;
  api?: AssistantConsentApi;
  pins?: ConsentPinStore;
  listProjects?: () => Promise<{ projects: ProjectSummary[] }>;
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
      const { consents } = await api.list();
      setAvailable(true);
      setListed(
        await Promise.all(
          consents.map(async (stored) => ({
            projectId: stored.projectId,
            route: stored.route,
            state: await verifyListedConsent(ctx, stored)
          }))
        )
      );
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
    try {
      const { projects } = await listProjects();
      setNames(
        new Map(projects.map((project) => [project.projectId, project.name]))
      );
    } catch {
      // Names are a convenience: rows fall back to the project id.
    }
  }, [api, context, listProjects]);

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
      await saveAssistantConsent(
        ctx,
        entry.projectId,
        { allowed: false, route: '' },
        consentFloor(entry.state)
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'The assistant could not be stopped for this project.'
      );
    } finally {
      setBusy(null);
      await reload();
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
      {allowed.length === 0 && untrusted.length === 0 ? (
        <SettingRow
          title="Encrypted projects the assistant may read"
          hint="None. The assistant asks before it reads an encrypted project."
          compact
        >
          <Status>None</Status>
        </SettingRow>
      ) : null}
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
      <Notice tone="info">{ASSISTANT_CONSENT_TRANSIT}</Notice>
    </Group>
  );
}
