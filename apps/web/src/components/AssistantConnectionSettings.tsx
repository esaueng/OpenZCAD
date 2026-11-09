import { useEffect, useState } from 'react';
import type { AppSettings, AppSettingsResponse } from '@openzcad/shared';
import {
  loadAssistantStatus,
  type AssistantStatus
} from '../lib/assistantStream';
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

const DATA_USE_INTRO =
  'The built-in assistant sends your prompts, conversation, model context, and any attachments to the configured AI provider.';
const GENERIC_DATA_POLICY =
  'The configured AI provider may retain this data or use it for training and service improvement under its policies. Ask your deployment operator which service and data policies apply.';
const DATA_USE_END =
  'Avoid sending sensitive or confidential data. Use a personal API key to choose another model; that provider’s data policies and charges apply.';
const FREE_MODEL_NOTICE =
  'Free with no personal API key. Usage limits and provider availability apply.';

/** The AI section owns its fallback read, independently of account discovery. */
export function AssistantConnectionSettings({
  assistant,
  accountState,
  sessionUserId,
  onChange
}: {
  assistant: AppSettings['assistant'];
  accountState: AppSettingsResponse | null;
  sessionUserId: string | undefined;
  onChange(next: Partial<AppSettings['assistant']>): void;
}) {
  const effective = accountState?.effectiveAssistant;
  const personal = assistant.credentialSource === 'personal';
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
  const policy =
    status?.provider === 'openrouter'
      ? {
          text: 'OpenRouter and the model provider may retain this data or use it for training and service improvement under their policies.',
          href: 'https://openrouter.ai/docs/guides/privacy/provider-logging',
          label: 'OpenRouter data policies'
        }
      : status?.provider === 'openai'
        ? {
            text: 'OpenAI may retain API data for safety and service operation. API data is not used for training unless the deployment operator opts in to sharing.',
            href: 'https://developers.openai.com/api/docs/guides/your-data',
            label: 'OpenAI API data policies'
          }
        : { text: GENERIC_DATA_POLICY, href: null, label: '' };

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
                  : status?.configured
                    ? 'good'
                    : 'warning'
              }
            >
              {loading
                ? 'Loading…'
                : !status
                  ? 'Unavailable'
                  : !assistant.enabled
                    ? 'Off'
                    : status.configured
                      ? 'Ready'
                      : 'Unavailable'}
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
            {/* Invisible sizing copy reserves the longest policy and the optional
                free-model row at every width. CSS generated text is excluded
                from the accessibility tree; no provider copy is announced. */}
            <div className="settings-assistant-data-reserve" aria-hidden="true">
              <div className="settings-notice" data-copy={FREE_MODEL_NOTICE} />
              <div
                className="settings-notice"
                data-copy={`${DATA_USE_INTRO} ${GENERIC_DATA_POLICY} ${DATA_USE_END}`}
              />
            </div>
            <div className="settings-assistant-data-content">
              {loading ? (
                <div
                  className="settings-assistant-data-loading"
                  role="status"
                  aria-label="Loading assistant data policies"
                />
              ) : (
                <>
                  {status?.configured &&
                  status.provider === 'openrouter' &&
                  status.model.endsWith(':free') ? (
                    <Notice>{FREE_MODEL_NOTICE}</Notice>
                  ) : null}
                  <Notice>
                    {DATA_USE_INTRO} {policy.text} {DATA_USE_END}{' '}
                    {policy.href ? (
                      <ExternalAnchor href={policy.href}>
                        {policy.label}
                      </ExternalAnchor>
                    ) : null}
                  </Notice>
                </>
              )}
            </div>
          </div>
        </Group>
      )}
    </>
  );
}
