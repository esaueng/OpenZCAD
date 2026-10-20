import {
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type ReactNode,
  type SetStateAction
} from 'react';
import {
  Axis3d,
  Box,
  ChevronRight,
  Combine,
  Eye,
  EyeOff,
  FileBox,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  Move3d,
  Pencil,
  PenLine,
  RotateCw,
  Search,
  SquareDashed,
  Trash2
} from 'lucide-react';
import {
  listObjectFolders,
  nextObjectFolderName,
  objectFolderPlacements,
  type ObjectFolderCreateInput,
  type ObjectFolderMoveInput
} from '@openzcad/document-core';
import {
  createId,
  type BodyId,
  type BodyRepresentation,
  type ObjectFolder,
  type ProjectDocument
} from '@openzcad/shared';
import { useArrivals } from '../../hooks/useArrivals';
import { useCollapsedFolders } from '../../lib/objectFolderView';
import { datumPlaneRows } from '../../lib/datumPlanes';
import { datumAxisRows } from '../../lib/datumAxes';
import type { SidebarProps } from '../Sidebar';
import { ObjectRenameField } from './ObjectRenameField';

/** What the Objects list is built from, and all its header count needs. */
export type ObjectsSource = Pick<
  SidebarProps,
  'features' | 'representations' | 'document' | 'parameterValues'
>;

/**
 * The Objects list's type filter, name search and source-body disclosure.
 * The composer holds them, so they outlive the list while its section is
 * folded.
 */
export interface ObjectsView {
  filter: string;
  setFilter(filter: string): void;
  query: string;
  setQuery(query: string): void;
  showConsumed: boolean;
  setShowConsumed: Dispatch<SetStateAction<boolean>>;
}

export function useObjectsView(): ObjectsView {
  const [showConsumed, setShowConsumed] = useState(false);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  return { filter, setFilter, query, setQuery, showConsumed, setShowConsumed };
}

export type ObjectsPanelProps = ObjectsSource &
  Pick<
    SidebarProps,
    | 'geometryPending'
    | 'selectedFeatureNodeId'
    | 'selectedSketchProfileId'
    | 'selectedBodyIds'
    | 'hiddenBodyIds'
    | 'hiddenSketchIds'
    | 'hiddenDatumIds'
    | 'onHiddenDatumIdsChange'
    | 'onSelectFeature'
    | 'onSelectBody'
    | 'onToggleBodyVisibility'
    | 'onToggleSketchVisibility'
    | 'onRenameBody'
    | 'objectFolderActions'
  > & { view: ObjectsView };

/**
 * What the Objects folders (U06, ZC-128) ask of the host. Each edit is one
 * undoable command there; visibility and selection are view state.
 */
export interface ObjectFolderActions {
  /** False when the command was refused; the host says why. */
  create(input: ObjectFolderCreateInput): boolean;
  rename(folderId: string, name: string): void;
  /** Deletes the folder only; what it held moves up a level. */
  remove(folderId: string): void;
  move(input: ObjectFolderMoveInput): void;
  setBodiesHidden(bodyIds: BodyId[], hidden: boolean): void;
  selectBodies(bodyIds: BodyId[], additive: boolean): void;
}

/** What a drag in the Objects list carries. */
interface ObjectDrag {
  bodyIds: BodyId[];
  folderIds: string[];
}

/** The drop target id of the top level. */
const ROOT_DROP = '';

const depthStyle = (depth: number) =>
  ({ '--object-depth': depth }) as CSSProperties;

// Resolving folders walks every body's lineage; once per immutable document.
const placementCache = new WeakMap<
  ProjectDocument,
  ReturnType<typeof objectFolderPlacements>
>();

function cachedPlacements(document: ProjectDocument) {
  let placements = placementCache.get(document);
  if (!placements) {
    placements = objectFolderPlacements(document);
    placementCache.set(document, placements);
  }
  return placements;
}

/** Body kind icons mirror the feature icons so the two lists read as one. */
function bodyIcon(body: BodyRepresentation) {
  const size = 13;
  switch (body.source) {
    case 'primitive':
      return <Box size={size} aria-hidden="true" />;
    case 'sketch':
      return <PenLine size={size} aria-hidden="true" />;
    case 'extrude':
      return <Layers size={size} aria-hidden="true" />;
    case 'revolve':
      return <RotateCw size={size} aria-hidden="true" />;
    case 'boolean':
      return <Combine size={size} aria-hidden="true" />;
    case 'transform':
      return <Move3d size={size} aria-hidden="true" />;
    default:
      return <FileBox size={size} aria-hidden="true" />;
  }
}

/** How long a new row keeps `.is-arrival`: its accent wash drains in 900ms. */
const ARRIVAL_MS = 900;

/** Every body, consumed ones included. */
export function modelBodies({
  features,
  representations
}: Pick<ObjectsSource, 'features' | 'representations'>): BodyRepresentation[] {
  // Bodies in feature-history order so the tree matches the timeline below.
  const bodies: BodyRepresentation[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (feature.bodyId && !seen.has(feature.bodyId)) {
      const body = representations[feature.bodyId];
      if (body) {
        seen.add(feature.bodyId);
        bodies.push(body);
      }
    }
  }
  for (const body of Object.values(representations)) {
    if (!seen.has(body.bodyId)) {
      seen.add(body.bodyId);
      bodies.push(body);
    }
  }
  return bodies;
}

function modelSketches({ features }: Pick<ObjectsSource, 'features'>) {
  return features.filter((feature) => feature.data.featureKind === 'sketch');
}

type DatumRows = ReturnType<typeof buildDatums>;

function buildDatums({
  document,
  parameterValues
}: Pick<ObjectsSource, 'document' | 'parameterValues'>) {
  // R01 datums: planes, then axes, each in history order, sharing one row.
  return [
    ...(document ? datumPlaneRows(document, parameterValues) : []).map(
      (row) => ({ ...row, datum: 'plane' as const })
    ),
    ...(document ? datumAxisRows(document, parameterValues) : []).map(
      (row) => ({ ...row, datum: 'axis' as const })
    )
  ];
}

// The header count and the panel both need the datum rows, and building them
// scans the whole history for each datum's dependents. Rows are cached per
// (immutable) document and parameter scope so a render builds them once; the
// WeakMap lets a closed project's document be collected.
const datumCache = new WeakMap<
  object,
  { parameterValues: ObjectsSource['parameterValues']; rows: DatumRows }
>();

function modelDatums(
  source: Pick<ObjectsSource, 'document' | 'parameterValues'>
): DatumRows {
  const { document } = source;
  if (!document) {
    return buildDatums(source);
  }
  const cached = datumCache.get(document);
  if (cached?.parameterValues === source.parameterValues) {
    return cached.rows;
  }
  const rows = buildDatums(source);
  datumCache.set(document, { parameterValues: source.parameterValues, rows });
  return rows;
}

/**
 * The Objects header count: live bodies, sketches and datums, before any
 * filter or search. The panel always shows, empty or not.
 */
export function objectCount(source: ObjectsSource): number {
  return (
    modelBodies(source).filter((body) => !body.consumed).length +
    modelSketches(source).length +
    modelDatums(source).length
  );
}

export function ObjectsPanel({
  features,
  representations,
  document,
  parameterValues,
  geometryPending = false,
  selectedFeatureNodeId,
  selectedSketchProfileId,
  selectedBodyIds,
  hiddenBodyIds,
  hiddenSketchIds,
  hiddenDatumIds,
  onHiddenDatumIdsChange,
  onSelectFeature,
  onSelectBody,
  onToggleBodyVisibility,
  onToggleSketchVisibility,
  onRenameBody,
  objectFolderActions,
  view
}: ObjectsPanelProps) {
  // The body whose name is a field right now (ZC-127): double-click or F2.
  const [renamingBodyId, setRenamingBodyId] = useState<string | null>(null);
  const {
    filter: objectFilter,
    setFilter: setObjectFilter,
    query: objectQuery,
    setQuery: setObjectQuery,
    showConsumed,
    setShowConsumed
  } = view;
  const objectNeedle = objectQuery.trim().toLowerCase();
  // Name search narrows the rows only: identities, selection and visibility
  // are untouched, and clearing the field brings back exactly the same list.
  const matchesObject = (name: string) =>
    !objectNeedle || name.toLowerCase().includes(objectNeedle);
  const allSketches = modelSketches({ features });
  const sketches = allSketches.filter((sketch) => matchesObject(sketch.name));
  const sketchArrivals = useArrivals(
    allSketches.map((sketch) => sketch.id),
    ARRIVAL_MS
  );
  const bodies = modelBodies({ features, representations });
  // Consumed bodies live behind a disclosure row: in a model built from
  // booleans nearly every body is an input to a later feature, and a list
  // that is mostly dead entries buries the ones that still exist.
  const bodyArrivals = useArrivals(
    bodies.map((body) => body.bodyId),
    ARRIVAL_MS
  );
  const matchingBodies = bodies.filter((body) => matchesObject(body.name));
  const liveBodies = matchingBodies.filter((body) => !body.consumed);
  // Every live body, searched for or not: a search narrows the rows, never
  // the selection that New folder and a drag act on.
  const allLiveBodyIds = new Set(
    bodies.filter((body) => !body.consumed).map((body) => body.bodyId)
  );
  const consumedBodies = matchingBodies.filter((body) => body.consumed);
  const showBodies = objectFilter === 'all' || objectFilter === 'bodies';
  const showSketches = objectFilter === 'all' || objectFilter === 'sketches';
  const showPlanes = objectFilter === 'all' || objectFilter === 'planes';
  const showAxes = objectFilter === 'all' || objectFilter === 'axes';
  const allPlanes = modelDatums({ document, parameterValues });
  const planes = allPlanes.filter(
    (plane) =>
      matchesObject(plane.name) &&
      (plane.datum === 'plane' ? showPlanes : showAxes)
  );
  // Folders (ZC-128) show while bodies are listed and nothing is searched: a
  // search lists its matches flat, and clearing it brings the tree back.
  const folders = document ? listObjectFolders(document) : [];
  const treeShown = showBodies && !objectNeedle;
  const placements = document ? cachedPlacements(document) : null;
  const collapsedFolders = useCollapsedFolders(document?.projectId ?? null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [drag, setDrag] = useState<ObjectDrag | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const folderOf = (bodyId: BodyId): string | null =>
    (treeShown && placements?.get(bodyId)) || null;
  const foldersIn = new Map<string | null, ObjectFolder[]>();
  for (const folder of treeShown ? folders : []) {
    const siblings = foldersIn.get(folder.parentId) ?? [];
    siblings.push(folder);
    foldersIn.set(folder.parentId, siblings);
  }
  const bodiesIn = new Map<string | null, BodyRepresentation[]>();
  for (const body of liveBodies) {
    const folderId = folderOf(body.bodyId);
    const members = bodiesIn.get(folderId) ?? [];
    members.push(body);
    bodiesIn.set(folderId, members);
  }
  /** Every live body in a folder and the folders inside it. */
  const folderBodyIds = (folderId: string): BodyId[] => [
    ...(bodiesIn.get(folderId) ?? []).map((body) => body.bodyId),
    ...(foldersIn.get(folderId) ?? []).flatMap((child) =>
      folderBodyIds(child.id)
    )
  ];
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  /** A drop is refused where it would put a folder inside itself. */
  const canDropInto = (target: string | null): boolean => {
    if (!drag) return false;
    for (let at = target; at !== null; at = parentOf.get(at) ?? null) {
      if (drag.folderIds.includes(at)) return false;
    }
    return true;
  };

  const filteredCount =
    (showBodies ? matchingBodies.length : 0) +
    (showSketches ? sketches.length : 0) +
    planes.length +
    (treeShown ? folders.length : 0);

  function endDrag() {
    setDrag(null);
    setDropTarget(null);
  }

  function startDrag(event: DragEvent, payload: ObjectDrag, label: string) {
    event.dataTransfer.effectAllowed = 'move';
    // Some engines start no drag without data.
    event.dataTransfer.setData('text/plain', label);
    setDrag(payload);
  }

  function dropZone(target: string | null) {
    const id = target ?? ROOT_DROP;
    return {
      onDragOver(event: DragEvent) {
        if (!canDropInto(target)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (dropTarget !== id) setDropTarget(id);
      },
      onDragLeave(event: DragEvent) {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        if (dropTarget === id) setDropTarget(null);
      },
      onDrop(event: DragEvent) {
        event.preventDefault();
        const payload = drag;
        endDrag();
        if (!payload || !canDropInto(target)) return;
        objectFolderActions?.move({ parentId: target, ...payload });
        if (target) collapsedFolders.expand(target);
      }
    };
  }

  function createFolder() {
    if (!objectFolderActions || !document) return;
    const bodyIds = (selectedBodyIds as BodyId[]).filter((id) =>
      allLiveBodyIds.has(id)
    );
    // Selected bodies that share a folder get the new one beside them.
    const homes = new Set(bodyIds.map((id) => placements?.get(id) ?? null));
    const parentId = homes.size === 1 ? [...homes][0]! : null;
    const folderId = createId<'ObjectFolderId'>('folder');
    const created = objectFolderActions.create({
      folderId,
      name: nextObjectFolderName(document, parentId),
      parentId,
      ...(bodyIds.length > 0 ? { bodyIds } : {})
    });
    if (!created) return;
    // Show it where it was made, with its name ready to type over.
    setObjectQuery('');
    if (!showBodies) setObjectFilter('all');
    if (parentId) collapsedFolders.expand(parentId);
    setRenamingFolderId(folderId);
  }

  function focusRow(selector: string) {
    requestAnimationFrame(() =>
      globalThis.document.querySelector<HTMLElement>(selector)?.focus()
    );
  }

  function renderFolderChildren(
    parentId: string | null,
    depth: number
  ): ReactNode[] {
    return [
      ...(foldersIn.get(parentId) ?? []).flatMap((folder) =>
        renderFolder(folder, depth)
      ),
      ...(bodiesIn.get(parentId) ?? []).map((body) =>
        renderBodyRow(body, depth)
      )
    ];
  }

  function renderFolder(folder: ObjectFolder, depth: number): ReactNode[] {
    const expanded = !collapsedFolders.collapsed.has(folder.id);
    const bodyIds = folderBodyIds(folder.id);
    const allHidden =
      bodyIds.length > 0 && bodyIds.every((id) => hiddenBodyIds.has(id));
    const allSelected =
      bodyIds.length > 0 && bodyIds.every((id) => selectedBodyIds.includes(id));
    const editable = Boolean(objectFolderActions);
    const icon = expanded ? (
      <FolderOpen size={13} aria-hidden="true" />
    ) : (
      <Folder size={13} aria-hidden="true" />
    );
    const row = (
      <div
        key={`folder-${folder.id}`}
        className={`object-row object-folder-row${allSelected ? ' selected' : ''}${allHidden ? ' hidden-body' : ''}${dropTarget === folder.id ? ' drop-target' : ''}`}
        role="listitem"
        style={depthStyle(depth)}
        draggable={editable && renamingFolderId !== folder.id}
        onDragStart={(event) =>
          startDrag(event, { bodyIds: [], folderIds: [folder.id] }, folder.name)
        }
        onDragEnd={endDrag}
        {...dropZone(folder.id)}
      >
        <button
          type="button"
          className="object-folder-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} folder ${folder.name}`}
          onClick={() => collapsedFolders.toggle(folder.id)}
        >
          <ChevronRight
            size={12}
            className="disclosure-chevron"
            aria-hidden="true"
          />
        </button>
        {editable && renamingFolderId === folder.id ? (
          <ObjectRenameField
            name={folder.name}
            label={`Rename folder ${folder.name}`}
            icon={icon}
            onCommit={(name) => objectFolderActions?.rename(folder.id, name)}
            onDone={(refocus) => {
              setRenamingFolderId(null);
              if (refocus)
                focusRow(`[data-folder-row="${CSS.escape(folder.id)}"]`);
            }}
          />
        ) : (
          <button
            type="button"
            className="body-row-main"
            data-folder-row={folder.id}
            aria-pressed={allSelected}
            aria-keyshortcuts={editable ? 'F2' : undefined}
            title={`${folder.name} — click to select its bodies${editable ? ', drag to move, double-click or F2 to rename' : ''}`}
            onClick={(event) =>
              objectFolderActions?.selectBodies(
                bodyIds,
                event.shiftKey || event.metaKey || event.ctrlKey
              )
            }
            onDoubleClick={() => {
              if (editable) setRenamingFolderId(folder.id);
            }}
            onKeyDown={(event) => {
              if (editable && event.key === 'F2') {
                event.preventDefault();
                setRenamingFolderId(folder.id);
              }
            }}
          >
            <span className="feature-icon">{icon}</span>
            <span className="feature-name">{folder.name}</span>
            <span className="feature-flag">{bodyIds.length}</span>
          </button>
        )}
        {editable && renamingFolderId !== folder.id && (
          <button
            type="button"
            className="row-visibility object-rename"
            title={`Rename folder ${folder.name} (F2)`}
            aria-label={`Rename folder ${folder.name}`}
            onClick={() => setRenamingFolderId(folder.id)}
          >
            <Pencil size={12} aria-hidden="true" />
          </button>
        )}
        {bodyIds.length > 0 && (
          <button
            type="button"
            className={`row-visibility${allHidden ? ' is-hidden' : ''}`}
            title={
              allHidden
                ? `Show folder ${folder.name}`
                : `Hide folder ${folder.name}`
            }
            aria-label={
              allHidden
                ? `Show folder ${folder.name}`
                : `Hide folder ${folder.name}`
            }
            aria-pressed={allHidden}
            onClick={() =>
              objectFolderActions?.setBodiesHidden(bodyIds, !allHidden)
            }
          >
            {allHidden ? (
              <EyeOff size={12} aria-hidden="true" />
            ) : (
              <Eye size={12} aria-hidden="true" />
            )}
          </button>
        )}
        {editable && (
          <button
            type="button"
            className="row-visibility object-folder-delete"
            title={`Delete folder ${folder.name} — what it holds moves up a level`}
            aria-label={`Delete folder ${folder.name}`}
            onClick={() => objectFolderActions?.remove(folder.id)}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    );
    return expanded
      ? [row, ...renderFolderChildren(folder.id, depth + 1)]
      : [row];
  }

  function renderBodyRow(body: BodyRepresentation, depth = 0) {
    const hidden = hiddenBodyIds.has(body.bodyId);
    const selected = selectedBodyIds.includes(body.bodyId);
    // A consumed body is history's input, not a thing the user still has:
    // it keeps the name it had when it was combined.
    const renamable = Boolean(onRenameBody) && !body.consumed;
    const draggable =
      Boolean(objectFolderActions) &&
      !body.consumed &&
      renamingBodyId !== body.bodyId;
    return (
      <div
        key={body.bodyId}
        className={`body-row ${selected ? 'selected' : ''} ${body.consumed ? 'consumed' : ''} ${hidden ? 'hidden-body' : ''}${bodyArrivals.has(body.bodyId) ? ' is-arrival' : ''}`}
        role="listitem"
        style={depth > 0 ? depthStyle(depth) : undefined}
        draggable={draggable}
        onDragStart={(event) => {
          // A selected body carries the rest of the selection with it.
          const bodyIds =
            selected && selectedBodyIds.length > 1
              ? (selectedBodyIds as BodyId[]).filter((id) =>
                  allLiveBodyIds.has(id)
                )
              : [body.bodyId];
          startDrag(event, { bodyIds, folderIds: [] }, body.name);
        }}
        onDragEnd={endDrag}
      >
        {renamable && renamingBodyId === body.bodyId ? (
          <ObjectRenameField
            name={body.name}
            label={`Rename body ${body.name}`}
            icon={bodyIcon(body)}
            onCommit={(name) => onRenameBody?.(body.bodyId, name)}
            onDone={(refocus) => {
              setRenamingBodyId(null);
              if (refocus)
                focusRow(`[data-body-row="${CSS.escape(body.bodyId)}"]`);
            }}
          />
        ) : (
          <button
            type="button"
            className="body-row-main"
            data-body-row={body.bodyId}
            aria-pressed={selected}
            aria-keyshortcuts={renamable ? 'F2' : undefined}
            title={`${body.name}${body.consumed ? ' — combined into a later feature' : ''} — click to select, ⇧click to add${draggable ? ', drag into a folder' : ''}${renamable ? ', double-click or F2 to rename' : ''}`}
            onClick={(event) =>
              onSelectBody(
                body.bodyId,
                event.shiftKey || event.metaKey || event.ctrlKey
              )
            }
            onDoubleClick={() => {
              if (renamable) setRenamingBodyId(body.bodyId);
            }}
            onKeyDown={(event) => {
              if (renamable && event.key === 'F2') {
                event.preventDefault();
                setRenamingBodyId(body.bodyId);
              }
            }}
          >
            <span className="feature-icon">{bodyIcon(body)}</span>
            <span className="feature-name">{body.name}</span>
          </button>
        )}
        {renamable && renamingBodyId !== body.bodyId && (
          // Double-click alone is not enough: the first click selects, and
          // the Inspector that opens for the selection can move the row
          // before the second click lands.
          <button
            type="button"
            className="row-visibility object-rename"
            title={`Rename body ${body.name} (F2)`}
            aria-label={`Rename body ${body.name}`}
            onClick={() => setRenamingBodyId(body.bodyId)}
          >
            <Pencil size={12} aria-hidden="true" />
          </button>
        )}
        {!body.consumed && (
          <button
            type="button"
            className={`row-visibility ${hidden ? 'is-hidden' : ''}`}
            title={hidden ? `Show body ${body.name}` : `Hide body ${body.name}`}
            aria-label={
              hidden ? `Show body ${body.name}` : `Hide body ${body.name}`
            }
            aria-pressed={hidden}
            onClick={() => onToggleBodyVisibility(body.bodyId)}
          >
            {hidden ? (
              <EyeOff size={12} aria-hidden="true" />
            ) : (
              <Eye size={12} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="object-filter">
        <Layers size={13} aria-hidden="true" />
        <select
          aria-label="Filter objects by type"
          value={objectFilter}
          onChange={(event) => setObjectFilter(event.target.value)}
        >
          <option value="all">All objects</option>
          <option value="bodies">Bodies</option>
          <option value="sketches">Sketches</option>
          <option value="planes">Planes</option>
          <option value="axes">Axes</option>
        </select>
      </div>
      <div className="object-filter">
        <Search size={13} aria-hidden="true" />
        <input
          type="search"
          aria-label="Find an object by name"
          placeholder="Find an object"
          value={objectQuery}
          onChange={(event) => setObjectQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && objectQuery) {
              event.preventDefault();
              event.stopPropagation();
              setObjectQuery('');
            }
          }}
        />
        {objectFolderActions && document && (
          <button
            type="button"
            className="object-folder-new"
            aria-label="New folder"
            title="New folder — the selected bodies go into it"
            onClick={createFolder}
          >
            <FolderPlus size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="feature-list" role="list" aria-label="Objects">
        {geometryPending && (
          <p className="muted sidebar-hint" role="status">
            Preparing model details…
          </p>
        )}
        {filteredCount === 0 && !geometryPending && (
          <p className="muted sidebar-hint" role="listitem">
            {objectNeedle
              ? `No objects match “${objectQuery.trim()}”.`
              : objectFilter === 'all'
                ? 'No objects yet. Create a body or sketch to get started.'
                : objectFilter === 'bodies'
                  ? 'No bodies yet. Create a primitive or extrude a sketch.'
                  : objectFilter === 'planes'
                    ? 'No planes yet. Use Plane to offset one from a plane or face.'
                    : objectFilter === 'axes'
                      ? 'No axes yet. Use Axis to run one through points, an edge or a cylinder.'
                      : 'No sketches yet. Start a sketch on a plane or face.'}
          </p>
        )}
        {showBodies &&
          (treeShown
            ? renderFolderChildren(null, 0)
            : liveBodies.map((body) => renderBodyRow(body)))}
        {drag && treeShown && (
          // Only while dragging: the way out of every folder.
          <div
            role="listitem"
            className={`object-drop-root${dropTarget === ROOT_DROP ? ' drop-target' : ''}`}
            {...dropZone(null)}
          >
            Move to top level
          </div>
        )}
        {showSketches &&
          sketches.map((sketch) => {
            if (sketch.data.featureKind !== 'sketch') return null;
            const sketchId = sketch.data.sketchId;
            const hidden = hiddenSketchIds.has(sketchId);
            const selected =
              selectedFeatureNodeId === sketch.id ||
              selectedSketchProfileId === sketchId;
            return (
              <div
                key={sketch.id}
                className={`object-row${selected ? ' selected' : ''}${hidden ? ' hidden-body' : ''}${sketchArrivals.has(sketch.id) ? ' is-arrival' : ''}`}
                role="listitem"
              >
                <button
                  type="button"
                  className="body-row-main"
                  aria-pressed={selected}
                  title={`${sketch.name} — click to select sketch`}
                  onClick={() => onSelectFeature(sketch.id)}
                >
                  <span className="feature-icon">
                    <PenLine size={13} aria-hidden="true" />
                  </span>
                  <span className="feature-name">{sketch.name}</span>
                </button>
                <button
                  type="button"
                  className={`row-visibility${hidden ? ' is-hidden' : ''}`}
                  title={
                    hidden
                      ? `Show sketch ${sketch.name}`
                      : `Hide sketch ${sketch.name}`
                  }
                  aria-label={
                    hidden
                      ? `Show sketch ${sketch.name}`
                      : `Hide sketch ${sketch.name}`
                  }
                  aria-pressed={hidden}
                  onClick={() => onToggleSketchVisibility(sketchId)}
                >
                  {hidden ? (
                    <EyeOff size={12} aria-hidden="true" />
                  ) : (
                    <Eye size={12} aria-hidden="true" />
                  )}
                </button>
              </div>
            );
          })}
        {planes.map((plane) => {
          const hidden = hiddenDatumIds?.has(plane.featureId) ?? false;
          const selected = selectedFeatureNodeId === plane.nodeId;
          const noun = plane.datum === 'axis' ? 'axis' : 'plane';
          const used =
            plane.dependents.length === 0
              ? 'Not used yet'
              : `Used by ${plane.dependents.join(', ')}`;
          return (
            <div
              key={plane.nodeId}
              className={`object-row${selected ? ' selected' : ''}${hidden ? ' hidden-body' : ''}`}
              role="listitem"
            >
              <button
                type="button"
                className="body-row-main"
                aria-pressed={selected}
                aria-description={`${plane.description ?? `Datum ${noun}`}. ${used}.`}
                title={`${plane.name} — ${plane.description ?? `datum ${noun}`} · ${used}`}
                onClick={() => onSelectFeature(plane.nodeId)}
              >
                <span className="feature-icon">
                  {plane.datum === 'axis' ? (
                    <Axis3d size={13} aria-hidden="true" />
                  ) : (
                    <SquareDashed size={13} aria-hidden="true" />
                  )}
                </span>
                <span className="feature-name">{plane.name}</span>
                {plane.suppressed ? (
                  <span className="feature-flag">suppressed</span>
                ) : !plane.resolved && !geometryPending ? (
                  <span className="feature-flag error">unresolved</span>
                ) : plane.dependents.length > 0 ? (
                  <span className="feature-flag">
                    {plane.dependents.length} use
                    {plane.dependents.length === 1 ? '' : 's'}
                  </span>
                ) : null}
              </button>
              {onHiddenDatumIdsChange ? (
                <button
                  type="button"
                  className={`row-visibility${hidden ? ' is-hidden' : ''}`}
                  title={
                    hidden
                      ? `Show ${noun} ${plane.name}`
                      : `Hide ${noun} ${plane.name}`
                  }
                  aria-label={
                    hidden
                      ? `Show ${noun} ${plane.name}`
                      : `Hide ${noun} ${plane.name}`
                  }
                  aria-pressed={hidden}
                  onClick={() => {
                    const next = new Set(hiddenDatumIds);
                    if (hidden) next.delete(plane.featureId);
                    else next.add(plane.featureId);
                    onHiddenDatumIdsChange(next);
                  }}
                >
                  {hidden ? (
                    <EyeOff size={12} aria-hidden="true" />
                  ) : (
                    <Eye size={12} aria-hidden="true" />
                  )}
                </button>
              ) : null}
            </div>
          );
        })}
        {showBodies && consumedBodies.length > 0 && (
          <div role="listitem">
            <button
              type="button"
              className="consumed-toggle"
              aria-expanded={showConsumed}
              onClick={() => setShowConsumed((current) => !current)}
              title={
                showConsumed
                  ? 'Hide the earlier bodies this model was built from'
                  : 'Show the earlier bodies this model was built from — each was combined into a later feature and is no longer separate'
              }
            >
              <ChevronRight
                size={12}
                className="disclosure-chevron"
                aria-hidden="true"
              />
              <span>
                {consumedBodies.length} source{' '}
                {consumedBodies.length === 1 ? 'body' : 'bodies'}
              </span>
            </button>
          </div>
        )}
        {showBodies &&
          showConsumed &&
          consumedBodies.map((body) => renderBodyRow(body))}
      </div>
    </>
  );
}
