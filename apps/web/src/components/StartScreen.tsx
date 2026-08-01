import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Copy,
  GraduationCap,
  GripVertical,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  X
} from 'lucide-react';
import {
  daysUntilPurge,
  MAX_PROJECT_NAME_LENGTH,
  projectOrganization,
  TRASH_RETENTION_DAYS,
  type BodyRepresentation,
  type ProjectStatus,
  type ProjectSummary,
  type UnitSystem
} from '@openzcad/shared';
import { bucketProjectsByShelf, moveItem } from '../lib/projectShelf';
import type { DemoDefinition } from '../lib/demos';
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
  onMoveToShelf(project: ProjectSummary, status: ProjectStatus): void;
  onTogglePin(project: ProjectSummary): void;
  /** The shelf's projects in their new order, front to back. */
  onReorder(projectIds: string[]): void;
  /** Irreversible: destroys the project outright. */
  onDeleteForever(project: ProjectSummary): void;
  onEmptyTrash(projects: ProjectSummary[]): void;
  loadThumbnailBodies(project: ProjectSummary): Promise<BodyRepresentation[]>;
}

/**
 * How many saved parts a shelf shows before it has to be expanded. Seven parts
 * plus the create tile fills roughly two rows at the widths the grid actually
 * settles on, which is enough to recognise recent work without the demos below
 * being pushed off the screen. Shelves without a create tile get its slot back.
 */
const COLLAPSED_PROJECT_LIMIT = 7;

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
  onMoveToShelf,
  onTogglePin,
  onReorder,
  onDeleteForever,
  onEmptyTrash,
  loadThumbnailBodies
}: StartScreenProps) {
  const [name, setName] = useState('New Part');
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
  const collapsedLimit =
    shelf === 'active' ? COLLAPSED_PROJECT_LIMIT : COLLAPSED_PROJECT_LIMIT + 1;
  const overflowCount = search ? 0 : matchingProjects.length - collapsedLimit;
  const visibleProjects =
    expanded || overflowCount <= 0
      ? matchingProjects
      : matchingProjects.slice(0, collapsedLimit);

  // Dragging reorders positions within a shelf, which only means anything when
  // every position is on screen and in its stored order.
  const canReorder = shelf === 'active' && !search && !busy;

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

    const preview = (
      <>
        <span className="start-tile-thumb">
          <PartThumbnail project={project} loadBodies={loadThumbnailBodies} />
        </span>
        <strong className="start-tile-name">{project.name}</strong>
        <small className="start-tile-meta">
          {trashed
            ? daysLeft === 0
              ? 'deleting shortly'
              : `deletes in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`
            : `rev ${project.revisionCount} · ${new Date(
                project.updatedAt
              ).toLocaleDateString()}`}
        </small>
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

  return (
    <div className="start-screen">
      <header className="start-header">
        <BrandMark />
        <h1 className="start-header-name">OpenZCAD</h1>
        <span className="start-tagline">parametric cad in the browser</span>
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
        <section className="start-section">
          <div className="start-section-head">
            <h2>Your parts</h2>
            <span className="start-section-note">
              {shelfProjects.length === 0
                ? shelfLabel.empty
                : search
                  ? `${matchingProjects.length} of ${shelfProjects.length} match`
                  : `${shelfProjects.length} ${
                      shelfProjects.length === 1 ? 'project' : 'projects'
                    }`}
            </span>
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

          <div className="start-shelf-bar">
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

            {shelf === 'deleted' && (
              <>
                <span className="start-shelf-hint">
                  deleted parts are kept for {TRASH_RETENTION_DAYS} days
                </span>
                {shelfProjects.length > 0 && (
                  <button
                    type="button"
                    className="start-shelf-action is-destructive"
                    disabled={busy}
                    onClick={() => onEmptyTrash(shelfProjects)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    Empty trash
                  </button>
                )}
              </>
            )}
          </div>

          <div className="start-tile-grid">
            {shelf === 'active' && (
              <form
                className="start-tile start-tile-new"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canCreate) {
                    onCreate(trimmedName, units);
                  }
                }}
                onKeyDown={(event) => {
                  // Enter creates from any field, including the units select.
                  if (
                    event.key === 'Enter' &&
                    !(event.target instanceof HTMLButtonElement)
                  ) {
                    event.preventDefault();
                    if (canCreate) {
                      onCreate(trimmedName, units);
                    }
                  }
                }}
              >
                <span className="start-tile-new-head">
                  <Plus size={15} aria-hidden="true" />
                  New part
                </span>
                <input
                  value={name}
                  aria-label="Project name"
                  autoFocus
                  aria-invalid={nameTooLong || undefined}
                  aria-describedby={
                    nameTooLong ? 'project-name-error' : undefined
                  }
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setName(event.target.value)}
                />
                {nameTooLong && (
                  <small
                    id="project-name-error"
                    className="field-error"
                    role="alert"
                  >
                    Project name must be at most {MAX_PROJECT_NAME_LENGTH}{' '}
                    characters.
                  </small>
                )}
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
                <button
                  type="submit"
                  className="primary wide"
                  disabled={!canCreate}
                >
                  Create project
                </button>
              </form>
            )}

            {visibleProjects.map((project, index) =>
              renderProjectTile(project, index)
            )}
          </div>

          {shelf !== 'active' && shelfProjects.length === 0 && (
            <p className="start-no-matches" role="status">
              {shelf === 'archived'
                ? 'Nothing archived. Archive a part to keep it without it crowding the grid.'
                : `Nothing in the recycle bin. Deleted parts wait here for ${TRASH_RETENTION_DAYS} days before they are destroyed.`}
            </p>
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

        <section className="start-section">
          <div className="start-section-head">
            <h2>Design revision demos</h2>
            <span className="start-section-note">
              walk a part through revisions A → C
            </span>
          </div>
          <div className="demo-list">
            {demos.map((demo) => (
              <button
                key={demo.key}
                type="button"
                className="demo-card"
                disabled={busy}
                onClick={() => onOpenDemo(demo)}
              >
                <span className="demo-card-head">
                  <GraduationCap size={14} aria-hidden="true" />
                  <strong>{demo.name.replace('Demo · ', '')}</strong>
                </span>
                <span className="demo-card-tagline">{demo.tagline}</span>
                <span className="demo-card-revs">
                  {demo.revisions.map((revision) => (
                    <span key={revision} className="demo-rev">
                      {revision}
                    </span>
                  ))}
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
