import { useId, useRef, type ReactNode } from 'react';
import { useModalFocus } from '../../lib/useModalFocus';

/**
 * The one modal shell for Settings › Encryption's flows: setup, recovery-key
 * replacement and every action a passkey or the recovery key confirms. It
 * opens over Settings (the confirm layer), keeps focus inside, and Escape
 * closes it unless work is in flight. Rendered inside the Settings dialog's
 * subtree, so the page's own locators and focus return still apply.
 */
export function EncryptionDialog({
  title,
  step,
  tone,
  busy = false,
  onClose,
  children,
  footer
}: {
  title: string;
  /** "2 of 5", beside the title, for a multi-step flow. */
  step?: { at: number; of: number };
  tone?: 'danger';
  busy?: boolean;
  onClose(): void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const id = useId();
  useModalFocus(ref, { autoFocus: true });
  return (
    <div className="modal-backdrop confirm-backdrop">
      <div
        ref={ref}
        className={`encryption-dialog${tone ? ` ${tone}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (!busy) onClose();
        }}
      >
        {step ? (
          <div
            className="encryption-dialog-progress"
            role="progressbar"
            aria-label="Step"
            aria-valuemin={1}
            aria-valuemax={step.of}
            aria-valuenow={step.at}
            aria-valuetext={`Step ${step.at} of ${step.of}`}
          >
            {Array.from({ length: step.of }, (_, index) => (
              <span key={index} data-done={index < step.at || undefined} />
            ))}
          </div>
        ) : null}
        <div className="encryption-dialog-head">
          <h2 id={`${id}-title`}>{title}</h2>
          {step ? (
            <span aria-hidden="true">
              {step.at} of {step.of}
            </span>
          ) : null}
        </div>
        <div className="encryption-dialog-body">{children}</div>
        <div className="encryption-dialog-actions">{footer}</div>
      </div>
    </div>
  );
}
