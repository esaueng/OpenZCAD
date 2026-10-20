import { useState, type Dispatch, type SetStateAction } from 'react';
import {
  Axis3d,
  Box,
  ChevronRight,
  Combine,
  Eye,
  EyeOff,
  FileBox,
  Layers,
  Move3d,
  PenLine,
  RotateCw,
  Search,
  SquareDashed
} from 'lucide-react';
import type { BodyRepresentation } from '@openzcad/shared';
import { useArrivals } from '../../hooks/useArrivals';
import { datumPlaneRows } from '../../lib/datumPlanes';
import { datumAxisRows } from '../../lib/datumAxes';
import type { ModelPanelSource } from './modelPanelProps';

/** What the Objects list is built from, and all its header count needs. */
export type ObjectsSource = Pick<
  ModelPanelSource,
  'features' | 'representations' | 'document' | 'parameterValues'
>;

/**
 * The Objects list's type filter, name search and source-body disclosure,
 * held by the panel's frame around the list.
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
    ModelPanelSource,
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
  > & { view: ObjectsView };

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

function modelDatums({
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
  view
}: ObjectsPanelProps) {
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
  const filteredCount =
    (showBodies ? matchingBodies.length : 0) +
    (showSketches ? sketches.length : 0) +
    planes.length;

  function renderBodyRow(body: BodyRepresentation) {
    const hidden = hiddenBodyIds.has(body.bodyId);
    const selected = selectedBodyIds.includes(body.bodyId);
    return (
      <div
        key={body.bodyId}
        className={`body-row ${selected ? 'selected' : ''} ${body.consumed ? 'consumed' : ''} ${hidden ? 'hidden-body' : ''}${bodyArrivals.has(body.bodyId) ? ' is-arrival' : ''}`}
        role="listitem"
      >
        <button
          type="button"
          className="body-row-main"
          aria-pressed={selected}
          title={`${body.name}${body.consumed ? ' — combined into a later feature' : ''} — click to select, ⇧click to add`}
          onClick={(event) =>
            onSelectBody(
              body.bodyId,
              event.shiftKey || event.metaKey || event.ctrlKey
            )
          }
        >
          <span className="feature-icon">{bodyIcon(body)}</span>
          <span className="feature-name">{body.name}</span>
        </button>
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
        {showBodies && liveBodies.map(renderBodyRow)}
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
        {showBodies && showConsumed && consumedBodies.map(renderBodyRow)}
      </div>
    </>
  );
}
