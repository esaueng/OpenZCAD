import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Check,
  ChevronDown,
  CloudOff,
  CloudUpload,
  Copy,
  GraduationCap,
  GripVertical,
  LoaderCircle,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react';
import {
  daysUntilPurge,
  MAX_PROJECT_NAME_LENGTH,
  projectOrganization,
  TRASH_RETENTION_DAYS,
  type ProjectStatus,
  type ProjectSummary,
  type UnitSystem
} from '@openzcad/shared';
import { generateCutePartName } from '../lib/cutePartName';
import { bucketProjectsByShelf, moveItem } from '../lib/projectShelf';
import { syncRunTotals, type SyncEntry } from '../lib/syncRun';
import type { DemoDefinition } from '../lib/demoDefinitions';
import { BrandMark } from './BrandMark';
import { PartThumbnail } from './PartThumbnail';

interface StartScreenProps {
  projects: ProjectSummary[];
  status: string;
  busy: boolean;
  demos: DemoDefinition[];
  defaultUnits: UnitSystem;
  onCreate(name: string, units: UnitSystem): void;
  onOpen(projectId: string): void;
  onOpenDemo(definition: DemoDefinition): void;
  onOpenSettings(): void;
  onDuplicate(project: ProjectSummary): void;
  /**
   * Projects the account holds. Anything absent lives on this device alone —
   * but only meaningfully so when `signedIn`, because a signed-out session has
   * no account to compare against and must not label everything local-only.
   */
  cloudProjectIds: ReadonlySet<string>;
  /**
   * False when the account listing failed. In that state an absent id is
   * unknown, not proof that a project exists only on this device.
   */
  accountProjectListReached: boolean;
  /**
   * Projects whose two copies diverged and were never reconciled. Surfaced on
   * the shelf because the divergence outlives the session that found it, and a
   * user who closed the dialog needs a way back to it.
   */
  conflictedProjectIds: ReadonlySet<string>;
  signedIn: boolean;
  onSaveToAccount(project: ProjectSummary): void;
  onSaveAllToAccount(projects: ProjectSummary[]): void;
  /**
   * The save-to-account run in progress or most recently finished, in attempt
   * order. Null when no run has happened; entries persist after the run so
   * failures stay explorable until dismissed.
   */
  syncRun: ReadonlyArray<SyncEntry> | null;
  onRetrySync(projectId: string): void;
  onDismissSyncRun(): void;
  onMoveToShelf(project: ProjectSummary, status: ProjectStatus): void;
  onTogglePin(project: ProjectSummary): void;
  /** The shelf's projects in their new order, front to back. */
  onReorder(projectIds: string[]): void;
  /** Irreversible: destroys the project outright. */
  onDeleteForever(project: ProjectSummary): void;
  onEmptyTrash(projects: ProjectSummary[]): void;
  /**
   * Reads a cached preview image. Deliberately not a document load: the shelf
   * must stay usable — openable, deletable — for a project too large to hold in
   * memory, which is exactly the project whose tile a viewer wants to see.
   */
  loadThumbnail(project: ProjectSummary): Promise<string | null | undefined>;
  /**
   * Renders the preview for a tile the cache could not answer for. Called only
   * for the tiles on screen, so an unexpanded shelf pays for nine parts rather
   * than every part the device holds.
   */
  backfillThumbnail(project: ProjectSummary): Promise<string | null | undefined>;
}

/**
 * How many saved parts a shelf shows before it has to be expanded. Ten parts
 * fills two five-column rows at the wide desktop layout, which is enough to
 * recognise recent work without the demos below being pushed too far down.
 */
const COLLAPSED_PROJECT_LIMIT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * The full local date and time, for the tooltip and for anything that needs
 * the exact moment rather than the shelf's shorthand.
 */
export function formatLastEditedExact(updatedAt: string): string {
  const date = new Date(updatedAt);
  return `${date.toLocaleDateString()} ${formatTime(date)}`;
}

/**
 * The shelf's shorthand for when a part was last edited: the time alone for
 * today, the weekday within the last week, and the date beyond that. Recency
 * is what a shelf is for — "Tue 4:05 PM" places a part in the week at a
 * glance where a full date makes every tile read the same.
 */
export function formatLastEdited(
  updatedAt: string,
  now: Date = new Date()
): string {
  const date = new Date(updatedAt);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayOffset = Math.floor(
    (startOfToday.getTime() - date.getTime()) / DAY_MS
  );
  if (date.getTime() >= startOfToday.getTime() && date.getTime() <= now.getTime()) {
    return `Today ${formatTime(date)}`;
  }
  if (dayOffset === 0) {
    return `Yesterday ${formatTime(date)}`;
  }
  if (dayOffset > 0 && dayOffset < 6) {
    return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${formatTime(date)}`;
  }
  return date.toLocaleDateString();
}

const SHELVES: ReadonlyArray<{
  status: ProjectStatus;
  label: string;
  empty: string;
}> = [
  { status: 'active', label: 'Parts', empty: 'nothing saved yet' },
  { status: 'archived', label: 'Archive', empty: 'nothing archived' },
  { status: 'deleted', label: 'Trash', empty: 'the recycle bin is empty' }
];

export function StartScreen({
  projects,
  status,
  busy,
  demos,
  defaultUnits,
  onCreate,
  onOpen,
  onOpenDemo,
  onOpenSettings,
  onDuplicate,
  cloudProjectIds,
  accountProjectListReached,
  conflictedProjectIds,
  signedIn,
  onSaveToAccount,
  onSaveAllToAccount,
  syncRun,
  onRetrySync,
  onDismissSyncRun,
  onMoveToShelf,
  onTogglePin,
  onReorder,
  onDeleteForever,
  onEmptyTrash,
  loadThumbnail,
  backfillThumbnail
}: StartScreenProps) {
  const [name, setName] = useState(generateCutePartName);
  const [units, setUnits] = useState<UnitSystem>(defaultUnits);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [shelf, setShelf] = useState<ProjectStatus>('active');
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const tileRefs = useRef(new Map<string, HTMLDivElement>());

  // The server measures the trimmed name, so the form has to agree exactly or
  // it would block names the API accepts (or vice versa).
  const trimmedName = name.trim();
  const nameTooLong = trimmedName.length > MAX_PROJECT_NAME_LENGTH;
  const canCreate = !busy && trimmedName.length > 0 && !nameTooLong;

  useEffect(() => {
    setUnits(defaultUnits);
  }, [defaultUnits]);

  // A tile menu is a transient overlay: any click that is not inside it, and
  // Escape from anywhere, dismisses it.
  useEffect(() => {
    if (!openMenu) {
      return;
    }
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.start-tile-menu, .start-tile-menu-button')
      ) {
        return;
      }
      setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpenMenu(null);
      }
    };
    globalThis.document.addEventListener('pointerdown', dismiss, true);
    globalThis.document.addEventListener('keydown', onKeyDown, true);
    return () => {
      globalThis.document.removeEventListener('pointerdown', dismiss, true);
      globalThis.document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [openMenu]);

  const demoIds = new Set(demos.map((demo) => demo.projectId));
  const userProjects = projects.filter(
    (project) => !demoIds.has(project.projectId)
  );
  const shelves = bucketProjectsByShelf(userProjects);
  const shelfProjects = shelves[shelf];

  const search = query.trim().toLowerCase();
  const matchingProjects = search
    ? shelfProjects.filter((project) =>
        project.name.toLowerCase().includes(search)
      )
    : shelfProjects;

  // A query is already a narrowing, so it shows every match and retires the
  // expand toggle — being told "3 of 40 match" and *still* having to expand to
  // see the third one would be absurd.
  const overflowCount = search
    ? 0
    : matchingProjects.length - COLLAPSED_PROJECT_LIMIT;
  const visibleProjects =
    expanded || overflowCount <= 0
      ? matchingProjects
      : matchingProjects.slice(0, COLLAPSED_PROJECT_LIMIT);

  // Dragging reorders positions within a shelf, which only means anything when
  // every position is on screen and in its stored order.
  const canReorder = shelf === 'active' && !search && !busy;

  // Demos are rebuilt from their definitions on any device, so they are not
  // work to rescue and would only pad the offer. Trashed projects are excluded
  // for the same reason in reverse: uploading something on its way out is not
  // what "save my work" means.
  const localOnlyProjects =
    signedIn && accountProjectListReached
      ? userProjects.filter(
          (project) =>
            !cloudProjectIds.has(project.projectId) &&
            projectOrganization(project).status !== 'deleted'
        )
      : [];

  const syncEntryById = new Map(
    (syncRun ?? []).map((entry) => [entry.projectId, entry] as const)
  );
  const syncTotals = syncRun ? syncRunTotals(syncRun) : null;
  const syncFailures = (syncRun ?? []).filter(
    (entry) => entry.state === 'failed'
  );
  // Retrying re-enters the bulk path with just the failed projects, so the
  // panel restarts scoped to what actually needs another attempt.
  const failedSummaries = syncFailures.flatMap((entry) => {
    const summary = userProjects.find(
      (project) => project.projectId === entry.projectId
    );
    return summary ? [summary] : [];
  });

  function moveProject(projectId: string, toIndex: number) {
    const from = shelfProjects.findIndex(
      (project) => project.projectId === projectId
    );
    const reordered = moveItem(shelfProjects, from, toIndex);
    if (reordered !== shelfProjects) {
      onReorder(reordered.map((project) => project.projectId));
    }
  }

  function nudgeProject(projectId: string, offset: number) {
    const from = shelfProjects.findIndex(
      (project) => project.projectId === projectId
    );
    moveProject(projectId, from + offset);
  }

  function shelfCount(status: ProjectStatus): number {
    return shelves[status].length;
  }

  function renderProjectTile(project: ProjectSummary, index: number) {
    const organization = projectOrganization(project);
    const menuOpen = openMenu === project.projectId;
    const trashed = shelf === 'deleted';
    const daysLeft = organization.deletedAt
      ? daysUntilPurge(organization.deletedAt)
      : TRASH_RETENTION_DAYS;
    const localOnly =
      signedIn &&
      accountProjectListReached &&
      !cloudProjectIds.has(project.projectId);
    const conflicted = conflictedProjectIds.has(project.projectId);
    const syncEntry = syncEntryById.get(project.projectId);

    const preview = (
      <>
        <span className="start-tile-thumb">
          <PartThumbnail
            project={project}
            loadThumbnail={loadThumbnail}
            backfillThumbnail={backfillThumbnail}
          />
          {syncEntry && !trashed ? (
            <span
              className={`start-tile-badge is-sync-${syncEntry.state}`}
              role="img"
              aria-label={
                syncEntry.state === 'pending'
                  ? 'Waiting to save to your account'
                  : syncEntry.state === 'syncing'
                    ? 'Saving to your account'
                    : syncEntry.state === 'synced'
                      ? 'Saved to your account'
                      : 'Could not be saved to your account'
              }
              title={
                syncEntry.state === 'failed'
                  ? (syncEntry.detail ?? 'Could not be saved to your account.')
                  : syncEntry.state === 'synced'
                    ? (syncEntry.detail ?? 'Saved to your account.')
                    : syncEntry.state === 'syncing'
                      ? 'Saving to your account…'
                      : 'Waiting to save to your account.'
              }
            >
              {syncEntry.state === 'pending' ? (
                <CloudUpload size={12} aria-hidden="true" />
              ) : syncEntry.state === 'syncing' ? (
                <LoaderCircle
                  size={12}
                  className="start-sync-spin"
                  aria-hidden="true"
                />
              ) : syncEntry.state === 'synced' ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <TriangleAlert size={12} aria-hidden="true" />
              )}
            </span>
          ) : conflicted && !trashed ? (
            <span
              className="start-tile-badge is-conflict"
              role="img"
              aria-label="Changed in two places"
              title="This project changed here and in your account. Open it to choose which to keep."
            >
              <TriangleAlert size={12} aria-hidden="true" />
            </span>
          ) : (
            localOnly &&
            !trashed && (
              <span
                className="start-tile-badge"
                role="img"
                aria-label="On this device only"
                title="On this device only — not saved to your account."
              >
                <CloudOff size={12} aria-hidden="true" />
              </span>
            )
          )}
        </span>
        <span className="start-tile-body">
          <strong className="start-tile-name">{project.name}</strong>
          <small className="start-tile-meta">
            <time
              dateTime={project.updatedAt}
              title={`Last edited ${formatLastEditedExact(project.updatedAt)}`}
            >
              {formatLastEdited(project.updatedAt)}
            </time>
            <span className="start-tile-rev">rev {project.revisionCount}</span>
          </small>
          {trashed && (
            <small className="start-tile-purge">
              {daysLeft === 0
                ? 'Deleting shortly'
                : `Deletes in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`}
            </small>
          )}
        </span>
      </>
    );

    return (
      <div
        key={project.projectId}
        ref={(element) => {
          if (element) {
            tileRefs.current.set(project.projectId, element);
          } else {
            tileRefs.current.delete(project.projectId);
          }
        }}
        className={[
          'start-tile',
          'start-tile-project',
          organization.pinned ? 'is-pinned' : '',
          dragId === project.projectId ? 'is-dragging' : '',
          dropId === project.projectId ? 'is-drop-target' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        onDragOver={(event) => {
          if (!canReorder || !dragId || dragId === project.projectId) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropId(project.projectId);
        }}
        onDragLeave={() => {
          setDropId((current) =>
            current === project.projectId ? null : current
          );
        }}
        onDrop={(event) => {
          if (!canReorder || !dragId) {
            return;
          }
          event.preventDefault();
          moveProject(dragId, index);
          setDragId(null);
          setDropId(null);
        }}
      >
        {trashed ? (
          <div className="start-tile-open is-static">{preview}</div>
        ) : (
          <button
            type="button"
            className="start-tile-open"
            disabled={busy}
            onClick={() => onOpen(project.projectId)}
          >
            {preview}
          </button>
        )}

        <div className="start-tile-actions">
          {canReorder && (
            <button
              type="button"
              className="start-tile-action start-tile-grip"
              aria-label={`Reorder ${project.name}. Use the arrow keys to move it.`}
              title="Drag to reorder"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', project.projectId);
                const tile = tileRefs.current.get(project.projectId);
                if (tile) {
                  // Without this the drag ghost is the grip alone, which gives
                  // no clue which part is being moved.
                  event.dataTransfer.setDragImage(tile, 24, 24);
                }
                setDragId(project.projectId);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropId(null);
              }}
              onKeyDown={(event) => {
                const offset =
                  event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                      ? 1
                      : 0;
                if (offset === 0) {
                  return;
                }
                event.preventDefault();
                nudgeProject(project.projectId, offset);
              }}
            >
              <GripVertical size={14} aria-hidden="true" />
            </button>
          )}

          {shelf === 'active' && (
            <button
              type="button"
              className="start-tile-action start-tile-pin"
              aria-pressed={organization.pinned}
              aria-label={
                organization.pinned
                  ? `Unpin ${project.name}`
                  : `Pin ${project.name}`
              }
              title={organization.pinned ? 'Unpin' : 'Pin to the front'}
              disabled={busy}
              onClick={() => onTogglePin(project)}
            >
              {organization.pinned ? (
                <PinOff size={14} aria-hidden="true" />
              ) : (
                <Pin size={14} aria-hidden="true" />
              )}
            </button>
          )}

          <button
            type="button"
            className="start-tile-action start-tile-menu-button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Actions for ${project.name}`}
            disabled={busy}
            onClick={() => setOpenMenu(menuOpen ? null : project.projectId)}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        </div>

        {menuOpen && (
          <div className="start-tile-menu" role="menu">
            {trashed ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenu(null);
                    onMoveToShelf(project, 'active');
                  }}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  Restore
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="is-destructive"
                  onClick={() => {
                    setOpenMenu(null);
                    onDeleteForever(project);
                  }}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  Delete forever
                </button>
              </>
            ) : (
              <>
                {localOnly && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      onSaveToAccount(project);
                    }}
                  >
                    <CloudUpload size={13} aria-hidden="true" />
                    Save to my account
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenu(null);
                    onDuplicate(project);
                  }}
                >
                  <Copy size={13} aria-hidden="true" />
                  Duplicate
                </button>
                {shelf === 'active' ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      onMoveToShelf(project, 'archived');
                    }}
                  >
                    <Archive size={13} aria-hidden="true" />
                    Archive
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenMenu(null);
                      onMoveToShelf(project, 'active');
                    }}
                  >
                    <ArchiveRestore size={13} aria-hidden="true" />
                    Move to parts
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="is-destructive"
                  onClick={() => {
                    setOpenMenu(null);
                    onMoveToShelf(project, 'deleted');
                  }}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  Move to trash
                </button>
              </>
            )}
          </div>
        )}

        {trashed && (
          <div className="start-tile-footer">
            <button
              type="button"
              disabled={busy}
              onClick={() => onMoveToShelf(project, 'active')}
            >
              <RotateCcw size={13} aria-hidden="true" />
              Restore
            </button>
            <button
              type="button"
              className="is-destructive"
              disabled={busy}
              onClick={() => onDeleteForever(project)}
            >
              <Trash2 size={13} aria-hidden="true" />
              Delete
            </button>
          </div>
        )}
      </div>
    );
  }

  const shelfLabel =
    SHELVES.find((entry) => entry.status === shelf) ?? SHELVES[0]!;

  function createPart() {
    if (canCreate) {
      onCreate(trimmedName, units);
    }
  }

  return (
    <div className="start-screen">
      <header className="start-header">
        <div className="start-brand">
          <BrandMark />
          <h1 className="start-header-name">OpenZCAD</h1>
          <span className="start-beta">beta</span>
        </div>
        <span className="start-tagline">Parametric CAD in the browser</span>
        <button
          className="start-settings-button icon-button"
          type="button"
          aria-label="Open settings"
          title="Settings (Ctrl+,)"
          onClick={onOpenSettings}
        >
          <Settings size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="start-body">
        <section className="start-launch" aria-labelledby="start-launch-title">
          <div className="start-launch-copy">
            <h2 id="start-launch-title">
              <Plus size={16} aria-hidden="true" />
              New project
            </h2>
            <p>
              Name it, choose its units, and start modelling. The name and units
              can be changed later.
            </p>
          </div>
          <form
            className="start-launch-form"
            onSubmit={(event) => {
              event.preventDefault();
              createPart();
            }}
            onKeyDown={(event) => {
              // Enter creates from any field, including the units select.
              if (
                event.key === 'Enter' &&
                !(event.target instanceof HTMLButtonElement)
              ) {
                event.preventDefault();
                createPart();
              }
            }}
          >
            <label className="start-field start-field-name">
              <span className="start-field-label">Name</span>
              <input
                value={name}
                aria-label="Project name"
                autoFocus
                aria-invalid={nameTooLong || undefined}
                aria-describedby={
                  nameTooLong ? 'project-name-error' : undefined
                }
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="start-field start-field-units">
              <span className="start-field-label">Units</span>
              <select
                value={units}
                aria-label="Unit system"
                onChange={(event) =>
                  setUnits(event.target.value as UnitSystem)
                }
              >
                <option value="mm">Millimeters</option>
                <option value="cm">Centimeters</option>
                <option value="m">Meters</option>
                <option value="inch">Inches</option>
              </select>
            </label>
            <button
              type="submit"
              className="primary start-launch-submit"
              disabled={!canCreate}
            >
              Create project
            </button>
            {nameTooLong && (
              <small
                id="project-name-error"
                className="field-error start-launch-error"
                role="alert"
              >
                Project name must be at most {MAX_PROJECT_NAME_LENGTH}{' '}
                characters.
              </small>
            )}
          </form>
        </section>

        <section className="start-section" aria-labelledby="start-parts-title">
          <div className="start-toolbar">
            <div className="start-toolbar-title">
              <h2 id="start-parts-title">Your parts</h2>
              <span className="start-section-note">
                {shelfProjects.length === 0
                  ? shelfLabel.empty
                  : search
                    ? `${matchingProjects.length} of ${shelfProjects.length} match`
                    : `${shelfProjects.length} ${
                        shelfProjects.length === 1 ? 'project' : 'projects'
                      }`}
              </span>
            </div>

            <div className="start-shelf-tabs" role="tablist">
              {SHELVES.map((entry) => (
                <button
                  key={entry.status}
                  type="button"
                  role="tab"
                  aria-selected={shelf === entry.status}
                  className={shelf === entry.status ? 'is-active' : undefined}
                  onClick={() => {
                    setShelf(entry.status);
                    setExpanded(false);
                    setOpenMenu(null);
                  }}
                >
                  {entry.label}
                  <span className="start-shelf-count">
                    {shelfCount(entry.status)}
                  </span>
                </button>
              ))}
            </div>

            {userProjects.length > 0 && (
              <div className="start-search">
                <Search size={13} aria-hidden="true" />
                <input
                  value={query}
                  type="text"
                  aria-label="Search parts"
                  placeholder="Search parts…"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && query) {
                      // Escape belongs to the field while it has a query;
                      // swallowing it stops the app's Escape ladder from also
                      // reacting to a keystroke the user aimed here.
                      event.stopPropagation();
                      setQuery('');
                    }
                  }}
                />
                {query && (
                  <button
                    type="button"
                    className="start-search-clear"
                    aria-label="Clear search"
                    onClick={() => setQuery('')}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
          </div>

          {shelf === 'deleted' && shelfProjects.length > 0 && (
            <div className="start-shelf-bar">
              <span className="start-shelf-hint">
                Deleted parts are kept for {TRASH_RETENTION_DAYS} days, then
                destroyed.
              </span>
              <button
                type="button"
                className="start-shelf-action is-destructive"
                disabled={busy}
                onClick={() => onEmptyTrash(shelfProjects)}
              >
                <Trash2 size={13} aria-hidden="true" />
                Empty trash
              </button>
            </div>
          )}

          {syncRun && syncTotals ? (
            <div className="start-sync-panel" role="status" aria-live="polite">
              <div className="start-sync-head">
                {syncTotals.active ? (
                  <LoaderCircle
                    size={14}
                    className="start-sync-spin"
                    aria-hidden="true"
                  />
                ) : syncTotals.failed > 0 ? (
                  <TriangleAlert
                    size={14}
                    className="is-failed"
                    aria-hidden="true"
                  />
                ) : (
                  <Check size={14} className="is-synced" aria-hidden="true" />
                )}
                <span className="start-sync-title">
                  {syncTotals.active
                    ? `Saving to your account · ${syncTotals.settled} of ${syncTotals.total} done`
                    : syncTotals.failed > 0
                      ? `Saved ${syncTotals.synced} of ${syncTotals.total} · ${syncTotals.failed} could not be saved`
                      : `All ${syncTotals.total} ${
                          syncTotals.total === 1 ? 'project' : 'projects'
                        } saved to your account`}
                </span>
                {!syncTotals.active && failedSummaries.length > 0 && (
                  <button
                    type="button"
                    className="start-shelf-action"
                    disabled={busy}
                    onClick={() => onSaveAllToAccount(failedSummaries)}
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                    Retry {failedSummaries.length === 1 ? 'it' : 'all'}
                  </button>
                )}
                {!syncTotals.active && (
                  <button
                    type="button"
                    className="start-sync-dismiss"
                    aria-label="Dismiss sync results"
                    onClick={onDismissSyncRun}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="start-sync-track" aria-hidden="true">
                <span
                  className="start-sync-fill"
                  style={{
                    width: `${(syncTotals.synced / syncTotals.total) * 100}%`
                  }}
                />
                <span
                  className="start-sync-fill is-failed"
                  style={{
                    width: `${(syncTotals.failed / syncTotals.total) * 100}%`
                  }}
                />
              </div>
              {syncFailures.length > 0 && (
                <ul className="start-sync-failures">
                  {syncFailures.map((entry) => (
                    <li key={entry.projectId} className="start-sync-failure">
                      <TriangleAlert size={12} aria-hidden="true" />
                      <span className="start-sync-failure-name">
                        {entry.name}
                      </span>
                      <span className="start-sync-failure-detail">
                        {entry.detail ?? 'Could not be saved.'}
                      </span>
                      <button
                        type="button"
                        className="start-shelf-action"
                        disabled={busy}
                        onClick={() => onRetrySync(entry.projectId)}
                      >
                        <RotateCcw size={12} aria-hidden="true" />
                        Retry
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : signedIn && !accountProjectListReached ? (
            <div className="start-adopt-bar is-unavailable" role="status">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                Cloud project status is temporarily unavailable. Your projects
                remain saved on this device.
              </span>
            </div>
          ) : (
            localOnlyProjects.length > 0 && (
              <div className="start-adopt-bar" role="status">
                <CloudOff size={14} aria-hidden="true" />
                <span>
                  {localOnlyProjects.length}{' '}
                  {localOnlyProjects.length === 1
                    ? 'project is'
                    : 'projects are'}{' '}
                  on this device only.
                </span>
                <button
                  type="button"
                  className="start-shelf-action"
                  disabled={busy}
                  onClick={() => onSaveAllToAccount(localOnlyProjects)}
                >
                  <CloudUpload size={13} aria-hidden="true" />
                  Save {localOnlyProjects.length === 1 ? 'it' : 'them all'} to
                  my account
                </button>
              </div>
            )
          )}

          {visibleProjects.length > 0 && (
            <div className="start-tile-grid">
              {visibleProjects.map((project, index) =>
                renderProjectTile(project, index)
              )}
            </div>
          )}

          {shelfProjects.length === 0 && (
            <div className="start-empty" role="status">
              <span className="start-empty-mark" aria-hidden="true">
                <BrandMark />
              </span>
              {shelf === 'active' ? (
                <>
                  <strong>No parts yet</strong>
                  <span>
                    Create one above, or open a demo below to see a part walk
                    through its revisions.
                  </span>
                </>
              ) : shelf === 'archived' ? (
                <>
                  <strong>Nothing archived.</strong>
                  <span>
                    Archive a part to keep it without it crowding the grid.
                  </span>
                </>
              ) : (
                <>
                  <strong>Nothing in the recycle bin.</strong>
                  <span>
                    Deleted parts wait here for {TRASH_RETENTION_DAYS} days
                    before they are destroyed.
                  </span>
                </>
              )}
            </div>
          )}

          {search &&
            shelfProjects.length > 0 &&
            matchingProjects.length === 0 && (
              <p className="start-no-matches" role="status">
                No parts match “{query.trim()}”.
                <button type="button" onClick={() => setQuery('')}>
                  Clear search
                </button>
              </p>
            )}

          {overflowCount > 0 && (
            <button
              type="button"
              className="start-expand"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={expanded ? 'is-open' : undefined}
              />
              {expanded
                ? 'Show fewer parts'
                : `Show ${overflowCount} more ${
                    overflowCount === 1 ? 'part' : 'parts'
                  }`}
            </button>
          )}
        </section>

        <section className="start-section" aria-labelledby="start-demos-title">
          <div className="start-toolbar">
            <div className="start-toolbar-title">
              <h2 id="start-demos-title">Learn by example</h2>
              <span className="start-section-note">
                each demo walks a part through revisions A → C
              </span>
            </div>
          </div>
          <div className="demo-list">
            {demos.map((demo) => (
              <button
                key={demo.key}
                type="button"
                className="demo-card"
                disabled={busy}
                // Named as one thing, because that is what it is: a card whose
                // name was otherwise assembled from its heading, its tagline
                // and three loose revision chips read in sequence.
                aria-label={`Open demo: ${demo.name.replace('Demo · ', '')} — ${demo.tagline}`}
                onClick={() => onOpenDemo(demo)}
              >
                <span className="demo-card-head">
                  <span className="demo-card-icon">
                    <GraduationCap size={15} aria-hidden="true" />
                  </span>
                  <span className="demo-card-title">
                    <strong>{demo.name.replace('Demo · ', '')}</strong>
                    <span className="demo-card-tagline">{demo.tagline}</span>
                  </span>
                </span>
                <span className="demo-card-revs">
                  {demo.revisions.map((revision) => {
                    const [letter, ...rest] = revision.split(' — ');
                    return (
                      <span key={revision} className="demo-rev">
                        <span className="demo-rev-letter">{letter}</span>
                        <span className="demo-rev-label">
                          {rest.join(' — ') || revision}
                        </span>
                      </span>
                    );
                  })}
                </span>
                <span className="demo-card-cta">
                  Open demo
                  <ArrowRight size={13} aria-hidden="true" />
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <footer className="start-foot">
        <span className="start-status">{status}</span>
      </footer>
    </div>
  );
}
