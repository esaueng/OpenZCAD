import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type {
  AccountDeletionPreview,
  AccountDeletionScope
} from '@openzcad/shared';
import { api } from '../lib/api';
import { useModalFocus } from '../lib/useModalFocus';

interface CloudDataDeletionDialogProps {
  scope: AccountDeletionScope;
  onConfirm(scope: AccountDeletionScope, confirmation: string): Promise<void>;
  onClose(): void;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1
    ? `${megabytes.toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

function inventory(
  scope: AccountDeletionScope,
  preview: AccountDeletionPreview
): string {
  const totalBytes = preview.documentBytes + preview.revisionBytes;
  if (scope === 'profile') {
    return `${preview.projectCount} owned cloud project(s) will be retained under a minimal anonymous ownership record.`;
  }
  return `${preview.projectCount} owned cloud project(s), ${preview.revisionCount} saved revision(s), and at least ${formatBytes(totalBytes)} of document and revision data will be deleted.`;
}

export function CloudDataDeletionDialog({
  scope,
  onConfirm,
  onClose
}: CloudDataDeletionDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [confirmation, setConfirmation] = useState('');
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

  const matches = Boolean(
    preview &&
    (preview.confirmationKind === 'email'
      ? confirmation.trim().toLowerCase() === preview.confirmationText
      : confirmation.trim() === preview.confirmationText)
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
      setError(
        caught instanceof Error ? caught.message : 'Cloud data deletion failed.'
      );
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
                  {preview.collaboratorCount} collaborator(s) will immediately
                  lose access to projects you own.
                </p>
              ) : null}
              <p>
                Local projects and settings on this device will remain. Projects
                owned by other people will not be deleted.
              </p>
              <small>
                Live OpenZCAD cloud data is removed immediately. Provider
                disaster-recovery copies may remain for Cloudflare’s documented
                retention window.
              </small>
            </div>
            <label className="cloud-deletion-confirmation">
              <span>
                Type{' '}
                <strong className="mono">{preview.confirmationText}</strong> to
                confirm
              </span>
              <input
                ref={inputRef}
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={confirmation}
                disabled={busy}
                aria-label="Deletion confirmation"
                onChange={(event) => setConfirmation(event.currentTarget.value)}
              />
            </label>
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
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cloud-deletion-confirm"
            disabled={!matches || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Deleting…' : copy.action}
          </button>
        </div>
      </div>
    </div>
  );
}
