import { useEffect, useState } from 'react';
import type { AppSettings, AppSettingsResponse } from '@openzcad/shared';
import {
  loadAssistantStatus,
  type AssistantStatus
} from '../lib/assistantStream';
import { assistantPersonalRowsShown } from '../lib/settingsSections';
import { ExternalAnchor } from './ExternalAnchor';
import {
  Group,
  Notice,
  Segmented,
  SettingRow,
  Status,
  Toggle,
  type SegmentOption
} from './settingsControls';

const CREDENTIAL_OPTIONS: readonly SegmentOption<
  AppSettings['assistant']['credentialSource']
>[] = [
  { value: 'deployment', label: 'Built-in' },
  { value: 'personal', label: 'Personal token' }
];

const SENT = 'Your prompts, conversation, model context and attachments go to';
const FREE_MODEL_NOTICE = 'Free to use, with usage limits.';
const CONFIDENTIAL = 'Don’t send anything confidential.';

/** The AI section owns its fallback read, independently of account discovery. */
export function AssistantConnectionSettings({
  assistant,
  accountState,
  sessionUserId,
  encryptedProjectOpen,
  onChange
}: {
  assistant: AppSettings['assistant'];
  accountState: AppSettingsResponse | null;
  sessionUserId: string | undefined;
  encryptedProjectOpen: boolean;
  onChange(next: Partial<AppSettings['assistant']>): void;
}) {
  const effective = accountState?.effectiveAssistant;
  // The test Settings search uses for which rows are drawn.
  const personal = assistantPersonalRowsShown(assistant);
  const [read, setRead] = useState<{
    userId: string | undefined;
    result: AssistantStatus | null;
  } | null>(null);

  useEffect(() => {
    setRead(null);
    if (effective || personal) return;
    const controller = new AbortController();
    void loadAssistantStatus(controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setRead({ userId: sessionUserId, result });
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setRead({ userId: sessionUserId, result: null });
        }
      }
    );
    return () => controller.abort();
  }, [effective, personal, sessionUserId]);

  const currentRead = read?.userId === sessionUserId ? read : null;
  const status = effective ?? currentRead?.result;
  const loading = !effective && currentRead === null;
  const encryptedProjectUnsupported =
    encryptedProjectOpen && status?.encryptedProjectUnsupported === true;
  const badge = loading
    ? 'Loading…'
    : !status
      ? 'Unavailable'
      : !assistant.enabled
        ? 'Off'
        : !status.configured
          ? 'Unavailable'
          : encryptedProjectUnsupported
            ? 'Unavailable for encrypted projects'
            : 'Configured';
  const policy =
    status?.provider === 'openrouter'
      ? {
          text: `${SENT} OpenRouter and the model’s provider, which may keep them or use them for training.`,
          href: 'https://openrouter.ai/docs/guides/privacy/provider-logging',
          label: 'OpenRouter data policies'
        }
      : status?.provider === 'openai'
        ? {
            text: `${SENT} OpenAI, which may keep them for safety but does not train on them unless this deployment’s operator opts in.`,
            href: 'https://developers.openai.com/api/docs/guides/your-data',
            label: 'OpenAI API data policies'
          }
        : {
            text: `${SENT} this deployment’s AI provider, which may keep them or use them for training. Ask its operator which policies apply.`,
            href: null,
            label: ''
          };
  const free =
    status?.configured === true &&
    status.provider === 'openrouter' &&
    status.model.endsWith(':free');

  return (
    <>
      <Group>
        <SettingRow
          title="AI assistant"
          hint="Off removes it from the workspace."
        >
          <Toggle
            checked={assistant.enabled}
            label="AI assistant"
            onChange={(enabled) => onChange({ enabled })}
          />
        </SettingRow>
        <SettingRow
          title="Credential source"
          hint="Use the built-in model, or your own API key and model."
        >
          <Segmented
            label="AI credential source"
            value={assistant.credentialSource}
            options={CREDENTIAL_OPTIONS}
            onChange={(credentialSource) => onChange({ credentialSource })}
          />
        </SettingRow>
        {!personal && (
          <SettingRow
            title="Built-in assistant"
            hint={
              loading ? (
                <span
                  className="settings-assistant-model-loading"
                  aria-hidden="true"
                >
                  Loading model…
                </span>
              ) : status ? (
                <span
                  className="settings-assistant-model"
                  title={`${status.provider} · ${status.model} · ${status.reasoningEffort} reasoning`}
                >
                  {status.provider} · {status.model} · {status.reasoningEffort}{' '}
                  reasoning
                </span>
              ) : (
                'Status appears when the server is reachable.'
              )
            }
          >
            <Status
              tone={
                loading || !assistant.enabled
                  ? undefined
                  : status?.configured && !encryptedProjectUnsupported
                    ? 'good'
                    : 'warning'
              }
            >
              {badge}
            </Status>
          </SettingRow>
        )}
      </Group>
      {personal ? (
        <Notice>
          Requests use your selected provider and model. That provider’s data
          retention, training policies, usage limits, and charges apply to
          prompts, model context, and attachments.
        </Notice>
      ) : (
        <Group title="Data use">
          <div className="settings-assistant-data" aria-busy={loading}>
            {loading ? (
              <div
                className="settings-assistant-data-loading"
                role="status"
                aria-label="Loading assistant data policies"
              />
            ) : (
              <Notice>
                {free ? `${FREE_MODEL_NOTICE} ` : null}
                {policy.text} {CONFIDENTIAL}{' '}
                {policy.href ? (
                  <ExternalAnchor href={policy.href}>
                    {policy.label}
                  </ExternalAnchor>
                ) : null}
              </Notice>
            )}
          </div>
        </Group>
      )}
    </>
  );
}
