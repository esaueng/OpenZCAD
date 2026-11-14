import { countLabel } from '../lib/toasts';
import { formatBytes } from '../lib/formatBytes';
import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type {
  AccountDeletionPreview,
  AccountDeletionScope
} from '@openzcad/shared';
import { api, ApiError } from '../lib/api';
import { useModalFocus } from '../lib/useModalFocus';
import { PrivateText } from './PersonalInfo';

interface CloudDataDeletionDialogProps {
  scope: AccountDeletionScope;
  onConfirm(scope: AccountDeletionScope, confirmation: string): Promise<void>;
  onClose(): void;
  /** Closes the dialog at "Download all data" (design review I84). */
  onDownloadFirst?(): void;
}

/**
 * A refusal the server gives before deleting anything (a typo, deletion
 * unavailable) is its own message. Anything else may have stopped partway:
 * say so, and that trying again finishes it (design review I84).
 */
export function deletionFailureMessage(caught: unknown): string {
  const message =
    caught instanceof Error ? caught.message : 'Cloud data deletion failed.';
  if (caught instanceof ApiError && caught.status < 500) return message;
  return `${message} Deletion may have stopped partway, so some cloud data may already be gone. Nothing on this device was deleted. Try again to finish.`;
}

const COPY: Record<
  AccountDeletionScope,
  { title: string; action: string; consequence: string }
> = {
  projects: {
    title: 'Delete all cloud projects?',
    action: 'Delete cloud projects',
    consequence:
      'Every cloud project you own, its revision history, imports, generated files, and live collaboration state will be deleted.'
  },
  profile: {
    title: 'Delete your cloud profile?',
    action: 'Delete cloud profile',
    consequence:
      'Your email profile, synchronized settings, personal AI credential, and every signed-in session will be deleted.'
  },
  all: {
    title: 'Delete all cloud data?',
    action: 'Delete all cloud data',
    consequence:
      'Your cloud profile and every cloud project you own will be deleted together, including revisions, imports, generated files, and collaboration state.'
  }
};

function inventory(
  scope: AccountDeletionScope,
  preview: AccountDeletionPreview
): string {
  const totalBytes = preview.documentBytes + preview.revisionBytes;
  if (scope === 'profile') {
    return `${countLabel(preview.projectCount, 'owned cloud project', 'owned cloud projects')} will be retained under a minimal anonymous ownership record.`;
  }
  return `${countLabel(preview.projectCount, 'owned cloud project', 'owned cloud projects')}, ${countLabel(preview.revisionCount, 'saved revision', 'saved revisions')}, and at least ${formatBytes(totalBytes, 'iec')} of document and revision data will be deleted.`;
}

export function CloudDataDeletionDialog({
  scope,
  onConfirm,
  onClose,
  onDownloadFirst
}: CloudDataDeletionDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [personalInfoVisible, setPersonalInfoVisible] = useState(false);
  // Masked only while not being typed in (design review I78).
  const [confirmationFocused, setConfirmationFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[scope];
  useModalFocus(dialogRef, {
    autoFocus: true,
    initialFocusRef: inputRef
  });

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    void api
      .accountDeletionPreview(scope)
      .then((loaded) => {
        if (!cancelled) {
          setPreview(loaded);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Could not inspect your cloud data.'
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // The confirmation field arrives with the preview, after opening focused
  // the only control there was, Cancel. Move on to the field unless the
  // viewer has taken focus somewhere else in the meantime.
  useEffect(() => {
    if (!preview) {
      return;
    }
    const active = document.activeElement;
    if (
      active === cancelRef.current ||
      active === dialogRef.current ||
      active === document.body
    ) {
      inputRef.current?.focus();
    }
  }, [preview]);

  const matches = Boolean(
    preview &&
    (preview.confirmationKind === 'email'
      ? confirmation.trim().toLowerCase() === preview.confirmationText
      : confirmation.trim() === preview.confirmationText)
  );

  // A typed value that cannot become the expected one says so, instead of
  // only leaving the button disabled (design review I78).
  const typed =
    preview?.confirmationKind === 'email'
      ? confirmation.trim().toLowerCase()
      : confirmation.trim();
  const mismatch = Boolean(
    preview &&
    typed !== '' &&
    !matches &&
    (!confirmationFocused || !preview.confirmationText.startsWith(typed))
  );

  const submit = async () => {
    if (!matches || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(scope, confirmation);
    } catch (caught) {
      setError(deletionFailureMessage(caught));
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="cloud-deletion-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-deletion-title"
        aria-describedby="cloud-deletion-description"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) {
              onClose();
            }
          }
        }}
      >
        <header>
          <TriangleAlert size={18} aria-hidden="true" />
          <div>
            <h2 id="cloud-deletion-title">{copy.title}</h2>
            <p id="cloud-deletion-description">{copy.consequence}</p>
          </div>
        </header>

        {preview ? (
          <>
            <div className="cloud-deletion-impact">
              <strong>This cannot be undone in OpenZCAD.</strong>
              <p>{inventory(scope, preview)}</p>
              {preview.collaboratorCount > 0 && scope !== 'profile' ? (
                <p>
                  {countLabel(
                    preview.collaboratorCount,
                    'collaborator',
                    'collaborators'
                  )}{' '}
                  will immediately lose access to projects you own.
                </p>
              ) : null}
              {onDownloadFirst ? (
                <p>
                  <button
                    type="button"
                    className="cloud-deletion-download"
                    onClick={onDownloadFirst}
                  >
                    Download your data first
                  </button>{' '}
                  to keep a copy of what will be deleted.
                </p>
              ) : null}
              <p>
                Local projects and settings on this device will remain. Projects
                owned by other people will not be deleted.
              </p>
              {scope !== 'projects' ? (
                // What it means for encryption, said before, not after
                // (design review I84): the key tables go with the profile.
                <p>
                  If you set up end-to-end encryption, the keys stored with your
                  account go too: your identity, your devices and their wrapped
                  keys. Your recovery key will no longer unlock anything.
                </p>
              ) : null}
              <small>
                Live OpenZCAD cloud data is removed immediately. Provider
                disaster-recovery copies may remain for Cloudflare’s documented
                retention window.
              </small>
            </div>
            {/* Not a <label>: it would take the email's reveal button, its
                first labelable descendant, as its control. The field carries
                its own name. */}
            <div className="cloud-deletion-confirmation">
              {/* Mono marks text to type verbatim. An email stays blurred
                  until clicked, and that click also unmasks the field. */}
              <span>
                Type{' '}
                {preview.confirmationKind === 'email' ? (
                  <PrivateText
                    className="mono"
                    value={preview.confirmationText}
                    visible={personalInfoVisible}
                    onChange={setPersonalInfoVisible}
                  />
                ) : (
                  <strong className="mono">{preview.confirmationText}</strong>
                )}{' '}
                to confirm
              </span>
              <input
                ref={inputRef}
                type={
                  preview.confirmationKind === 'email' &&
                  !personalInfoVisible &&
                  !confirmationFocused
                    ? 'password'
                    : 'text'
                }
                aria-invalid={mismatch || undefined}
                aria-describedby={
                  mismatch ? 'cloud-deletion-mismatch' : undefined
                }
                onFocus={() => setConfirmationFocused(true)}
                onBlur={() => setConfirmationFocused(false)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={confirmation}
                disabled={busy}
                aria-label="Deletion confirmation"
                onChange={(event) => setConfirmation(event.currentTarget.value)}
              />
            </div>
            {mismatch ? (
              <p id="cloud-deletion-mismatch" className="cloud-deletion-error">
                {preview.confirmationKind === 'email'
                  ? 'That doesn’t match your account’s email address.'
                  : 'That doesn’t match. Type it exactly as shown.'}
              </p>
            ) : null}
          </>
        ) : error ? null : (
          <p className="cloud-deletion-loading" role="status">
            Inspecting cloud data…
          </p>
        )}

        {error ? (
          <p className="cloud-deletion-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="cloud-deletion-actions">
          <button
            ref={cancelRef}
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          {/* aria-disabled, not disabled, while deleting: disabling the
              focused button dropped focus on the body, and a failure's error
              then appeared with the keyboard nowhere. */}
          <button
            type="button"
            className="cloud-deletion-confirm"
            disabled={!matches}
            aria-disabled={busy || undefined}
            onClick={() => void submit()}
          >
            {busy ? 'Deleting…' : copy.action}
          </button>
        </div>
      </div>
    </div>
  );
}
