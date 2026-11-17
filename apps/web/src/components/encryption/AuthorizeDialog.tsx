import { useId, useState } from 'react';
import { Fingerprint, KeyRound } from 'lucide-react';
import type { Bytes } from '@openzcad/crypto';
import type {
  EncryptionState,
  UnlockAuthorization
} from '../../lib/e2ee/accountKeys';
import { EncryptionDialog } from './EncryptionDialog';
import { isWrongRecoveryKey, readRecoveryKey, type Shared } from './flow';

export interface AuthorizeRequest {
  title: string;
  /** One sentence on what happens, and what does not. */
  body?: string;
  /** The verb on the recovery-key button, such as "Remove device". */
  actionLabel: string;
  danger?: boolean;
  /** Offer this account's passkey first (it has one, and PRF can work here). */
  passkey: boolean;
  /** Whether the recovery key may authorize it too (every flow but one). */
  recoveryKey?: boolean;
  work(authorization: UnlockAuthorization): Promise<EncryptionState | void>;
}

/**
 * The one confirmation for every action that opens the identity key:
 * approving or removing a device, revoking read-only access, adding or
 * removing a passkey, resetting a project's group, sealing contacts and
 * unlocking this device. A passkey comes first where the account has one;
 * the recovery key waits behind "Use recovery key instead". A wrong key is
 * said under the field it was typed in (review I4), and any other failure
 * inside the dialog, never hundreds of pixels away on the page.
 */
export function AuthorizeDialog({
  request,
  busy,
  run,
  onClose
}: Pick<Shared, 'busy' | 'run'> & {
  request: AuthorizeRequest;
  onClose(): void;
}) {
  const allowRecovery = request.recoveryKey !== false;
  const [showKey, setShowKey] = useState(!request.passkey);
  const [text, setText] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const fieldId = useId();

  const authorize = (authorization: 'passkey' | 'recovery') =>
    void run(
      async () => {
        setError(null);
        setKeyError(null);
        if (authorization === 'passkey') {
          const next = await request.work('passkey');
          onClose();
          return next;
        }
        let secret: Bytes;
        try {
          secret = await readRecoveryKey(text);
        } catch (caught) {
          if (isWrongRecoveryKey(caught)) {
            setKeyError(caught.message);
            return;
          }
          throw caught;
        }
        try {
          const next = await request.work(secret);
          setText('');
          onClose();
          return next;
        } catch (caught) {
          if (isWrongRecoveryKey(caught)) {
            setKeyError(caught.message);
            return;
          }
          throw caught;
        } finally {
          secret.fill(0);
        }
      },
      { onError: setError }
    );

  return (
    <EncryptionDialog
      title={request.title}
      tone={request.danger ? 'danger' : undefined}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          {showKey && allowRecovery ? (
            <button
              className={request.danger ? 'confirm-dialog-danger' : 'primary'}
              type="button"
              disabled={busy || text.trim() === ''}
              onClick={() => authorize('recovery')}
            >
              {request.actionLabel}
            </button>
          ) : null}
        </>
      }
    >
      {request.body ? <p>{request.body}</p> : null}
      {error ? (
        <p className="encryption-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      {request.passkey ? (
        <button
          className="primary encryption-passkey-button"
          type="button"
          disabled={busy}
          onClick={() => authorize('passkey')}
        >
          <Fingerprint size={15} aria-hidden="true" />
          Confirm with passkey
        </button>
      ) : null}
      {allowRecovery && request.passkey ? (
        <button
          className="encryption-link-button"
          type="button"
          aria-expanded={showKey}
          onClick={() => setShowKey((shown) => !shown)}
        >
          <KeyRound size={13} aria-hidden="true" />
          Use recovery key instead
        </button>
      ) : null}
      {allowRecovery && showKey ? (
        <div className="encryption-key-field">
          <label htmlFor={fieldId}>Recovery key</label>
          <input
            id={fieldId}
            value={text}
            aria-invalid={keyError ? true : undefined}
            aria-describedby={keyError ? errorId : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXX-XXXX-…"
            onChange={(event) => {
              setKeyError(null);
              setText(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && text.trim() && !busy)
                authorize('recovery');
            }}
          />
          <small>Used for this change only, then forgotten.</small>
          {keyError ? (
            <small id={errorId} className="settings-field-error" role="alert">
              {keyError}
            </small>
          ) : null}
        </div>
      ) : null}
    </EncryptionDialog>
  );
}
