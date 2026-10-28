import { ProjectImportButton } from './ProjectImportButton';
import { labelWithKey, useKeymap } from '../lib/keymap';
import { Fragment, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useDissolveOnUnmount } from '../hooks/useDissolveOnUnmount';
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Box,
  Check,
  Cloud,
  CloudAlert,
  CloudCheck,
  CloudOff,
  CloudUpload,
  Copy,
  GripVertical,
  Info,
  LayoutGrid,
  List,
  LoaderCircle,
  Lock,
  MoreHorizontal,
  Pin,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon
} from 'lucide-react';
import { isLibraryModeStatus } from '../lib/libraryStatus';
import { STALE_CHUNK_MESSAGE } from '../lib/staleChunk';
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
import { readLibraryLayout, saveLibraryLayout } from '../lib/libraryLayout';
import {
  bucketProjectsByShelf,
  moveItem,
  PROJECT_UPDATE_REQUIRED_LABEL,
  projectNeedsUpdate
} from '../lib/projectShelf';
import { syncRunTotals, type SyncEntry } from '../lib/syncRun';
import { useMigrationLockedProjects } from '../lib/migrationStatus';
import type { DemoDefinition } from '../lib/demoDefinitions';
import { BrandMark } from './BrandMark';
import { DemoModelIcon } from './DemoModelIcon';
import { PartThumbnail } from './PartThumbnail';
import type { ProjectProperties } from '../lib/projectProperties';

const ProjectPropertiesDialog = lazy(async () => ({
  default: (await import('./ProjectPropertiesDialog')).ProjectPropertiesDialog
}));

interface StartScreenProps {
  projects: ProjectSummary[];
  status: string;
  /**
   * Present once the version watch confirms a newer build: the footer offers
   * the reload. Download failures have their own actionable toast.
   */
  onReloadForUpdate?: () => void;
  /** Remains available after a download failure, without claiming an update. */
  onReloadForLoadFailure?: () => void;
  busy: boolean;
  /** Discovery is pending; an empty array and absent session are not results. */
  loading?: boolean;
  demos: DemoDefinition[];
  defaultUnits: UnitSystem;
  onImportProject?(file: File): void;
  onCreate(name: string, units: UnitSystem): void;
  onOpen(projectId: string): void;
  onOpenDemo(definition: DemoDefinition): void;
  onOpenSettings(): void;
  /** Settings at its Account section; falls back to plain Settings. */
  onSignIn?(): void;
  onDuplicate(project: ProjectSummary): void;
  loadProperties(project: ProjectSummary): Promise<ProjectProperties | null>;
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
   * Answers a cache miss and publishes an existing preview to the account.
   * Called as tiles approach the viewport, without rebuilding documents.
   */
  publishThumbnail(project: ProjectSummary): Promise<string | null | undefined>;
}

const LOADING_PROJECT_TILES = 10;

/** The Parts shelf's narrowing, beside its heading. */
type ShelfFilter = 'all' | 'pinned' | 'attention' | 'local';
type ShelfSort = 'custom' | 'edited' | 'name';
type ShelfLayout = 'grid' | 'list';

const SHELF_FILTERS: ReadonlyArray<{ id: ShelfFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'local', label: 'This device only' }
];

const SHELF_LAYOUT_STORAGE_KEY = 'openzcad.start.layout';

/** A per-device convenience: an unreadable store simply means the grid. */
function readShelfLayout(): ShelfLayout {
  try {
    return globalThis.localStorage?.getItem(SHELF_LAYOUT_STORAGE_KEY) === 'list'
      ? 'list'
      : 'grid';
  } catch {
    return 'grid';
  }
}

function writeShelfLayout(layout: ShelfLayout) {
  try {
    globalThis.localStorage?.setItem(SHELF_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // Private windows and blocked storage keep the choice for this visit.
  }
}

const RECOVERY_SUFFIX = / \((?:Recovery|Local copy)\)(?: \(copy(?: \d+)?\))*$/;

/**
 * The part a recovery copy was made from, by name: conflict recovery and
 * local-copy saves append "(Recovery)" or "(Local copy)", and duplicating one
 * appends "(copy)". Null for an ordinary part.
 */
export function recoveryCopyOf(name: string): string | null {
  const match = RECOVERY_SUFFIX.exec(name);
  return match ? name.slice(0, match.index) : null;
}

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
 * The shelf's date for when a part was last edited: one absolute shape for
 * every tile ("Oct 4, 2026"). The shelf used to say "Today 4:05 PM" or
 * "Tue 4:05 PM" within the week and a numeric date beyond it, so one row
 * mixed two notations and neighbours could not be compared at a glance. The
 * exact time stays in the tooltip (formatLastEditedExact).
 */
export function formatLastEdited(updatedAt: string): string {
  return new Date(updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

const SHELVES: ReadonlyArray<{
  status: ProjectStatus;
  label: string;
  empty: string;
  Icon: typeof Box;
}> = [
  { status: 'active', label: 'Parts', empty: 'nothing saved yet', Icon: Box },
  {
    status: 'archived',
    label: 'Archive',
    empty: 'nothing archived',
    Icon: Archive
  },
  {
    status: 'deleted',
    label: 'Trash',
    empty: 'the trash is empty',
    Icon: Trash2
  }
];

/** The tile's actions button, which a closing menu hands focus back to. */
function tileMenuOpener(tile: HTMLElement | undefined) {
  return (
    tile?.querySelector<HTMLButtonElement>('.start-tile-menu-button') ?? null
  );
}

function focusTileMenuItem(
  tile: HTMLElement | undefined,
  end: 'first' | 'last'
) {
  const items = tile?.querySelectorAll<HTMLElement>('[role="menuitem"]');
  if (items && items.length > 0) {
    items[end === 'first' ? 0 : items.length - 1]?.focus();
  }
}

/** A part leaving the shelf from its own tile, and who inherits focus. */
interface ShelfDeparture {
  projectId: string;
  shelf: ProjectStatus;
  /** The parts after it, then the parts before it, nearest first. */
  successors: string[];
}

/** The start screen's crossfade into the workspace. */
const START_SCREEN_DISSOLVE_MS = 240;

/** The cloud card's one sentence and its one action, for a library state. */
interface CloudSentence {
  tone: 'idle' | 'busy' | 'saved' | 'warning' | 'failed';
  Icon: LucideIcon;
  spin?: boolean;
  text: string;
  title?: string;
  progress?: { saved: number; failed: number };
  action?: {
    text: string;
    label: string;
    /** Saving waits for the library to settle; signing in does not. */
    needsIdle?: boolean;
    run(): void;
  };
}

export function StartScreen({
  projects,
  status,
  onReloadForUpdate,
  onReloadForLoadFailure,
  busy,
  loading = false,
  demos,
  defaultUnits,
  onImportProject,
  onCreate,
  onOpen,
  onOpenDemo,
  onOpenSettings,
  onSignIn,
  onDuplicate,
  loadProperties,
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
  publishThumbnail
}: StartScreenProps) {
  const settingsKey = useKeymap().label('app-settings');
  const [name, setName] = useState(generateCutePartName);
  const [units, setUnits] = useState<UnitSystem>(defaultUnits);
  const [query, setQuery] = useState('');
  const [shelf, setShelf] = useState<ProjectStatus>('active');
  const [filter, setFilter] = useState<ShelfFilter>('all');
  const [sort, setSort] = useState<ShelfSort>('custom');
  const [layout, setLayout] = useState<ShelfLayout>(readShelfLayout);
  const [previousLayout] = useState(readLibraryLayout);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [propertiesProject, setPropertiesProject] =
    useState<ProjectSummary | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const tileRefs = useRef(new Map<string, HTMLDivElement>());
  // Which end of a menu takes focus as it opens: ArrowUp on the opener asks
  // for the last item, everything else for the first.
  const menuFocusEnd = useRef<'first' | 'last'>('first');
  const departure = useRef<ShelfDeparture | null>(null);
  const partsTitleRef = useRef<HTMLHeadingElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  // Opening a part crossfades into the workspace instead of cutting to it.
  useDissolveOnUnmount(screenRef, START_SCREEN_DISSOLVE_MS);

  // The server measures the trimmed name, so the form has to agree exactly or
  // it would block names the API accepts (or vice versa).
  const trimmedName = name.trim();
  const nameTooLong = trimmedName.length > MAX_PROJECT_NAME_LENGTH;
  const canCreate = !busy && trimmedName.length > 0 && !nameTooLong;

  useEffect(() => {
    setUnits(defaultUnits);
  }, [defaultUnits]);

  // A tile menu is a transient overlay: any click that is not inside it, and
  // Escape from anywhere, dismisses it. It takes focus as it opens, so the
  // arrow keys work on it straight away.
  useEffect(() => {
    if (!openMenu) {
      return;
    }
    focusTileMenuItem(tileRefs.current.get(openMenu), menuFocusEnd.current);
    menuFocusEnd.current = 'first';
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
        // The focused item unmounts with the menu, which would drop focus to
        // the page; the opener takes it back instead.
        if (
          event.target instanceof Element &&
          event.target.closest('.start-tile-menu')
        ) {
          tileMenuOpener(tileRefs.current.get(openMenu))?.focus();
        }
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

  // Being encrypted in this tab, or paused or stopped with its plaintext
  // still locked: badged, and opened read-only (App.tsx).
  const migratingProjectIds = useMigrationLockedProjects();
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

  const localOnlyIds = new Set(
    localOnlyProjects.map((project) => project.projectId)
  );
  // Recovery copies stay parts in their own right (they open, sync and
  // trash like any other), but each original says how many it has, and the
  // Needs attention filter gathers them with the parts that diverged or
  // failed to save.
  const recoveryCounts = new Map<string, number>();
  for (const project of shelfProjects) {
    const original = recoveryCopyOf(project.name);
    if (original !== null) {
      recoveryCounts.set(original, (recoveryCounts.get(original) ?? 0) + 1);
    }
  }
  const needsAttention = (project: ProjectSummary) =>
    conflictedProjectIds.has(project.projectId) ||
    syncEntryById.get(project.projectId)?.state === 'failed' ||
    recoveryCopyOf(project.name) !== null;
  const filterMatches: Record<
    ShelfFilter,
    (project: ProjectSummary) => boolean
  > = {
    all: () => true,
    pinned: (project) => projectOrganization(project).pinned,
    attention: needsAttention,
    local: (project) => localOnlyIds.has(project.projectId)
  };
  // Filters narrow the Parts shelf only; Archive and Trash are short lists.
  const filterable = shelf === 'active';
  // "This device only" means something only against an account listing;
  // signed out, or with the listing unreachable, it would hide every part.
  const activeFilter: ShelfFilter =
    !filterable ||
    (filter === 'local' && !(signedIn && accountProjectListReached))
      ? 'all'
      : filter;
  const filterCounts = Object.fromEntries(
    SHELF_FILTERS.map((entry) => [
      entry.id,
      shelfProjects.filter(filterMatches[entry.id]).length
    ])
  ) as Record<ShelfFilter, number>;
  const filteredProjects =
    activeFilter === 'all'
      ? shelfProjects
      : shelfProjects.filter(filterMatches[activeFilter]);

  const search = query.trim().toLowerCase();
  const searchedProjects = search
    ? filteredProjects.filter((project) =>
        project.name.toLowerCase().includes(search)
      )
    : filteredProjects;
  // Pinned parts stay at the front whatever the order: pinning is the one
  // ordering a person chose on purpose.
  const matchingProjects =
    sort === 'custom'
      ? searchedProjects
      : [...searchedProjects].sort((a, b) => {
          const pinned =
            Number(projectOrganization(b).pinned) -
            Number(projectOrganization(a).pinned);
          if (pinned !== 0) return pinned;
          return sort === 'edited'
            ? b.updatedAt.localeCompare(a.updatedAt)
            : a.name.localeCompare(b.name, undefined, { numeric: true });
        });

  // A part sent to another shelf takes its tile, and the focused control in
  // it, off the page, which would leave focus on nothing. Once it is gone the
  // next part takes focus (the previous one at the end, the shelf's heading
  // when it was the last) — unless focus already went somewhere on purpose.
  useEffect(() => {
    const leaving = departure.current;
    if (!leaving || busy) {
      return;
    }
    if (
      leaving.shelf === shelf &&
      matchingProjects.some(
        (project) => project.projectId === leaving.projectId
      )
    ) {
      return;
    }
    departure.current = null;
    const focused = globalThis.document.activeElement;
    if (
      leaving.shelf !== shelf ||
      (focused && focused !== globalThis.document.body)
    ) {
      return;
    }
    for (const projectId of leaving.successors) {
      const target = tileRefs.current
        .get(projectId)
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      if (target) {
        target.focus();
        return;
      }
    }
    partsTitleRef.current?.focus();
  });

  // Dragging reorders positions within a shelf, which only means anything when
  // every position is on screen and in its stored order.
  const canReorder =
    shelf === 'active' &&
    !search &&
    !busy &&
    activeFilter === 'all' &&
    sort === 'custom';

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

  /** Closes a tile's menu with focus back on its opener, not on the page. */
  function closeMenu(projectId: string) {
    tileMenuOpener(tileRefs.current.get(projectId))?.focus();
    setOpenMenu(null);
  }

  /** Runs an action that takes the part off this shelf (see `departure`). */
  function leaveShelf(project: ProjectSummary, action: () => void) {
    const ids = matchingProjects.map((entry) => entry.projectId);
    const at = ids.indexOf(project.projectId);
    departure.current = {
      projectId: project.projectId,
      shelf,
      successors: [...ids.slice(at + 1), ...ids.slice(0, at).reverse()]
    };
    if (openMenu === project.projectId) {
      closeMenu(project.projectId);
    }
    action();
  }

  function selectShelf(status: ProjectStatus) {
    setShelf(status);
    setOpenMenu(null);
  }

  function selectLayout(next: ShelfLayout) {
    setLayout(next);
    writeShelfLayout(next);
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
    const recoveryOf = recoveryCopyOf(project.name);
    const copies =
      recoveryOf === null ? (recoveryCounts.get(project.name) ?? 0) : 0;
    // Stored in a format this build cannot open (end-to-end encrypted, ADR-024
    // Phase 4): shown locked, never loaded, and offered only shelf actions.
    const locked = projectNeedsUpdate(project);
    // An encrypted project this build opens (ADR-024 Phase 4); it is
    // duplicated in the browser like any other (slice 4-8).
    const encrypted = project.storageFormat === 2;
    // Being encrypted in this tab (ADR-024 Phase 7): it opens read-only.
    const migrating = migratingProjectIds.has(project.projectId);

    const preview = (
      <>
        <span className="start-tile-thumb">
          {locked ? (
            <>
              <Lock className="start-tile-lock" aria-hidden="true" />
              <span className="start-tile-thumb-empty" aria-hidden="true">
                End-to-end encrypted
              </span>
            </>
          ) : (
            <PartThumbnail
              project={project}
              loadThumbnail={loadThumbnail}
              publishThumbnail={publishThumbnail}
            />
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
              {recoveryOf !== null &&
                ` · ${formatTime(new Date(project.updatedAt))}`}
            </time>
            <span className="start-tile-rev">
              {project.revisionCount}{' '}
              {project.revisionCount === 1 ? 'save' : 'saves'}
            </span>
          </small>
          {locked && (
            <small className="start-tile-update">
              {PROJECT_UPDATE_REQUIRED_LABEL}
            </small>
          )}
          {trashed && (
            <small className="start-tile-purge">
              {daysLeft === 0
                ? 'Deleting shortly'
                : `Deletes in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`}
            </small>
          )}
        </span>
        <span className="start-tile-flags">
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
                <LoaderCircle size={12} className="spin" aria-hidden="true" />
              ) : syncEntry.state === 'synced' ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <TriangleAlert size={12} aria-hidden="true" />
              )}
              {syncEntry.state === 'failed' && (
                <span className="start-tile-badge-text">Not saved</span>
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
              <span className="start-tile-badge-text">
                Changed in two places
              </span>
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
          {migrating && !encrypted && (
            <span
              className="start-tile-badge is-locked"
              role="img"
              aria-label="Encrypting"
              title="Being end-to-end encrypted. It opens read-only until that finishes."
            >
              <Lock size={12} aria-hidden="true" />
              <span className="start-tile-badge-text">Encrypting</span>
            </span>
          )}
          {(locked || encrypted) && (
            <span
              className="start-tile-badge is-locked"
              role="img"
              aria-label="End-to-end encrypted"
              title={
                locked
                  ? 'End-to-end encrypted. Update OpenZCAD to open this project.'
                  : 'End-to-end encrypted.'
              }
            >
              <Lock size={12} aria-hidden="true" />
            </span>
          )}
          {recoveryOf !== null && !trashed && (
            <span className="start-tile-badge is-recovery">
              <span className="start-tile-badge-text">Recovery copy</span>
            </span>
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
        {trashed || locked ? (
          // A locked card opens nothing: loading it would only fetch a
          // refusal (or ciphertext) this build cannot read.
          <div
            className="start-tile-open is-static"
            title={locked ? PROJECT_UPDATE_REQUIRED_LABEL : undefined}
          >
            {preview}
          </div>
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
              <GripVertical size={12} aria-hidden="true" />
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
              {/* Filled when pinned: the marker stays on a pinned tile, and a
                  slashed pin there read as "not pinned". */}
              <Pin
                size={12}
                fill={organization.pinned ? 'currentColor' : 'none'}
                aria-hidden="true"
              />
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
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                return;
              }
              event.preventDefault();
              const end = event.key === 'ArrowUp' ? 'last' : 'first';
              if (menuOpen) {
                focusTileMenuItem(tileRefs.current.get(project.projectId), end);
              } else {
                menuFocusEnd.current = end;
                setOpenMenu(project.projectId);
              }
            }}
          >
            <MoreHorizontal size={12} aria-hidden="true" />
          </button>
        </div>

        {menuOpen && (
          <div
            className="start-tile-menu"
            role="menu"
            aria-label={`Actions for ${project.name}`}
            onKeyDown={(event) => {
              if (event.key === 'Tab') {
                // The items are not tab stops: Tab leaves the menu from its
                // opener, onward to the next control or back to the opener.
                closeMenu(project.projectId);
                if (event.shiftKey) {
                  event.preventDefault();
                }
                return;
              }
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  '[role="menuitem"]'
                )
              );
              const at = items.findIndex(
                (item) => item === globalThis.document.activeElement
              );
              const next =
                event.key === 'ArrowDown'
                  ? (at + 1) % items.length
                  : event.key === 'ArrowUp'
                    ? (at <= 0 ? items.length : at) - 1
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? items.length - 1
                        : -1;
              if (next < 0) {
                return;
              }
              event.preventDefault();
              items[next]?.focus();
            }}
          >
            {!locked && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  // Keep a mounted opener for the modal's focus restoration.
                  closeMenu(project.projectId);
                  setPropertiesProject(project);
                }}
              >
                <Info size={13} aria-hidden="true" />
                Properties
              </button>
            )}
            {trashed ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  onClick={() =>
                    leaveShelf(project, () => onMoveToShelf(project, 'active'))
                  }
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  Restore
                </button>
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="is-destructive"
                  onClick={() =>
                    leaveShelf(project, () => onDeleteForever(project))
                  }
                >
                  <Trash2 size={13} aria-hidden="true" />
                  Delete forever
                </button>
              </>
            ) : (
              <>
                {localOnly && !locked && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      closeMenu(project.projectId);
                      onSaveToAccount(project);
                    }}
                  >
                    <CloudUpload size={13} aria-hidden="true" />
                    Save to my account
                  </button>
                )}
                {!locked && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      closeMenu(project.projectId);
                      onDuplicate(project);
                    }}
                  >
                    <Copy size={13} aria-hidden="true" />
                    Duplicate
                  </button>
                )}
                {shelf === 'active' ? (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() =>
                      leaveShelf(project, () =>
                        onMoveToShelf(project, 'archived')
                      )
                    }
                  >
                    <Archive size={13} aria-hidden="true" />
                    Archive
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() =>
                      leaveShelf(project, () =>
                        onMoveToShelf(project, 'active')
                      )
                    }
                  >
                    <ArchiveRestore size={13} aria-hidden="true" />
                    Move to parts
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="is-destructive"
                  onClick={() =>
                    leaveShelf(project, () => onMoveToShelf(project, 'deleted'))
                  }
                >
                  <Trash2 size={13} aria-hidden="true" />
                  Move to trash
                </button>
              </>
            )}
          </div>
        )}

        {copies > 0 && !trashed && (
          // Searching by the original's name brings its copies up beside it.
          <button
            type="button"
            className="start-tile-copies"
            aria-label={`Show ${project.name} with its ${copies} recovery ${
              copies === 1 ? 'copy' : 'copies'
            }`}
            onClick={() => {
              setFilter('all');
              setQuery(project.name);
            }}
          >
            <Copy size={12} aria-hidden="true" />
            {copies} recovery {copies === 1 ? 'copy' : 'copies'}
          </button>
        )}

        {trashed && (
          // The visible labels are short for the narrow footer; the names
          // say which part, and match the menu's "Delete forever".
          <div className="start-tile-footer">
            <button
              type="button"
              aria-label={`Restore ${project.name}`}
              disabled={busy}
              onClick={() =>
                leaveShelf(project, () => onMoveToShelf(project, 'active'))
              }
            >
              <RotateCcw size={13} aria-hidden="true" />
              Restore
            </button>
            <button
              type="button"
              className="is-destructive"
              aria-label={`Delete ${project.name} forever`}
              disabled={busy}
              onClick={() =>
                leaveShelf(project, () => onDeleteForever(project))
              }
            >
              <Trash2 size={13} aria-hidden="true" />
              Delete
            </button>
          </div>
        )}
      </div>
    );
  }

  const layoutCounts =
    loading && previousLayout ? previousLayout : filterCounts;
  const showFilters = filterable && (loading || shelfProjects.length > 0);
  // Pinned parts head the shelf as their own group when the whole shelf is
  // on screen. Partitioned by the flag, not sliced by count: a part created
  // this session is prepended to the listing ahead of pinned ones. Each tile
  // keeps its shelf-wide position, which is what reordering uses.
  const pinnedProjects = matchingProjects.filter(
    (project) => projectOrganization(project).pinned
  );
  const shelfPositions = new Map(
    matchingProjects.map((project, index) => [project.projectId, index])
  );
  const shelfGroups: Array<{
    label: string | null;
    projects: ProjectSummary[];
  }> =
    shelf === 'active' &&
    activeFilter === 'all' &&
    !search &&
    pinnedProjects.length > 0 &&
    pinnedProjects.length < matchingProjects.length
      ? [
          { label: 'Pinned', projects: pinnedProjects },
          {
            label: 'Parts',
            projects: matchingProjects.filter(
              (project) => !projectOrganization(project).pinned
            )
          }
        ]
      : [{ label: null, projects: matchingProjects }];

  const { all, pinned, attention, local } = filterCounts;
  const footerPositions = shelfGroups
    .flatMap((group) => group.projects)
    .flatMap((project, index) =>
      recoveryCounts.has(project.name) ? [index] : []
    )
    .join(',');
  useEffect(() => {
    if (
      loading ||
      !filterable ||
      activeFilter !== 'all' ||
      search ||
      sort !== 'custom'
    )
      return;
    saveLibraryLayout({
      all,
      pinned,
      attention,
      local,
      footers: footerPositions ? footerPositions.split(',').map(Number) : []
    });
  }, [
    loading,
    filterable,
    activeFilter,
    search,
    sort,
    all,
    pinned,
    attention,
    local,
    footerPositions
  ]);

  const loadingGroups =
    previousLayout &&
    previousLayout.pinned > 0 &&
    previousLayout.pinned < previousLayout.all
      ? [
          { label: 'Pinned', count: previousLayout.pinned, offset: 0 },
          {
            label: 'Parts',
            count: previousLayout.all - previousLayout.pinned,
            offset: previousLayout.pinned
          }
        ]
      : [
          {
            label: null,
            count: previousLayout?.all ?? LOADING_PROJECT_TILES,
            offset: 0
          }
        ];

  const shelfLabel =
    SHELVES.find((entry) => entry.status === shelf) ?? SHELVES[0]!;

  function createPart() {
    if (canCreate) {
      onCreate(trimmedName, units);
    }
  }

  // The account's view of the shelf, for the column's status card. Deleted
  // parts are left out on both sides: they are on their way out, not work to
  // account for.
  const accountableProjects = userProjects.filter(
    (project) => projectOrganization(project).status !== 'deleted'
  );
  const savedToAccountCount =
    accountableProjects.length - localOnlyProjects.length;

  // With nothing saved yet the demos are the most useful thing on the page,
  // so they take the stage as full cards instead of a list in the column.
  const fresh = !loading && userProjects.length === 0;
  // An empty Parts shelf is not an empty library when every part was
  // archived or trashed: the shelf says where they went instead of
  // "nothing saved yet". Null when the library really is empty.
  const partsElsewhere =
    userProjects.length === 0
      ? null
      : shelves.archived.length > 0 && shelves.deleted.length > 0
        ? 'Archive or Trash'
        : shelves.archived.length > 0
          ? 'Archive'
          : 'Trash';

  const cloud = describeCloud();
  // A run's outcome is in the sentence, and the startup mode texts restate
  // what the sentence already says; anything else is news worth a line.
  const statusLine =
    !loading && !syncRun && status && !isLibraryModeStatus(status)
      ? status
      : '';

  function describeCloud(): CloudSentence {
    if (syncTotals) {
      const progress = {
        saved: syncTotals.synced / syncTotals.total,
        failed: syncTotals.failed / syncTotals.total
      };
      if (syncTotals.active) {
        return {
          tone: 'busy',
          Icon: LoaderCircle,
          spin: true,
          text: `Saving ${syncTotals.settled + 1} of ${syncTotals.total}…`,
          progress
        };
      }
      if (syncTotals.failed > 0) {
        return {
          tone: 'failed',
          Icon: CloudAlert,
          text: `${syncTotals.failed} not saved`,
          title: `Saved ${syncTotals.synced} of ${syncTotals.total}. ${syncTotals.failed} could not be saved.`,
          progress,
          ...(failedSummaries.length > 0 && {
            action: {
              text: 'Retry',
              label:
                failedSummaries.length === 1
                  ? 'Retry it'
                  : `Retry all ${failedSummaries.length}`,
              needsIdle: true,
              run: () => onSaveAllToAccount(failedSummaries)
            }
          })
        };
      }
      return {
        tone: 'saved',
        Icon: CloudCheck,
        text:
          syncTotals.total === 1
            ? 'Saved to your account'
            : `All ${syncTotals.total} saved to your account`
      };
    }
    if (loading) {
      return { tone: 'idle', Icon: Cloud, text: 'Checking account…' };
    }
    if (!signedIn) {
      return {
        tone: 'idle',
        Icon: CloudOff,
        text: 'On this device only',
        title:
          'Parts stay on this device. Sign in to keep them across devices.',
        action: {
          text: 'Sign in',
          label: 'Sign in',
          run: onSignIn ?? onOpenSettings
        }
      };
    }
    if (!accountProjectListReached) {
      return {
        tone: 'warning',
        Icon: CloudAlert,
        text: 'Account status unavailable',
        title:
          'Cloud project status is temporarily unavailable. Your projects remain saved on this device.'
      };
    }
    if (localOnlyProjects.length > 0) {
      const count = localOnlyProjects.length;
      return {
        tone: 'warning',
        Icon: CloudAlert,
        text: `${count} ${count === 1 ? 'part' : 'parts'} not saved`,
        title: `${savedToAccountCount} of ${accountableProjects.length} parts are in your account; ${count === 1 ? 'one is' : `${count} are`} on this device only.`,
        progress: {
          saved: savedToAccountCount / accountableProjects.length,
          failed: 0
        },
        action: {
          text: 'Save',
          label:
            count === 1
              ? 'Save it to my account'
              : 'Save them all to my account',
          needsIdle: true,
          run: () => onSaveAllToAccount(localOnlyProjects)
        }
      };
    }
    const saved = accountableProjects.length;
    return {
      tone: 'saved',
      Icon: CloudCheck,
      text:
        saved === 0
          ? 'Signed in'
          : saved === 1
            ? '1 part saved'
            : `All ${saved} parts saved`
    };
  }

  return (
    <div
      ref={screenRef}
      className={fresh ? 'start-screen is-fresh' : 'start-screen'}
    >
      <header className="start-header">
        <div className="start-brand">
          <BrandMark />
          <h1 className="start-header-name">OpenZCAD</h1>
          <span className="start-beta">beta</span>
        </div>
        {/* Import sits with Settings as a header action: beside the launch
            card it competed with Create project and pushed the shelf down. */}
        <div className="start-header-actions">
          {onImportProject && (
            <ProjectImportButton
              onImport={onImportProject}
              disabled={busy}
              className="icon-button start-import"
              title="Import project…"
            />
          )}
          <button
            className="start-settings-button icon-button"
            type="button"
            aria-label="Open settings"
            title={labelWithKey('Settings', settingsKey)}
            onClick={onOpenSettings}
          >
            <Settings size={16} aria-hidden="true" />
          </button>
        </div>
        <span className="start-tagline">Parametric CAD in the browser</span>
      </header>

      <section className="start-launch" aria-labelledby="start-launch-title">
        <form
          className="start-launch-form"
          onSubmit={(event) => {
            event.preventDefault();
            createPart();
          }}
          onKeyDown={(event) => {
            // The Enter that commits an IME composition (CJK input) is not
            // a request to create the part from a half-typed name. Safari
            // reports that keystroke with isComposing already false.
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              return;
            }
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
          <h2 id="start-launch-title">
            <Plus size={15} aria-hidden="true" />
            New part
          </h2>
          <label className="start-field start-field-name">
            <span className="start-field-label">Name</span>
            <input
              value={name}
              aria-label="Project name"
              aria-invalid={nameTooLong || undefined}
              aria-describedby={nameTooLong ? 'project-name-error' : undefined}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="start-field start-field-units">
            <span className="start-field-label">Units</span>
            <select
              value={units}
              // Kept for the narrow layout, which hides the visible label.
              aria-label="Units"
              onChange={(event) => setUnits(event.target.value as UnitSystem)}
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
          {nameTooLong ? (
            <small
              id="project-name-error"
              className="field-error start-launch-error"
              role="alert"
            >
              Project name must be at most {MAX_PROJECT_NAME_LENGTH} characters.
            </small>
          ) : (
            <small className="start-launch-hint">
              Name and units can be changed later.
            </small>
          )}
        </form>
      </section>

      <nav className="start-library" aria-label="Library">
        <span className="start-eyebrow">Library</span>
        <div className="start-shelf-tabs" role="tablist">
          {SHELVES.map((entry, index) => (
            <button
              key={entry.status}
              id={`start-shelf-tab-${entry.status}`}
              type="button"
              role="tab"
              aria-selected={shelf === entry.status}
              aria-controls="start-shelf-panel"
              // One tab stop for the strip; the arrow keys move along it.
              tabIndex={shelf === entry.status ? 0 : -1}
              className={shelf === entry.status ? 'is-active' : undefined}
              onClick={() => selectShelf(entry.status)}
              onKeyDown={(event) => {
                const step =
                  event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                      ? 1
                      : 0;
                const target =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? SHELVES.length - 1
                      : step !== 0
                        ? (index + step + SHELVES.length) % SHELVES.length
                        : -1;
                const next = SHELVES[target];
                if (!next) {
                  return;
                }
                event.preventDefault();
                selectShelf(next.status);
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLElement>('[role="tab"]')
                  [target]?.focus();
              }}
            >
              <entry.Icon size={15} aria-hidden="true" />
              {entry.label}
              <span className="start-shelf-count">
                {loading ? '…' : shelfCount(entry.status)}
              </span>
            </button>
          ))}
        </div>
      </nav>

      <div className="start-body">
        <section
          id="start-shelf-panel"
          className="start-section"
          role="tabpanel"
          aria-labelledby={`start-shelf-tab-${shelf}`}
          aria-busy={loading}
        >
          <div className="start-toolbar">
            <div className="start-toolbar-title">
              {/* Focusable from script only: it catches focus when the last
                  part leaves the shelf (see `departure`). */}
              <h2 id="start-parts-title" ref={partsTitleRef} tabIndex={-1}>
                {shelfLabel.label}
              </h2>
              {/* The filters carry the count once they show; the note keeps
                  the empty, loading and search states. */}
              {!(showFilters && !search) && (
                <span className="start-section-note">
                  {loading
                    ? 'Loading parts…'
                    : shelfProjects.length === 0
                      ? shelf === 'active' && partsElsewhere
                        ? 'none on this shelf'
                        : shelfLabel.empty
                      : search
                        ? `${matchingProjects.length} of ${filteredProjects.length} match`
                        : `${shelfProjects.length} ${
                            shelfProjects.length === 1 ? 'part' : 'parts'
                          }`}
                </span>
              )}
            </div>

            {showFilters && (
              <div
                className="start-filters"
                role="group"
                aria-label="Show parts"
              >
                {SHELF_FILTERS.filter(
                  (entry) =>
                    entry.id === 'all' ||
                    entry.id === activeFilter ||
                    layoutCounts[entry.id] > 0
                ).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={loading}
                    aria-pressed={activeFilter === entry.id}
                    className={[
                      'start-filter',
                      activeFilter === entry.id ? 'is-active' : '',
                      entry.id === 'attention' ? 'is-attention' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      setFilter(entry.id);
                      setOpenMenu(null);
                    }}
                  >
                    {entry.label}
                    <span className="start-filter-count">
                      {loading ? '…' : filterCounts[entry.id]}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {(loading || userProjects.length > 0) && (
              <div className="start-toolbar-tools">
                {(layoutCounts.all > 1 || (loading && !previousLayout)) && (
                  <label className="start-sort">
                    <span className="visually-hidden">Sort parts</span>
                    <select
                      value={sort}
                      disabled={loading}
                      onChange={(event) =>
                        setSort(event.target.value as ShelfSort)
                      }
                    >
                      <option value="custom">Custom order</option>
                      <option value="edited">Last edited</option>
                      <option value="name">Name</option>
                    </select>
                  </label>
                )}
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
                      <X size={12} aria-hidden="true" />
                    </button>
                  )}
                </div>
                <div className="start-layout" role="group" aria-label="Layout">
                  <button
                    type="button"
                    className="start-layout-button"
                    aria-label="Grid"
                    aria-pressed={layout === 'grid'}
                    title="Grid"
                    onClick={() => selectLayout('grid')}
                  >
                    <LayoutGrid size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="start-layout-button"
                    aria-label="List"
                    aria-pressed={layout === 'list'}
                    title="List"
                    onClick={() => selectLayout('list')}
                  >
                    <List size={14} aria-hidden="true" />
                  </button>
                </div>
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

          {loading && (
            <>
              {/* Announced, not shown: the heading's note and the cloud card
                  already say so on screen, and a visible line here pushed the
                  skeleton down by a row it then jumped back up from. */}
              <div
                className="start-loading visually-hidden"
                role="status"
                aria-label="Loading library"
              >
                Loading your parts and account…
              </div>
              {layout === 'list' && (
                <div className="start-list-head" aria-hidden="true">
                  <span>Name</span>
                  <span>Status</span>
                  <span>Edited</span>
                  <span>Saves</span>
                </div>
              )}
              {loadingGroups.map((group) => (
                <Fragment key={group.label ?? 'all'}>
                  {group.label && (
                    <h3 className="start-shelf-group" aria-hidden="true">
                      {group.label}
                      <span>…</span>
                    </h3>
                  )}
                  <div
                    className={`start-tile-grid${layout === 'list' ? ' is-list' : ''}`}
                    aria-hidden="true"
                  >
                    {Array.from({ length: group.count }, (_, index) => (
                      <div
                        className="start-tile start-tile-placeholder"
                        key={index}
                      >
                        <div className="start-tile-open">
                          <span className="start-tile-thumb" />
                          {/* The real tile's text rows also own list sizing. */}
                          <span className="start-tile-body">
                            <strong className="start-tile-name">&nbsp;</strong>
                            <small className="start-tile-meta">
                              <time>&nbsp;</time>
                              <span className="start-tile-rev">&nbsp;</span>
                            </small>
                          </span>
                          <span className="start-tile-flags" />
                        </div>
                        {previousLayout?.footers.includes(
                          group.offset + index
                        ) && <div className="start-tile-copies" />}
                      </div>
                    ))}
                  </div>
                </Fragment>
              ))}
            </>
          )}

          {!loading && matchingProjects.length > 0 && (
            <>
              {layout === 'list' && (
                <div className="start-list-head" aria-hidden="true">
                  <span>Name</span>
                  <span>Status</span>
                  <span>Edited</span>
                  <span>Saves</span>
                </div>
              )}
              {shelfGroups.map((group) => (
                <Fragment key={group.label ?? 'all'}>
                  {group.label && (
                    <h3 className="start-shelf-group">
                      {group.label}
                      <span>{group.projects.length}</span>
                    </h3>
                  )}
                  <div
                    className={
                      layout === 'list'
                        ? 'start-tile-grid is-list'
                        : 'start-tile-grid'
                    }
                  >
                    {group.projects.map((project) =>
                      renderProjectTile(
                        project,
                        shelfPositions.get(project.projectId) ?? 0
                      )
                    )}
                  </div>
                </Fragment>
              ))}
            </>
          )}

          {!loading &&
            !search &&
            activeFilter !== 'all' &&
            shelfProjects.length > 0 &&
            matchingProjects.length === 0 && (
              <p className="start-no-matches" role="status">
                No parts here right now.
                <button type="button" onClick={() => setFilter('all')}>
                  Show all parts
                </button>
              </p>
            )}

          {!loading && shelfProjects.length === 0 && (
            <div className="start-empty" role="status">
              <span className="start-empty-mark" aria-hidden="true">
                <BrandMark />
              </span>
              {shelf === 'active' && partsElsewhere ? (
                <>
                  <strong>No parts on this shelf</strong>
                  <span>{`All your parts are in ${partsElsewhere}.`}</span>
                </>
              ) : shelf === 'active' ? (
                <>
                  <strong>No parts yet</strong>
                  <span>
                    Name one and press Create, or open a demo to see a part walk
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
                  <strong>Nothing in the trash.</strong>
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
        </section>
      </div>

      <section className="start-learn" aria-labelledby="start-demos-title">
        <div className="start-learn-head">
          <h2 id="start-demos-title">Learn by example</h2>
          <span className="start-section-note">
            each demo walks a part through revisions A → C
          </span>
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
                  <DemoModelIcon demoKey={demo.key} />
                </span>
                <span className="demo-card-title">
                  <strong>{demo.name.replace('Demo · ', '')}</strong>
                  <span className="demo-card-tagline">{demo.tagline}</span>
                  <span className="demo-card-summary">
                    {demo.summary ?? demo.tagline}
                  </span>
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

      {/* Where the parts are kept, said once: one sentence, its one action,
          and a hairline of progress. A save-all run takes the sentence over
          while it is on screen, and the status line speaks only with news
          the sentence does not already carry. */}
      <aside className="start-cloud" aria-label="Cloud sync">
        {onReloadForUpdate || onReloadForLoadFailure ? (
          // Module failures can stay cached until navigation. This action
          // outlives the toast, whether or not an update was confirmed.
          <span
            className={`start-update ${onReloadForUpdate ? 'is-update' : 'is-failure'}`}
            role="alert"
          >
            <span className="start-update-dot" aria-hidden="true" />
            <span className="start-update-text">
              {onReloadForUpdate ? 'New version ready' : STALE_CHUNK_MESSAGE}
            </span>
            <button
              type="button"
              onClick={onReloadForUpdate ?? onReloadForLoadFailure}
            >
              Reload
              <RotateCw size={13} aria-hidden="true" />
            </button>
          </span>
        ) : null}
        <div
          className={`start-account is-${cloud.tone}`}
          role="status"
          aria-live="polite"
        >
          <div className="start-account-row">
            <cloud.Icon
              size={14}
              aria-hidden="true"
              className={cloud.spin ? 'spin' : undefined}
            />
            <span className="start-account-text" title={cloud.title}>
              {cloud.text}
            </span>
            {cloud.action && (
              <button
                type="button"
                className="start-account-action"
                aria-label={cloud.action.label}
                title={cloud.action.label}
                disabled={cloud.action.needsIdle && busy}
                onClick={cloud.action.run}
              >
                {cloud.action.text}
              </button>
            )}
            {syncTotals && !syncTotals.active && (
              <button
                type="button"
                className="start-account-dismiss"
                aria-label="Dismiss sync results"
                onClick={onDismissSyncRun}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
          {cloud.progress && (
            <div className="start-account-track" aria-hidden="true">
              <span
                className="start-account-fill"
                style={{ width: `${cloud.progress.saved * 100}%` }}
              />
              <span
                className="start-account-fill is-failed"
                style={{ width: `${cloud.progress.failed * 100}%` }}
              />
            </div>
          )}
          {syncFailures.length > 0 && (
            <ul className="start-sync-failures">
              {syncFailures.map((entry) => (
                <li key={entry.projectId} className="start-sync-failure">
                  <span
                    className="start-sync-failure-name"
                    title={entry.detail ?? 'Could not be saved.'}
                  >
                    {entry.name}
                  </span>
                  <button
                    type="button"
                    className="start-account-action"
                    aria-label={`Retry ${entry.name}`}
                    title={entry.detail ?? 'Could not be saved.'}
                    disabled={busy}
                    onClick={() => onRetrySync(entry.projectId)}
                  >
                    Retry
                  </button>
                </li>
              ))}
            </ul>
          )}
          {statusLine && <p className="start-status">{statusLine}</p>}
        </div>
      </aside>
      {propertiesProject && (
        <Suspense fallback={null}>
          <ProjectPropertiesDialog
            project={propertiesProject}
            loadProperties={loadProperties}
            accountStatus={
              !signedIn
                ? 'Sign in to check'
                : cloudProjectIds.has(propertiesProject.projectId)
                  ? 'Saved to my account'
                  : accountProjectListReached
                    ? 'This device only'
                    : 'Unknown — account listing unavailable'
            }
            onClose={() => setPropertiesProject(null)}
          />
        </Suspense>
      )}
    </div>
  );
}
