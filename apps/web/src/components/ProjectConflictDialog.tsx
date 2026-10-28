import { useRef, useState } from 'react';
import type { ProjectDocument } from '@openzcad/shared';
import { ChevronRight, Cloud, Copy, Monitor, Pause } from 'lucide-react';
import type {
  ConflictResolution,
  ProjectConflict
} from '../lib/conflictRecovery';
import { useModalFocus } from '../lib/useModalFocus';
import { errorMessage } from '../lib/errors';

export interface ProjectConflictDialogProps {
  conflict: ProjectConflict;
  busy: boolean;
  /** A viewer or a room without the required edit lease cannot replace remote. */
  keepMineDisabledReason?: string | null;
  onResolve(resolution: ConflictResolution): void | Promise<void>;
  onClose(): void;
}

/** Display only: device clocks never choose a winner or bypass a version fence. */
function modifiedTime(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Rebuild projections can retain an old time after a canonical edit (e.g. rename). */
function lastModified(document: ProjectDocument): string {
  const editTime = document.revisions.at(-1)?.createdAt;
  return editTime && modifiedTime(editTime) !== null
    ? editTime
    : document.derived.updatedAt;
}

function ModifiedAt({ value }: { value: string }) {
  const time = modifiedTime(value);
  return time === null ? (
    <span className="conflict-choice-detail">Modified time unavailable</span>
  ) : (
    <time className="conflict-choice-detail" dateTime={value}>
      {new Date(time).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
      })}
    </time>
  );
}

/** One choice dialog for account and live-session conflicts; close defers it. */
export function ProjectConflictDialog({
  conflict,
  busy,
  keepMineDisabledReason = null,
  onResolve,
  onClose
}: ProjectConflictDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = busy || resolving;
  useModalFocus(dialogRef, { autoFocus: true });
  const other = conflict.source === 'account' ? 'Cloud' : 'Live session';
  const localModified = lastModified(conflict.localDocument);
  const remoteModified = lastModified(conflict.remoteDocument);
  const localTime = modifiedTime(localModified);
  const remoteTime = modifiedTime(remoteModified);
  const canCompareTimes = localTime !== null && remoteTime !== null;

  async function resolve(resolution: ConflictResolution) {
    if (working) return;
    setError(null);
    setResolving(true);
    try {
      await onResolve(resolution);
    } catch (failure) {
      setError(
        errorMessage(failure, 'Could not resolve the conflict. Please retry.')
      );
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-conflict-title"
        aria-describedby="project-conflict-consequence"
        aria-busy={working}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!working) onClose();
          }
        }}
      >
        <div className="conflict-dialog-header">
          <span className="conflict-project-name">
            {conflict.localDocument.name}
          </span>
          <span className="conflict-sync-paused">
            <Pause size={12} aria-hidden="true" />
            Sync paused
          </span>
        </div>
        <h2 id="project-conflict-title">Choose a version to keep</h2>
        <p id="project-conflict-consequence">
          Using one version replaces the other.
        </p>
        <div
          className="conflict-dialog-actions"
          role="group"
          aria-label="Last modified"
        >
          {/* aria-disabled keeps focus on the row during async confirmation,
              so errors and Escape remain reachable after a failed resolution. */}
          <button
            type="button"
            className="conflict-choice"
            disabled={keepMineDisabledReason !== null}
            aria-disabled={working || undefined}
            aria-describedby={
              keepMineDisabledReason !== null
                ? 'project-conflict-keep-mine-note'
                : undefined
            }
            onClick={() => void resolve('keep-mine')}
          >
            <Monitor size={18} aria-hidden="true" />
            <span className="conflict-choice-content">
              <span className="conflict-choice-label">
                This browser
                {canCompareTimes && localTime > remoteTime && (
                  <span className="conflict-newer">Newer</span>
                )}
              </span>
              <ModifiedAt value={localModified} />
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="conflict-choice"
            aria-disabled={working || undefined}
            onClick={() => void resolve('use-remote')}
          >
            <Cloud size={18} aria-hidden="true" />
            <span className="conflict-choice-content">
              <span className="conflict-choice-label">
                {other}
                {canCompareTimes && remoteTime > localTime && (
                  <span className="conflict-newer">Newer</span>
                )}
              </span>
              <ModifiedAt value={remoteModified} />
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="conflict-choice"
            aria-disabled={working || undefined}
            onClick={() => void resolve('save-local-copy')}
          >
            <Copy size={18} aria-hidden="true" />
            <span className="conflict-choice-content">
              <span className="conflict-choice-label">Keep both</span>
              <span className="conflict-choice-detail">
                {other} stays original; yours becomes a copy.
              </span>
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
        {working && (
          <p className="conflict-dialog-note" role="status">
            Waiting for confirmation…
          </p>
        )}
        {error && (
          <p className="conflict-dialog-error" role="alert">
            {error}
          </p>
        )}
        {keepMineDisabledReason !== null && (
          <p
            id="project-conflict-keep-mine-note"
            className="conflict-dialog-note"
          >
            {keepMineDisabledReason}
          </p>
        )}
        <button
          type="button"
          className="secondary"
          aria-disabled={working || undefined}
          onClick={() => {
            if (!working) onClose();
          }}
        >
          Decide later
        </button>
      </div>
    </div>
  );
}
