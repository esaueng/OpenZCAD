import { ProjectImportButton } from './ProjectImportButton';
import { labelWithKey, useKeymap } from '../lib/keymap';
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import { useDissolveOnUnmount } from '../hooks/useDissolveOnUnmount';
import { useScrollMemory } from '../hooks/useScrollMemory';
import { useTileReorder } from '../hooks/useTileReorder';
import {
  Archive,
  ArchiveRestore,
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  Cloud,
  CloudAlert,
  CloudCheck,
  CloudOff,
  CloudUpload,
  Copy,
  Folder,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  History,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  List,
  LoaderCircle,
  Lock,
  MoreHorizontal,
  Pencil,
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
  createFolder,
  deleteFolder,
  folderCover,
  moveProjectsToFolder,
  newFolderId,
  renameFolder,
  reorderFolders,
  setFolderCover,
  setFolderPinned,
  useLibraryFolders,
  MAX_FOLDER_NAME_LENGTH,
  type LibraryFolder
} from '../lib/libraryFolders';
import { LibrarySelectionBar } from './LibrarySelectionBar';
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
const FolderCoverDialog = lazy(async () => ({
  default: (await import('./FolderCoverDialog')).FolderCoverDialog
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
  /** Several parts at once, reported as one change; loops when absent. */
  onMoveManyToShelf?(projects: ProjectSummary[], status: ProjectStatus): void;
  onTogglePin(project: ProjectSummary): void;
  /** Pins or unpins several parts at once; toggles each when absent. */
  onSetPinnedMany?(projects: ProjectSummary[], pinned: boolean): void;
  /**
   * The shelf's projects in their new order, front to back, and the part a
   * drag took into or out of the pinned group, if any.
   */
  onReorder(
    projectIds: string[],
    pin?: { projectId: string; pinned: boolean }
  ): void | Promise<void>;
  /** Irreversible: destroys the project outright. */
  onDeleteForever(project: ProjectSummary): void;
  /** Irreversible: destroys every one of the projects, after one confirm. */
  onDeleteManyForever?(projects: ProjectSummary[]): void;
  /**
   * Discards this device's edited copy of a sample, so the next open builds
   * it from its definition again.
   */
  onResetDemo?(definition: DemoDefinition, project: ProjectSummary): void;
  onEmptyTrash(projects: ProjectSummary[]): void;
  /**
   * Reads a cached preview image. Deliberately not a document load: the shelf
   * must stay usable — openable, deletable — for a project too large to hold in
   * memory, which is exactly the project whose tile a viewer wants to see.
   */
  loadThumbnail(project: ProjectSummary): Promise<string | null | undefined>;
  thumbnailAccountId?: string | null;
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

const LIBRARY_VIEW_KEY = 'openzcad.start.view';

interface LibraryView {
  shelf: ProjectStatus;
  filter: ShelfFilter;
  sort: ShelfSort;
  query: string;
  /** The folder open on the Parts shelf, if any. */
  folder: string | null;
}

/**
 * The shelf, filter, sort and search this tab last showed, so a reload (or a
 * trip into a part and back) returns to the same view, and its scroll
 * position with it. Per tab: a new tab starts on Parts. Anything unreadable
 * falls back to the defaults.
 */
function readLibraryView(): LibraryView {
  const view: LibraryView = {
    shelf: 'active',
    filter: 'all',
    sort: 'custom',
    query: '',
    folder: null
  };
  try {
    const stored = JSON.parse(
      globalThis.sessionStorage?.getItem(LIBRARY_VIEW_KEY) ?? 'null'
    ) as Partial<Record<keyof LibraryView, unknown>> | null;
    if (!stored) {
      return view;
    }
    if (
      stored.shelf === 'active' ||
      stored.shelf === 'archived' ||
      stored.shelf === 'deleted'
    ) {
      view.shelf = stored.shelf;
    }
    if (
      stored.filter === 'pinned' ||
      stored.filter === 'attention' ||
      stored.filter === 'local'
    ) {
      view.filter = stored.filter;
    }
    if (stored.sort === 'edited' || stored.sort === 'name') {
      view.sort = stored.sort;
    }
    if (typeof stored.query === 'string') {
      view.query = stored.query;
    }
    if (typeof stored.folder === 'string') {
      view.folder = stored.folder;
    }
  } catch {
    // An unreadable store starts on the default view.
  }
  return view;
}

function writeLibraryView(view: LibraryView) {
  try {
    globalThis.sessionStorage?.setItem(LIBRARY_VIEW_KEY, JSON.stringify(view));
  } catch {
    // Forgetting the view is the whole failure mode.
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
const LIBRARY_SCROLL_KEY = 'openzcad.start.scroll';
const LIBRARY_SCROLLERS = ['.start-body'] as const;
const REORDER_KEYS = 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown';
/** How long a part is held over another's middle before they would merge. */
const MERGE_HOLD_MS = 450;
const FOLDER_KEY_PREFIX = 'folder:';

/** A folder's tile id, kept apart from part ids on the same shelf. */
function folderKey(folderId: string) {
  return `${FOLDER_KEY_PREFIX}${folderId}`;
}

function folderIdOf(tileId: string): string | null {
  return tileId.startsWith(FOLDER_KEY_PREFIX)
    ? tileId.slice(FOLDER_KEY_PREFIX.length)
    : null;
}

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

/** One tile on the shelf: a folder or a part. */
interface ShelfItem {
  key: string;
  folder?: LibraryFolder;
  project?: ProjectSummary;
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
  onMoveManyToShelf,
  onTogglePin,
  onSetPinnedMany,
  onReorder,
  onDeleteForever,
  onDeleteManyForever,
  onResetDemo,
  onEmptyTrash,
  loadThumbnail,
  thumbnailAccountId,
  publishThumbnail
}: StartScreenProps) {
  const settingsKey = useKeymap().label('app-settings');
  const [name, setName] = useState(generateCutePartName);
  const [units, setUnits] = useState<UnitSystem>(defaultUnits);
  const [initialView] = useState(readLibraryView);
  const [query, setQuery] = useState(initialView.query);
  const [shelf, setShelf] = useState<ProjectStatus>(initialView.shelf);
  const [filter, setFilter] = useState<ShelfFilter>(initialView.filter);
  const [sort, setSort] = useState<ShelfSort>(initialView.sort);
  const [openFolderId, setOpenFolderId] = useState<string | null>(
    initialView.folder
  );
  useEffect(() => {
    writeLibraryView({ shelf, filter, sort, query, folder: openFolderId });
  }, [shelf, filter, sort, query, openFolderId]);
  const [folderState, updateFolders] = useLibraryFolders(thumbnailAccountId);
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [coverFolderId, setCoverFolderId] = useState<string | null>(null);
  // Parts picked for a bulk action, by id; only those on screen count.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const selectionAnchor = useRef<string | null>(null);
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  // A short line about a folder change, which the App's status never hears.
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const timer = globalThis.setTimeout(() => setNotice(''), 4000);
    return () => globalThis.clearTimeout(timer);
  }, [notice]);
  const [layout, setLayout] = useState<ShelfLayout>(readShelfLayout);
  const [previousLayout] = useState(readLibraryLayout);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [propertiesProject, setPropertiesProject] =
    useState<ProjectSummary | null>(null);
  const tileRefs = useRef(new Map<string, HTMLElement>());
  // Which end of a menu takes focus as it opens: ArrowUp on the opener asks
  // for the last item, everything else for the first.
  const menuFocusEnd = useRef<'first' | 'last'>('first');
  const departure = useRef<ShelfDeparture | null>(null);
  const partsTitleRef = useRef<HTMLHeadingElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  // Opening a part crossfades into the workspace instead of cutting to it.
  useDissolveOnUnmount(screenRef, START_SCREEN_DISSOLVE_MS);
  // A reload, or a trip to a part and back, returns to the same place in the
  // library. The page shell scrolls on narrow screens, the body on wide ones.
  useScrollMemory(
    screenRef,
    LIBRARY_SCROLL_KEY,
    LIBRARY_SCROLLERS,
    [shelf, filter, query, sort, layout, openFolderId ?? ''].join('|'),
    !loading
  );

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
  const activeProjectIds = new Set<string>(
    shelves.active.map((project) => project.projectId)
  );

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
  // Folders live on the Parts shelf. A part in one is shown inside it, not
  // loose on the shelf; a folder left open in a view that no longer has it
  // (ungrouped in another tab, say) reads as no folder.
  const folders = folderState.folders;
  const folderByProject = new Map<string, LibraryFolder>();
  for (const folder of folders) {
    for (const projectId of folder.projectIds) {
      folderByProject.set(projectId, folder);
    }
  }
  const openFolder =
    shelf === 'active'
      ? (folders.find((folder) => folder.id === openFolderId) ?? null)
      : null;
  const shelfById = new Map<string, ProjectSummary>(
    shelfProjects.map((project) => [project.projectId, project])
  );
  const shelfIds: ReadonlySet<string> = new Set(shelfById.keys());
  /** A folder's parts on this shelf, in the folder's order. */
  function folderMembers(folder: LibraryFolder): ProjectSummary[] {
    return folder.projectIds.flatMap((projectId) => {
      const project = shelfById.get(projectId);
      return project ? [project] : [];
    });
  }
  // What the shelf is showing before any filter: one folder, or everything.
  const baseProjects = openFolder ? folderMembers(openFolder) : shelfProjects;

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
      baseProjects.filter(filterMatches[entry.id]).length
    ])
  ) as Record<ShelfFilter, number>;
  const filteredProjects =
    activeFilter === 'all'
      ? baseProjects
      : baseProjects.filter(filterMatches[activeFilter]);

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
  // Folders gather parts only on the unfiltered shelf; a filter or a search
  // looks through them, showing every matching part on its own.
  const foldering =
    shelf === 'active' && !openFolder && activeFilter === 'all' && !search;
  const looseProjects = foldering
    ? matchingProjects.filter(
        (project) => !folderByProject.has(project.projectId)
      )
    : matchingProjects;
  const latestEdit = (folder: LibraryFolder) =>
    folderMembers(folder).reduce(
      (latest, project) =>
        project.updatedAt > latest ? project.updatedAt : latest,
      ''
    );
  const shownFolders = !foldering
    ? []
    : sort === 'custom'
      ? folders
      : [...folders].sort((a, b) =>
          sort === 'edited'
            ? latestEdit(b).localeCompare(latestEdit(a))
            : a.name.localeCompare(b.name, undefined, { numeric: true })
        );

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
      looseProjects.some((project) => project.projectId === leaving.projectId)
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
  const pinnedIds = new Set<string>(
    shelfProjects
      .filter((project) => projectOrganization(project).pinned)
      .map((project) => project.projectId)
  );
  // The tiles a drag moves among, folders (keyed apart from parts) first.
  const reorderIds = [
    ...shownFolders.map((folder) => folderKey(folder.id)),
    ...looseProjects.map((project) => project.projectId)
  ];
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));

  /**
   * Saves a new order of the tiles on screen, and the tile a drag took into
   * or out of Pinned. Folders keep their own order on this device; parts
   * keep the shelf order, with the parts filed in folders after the loose
   * ones (a folder orders its own parts).
   */
  function commitOrder(ids: string[], moved?: { id: string; group: string }) {
    if (openFolder) {
      updateFolders((state) => moveProjectsToFolder(state, ids, openFolder.id));
      return;
    }
    const folderIds = ids.flatMap((id) => {
      const folderId = folderIdOf(id);
      return folderId ? [folderId] : [];
    });
    const projectIds = ids.filter((id) => !folderIdOf(id));
    const movedFolder = moved && folderIdOf(moved.id);
    if (
      movedFolder ||
      folderIds.join('\n') !==
        shownFolders.map((folder) => folder.id).join('\n')
    ) {
      updateFolders((state) => {
        const ordered = reorderFolders(state, folderIds);
        return movedFolder
          ? setFolderPinned(ordered, movedFolder, moved.group === 'pinned')
          : ordered;
      });
    }
    const loose = looseProjects.map((project) => project.projectId);
    if ((moved && !movedFolder) || projectIds.join('\n') !== loose.join('\n')) {
      const filed = shelfProjects
        .map((project) => project.projectId)
        .filter((projectId) => !projectIds.includes(projectId));
      const order = [...projectIds, ...filed];
      return moved && !movedFolder
        ? onReorder(order, {
            projectId: moved.id,
            pinned: moved.group === 'pinned'
          })
        : onReorder(order);
    }
  }

  /** Every selected part when the dragged one is among them, else just it. */
  function draggedProjectIds(projectId: string): string[] {
    return selected.has(projectId)
      ? visibleProjectIds().filter((id) => selected.has(id))
      : [projectId];
  }

  function fileProjects(projectIds: string[], folderId: string | null) {
    const folder = folderId ? folderById.get(folderId) : undefined;
    updateFolders((state) => moveProjectsToFolder(state, projectIds, folderId));
    const what =
      projectIds.length === 1
        ? (shelfProjects.find((project) => project.projectId === projectIds[0])
            ?.name ?? '1 part')
        : `${projectIds.length} parts`;
    setNotice(
      folder
        ? `Moved ${what} to ${folder.name}.`
        : `Took ${what} out of the folder.`
    );
    setSelected(new Set());
  }

  function makeFolder(projectIds: string[], pinned = false) {
    const id = newFolderId();
    updateFolders((state) => createFolder(state, { id, projectIds, pinned }));
    showFolder(null);
    setFilter('all');
    setQuery('');
    setMoveMenuOpen(false);
    setRenamingFolderId(id);
    return id;
  }

  const reorder = useTileReorder({
    ids: openFolder
      ? baseProjects.map((project) => project.projectId)
      : reorderIds,
    enabled: canReorder,
    tileRefs,
    // Pinned parts and folders head the shelf as their own group: dragging
    // one into it pins it, and dragging one out unpins it. Inside a folder
    // there is just the folder.
    groupOf: (id) => {
      const folderId = folderIdOf(id);
      if (folderId) {
        return folderById.get(folderId)?.pinned ? 'pinned' : 'parts';
      }
      return !openFolder && pinnedIds.has(id) ? 'pinned' : 'parts';
    },
    // Folders sit among folders and parts among parts.
    canPlaceBeside: (dragged, target) =>
      Boolean(folderIdOf(dragged)) === Boolean(folderIdOf(target)),
    dropInto: (dragged, hit, pointer) => {
      if (folderIdOf(dragged)) return null;
      const root = hit.closest<HTMLElement>('[data-drop-root]');
      if (root && openFolder) return { target: 'root' };
      const folder = hit.closest<HTMLElement>('[data-drop-folder]');
      if (folder?.dataset.dropFolder) {
        return folder.dataset.dropFolder === openFolder?.id
          ? null
          : { target: folderKey(folder.dataset.dropFolder) };
      }
      // Held over the middle of another loose part: the two become a folder.
      const tile = hit.closest<HTMLElement>('[data-tile-id]');
      const target = tile?.dataset.tileId;
      if (!tile || !target || target === dragged || openFolder) return null;
      if (folderIdOf(target)) return { target };
      const box = tile.getBoundingClientRect();
      // The middle half of the card, top to bottom, so a drag arriving from
      // the row above or below meets the merge zone first; its outer
      // quarters place the part beside it.
      const fx = (pointer.x - box.left) / box.width;
      return fx > 0.25 && fx < 0.75
        ? { target: `merge:${target}`, delay: MERGE_HOLD_MS }
        : null;
    },
    onDropInto: (dragged, target) => {
      const moving = draggedProjectIds(dragged);
      if (target === 'root') {
        fileProjects(moving, null);
        return;
      }
      const folderId = folderIdOf(target);
      if (folderId) {
        fileProjects(moving, folderId);
        return;
      }
      const other = target.slice('merge:'.length);
      makeFolder(
        [other, ...moving.filter((id) => id !== other)],
        pinnedIds.has(other)
      );
      setNotice('Made a folder. Name it, or press Enter to keep the name.');
    },
    onCommit: (ids, moved) => commitOrder(ids, moved)
  });
  /** Pinned as stored, or as a drag would leave it. */
  function shownPinned(project: ProjectSummary): boolean {
    const group = canReorder ? reorder.moved.get(project.projectId) : undefined;
    return group ? group === 'pinned' : projectOrganization(project).pinned;
  }
  function shownFolderPinned(folder: LibraryFolder): boolean {
    const group = canReorder
      ? reorder.moved.get(folderKey(folder.id))
      : undefined;
    return group ? group === 'pinned' : folder.pinned;
  }

  /** Alt and an arrow key move the focused card one place among its kind. */
  function nudge(id: string, offset: number) {
    const ids = openFolder
      ? baseProjects.map((project) => project.projectId)
      : reorderIds;
    const kind = ids.filter(
      (entry) => Boolean(folderIdOf(entry)) === Boolean(folderIdOf(id))
    );
    const from = kind.indexOf(id);
    const reordered = moveItem(kind, from, from + offset);
    if (reordered === kind) return;
    const others = ids.filter((entry) => !kind.includes(entry));
    void commitOrder(
      folderIdOf(id) ? [...reordered, ...others] : [...others, ...reordered]
    );
  }

  /** Alt and an arrow key move the focused card one place. */
  function nudgeFromKey(id: string, event: ReactKeyboardEvent) {
    if (!canReorder || !event.altKey) {
      return;
    }
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
    nudge(id, offset);
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
    setOpenFolderId(null);
    setSelected(new Set());
  }

  function showFolder(folderId: string | null) {
    setShelf('active');
    setOpenFolderId(folderId);
    setOpenMenu(null);
    setFolderMenu(null);
    setSelected(new Set());
  }

  // ── Selection ──────────────────────────────────────────────────────────

  /** Parts on screen, in the order they are shown. */
  function visibleProjectIds(): string[] {
    return shelfGroups.flatMap((group) =>
      group.items.flatMap((item) =>
        item.project ? [item.project.projectId] : []
      )
    );
  }

  /**
   * Adds or removes a part. With Shift, everything from the last part picked
   * to this one joins the selection instead.
   */
  function toggleSelected(projectId: string, range = false) {
    const ids = visibleProjectIds();
    const anchor = selectionAnchor.current;
    setSelected((current) => {
      const next = new Set(current);
      if (range && anchor && anchor !== projectId) {
        const from = ids.indexOf(anchor);
        const to = ids.indexOf(projectId);
        if (from >= 0 && to >= 0) {
          for (const id of ids.slice(
            Math.min(from, to),
            Math.max(from, to) + 1
          ))
            next.add(id);
          return next;
        }
      }
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    selectionAnchor.current = projectId;
  }

  function clearSelection() {
    setSelected(new Set());
    setMoveMenuOpen(false);
    selectionAnchor.current = null;
  }

  function selectedOnScreen(): ProjectSummary[] {
    const ids = new Set(visibleProjectIds());
    return shelfProjects.filter(
      (project) => selected.has(project.projectId) && ids.has(project.projectId)
    );
  }

  function moveSelectedToShelf(status: ProjectStatus) {
    const chosen = selectedOnScreen();
    clearSelection();
    if (chosen.length === 0) return;
    if (onMoveManyToShelf) onMoveManyToShelf(chosen, status);
    else chosen.forEach((project) => onMoveToShelf(project, status));
  }

  function pinSelected(pinned: boolean) {
    const chosen = selectedOnScreen().filter(
      (project) => projectOrganization(project).pinned !== pinned
    );
    clearSelection();
    if (chosen.length === 0) return;
    if (onSetPinnedMany) onSetPinnedMany(chosen, pinned);
    else chosen.forEach((project) => onTogglePin(project));
  }

  function deleteSelectedForever() {
    const chosen = selectedOnScreen();
    clearSelection();
    if (chosen.length === 0) return;
    if (onDeleteManyForever) onDeleteManyForever(chosen);
    else if (chosen.length === 1) onDeleteForever(chosen[0]!);
    else onEmptyTrash(chosen);
  }

  // A selection is a mode: Escape leaves it, and ⌘A / Ctrl+A takes in every
  // part on screen while focus is not in a field. (`selecting` counts only
  // picked parts still on screen; it is set once the shelf is grouped.)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const inField =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest('input, textarea, select') !== null);
      if (
        event.key === 'Escape' &&
        selecting &&
        !openMenu &&
        !folderMenu &&
        !inField
      ) {
        event.stopPropagation();
        // The Move menu closes first; the selection goes on the next press.
        if (moveMenuOpen) {
          setMoveMenuOpen(false);
          globalThis.document
            .querySelector<HTMLElement>(
              '.start-selection-move > [aria-haspopup="menu"]'
            )
            ?.focus();
          return;
        }
        setSelected(new Set());
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'a' &&
        !inField &&
        !propertiesProject &&
        !coverFolderId
      ) {
        const ids = visibleProjectIds();
        if (ids.length === 0) return;
        event.preventDefault();
        setSelected(new Set(ids));
      }
    };
    globalThis.document.addEventListener('keydown', onKeyDown, true);
    return () =>
      globalThis.document.removeEventListener('keydown', onKeyDown, true);
  });

  // ── Folders ────────────────────────────────────────────────────────────

  // A folder's menu closes like a tile's: a click elsewhere, or Escape.
  useEffect(() => {
    if (!folderMenu) return;
    const tile = tileRefs.current.get(folderKey(folderMenu));
    focusTileMenuItem(tile, 'first');
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.start-tile-menu, .start-tile-menu-button')
      ) {
        return;
      }
      setFolderMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        tileMenuOpener(tile)?.focus();
        setFolderMenu(null);
      }
    };
    globalThis.document.addEventListener('pointerdown', dismiss, true);
    globalThis.document.addEventListener('keydown', onKeyDown, true);
    return () => {
      globalThis.document.removeEventListener('pointerdown', dismiss, true);
      globalThis.document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [folderMenu]);

  function newEmptyFolder() {
    makeFolder([]);
  }

  function ungroupFolder(folder: LibraryFolder) {
    setFolderMenu(null);
    if (openFolderId === folder.id) setOpenFolderId(null);
    updateFolders((state) => deleteFolder(state, folder.id));
    const count = folderMembers(folder).length;
    setNotice(
      count === 0
        ? `Removed ${folder.name}.`
        : `Removed ${folder.name}; its ${count === 1 ? 'part is' : `${count} parts are`} back on the shelf.`
    );
  }

  function commitRename(folderId: string, name: string) {
    setRenamingFolderId(null);
    updateFolders((state) => renameFolder(state, folderId, name));
  }

  function renderFolderName(folder: LibraryFolder) {
    if (renamingFolderId !== folder.id) {
      return (
        <strong className="start-tile-name" title={folder.name}>
          {folder.name}
        </strong>
      );
    }
    return (
      <input
        className="start-folder-rename"
        defaultValue={folder.name}
        aria-label="Folder name"
        maxLength={MAX_FOLDER_NAME_LENGTH}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            commitRename(folder.id, event.currentTarget.value);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setRenamingFolderId(null);
          }
        }}
        onBlur={(event) => commitRename(folder.id, event.currentTarget.value)}
      />
    );
  }

  function renderFolderTile(folder: LibraryFolder) {
    const key = folderKey(folder.id);
    const members = folderMembers(folder);
    const coverId = folderCover(folder, shelfIds);
    const cover = members.find((project) => project.projectId === coverId);
    const menuOpen = folderMenu === folder.id;
    const pinnedNow = shownFolderPinned(folder);
    const dropping = reorder.dropTarget?.target === key;
    const edited = latestEdit(folder);
    const renaming = renamingFolderId === folder.id;
    return (
      <div
        key={key}
        ref={(element) => {
          if (element) tileRefs.current.set(key, element);
          else tileRefs.current.delete(key);
        }}
        data-tile-id={key}
        data-drop-folder={folder.id}
        className={[
          'start-tile',
          'start-tile-project',
          'start-tile-folder',
          pinnedNow ? 'is-pinned' : '',
          canReorder ? 'is-reorderable' : '',
          reorder.draggingId === key ? 'is-dragging' : '',
          dropping ? 'is-drop-target' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        onPointerDown={(event) => {
          if (!renaming) reorder.onPointerDown(key, event);
        }}
        onDragStart={(event) => event.preventDefault()}
      >
        <button
          type="button"
          className="start-tile-open"
          data-tile-drag=""
          disabled={busy}
          aria-label={`Open folder ${folder.name}, ${members.length} ${members.length === 1 ? 'part' : 'parts'}`}
          aria-keyshortcuts={canReorder ? REORDER_KEYS : undefined}
          onClick={() => {
            if (!renaming) showFolder(folder.id);
          }}
          onKeyDown={(event) => nudgeFromKey(key, event)}
        >
          <span className="start-tile-thumb start-folder-thumb">
            {cover ? (
              <PartThumbnail
                project={cover}
                accountId={thumbnailAccountId}
                loadThumbnail={loadThumbnail}
                publishThumbnail={publishThumbnail}
              />
            ) : (
              <FolderOpen
                className="start-folder-empty-icon"
                aria-hidden="true"
              />
            )}
            <span className="start-folder-count" aria-hidden="true">
              <Folder size={11} aria-hidden="true" />
              {members.length}
            </span>
          </span>
          <span className="start-tile-body">
            {!renaming && renderFolderName(folder)}
            {renaming && <span className="start-folder-rename-slot" />}
            <small className="start-tile-meta">
              <span className="start-tile-when">
                {members.length === 0
                  ? 'Empty — drop parts here'
                  : `${members.length} ${members.length === 1 ? 'part' : 'parts'}${
                      edited ? ` · ${formatLastEdited(edited)}` : ''
                    }`}
              </span>
            </small>
          </span>
        </button>
        {/* The name field is a sibling of the open button: a field inside a
            button would be invalid and would open the folder on each key. */}
        {renaming && (
          <div className="start-folder-rename-field">
            {renderFolderName(folder)}
          </div>
        )}

        <div className="start-tile-actions">
          <button
            type="button"
            className="start-tile-action start-tile-pin"
            aria-pressed={pinnedNow}
            aria-label={
              pinnedNow
                ? `Unpin folder ${folder.name}`
                : `Pin folder ${folder.name}`
            }
            title={pinnedNow ? 'Unpin' : 'Pin to the front'}
            disabled={busy}
            onClick={() =>
              updateFolders((state) =>
                setFolderPinned(state, folder.id, !pinnedNow)
              )
            }
          >
            <Pin
              size={12}
              fill={pinnedNow ? 'currentColor' : 'none'}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="start-tile-action start-tile-menu-button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Actions for folder ${folder.name}`}
            disabled={busy}
            onClick={() => setFolderMenu(menuOpen ? null : folder.id)}
          >
            <MoreHorizontal size={12} aria-hidden="true" />
          </button>
        </div>

        {menuOpen && (
          <div
            className="start-tile-menu"
            role="menu"
            aria-label={`Actions for folder ${folder.name}`}
            onKeyDown={(event) => {
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  '[role="menuitem"]:not(:disabled)'
                )
              );
              const at = items.indexOf(
                globalThis.document.activeElement as HTMLElement
              );
              const next =
                event.key === 'ArrowDown'
                  ? (at + 1) % items.length
                  : event.key === 'ArrowUp'
                    ? (at <= 0 ? items.length : at) - 1
                    : -1;
              if (next >= 0) {
                event.preventDefault();
                items[next]?.focus();
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => showFolder(folder.id)}
            >
              <FolderOpen size={13} aria-hidden="true" />
              Open
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setFolderMenu(null);
                setRenamingFolderId(folder.id);
              }}
            >
              <Pencil size={13} aria-hidden="true" />
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={members.length === 0}
              onClick={() => {
                setFolderMenu(null);
                setCoverFolderId(folder.id);
              }}
            >
              <ImageIcon size={13} aria-hidden="true" />
              Choose cover…
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="is-destructive"
              onClick={() => ungroupFolder(folder)}
            >
              <FolderMinus size={13} aria-hidden="true" />
              Ungroup
            </button>
          </div>
        )}
      </div>
    );
  }

  function selectLayout(next: ShelfLayout) {
    setLayout(next);
    writeShelfLayout(next);
  }

  function renderProjectTile(project: ProjectSummary) {
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
              accountId={thumbnailAccountId}
              loadThumbnail={loadThumbnail}
              publishThumbnail={publishThumbnail}
            />
          )}
        </span>
        <span className="start-tile-body">
          {/* Clipped names differ only in their ends ("…-Profiles" and
              "…-Profiles copy"), so the whole name is a hover away. */}
          <strong className="start-tile-name" title={project.name}>
            {project.name}
          </strong>
          <small className="start-tile-meta">
            {/* Quiet marks for the part's standing traits, ahead of the date
                they qualify: how it is stored, where it lives, what it is. */}
            <span className="start-tile-when">
              {migrating && !encrypted ? (
                <span
                  className="start-tile-mark is-encrypting"
                  role="img"
                  aria-label="Encrypting"
                  title="Being end-to-end encrypted. It opens read-only until that finishes."
                >
                  <LoaderCircle size={11} className="spin" aria-hidden="true" />
                </span>
              ) : (
                (locked || encrypted) && (
                  <span
                    className="start-tile-mark"
                    role="img"
                    aria-label="End-to-end encrypted"
                    title={
                      locked
                        ? 'End-to-end encrypted. Update OpenZCAD to open this project.'
                        : 'End-to-end encrypted.'
                    }
                  >
                    <Lock size={11} aria-hidden="true" />
                  </span>
                )
              )}
              {recoveryOf !== null && !trashed && (
                <span
                  className="start-tile-mark"
                  role="img"
                  aria-label="Recovery copy"
                  title={`Recovery copy of ${recoveryOf}`}
                >
                  <History size={11} aria-hidden="true" />
                </span>
              )}
              {localOnly && !trashed && !syncEntry && !conflicted && (
                <span
                  className="start-tile-mark"
                  role="img"
                  aria-label="On this device only"
                  title="On this device only — not saved to your account."
                >
                  <CloudOff size={11} aria-hidden="true" />
                </span>
              )}
              <time
                dateTime={project.updatedAt}
                title={`Last edited ${formatLastEditedExact(project.updatedAt)} · ${
                  project.revisionCount
                } ${project.revisionCount === 1 ? 'save' : 'saves'}`}
              >
                {formatLastEdited(project.updatedAt)}
                {recoveryOf !== null &&
                  ` · ${formatTime(new Date(project.updatedAt))}`}
              </time>
            </span>
            {/* The list has a Saves column; a card leaves the count out. */}
            {layout === 'list' && (
              <span className="start-tile-rev">
                {project.revisionCount}{' '}
                {project.revisionCount === 1 ? 'save' : 'saves'}
              </span>
            )}
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
        {/* Anything that wants a look: a dot in the card's corner, a word in
            the list's Status column. */}
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
          ) : (
            conflicted &&
            !trashed && (
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
            )
          )}
        </span>
      </>
    );

    const dragging = reorder.draggingId === project.projectId;
    // As the shelf shows it: a drop into or out of Pinned counts before its
    // save lands, so the pin button never offers the opposite action.
    const pinnedNow = shownPinned(project);
    const isSelected = selected.has(project.projectId);
    const mergeTarget =
      reorder.dropTarget?.target === `merge:${project.projectId}`
        ? reorder.dropTarget
        : null;
    // While anything is selected, a click picks rather than opens; ⌘/Ctrl
    // and Shift pick from the start.
    const picks = (event: {
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
    }) => selecting || event.metaKey || event.ctrlKey || event.shiftKey;
    const inFolder = openFolder !== null;
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
        data-tile-id={project.projectId}
        className={[
          'start-tile',
          'start-tile-project',
          pinnedNow ? 'is-pinned' : '',
          recoveryOf !== null ? 'is-recovery' : '',
          canReorder ? 'is-reorderable' : '',
          dragging ? 'is-dragging' : '',
          isSelected ? 'is-selected' : '',
          mergeTarget?.armed ? 'is-drop-target' : '',
          mergeTarget && !mergeTarget.armed ? 'is-drop-pending' : ''
        ]
          .filter(Boolean)
          .join(' ')}
        onPointerDown={(event) =>
          reorder.onPointerDown(project.projectId, event)
        }
        // The preview picture is an image, which the browser would otherwise
        // drag out on its own instead of moving the card.
        onDragStart={(event) => event.preventDefault()}
      >
        {trashed || locked ? (
          // A locked card opens nothing: loading it would only fetch a
          // refusal (or ciphertext) this build cannot read. It still takes
          // focus while the shelf can be reordered, so the keyboard can move
          // it like any other card.
          <div
            className="start-tile-open is-static"
            title={locked ? PROJECT_UPDATE_REQUIRED_LABEL : undefined}
            onClick={(event) => {
              if (picks(event))
                toggleSelected(project.projectId, event.shiftKey);
            }}
            {...(canReorder && {
              tabIndex: 0,
              role: 'group',
              'aria-label': project.name,
              'aria-keyshortcuts': REORDER_KEYS,
              onKeyDown: (event: ReactKeyboardEvent) =>
                nudgeFromKey(project.projectId, event)
            })}
          >
            {preview}
          </div>
        ) : (
          <button
            type="button"
            className="start-tile-open"
            data-tile-drag=""
            disabled={busy}
            aria-keyshortcuts={canReorder ? REORDER_KEYS : undefined}
            onClick={(event) => {
              if (picks(event)) {
                event.preventDefault();
                toggleSelected(project.projectId, event.shiftKey);
              } else {
                onOpen(project.projectId);
              }
            }}
            onKeyDown={(event) => nudgeFromKey(project.projectId, event)}
          >
            {preview}
          </button>
        )}

        {/* Picks the part for a bulk action. Shown on hover, and on every
            card once anything is picked. */}
        <button
          type="button"
          role="checkbox"
          className="start-tile-select"
          aria-checked={isSelected}
          aria-label={`Select ${project.name}`}
          title={isSelected ? 'Deselect' : 'Select (Shift picks a range)'}
          onClick={(event) => toggleSelected(project.projectId, event.shiftKey)}
        >
          {isSelected && <Check size={12} aria-hidden="true" />}
        </button>

        {mergeTarget && (
          <span className="start-tile-merge-hint" aria-hidden="true">
            <FolderPlus size={14} aria-hidden="true" />
            {mergeTarget.armed
              ? 'Release to make a folder'
              : 'Hold to make a folder'}
          </span>
        )}

        <div className="start-tile-actions">
          {shelf === 'active' && (
            <button
              type="button"
              className="start-tile-action start-tile-pin"
              aria-pressed={pinnedNow}
              aria-label={
                pinnedNow ? `Unpin ${project.name}` : `Pin ${project.name}`
              }
              title={pinnedNow ? 'Unpin' : 'Pin to the front'}
              disabled={busy}
              onClick={() => onTogglePin(project)}
            >
              {/* Filled when pinned: the marker stays on a pinned tile, and a
                  slashed pin there read as "not pinned". */}
              <Pin
                size={12}
                fill={pinnedNow ? 'currentColor' : 'none'}
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
                {shelf === 'active' && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => {
                      closeMenu(project.projectId);
                      // The selection bar's Move menu, for just this part.
                      setSelected(new Set([project.projectId]));
                      selectionAnchor.current = project.projectId;
                      setMoveMenuOpen(true);
                    }}
                  >
                    <FolderInput size={13} aria-hidden="true" />
                    Move to folder…
                  </button>
                )}
                {inFolder && openFolder && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      onClick={() => {
                        closeMenu(project.projectId);
                        updateFolders((state) =>
                          setFolderCover(
                            state,
                            openFolder.id,
                            project.projectId
                          )
                        );
                        setNotice(
                          `${project.name} is now the cover of ${openFolder.name}.`
                        );
                      }}
                    >
                      <ImageIcon size={13} aria-hidden="true" />
                      Use as folder cover
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      onClick={() => {
                        closeMenu(project.projectId);
                        fileProjects([project.projectId], null);
                      }}
                    >
                      <FolderMinus size={13} aria-hidden="true" />
                      Take out of folder
                    </button>
                  </>
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
            title={`Show its ${copies} recovery ${copies === 1 ? 'copy' : 'copies'}`}
            aria-label={`Show ${project.name} with its ${copies} recovery ${
              copies === 1 ? 'copy' : 'copies'
            }`}
            onClick={() => {
              setFilter('all');
              setQuery(project.name);
            }}
          >
            <Copy size={12} aria-hidden="true" />
            {copies}
            <span className="start-tile-copies-label">
              {' '}
              recovery {copies === 1 ? 'copy' : 'copies'}
            </span>
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
  // Pinned parts and folders head the shelf as their own group when the
  // whole shelf is on screen. Partitioned by the flag, not sliced by count: a
  // part created this session is prepended to the listing ahead of pinned
  // ones. While a drag is under way, the tiles take the order it would drop
  // into. Folders lead each group.
  const dragPositions =
    canReorder && reorder.order
      ? new Map(reorder.order.map((id, index) => [id, index]))
      : null;
  const items: ShelfItem[] = [
    ...shownFolders.map((folder) => ({ key: folderKey(folder.id), folder })),
    ...looseProjects.map((project) => ({ key: project.projectId, project }))
  ];
  const orderedItems = dragPositions
    ? [...items].sort(
        (a, b) =>
          (dragPositions.get(a.key) ?? 0) - (dragPositions.get(b.key) ?? 0)
      )
    : items;
  const itemPinned = (item: ShelfItem) =>
    item.folder ? shownFolderPinned(item.folder) : shownPinned(item.project!);
  // Grouped by the stored flags, so a drag that empties a group keeps its
  // grid on screen to drop back into.
  const storedPinned =
    looseProjects.filter((project) => projectOrganization(project).pinned)
      .length + shownFolders.filter((folder) => folder.pinned).length;
  const shelfGroups: Array<{
    label: string | null;
    group?: 'pinned' | 'parts';
    items: ShelfItem[];
  }> =
    shelf === 'active' &&
    !openFolder &&
    activeFilter === 'all' &&
    !search &&
    storedPinned > 0 &&
    // With everything pinned the Parts group stays, empty, while the shelf
    // can be reordered: it is where a card is dragged to unpin it.
    (storedPinned < items.length || canReorder)
      ? [
          {
            label: 'Pinned',
            group: 'pinned',
            items: orderedItems.filter(itemPinned)
          },
          {
            label: 'Parts',
            group: 'parts',
            items: orderedItems.filter((item) => !itemPinned(item))
          }
        ]
      : [{ label: null, items: orderedItems }];
  // A filter or search that hides every picked part ends selection mode
  // rather than leaving a bar that acts on nothing.
  const selecting = selectedOnScreen().length > 0;
  const shownProjectCount = shelfGroups.reduce(
    (count, group) => count + group.items.filter((item) => item.project).length,
    0
  );

  const { all, pinned, attention, local } = filterCounts;
  const footerPositions = shelfGroups
    .flatMap((group) => group.items)
    .flatMap((item, index) =>
      item.project && recoveryCounts.has(item.project.name) ? [index] : []
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

  // Matches the loaded shelf: an all-pinned shelf still heads its cards
  // with Pinned, and its empty Parts group shows only mid-drag.
  const loadingGroups =
    previousLayout && previousLayout.pinned > 0
      ? [
          { label: 'Pinned', count: previousLayout.pinned, offset: 0 },
          {
            label: 'Parts',
            count: previousLayout.all - previousLayout.pinned,
            offset: previousLayout.pinned
          }
        ].filter((group) => group.count > 0)
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
      {/* The column is the page's frame: the product at its head, on the
          pixels the workspace's logo takes, and where the parts are kept at
          its foot. No bar across the top: the library and Settings are
          pages, not a workspace, and the column says so. */}
      <header className="start-brand">
        <h1 className="brand">
          <BrandMark compact />
          OpenZCAD <span className="beta-tag">Beta</span>
        </h1>
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
        {!loading && userProjects.length > 0 && (
          <div className="start-folders">
            <div className="start-folders-head">
              <span className="start-eyebrow">Folders</span>
              <button
                type="button"
                className="start-folders-new"
                aria-label="New folder"
                title="New folder"
                disabled={busy}
                onClick={newEmptyFolder}
              >
                <FolderPlus size={13} aria-hidden="true" />
              </button>
            </div>
            {folders.length === 0 ? (
              <p className="start-folders-hint">
                Drag one part onto another to group them.
              </p>
            ) : (
              <ul className="start-folders-list">
                {folders.map((folder) => {
                  const open = openFolder?.id === folder.id;
                  return (
                    <li key={folder.id}>
                      <button
                        type="button"
                        className={
                          open
                            ? 'start-folder-link is-active'
                            : 'start-folder-link'
                        }
                        aria-current={open ? 'page' : undefined}
                        data-drop-folder={folder.id}
                        title={folder.name}
                        onClick={() => showFolder(folder.id)}
                      >
                        {open ? (
                          <FolderOpen size={14} aria-hidden="true" />
                        ) : (
                          <Folder size={14} aria-hidden="true" />
                        )}
                        <span className="start-folder-link-name">
                          {folder.name}
                        </span>
                        {folder.pinned && (
                          <Pin
                            size={10}
                            fill="currentColor"
                            className="start-folder-link-pin"
                            aria-label="Pinned"
                          />
                        )}
                        <span className="start-shelf-count">
                          {
                            folder.projectIds.filter((projectId) =>
                              activeProjectIds.has(projectId)
                            ).length
                          }
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
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
              {openFolder && (
                // The way back out, and a drop target that takes parts out
                // of the folder.
                <>
                  <button
                    type="button"
                    className="start-crumb"
                    data-drop-root=""
                    onClick={() => showFolder(null)}
                  >
                    Parts
                  </button>
                  <ChevronRight
                    size={14}
                    className="start-crumb-separator"
                    aria-hidden="true"
                  />
                </>
              )}
              {/* Focusable from script only: it catches focus when the last
                  part leaves the shelf (see `departure`). */}
              <h2
                id="start-parts-title"
                ref={partsTitleRef}
                tabIndex={-1}
                className={openFolder ? 'start-folder-title' : undefined}
                title={openFolder?.name}
              >
                {openFolder ? openFolder.name : shelfLabel.label}
              </h2>
              {/* The filters carry the count once they show; the note keeps
                  the empty, loading and search states. */}
              {!(showFilters && !search) && (
                <span className="start-section-note">
                  {loading
                    ? 'Loading parts…'
                    : openFolder && baseProjects.length === 0
                      ? 'empty'
                      : shelfProjects.length === 0
                        ? shelf === 'active' && partsElsewhere
                          ? 'none on this shelf'
                          : shelfLabel.empty
                        : search
                          ? `${matchingProjects.length} of ${filteredProjects.length} match`
                          : `${baseProjects.length} ${
                              baseProjects.length === 1 ? 'part' : 'parts'
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

          {/* The heading and cloud card show refresh progress; announce it once. */}
          {loading && (
            <div
              className="start-loading visually-hidden"
              role="status"
              aria-label="Loading library"
            >
              Loading your parts and account…
            </div>
          )}
          {loading && userProjects.length === 0 && (
            <>
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
                              <span className="start-tile-when">
                                <time>&nbsp;</time>
                              </span>
                              {layout === 'list' && (
                                <span className="start-tile-rev">&nbsp;</span>
                              )}
                            </small>
                          </span>
                          <span className="start-tile-flags" />
                        </div>
                        {/* Only a row grows by its copies line; a card
                            keeps its count in the corner. */}
                        {layout === 'list' &&
                          previousLayout?.footers.includes(
                            group.offset + index
                          ) && <div className="start-tile-copies" />}
                      </div>
                    ))}
                  </div>
                </Fragment>
              ))}
            </>
          )}

          {notice && (
            <p className="start-folder-notice" role="status">
              {notice}
            </p>
          )}

          {openFolder && !loading && baseProjects.length === 0 && (
            <div className="start-empty start-folder-empty" role="status">
              <FolderOpen size={28} aria-hidden="true" />
              <strong>This folder is empty</strong>
              <span>
                Drag parts onto it on the shelf, or select parts and use Move
                to.
              </span>
            </div>
          )}

          {items.length > 0 && (
            <>
              {layout === 'list' && (
                <div className="start-list-head" aria-hidden="true">
                  <span>Name</span>
                  <span>Status</span>
                  <span>Edited</span>
                  <span>Saves</span>
                </div>
              )}
              {shelfGroups.map((group) =>
                // An empty group only shows as a drop target mid-drag.
                group.items.length === 0 && !reorder.draggingId ? null : (
                  <Fragment key={group.label ?? 'all'}>
                    {group.label && (
                      <h3 className="start-shelf-group">
                        {group.label}
                        <span>{group.items.length}</span>
                      </h3>
                    )}
                    <div
                      className={
                        layout === 'list'
                          ? 'start-tile-grid is-list'
                          : 'start-tile-grid'
                      }
                      data-tile-group={canReorder ? group.group : undefined}
                    >
                      {group.items.map((item) =>
                        item.folder
                          ? renderFolderTile(item.folder)
                          : renderProjectTile(item.project!)
                      )}
                      {group.items.length === 0 && (
                        <p className="start-drop-zone">
                          {group.group === 'pinned'
                            ? 'Drop here to pin'
                            : 'Drop here to unpin'}
                        </p>
                      )}
                    </div>
                  </Fragment>
                )
              )}
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
        {selecting && (
          <LibrarySelectionBar
            count={selectedOnScreen().length}
            total={shownProjectCount}
            shelf={shelf}
            busy={busy}
            folders={folders}
            inFolderId={openFolder?.id ?? null}
            allPinned={selectedOnScreen().every(
              (project) => projectOrganization(project).pinned
            )}
            moveMenuOpen={moveMenuOpen}
            onMoveMenuOpenChange={setMoveMenuOpen}
            onSelectAll={() => setSelected(new Set(visibleProjectIds()))}
            onClear={clearSelection}
            onMoveToFolder={(folderId) => {
              setMoveMenuOpen(false);
              fileProjects(
                selectedOnScreen().map((project) => project.projectId),
                folderId
              );
            }}
            onNewFolder={() => {
              makeFolder(
                selectedOnScreen().map((project) => project.projectId)
              );
              setNotice(
                'Made a folder. Name it, or press Enter to keep the name.'
              );
            }}
            onRemoveFromFolder={() =>
              fileProjects(
                selectedOnScreen().map((project) => project.projectId),
                null
              )
            }
            onPin={pinSelected}
            onMoveToShelf={moveSelectedToShelf}
            onDeleteForever={deleteSelectedForever}
          />
        )}
      </div>

      <section className="start-learn" aria-labelledby="start-demos-title">
        <div className="start-learn-head">
          <h2 id="start-demos-title">Learn by example</h2>
          <span className="start-section-note">
            each demo walks a part through revisions A → C
          </span>
        </div>
        <div className="demo-list">
          {demos.map((demo) => {
            // Opened before: this device holds an edited copy, which the
            // sample opens as until it is reset.
            const opened = projects.find(
              (project) => project.projectId === demo.projectId
            );
            const title = demo.name.replace('Demo · ', '');
            return (
              <div key={demo.key} className="demo-item">
                <button
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
                {opened && (
                  <div className="demo-actions">
                    <button
                      type="button"
                      className="demo-action"
                      aria-label={`Save a copy of ${title} to your parts`}
                      title="Save a copy to your parts"
                      disabled={busy}
                      onClick={() => onDuplicate(opened)}
                    >
                      <Copy size={12} aria-hidden="true" />
                    </button>
                    {onResetDemo && (
                      <button
                        type="button"
                        className="demo-action"
                        aria-label={`Reset ${title} to the original`}
                        title="Reset to the original"
                        disabled={busy}
                        onClick={() => onResetDemo(demo, opened)}
                      >
                        <RotateCcw size={12} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="start-column-foot" aria-label="Account and app">
        <aside className="start-cloud" aria-label="Cloud sync">
          {onReloadForUpdate || onReloadForLoadFailure ? (
            // Module failures can stay cached until navigation. This action
            // outlives the toast, whether or not an update was confirmed.
            <span
              className={`start-update ${onReloadForUpdate ? 'is-update' : 'is-failure'}`}
              role="alert"
            >
              <span className="start-update-dot" aria-hidden="true" />
              <span
                className="start-update-text"
                // The bar clips a long sentence; the tooltip keeps it whole.
                title={onReloadForUpdate ? undefined : STALE_CHUNK_MESSAGE}
              >
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
            {/* What the one-line readout cannot hold hangs below it. */}
            {(syncFailures.length > 0 || statusLine) && (
              <div className="start-account-details">
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
            )}
          </div>
        </aside>
        <div className="start-column-foot-actions">
          {onImportProject && (
            <ProjectImportButton
              onImport={onImportProject}
              disabled={busy}
              className="start-column-action start-import"
              title="Import project…"
            />
          )}
          <button
            className="start-column-action start-settings-button"
            type="button"
            aria-label="Open settings"
            title={labelWithKey('Settings', settingsKey)}
            onClick={onOpenSettings}
          >
            <Settings size={14} aria-hidden="true" />
            Settings
          </button>
        </div>
      </section>

      {coverFolderId && folderById.get(coverFolderId) && (
        <Suspense fallback={null}>
          <FolderCoverDialog
            folderName={folderById.get(coverFolderId)!.name}
            members={folderMembers(folderById.get(coverFolderId)!)}
            coverProjectId={folderCover(
              folderById.get(coverFolderId)!,
              shelfIds
            )}
            thumbnailAccountId={thumbnailAccountId}
            loadThumbnail={loadThumbnail}
            publishThumbnail={publishThumbnail}
            onChoose={(projectId) =>
              updateFolders((state) =>
                setFolderCover(state, coverFolderId, projectId)
              )
            }
            onClose={() => setCoverFolderId(null)}
          />
        </Suspense>
      )}
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
