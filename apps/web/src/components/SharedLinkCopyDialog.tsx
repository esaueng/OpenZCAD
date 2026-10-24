import { useRef } from 'react';
import { useModalFocus } from '../lib/useModalFocus';

export type SharedLinkCopyDestination = 'account' | 'device';

/**
 * Where "Make a copy" puts an end-to-end encrypted share link's model
 * (ADR-024 slice 5-11) for a signed-in visitor: into their account, which
 * stores it encrypted under their own keys when the account encrypts new
 * projects and without end-to-end encryption otherwise, or on this device
 * only. `accountEncrypts` is null while the account is being asked.
 */
export function SharedLinkCopyDialog({
  accountEncrypts,
  onChoose
}: {
  accountEncrypts: boolean | null;
  onChoose(destination: SharedLinkCopyDestination | null): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, { autoFocus: true });
  return (
    <div className="modal-backdrop">
      <div
        className="save-revision-dialog"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shared-link-copy-title"
        aria-describedby="shared-link-copy-account"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onChoose(null);
          }
        }}
      >
        <h2 id="shared-link-copy-title">Make a copy</h2>
        <p>
          The copy is yours: it keeps the model, its parameters and history, and
          opens in Build mode. Later changes the owner makes don&apos;t reach
          it.
        </p>
        <p id="shared-link-copy-account">
          {accountEncrypts === null
            ? 'Checking your account…'
            : accountEncrypts
              ? 'Your account encrypts new projects, so a copy in your account is end-to-end encrypted under your keys.'
              : "Your account doesn't encrypt new projects, so a copy in your account is stored without end-to-end encryption."}
        </p>
        <div className="save-revision-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => onChoose(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => onChoose('device')}
          >
            Keep on this device only
          </button>
          <button
            type="button"
            className="primary"
            disabled={accountEncrypts === null}
            onClick={() => onChoose('account')}
          >
            Copy to your account
          </button>
        </div>
      </div>
    </div>
  );
}
