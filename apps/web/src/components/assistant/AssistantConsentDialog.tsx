import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock } from 'lucide-react';
import {
  ASSISTANT_CONSENT_FINALITY,
  ASSISTANT_CONSENT_ITEMS,
  ASSISTANT_CONSENT_TRANSIT
} from '../../lib/assistant/consentCopy';
import { useModalFocus } from '../../lib/useModalFocus';

/**
 * The question an encrypted project asks before its first assistant request
 * (ADR-024 Phase 6, slice 6-1): exactly what leaves this device, who
 * receives it, and that it cannot be recalled. Nothing is sent unless the
 * user allows it, and the answer is stored for this project only.
 */
export function AssistantConsentDialog({
  routeLabel,
  error,
  onAllow,
  onCancel
}: {
  /** "OpenZCAD’s AI provider, OpenRouter, model …" or "your own key with …". */
  routeLabel: string;
  error?: string | null;
  onAllow(): Promise<void> | void;
  onCancel(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  useModalFocus(ref, { autoFocus: true });
  // Portaled: the panel sits in the stage's stacking context, which lets
  // the workspace take the pointer over a dialog rendered inside it.
  return createPortal(
    <div
      className="modal-backdrop"
      data-assistant-consent=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={ref}
        className="assistant-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id={titleId}>
          <Lock size={16} aria-hidden="true" />
          Let the assistant read this encrypted project?
        </h2>
        <p>
          The assistant cannot work on encrypted data. Each request you send
          from this project goes in plaintext to {routeLabel}, and contains:
        </p>
        <ul className="assistant-consent-list">
          {ASSISTANT_CONSENT_ITEMS.map((item) => (
            <li key={item.label}>
              <strong>{item.label}.</strong> {item.detail}
            </li>
          ))}
        </ul>
        <p>{ASSISTANT_CONSENT_TRANSIT}</p>
        <p>
          {ASSISTANT_CONSENT_FINALITY} This choice is for you, on this project
          only; you can stop it from the assistant, the project’s properties or
          Settings › Encryption.
        </p>
        {error ? (
          <p className="assistant-consent-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="assistant-consent-actions">
          {/* Blocked while the allow is being stored, like the backdrop and
              Escape: a decline then would close the dialog while the
              consent it means to refuse still lands. */}
          <button
            type="button"
            className="secondary"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            Not now
          </button>
          <button
            type="button"
            className="primary"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void Promise.resolve(onAllow()).finally(() => setBusy(false));
            }}
          >
            Allow for this project
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * The panel's standing reminder while consent is in force: what it allows,
 * and Stop, which revokes it and aborts a request in flight.
 */
export function AssistantConsentChip({
  routeLabel,
  onStop
}: {
  routeLabel: string;
  onStop(): void;
}) {
  return (
    <p className="assistant-consent-chip" role="status">
      <Lock size={12} aria-hidden="true" />
      <span title={`Requests go to ${routeLabel}.`}>
        Allowed for this project
      </span>
      <button
        type="button"
        className="assistant-foot-action"
        aria-label="Stop the assistant reading this project"
        onClick={onStop}
      >
        Stop
      </button>
    </p>
  );
}
