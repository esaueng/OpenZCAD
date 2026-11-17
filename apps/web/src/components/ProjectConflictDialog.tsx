import { useMemo, useRef, useState } from 'react';
import type { ProjectDocument } from '@openzcad/shared';
import { ChevronRight, Cloud, Copy, Monitor, Pause } from 'lucide-react';
import type {
  ConflictResolution,
  ProjectConflict
} from '../lib/conflictRecovery';
import { useModalFocus } from '../lib/useModalFocus';
import { errorMessage } from '../lib/errors';
import {
  projectWorkDifferences,
  type ProjectWorkDifference
} from '../lib/localProjectStore';

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

const DIFFERENCE_LABELS: Record<ProjectWorkDifference, string> = {
  model: 'the model',
  name: 'the project name',
  units: 'the units',
  drawings: 'the drawings',
  referenceImages: 'the reference images',
  objectFolders: 'the object folders',
  assembly: 'the assembly',
  edits: 'the edit history',
  savePoints: 'the save points',
  undoHistory: 'the undo history',
  fileFormat: 'the file format version'
};

function listLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/** Rows that match in every shown detail still differ somewhere; say where. */
function differenceSummary(
  local: ProjectDocument,
  remote: ProjectDocument
): string | null {
  const differences = projectWorkDifferences(local, remote);
  if (differences.length === 0) return null;
  return `They differ in ${listLabels(
    differences.map((difference) => DIFFERENCE_LABELS[difference])
  )}.`;
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1]
];

/** "2 minutes ago": what a person compares first (design review I74). */
export function relativeModified(time: number, now: number): string {
  const seconds = Math.round((time - now) / 1000);
  if (Math.abs(seconds) < 5) return 'just now';
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size || unit === 'second') {
      return format.format(Math.trunc(seconds / size), unit);
    }
  }
  return 'just now';
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Rows show whole seconds, so two saves in one second read the same. The
 * later one is still newer; say by how little rather than contradict the
 * times on screen (design review I74).
 */
function newerLabel(newer: number, older: number): string {
  return Math.floor(newer / 1000) === Math.floor(older / 1000)
    ? 'Newer · under 1 s'
    : 'Newer';
}

function ModifiedAt({ value, now }: { value: string; now: number }) {
  const time = modifiedTime(value);
  return time === null ? (
    <span className="conflict-choice-detail">Modified time unavailable</span>
  ) : (
    <time className="conflict-choice-detail" dateTime={value}>
      {relativeModified(time, now)} ·{' '}
      {new Date(time).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
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
  // Not a version row: the first enabled row depends on lease timing, so the
  // highlight moved between choices and Enter meant different things. The
  // non-destructive action is the same target in every dialog.
  const decideLaterRef = useRef<HTMLButtonElement>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = busy || resolving;
  useModalFocus(dialogRef, {
    autoFocus: true,
    initialFocusRef: decideLaterRef
  });
  const { localDocument, remoteDocument } = conflict;
  const difference = useMemo(
    () => differenceSummary(localDocument, remoteDocument),
    [localDocument, remoteDocument]
  );
  const other = conflict.source === 'account' ? 'Cloud' : 'Live session';
  const localModified = lastModified(conflict.localDocument);
  const remoteModified = lastModified(conflict.remoteDocument);
  const localTime = modifiedTime(localModified);
  const remoteTime = modifiedTime(remoteModified);
  const localNewer =
    localTime !== null && remoteTime !== null && localTime > remoteTime
      ? newerLabel(localTime, remoteTime)
      : null;
  const remoteNewer =
    localTime !== null && remoteTime !== null && remoteTime > localTime
      ? newerLabel(remoteTime, localTime)
      : null;
  // Each row names its own copy when the names differ; the header names only
  // this browser's (design review I74).
  const namesDiffer = localDocument.name !== remoteDocument.name;
  const [now] = useState(() => Date.now());

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
          {difference && ` ${difference}`}
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
                {localNewer && (
                  <span className="conflict-newer">{localNewer}</span>
                )}
              </span>
              {namesDiffer && (
                <span className="conflict-choice-detail conflict-choice-name">
                  “{localDocument.name}”
                </span>
              )}
              <ModifiedAt value={localModified} now={now} />
              <span className="conflict-choice-detail">
                {plural(localDocument.revisions.length, 'edit', 'edits')} ·{' '}
                {plural(
                  localDocument.checkpoints.length,
                  'save point',
                  'save points'
                )}
              </span>
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
                {remoteNewer && (
                  <span className="conflict-newer">{remoteNewer}</span>
                )}
              </span>
              {namesDiffer && (
                <span className="conflict-choice-detail conflict-choice-name">
                  “{remoteDocument.name}”
                </span>
              )}
              <ModifiedAt value={remoteModified} now={now} />
              <span className="conflict-choice-detail">
                {plural(remoteDocument.revisions.length, 'edit', 'edits')} ·{' '}
                {plural(
                  remoteDocument.checkpoints.length,
                  'save point',
                  'save points'
                )}
              </span>
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
                {other} stays original; yours is saved as a copy on this device.
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
          ref={decideLaterRef}
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
