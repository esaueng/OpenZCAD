import { useEffect, useRef } from 'react';

export interface ShareLinkRevokeConfirmProps {
  /** How the row names the link, e.g. "View only link". */
  name: string;
  disabled?: boolean;
  onCancel(): void;
  onRevoke(): void;
}

/**
 * Revoking a share link is final: its address was shown once, so a revoked
 * link cannot be turned back on. The row asks first, in place, with focus on
 * the safe choice (design review I2), as removing a person already does.
 */
export function ShareLinkRevokeConfirm({
  name,
  disabled = false,
  onCancel,
  onRevoke
}: ShareLinkRevokeConfirmProps) {
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keepRef.current?.focus();
  }, []);
  return (
    <div
      className="sharing-confirm"
      role="group"
      aria-label={`Revoke ${name}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Cancels the question only, not the whole dialog.
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p className="sharing-confirm-title">Revoke {name}?</p>
      <p className="sharing-hint">
        People with this link lose access right away. It cannot be turned back
        on; to share again, create a new link and send it.
      </p>
      <div className="sharing-confirm-actions">
        <button
          ref={keepRef}
          type="button"
          className="secondary"
          disabled={disabled}
          onClick={onCancel}
        >
          Keep link
        </button>
        <button
          type="button"
          className="secondary danger"
          disabled={disabled}
          onClick={onRevoke}
        >
          Revoke link
        </button>
      </div>
    </div>
  );
}
