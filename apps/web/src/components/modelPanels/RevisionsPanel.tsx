import { useEffect, useState } from 'react';
import { GitBranch, History } from 'lucide-react';
import type { ProjectCheckpoint } from '@openzcad/shared';
import {
  listLocalSaveStateCheckpoints,
  onLocalSaveStatesChanged
} from '../../lib/localProjectStore';
import type { SidebarProps } from '../Sidebar';

/**
 * The save points Revisions lists: the document's own, merged with the ones
 * stored only on this device, oldest first.
 */
export interface RevisionCheckpoints {
  visible: ProjectCheckpoint[];
  /** The document's own checkpoints; the rest are device-only. */
  canonicalIds: ReadonlySet<string>;
  /** The device's stored save states for the open project. */
  local: ProjectCheckpoint[];
}

/**
 * Loads this device's save states for the open project and keeps them current.
 * The composer calls it, not the panel, because whether Revisions shows at all
 * depends on what it finds.
 */
export function useRevisionCheckpoints({
  projectId,
  checkpoints,
  restorableCheckpointIds
}: Pick<
  SidebarProps,
  'projectId' | 'checkpoints' | 'restorableCheckpointIds'
>): RevisionCheckpoints {
  const [localSaveStates, setLocalSaveStates] = useState<{
    projectId: string;
    checkpoints: ProjectCheckpoint[];
  } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void listLocalSaveStateCheckpoints(projectId)
        .catch(() => [])
        .then((stored) => {
          if (!cancelled && request === generation)
            setLocalSaveStates({ projectId, checkpoints: stored });
        });
    };
    refresh();
    const stop = onLocalSaveStatesChanged((storedProjectId) => {
      if (storedProjectId === projectId) refresh();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [projectId, restorableCheckpointIds]);
  const canonicalCheckpointIds = new Set(
    checkpoints.map((point) => point.checkpointId)
  );
  const localCheckpoints =
    localSaveStates && localSaveStates.projectId === projectId
      ? localSaveStates.checkpoints
      : [];
  const privateCheckpoints = localCheckpoints.filter(
    (point) => !canonicalCheckpointIds.has(point.checkpointId)
  );
  const visibleCheckpoints = privateCheckpoints.length
    ? [...checkpoints, ...privateCheckpoints].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      )
    : checkpoints;
  return {
    visible: visibleCheckpoints,
    canonicalIds: canonicalCheckpointIds,
    local: localCheckpoints
  };
}

/** The Revisions header count. The panel hides while it is zero. */
export function revisionCount(revisions: RevisionCheckpoints): number {
  return revisions.visible.length;
}

/**
 * When a save point was made. A same-day save shows its time: Ctrl+S makes a
 * "Manual save" each time, and a list of identical names over identical dates
 * gave no way to tell them apart.
 */
function revisionTime(createdAt: string): string {
  const created = new Date(createdAt);
  return created.toDateString() === new Date().toDateString()
    ? created.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      })
    : created.toLocaleDateString();
}

export type RevisionsPanelProps = Pick<
  SidebarProps,
  | 'documentVersion'
  | 'restorableCheckpointIds'
  | 'onRestoreCheckpoint'
  | 'onBranchCheckpoint'
> & { revisions: RevisionCheckpoints };

export function RevisionsPanel({
  documentVersion,
  restorableCheckpointIds,
  onRestoreCheckpoint,
  onBranchCheckpoint,
  revisions
}: RevisionsPanelProps) {
  const {
    visible: visibleCheckpoints,
    canonicalIds: canonicalCheckpointIds,
    local: localCheckpoints
  } = revisions;
  return (
    <div className="revision-list">
      {[...visibleCheckpoints].reverse().map((checkpoint, index) => {
        // The save point the open document is currently sitting on.
        // Offering to restore what is already loaded would be a no-op
        // dressed up as an action.
        const isCurrent =
          canonicalCheckpointIds.has(checkpoint.checkpointId) &&
          checkpoint.documentVersion === documentVersion;
        const stored =
          restorableCheckpointIds.has(checkpoint.checkpointId) ||
          localCheckpoints.some(
            (point) => point.checkpointId === checkpoint.checkpointId
          );
        return (
          <div
            key={checkpoint.checkpointId}
            className={`revision-row ${index === 0 ? 'latest' : ''}`}
            title={`${checkpoint.reason} · document v${checkpoint.documentVersion} · ${new Date(checkpoint.createdAt).toLocaleString()}${canonicalCheckpointIds.has(checkpoint.checkpointId) ? '' : ' · Stored on this device'}`}
          >
            <span className="revision-dot" aria-hidden="true" />
            <span className="revision-reason">{checkpoint.reason}</span>
            <small className="revision-time mono">
              {revisionTime(checkpoint.createdAt)}
            </small>
            {stored ? (
              <span className="revision-actions">
                {!isCurrent && (
                  <button
                    type="button"
                    className="revision-action"
                    title={`Restore “${checkpoint.reason}”. This is one Undo away, and the current state is saved first.`}
                    aria-label={`Restore ${checkpoint.reason}`}
                    onClick={() => onRestoreCheckpoint(checkpoint)}
                  >
                    <History size={12} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className="revision-action"
                  title={`Branch “${checkpoint.reason}” into a new project. This project is left as it is.`}
                  aria-label={`Branch ${checkpoint.reason} into a new project`}
                  onClick={() => onBranchCheckpoint(checkpoint)}
                >
                  <GitBranch size={12} aria-hidden="true" />
                </button>
              </span>
            ) : (
              // Retention drops stored documents while the checkpoints
              // naming them stay in the document, so some rows are a
              // record of a save rather than a save you can open. Saying
              // so beats a button that fails when pressed.
              <span
                className="revision-unavailable"
                title="This save is listed in the project's history, but its model is no longer stored."
              >
                not stored
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
