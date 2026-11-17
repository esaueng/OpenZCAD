import { useEffect, useState, type FormEvent } from 'react';
import { Eye, GitBranch, History, Pencil } from 'lucide-react';
import {
  MAX_CHECKPOINT_NAME_LENGTH,
  checkpointLabel,
  type ProjectCheckpoint
} from '@openzcad/shared';
import {
  listLocalSaveStateCheckpoints,
  onLocalSaveStatesChanged
} from '../../lib/localProjectStore';
import {
  loadCheckpointThumbnails,
  onCheckpointThumbnailsChanged
} from '../../lib/checkpointThumbnails';
import type { ModelPanelSource } from './modelPanelProps';

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
  /** L03: this device's card for each save point that has one. */
  thumbnails?: ReadonlyMap<string, string>;
}

/**
 * Loads this device's save states for the open project and keeps them current.
 * The panel's frame calls it, not the list, because the header counts what
 * it finds.
 */
export function useRevisionCheckpoints({
  projectId,
  checkpoints,
  restorableCheckpointIds
}: Pick<
  ModelPanelSource,
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
  const thumbnails = useCheckpointThumbnails(
    visibleCheckpoints.map((point) => point.checkpointId)
  );
  return {
    visible: visibleCheckpoints,
    canonicalIds: canonicalCheckpointIds,
    local: localCheckpoints,
    thumbnails
  };
}

/** Loads this device's save-point cards and keeps them current. */
function useCheckpointThumbnails(
  checkpointIds: readonly string[]
): ReadonlyMap<string, string> {
  const [thumbnails, setThumbnails] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  // Keyed on the ids, not the array: a new array arrives on every render.
  const key = checkpointIds.join(' ');
  useEffect(() => {
    const ids = key ? key.split(' ') : [];
    let cancelled = false;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void loadCheckpointThumbnails(ids)
        .catch(() => new Map<string, string>())
        .then((loaded) => {
          if (!cancelled && request === generation) setThumbnails(loaded);
        });
    };
    refresh();
    const stop = onCheckpointThumbnailsChanged((checkpointId) => {
      if (ids.includes(checkpointId)) refresh();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [key]);
  return thumbnails;
}

/** The Revisions header count. */
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
        minute: '2-digit',
        hour12: false
      })
    : created.toLocaleDateString();
}

/**
 * The versions list's editor column (L03): "You" for the signed-in account's
 * own saves, else the name the save recorded. Null for a save made before
 * save points recorded their author.
 */
export function revisionEditor(
  checkpoint: ProjectCheckpoint,
  currentUserId: string | null | undefined
): string | null {
  const author = checkpoint.author;
  if (!author) return null;
  if (author.userId !== undefined && author.userId === currentUserId)
    return 'You';
  if (author.userId === undefined && !currentUserId) return 'You';
  return author.name ?? (author.userId ? 'A member' : 'Signed out');
}

/** The sync column: where this save point's model is stored. */
export function revisionSync(onDevice: boolean, inAccount: boolean): string {
  if (onDevice && inAccount) return 'Device and account';
  if (onDevice) return 'This device';
  if (inAccount) return 'Account';
  return 'Not stored';
}

export type RevisionsPanelProps = Pick<
  ModelPanelSource,
  | 'documentVersion'
  | 'restorableCheckpointIds'
  | 'accountCheckpointIds'
  | 'currentUserId'
  | 'onRestoreCheckpoint'
  | 'onBranchCheckpoint'
  | 'onRenameCheckpoint'
  | 'onPreviewCheckpoint'
  | 'previewingCheckpointId'
> & { revisions: RevisionCheckpoints };

/** Names a save point in place of its row's name; Escape leaves it as it was. */
function RevisionRenameForm({
  checkpoint,
  onRename,
  onDone
}: {
  checkpoint: ProjectCheckpoint;
  onRename(checkpoint: ProjectCheckpoint, name: string): void;
  onDone(): void;
}) {
  const [name, setName] = useState(checkpointLabel(checkpoint));
  function submit(event: FormEvent) {
    event.preventDefault();
    onRename(checkpoint, name);
    onDone();
  }
  return (
    <form
      className="revision-rename"
      onSubmit={submit}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        className="revision-rename-input"
        aria-label={`Name for ${checkpointLabel(checkpoint)}`}
        value={name}
        maxLength={MAX_CHECKPOINT_NAME_LENGTH}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          }
        }}
      />
      <button type="submit" className="revision-action">
        Save
      </button>
      <button type="button" className="revision-action" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

export function RevisionsPanel({
  documentVersion,
  restorableCheckpointIds,
  accountCheckpointIds,
  currentUserId,
  onRestoreCheckpoint,
  onBranchCheckpoint,
  onRenameCheckpoint,
  onPreviewCheckpoint,
  previewingCheckpointId,
  revisions
}: RevisionsPanelProps) {
  const {
    visible: visibleCheckpoints,
    canonicalIds: canonicalCheckpointIds,
    local: localCheckpoints
  } = revisions;
  // The row a press opened: its details and labelled actions show without
  // hover (design review I82, I87).
  const [openId, setOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  if (visibleCheckpoints.length === 0) {
    return (
      <p className="muted sidebar-hint">
        No save points yet. Save the project to start its revision list.
      </p>
    );
  }
  return (
    <div className="revision-list">
      {[...visibleCheckpoints].reverse().map((checkpoint, index) => {
        // The save point the open document is currently sitting on.
        // Offering to restore what is already loaded would be a no-op
        // dressed up as an action.
        const canonical = canonicalCheckpointIds.has(checkpoint.checkpointId);
        const isCurrent =
          canonical && checkpoint.documentVersion === documentVersion;
        const onDevice = localCheckpoints.some(
          (point) => point.checkpointId === checkpoint.checkpointId
        );
        const inAccount =
          accountCheckpointIds?.has(checkpoint.checkpointId) ?? false;
        const stored =
          restorableCheckpointIds.has(checkpoint.checkpointId) || onDevice;
        const open = openId === checkpoint.checkpointId;
        const renaming =
          renamingId === checkpoint.checkpointId &&
          canonical &&
          !!onRenameCheckpoint;
        const detailsId = `revision-details-${checkpoint.checkpointId}`;
        const thumbnail = revisions.thumbnails?.get(checkpoint.checkpointId);
        const label = checkpointLabel(checkpoint);
        const previewing = previewingCheckpointId === checkpoint.checkpointId;
        const editor = revisionEditor(checkpoint, currentUserId);
        return (
          <div
            key={checkpoint.checkpointId}
            className={`revision-row${index === 0 ? ' latest' : ''}${open ? ' is-open' : ''}${previewing ? ' is-previewing' : ''}`}
            onClick={(event) => {
              // A press anywhere on the row opens it; its own buttons act.
              if ((event.target as HTMLElement).closest('.revision-action'))
                return;
              setOpenId(open ? null : checkpoint.checkpointId);
            }}
          >
            <span className="revision-dot" aria-hidden="true" />
            {renaming ? (
              <RevisionRenameForm
                checkpoint={checkpoint}
                onRename={onRenameCheckpoint}
                onDone={() => setRenamingId(null)}
              />
            ) : (
              <button
                type="button"
                className="revision-reason"
                aria-expanded={open}
                aria-controls={detailsId}
              >
                {label}
              </button>
            )}
            <small className="revision-time mono">
              {revisionTime(checkpoint.createdAt)}
            </small>
            {stored ? (
              <span className="revision-actions">
                {!isCurrent && onPreviewCheckpoint && !previewing && (
                  <button
                    type="button"
                    className="revision-action"
                    aria-label={`Preview ${label}`}
                    onClick={() => onPreviewCheckpoint(checkpoint)}
                  >
                    <Eye size={12} aria-hidden="true" />
                    <span>Preview</span>
                  </button>
                )}
                {!isCurrent && (
                  <button
                    type="button"
                    className="revision-action"
                    aria-label={`Restore ${label}`}
                    onClick={() => onRestoreCheckpoint(checkpoint)}
                  >
                    <History size={12} aria-hidden="true" />
                    <span>Restore</span>
                  </button>
                )}
                <button
                  type="button"
                  className="revision-action"
                  aria-label={`Branch ${label} into a new project`}
                  onClick={() => onBranchCheckpoint(checkpoint)}
                >
                  <GitBranch size={12} aria-hidden="true" />
                  <span>Branch</span>
                </button>
              </span>
            ) : (
              // Retention drops stored documents while the checkpoints
              // naming them stay in the document, so some rows are a
              // record of a save rather than a save you can open. Saying
              // so beats a button that fails when pressed.
              <span className="revision-unavailable">history only</span>
            )}
            {/* L03 columns: who saved, on which device, and where the
                save's model is stored now. */}
            <span className="revision-meta">
              {/* A save from before save points recorded who made them
                  shows only where it is stored. Separators are text, so a
                  screen reader hears three values rather than one word. */}
              {editor ? (
                <span className="revision-editor">{editor} · </span>
              ) : null}
              {checkpoint.author?.device ? (
                <span className="revision-device">
                  {checkpoint.author.device} ·{' '}
                </span>
              ) : null}
              <span className="revision-sync">
                {revisionSync(onDevice, inAccount)}
              </span>
            </span>
            {open ? (
              <div id={detailsId} className="revision-details">
                {thumbnail ? (
                  <img
                    className="revision-thumb"
                    src={thumbnail}
                    alt={`The model at ${label}`}
                  />
                ) : null}
                <p>
                  {new Date(checkpoint.createdAt).toLocaleString()} · document v
                  {checkpoint.documentVersion}
                  {checkpoint.name ? ` · Saved as “${checkpoint.reason}”` : ''}
                  {canonical ? '' : ' · Stored on this device'}
                  {stored
                    ? isCurrent
                      ? '. The project is at this save point now. Branch copies it into a new project.'
                      : '. Restore brings the project back to it (one Undo away; the current state is saved first). Branch copies it into a new project and leaves this one as it is.'
                    : '. Listed in the project’s history only: its model is no longer stored, so it cannot be restored or branched.'}
                </p>
                {canonical && onRenameCheckpoint && !renaming ? (
                  <button
                    type="button"
                    className="revision-action"
                    aria-label={`Rename ${label}`}
                    onClick={() => setRenamingId(checkpoint.checkpointId)}
                  >
                    <Pencil size={12} aria-hidden="true" />
                    <span>Rename</span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
