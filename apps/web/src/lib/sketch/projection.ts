import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  createSketchFeatureIds,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { orientLikeStored, type PlaneBasis } from '@openzcad/geometry';
import { ownEntry } from '@openzcad/shared';
import {
  documentPickEdges,
  projectionPickOutcome,
  sameProjectionSource
} from './projectionPickEdges';
import type {
  DerivedState,
  EntityId,
  ProjectDocument,
  SketchId,
  SketchNode,
  SketchObjectData,
  SketchPlaneRef,
  SketchProjection,
  SketchProjectionMode,
  SketchProjectionSource,
  SketchProjectionState,
  TopologySelection
} from '@openzcad/shared';

/**
 * I01 sketch projection, browser side: turning a pick into projected sketch
 * objects, writing a moved linked projection back after the exact build
 * re-projected it, and describing each projection for History and Objects.
 * The exact build is the authority on where a linked projection is; nothing
 * here guesses a source edge from geometry.
 */

/** What a pick projected, and the edges it left out with the reason. */
export interface ProjectionPick {
  objects: SketchObjectData[];
  skipped: string[];
}

const sameSource = sameProjectionSource;

/** The published edges a pick names: one edge, or a face's boundary. */
const pickedEdges = documentPickEdges;

/**
 * Projects a picked edge, or each edge bounding a picked face, onto the
 * sketch plane. A linked projection needs the edge's verified schema-v5
 * reference; an edge without one is left out by name (it can still be
 * copied unlinked). Throws with the reason when nothing projects.
 */
export function projectionFromPick(input: {
  document: ProjectDocument;
  sketch: SketchNode | null;
  selection: TopologySelection;
  basis: PlaneBasis;
  mode: SketchProjectionMode;
  construction: boolean;
  /** A re-pick: the object whose source the pick replaces. */
  repairing?: string;
}): ProjectionPick {
  const { selection, mode, construction } = input;
  if (selection.kind === 'body') {
    throw new Error('Pick a model edge, or a face for its whole boundary.');
  }
  const { edges, added, skipped } = projectionPickOutcome(input);
  if (edges.length === 0) {
    throw new Error(
      selection.kind === 'face'
        ? 'That face has no boundary edges to project.'
        : 'That edge is no longer part of the model.'
    );
  }
  const objects: SketchObjectData[] = added.map(({ source, data }) => {
    const projection: SketchProjection =
      mode === 'linked'
        ? { mode: 'linked', source: source! }
        : { mode: 'unlinked', ...(source ? { source } : {}) };
    return {
      ...data,
      ...(construction ? { construction: true } : {}),
      projection
    };
  });
  if (objects.length === 0) {
    throw new Error(`Nothing to project: ${skipped.join('; ')}.`);
  }
  return { objects, skipped };
}

/** Acquire idle-skipped lineage once before accepting or refusing a linked pick. */
export async function projectionFromPickWithLineage(
  input: Parameters<typeof projectionFromPick>[0],
  control: {
    rebuildWithLineage(): Promise<ProjectDocument>;
    cancelled(): boolean;
  }
): Promise<ProjectionPick | null> {
  if (control.cancelled()) return null;
  let document = input.document;
  const edges = pickedEdges(document, input.selection);
  if (
    input.mode === 'linked' &&
    input.selection.kind !== 'body' &&
    (edges.length === 0 || edges.some((edge) => !edge.reference))
  ) {
    try {
      document = await control.rebuildWithLineage();
    } catch (error) {
      if (control.cancelled()) return null;
      throw error;
    }
  }
  if (control.cancelled()) return null;
  return projectionFromPick({ ...input, document });
}

/** The sketch an object belongs to, by its object list. */
function sketchOf(
  document: ProjectDocument,
  objectId: string
): SketchNode | undefined {
  return Object.values(document.nodes).find(
    (node): node is SketchNode =>
      node.kind === 'sketch' && node.objectIds.includes(objectId as EntityId)
  );
}

/**
 * Writes each linked projection the exact build moved back to its object,
 * as one normalization: the build already built from the re-projected
 * geometry, so this changes no model, only the stored copy every browser
 * view reads. An object no longer linked to the same source is left alone.
 * Null when nothing moved.
 */
export function projectionWriteBackCommand(
  document: ProjectDocument,
  derived: Pick<DerivedState, 'sketchProjections'>
): AnyCommand | null {
  const commands: AnyCommand[] = [];
  for (const [objectId, state] of Object.entries(
    derived.sketchProjections ?? {}
  )) {
    if (state.status !== 'moved') continue;
    const node = ownEntry(document.nodes, objectId);
    const sketch = sketchOf(document, objectId);
    const current = node?.kind === 'sketch-object' ? node.data : undefined;
    const moved = state.data.projection;
    if (
      !sketch ||
      !current ||
      current.projection?.mode !== 'linked' ||
      moved?.mode !== 'linked' ||
      !sameSource(current.projection.source, moved.source) ||
      current.objectKind !== state.data.objectKind
    ) {
      continue;
    }
    commands.push(
      commandFactories.updateSketchObject(
        {
          sketchId: sketch.sketchId,
          objectId: objectId as EntityId,
          data: {
            ...state.data,
            ...(current.construction ? { construction: true } : {}),
            projection: current.projection
          }
        },
        'Follow projected edge'
      )
    );
  }
  if (commands.length === 0) return null;
  return commands.length === 1
    ? commands[0]!
    : composeCommands('Follow projected edges', commands);
}

/** The object as an independent copy: same geometry, link dropped. */
export function unlinkedProjectionData(
  data: SketchObjectData
): SketchObjectData {
  const projection = data.projection;
  if (!projection || projection.mode === 'unlinked') return data;
  return {
    ...data,
    projection: { mode: 'unlinked', source: projection.source }
  };
}

/**
 * The repaired object after an explicit re-pick: the replacement edge's
 * projection, linked to its verified source, on the same object id so every
 * relation and profile that names the object keeps it. The replacement must
 * project to the same kind of curve.
 */
export function repickedProjectionData(
  current: SketchObjectData,
  replacement: SketchObjectData
): SketchObjectData {
  if (replacement.objectKind !== current.objectKind) {
    throw new Error(
      `Re-pick an edge that projects to a ${current.objectKind}; that one projects to a ${replacement.objectKind}.`
    );
  }
  if (replacement.projection?.mode !== 'linked') {
    throw new Error('A re-picked source must keep a verified identity.');
  }
  // The object keeps its own construction role, whatever the pick carried.
  const oriented =
    replacement.objectKind === 'line'
      ? orientLikeStored(current, replacement)
      : replacement;
  const { construction: _ignored, ...geometry } = oriented;
  return current.construction ? { ...geometry, construction: true } : geometry;
}

/** How U06 (History and Objects) names one projected object. */
export interface SketchProjectionRow {
  sketchId: SketchId;
  objectId: string;
  objectKind: SketchObjectData['objectKind'];
  mode: SketchProjectionMode;
  /** "Block" — the feature that produced the source edge, when known. */
  sourceName: string | null;
  /** Linked only: what the last exact build found; absent while pending. */
  state?: SketchProjectionState['status'];
  reason?: string;
}

/** The feature name an edge reference was produced by, if it still exists. */
export function projectionSourceName(
  document: ProjectDocument,
  source: SketchProjectionSource | undefined
): string | null {
  if (!source) return null;
  return (
    listFeaturesInOrder(document).find(
      (feature) => feature.featureId === source.edgeReference.producingFeatureId
    )?.name ?? null
  );
}

/** Every projected object of a sketch, in the sketch's object order. */
export function sketchProjectionRows(
  document: ProjectDocument,
  sketch: SketchNode
): SketchProjectionRow[] {
  return sketch.objectIds.flatMap((objectId) => {
    const node = ownEntry(document.nodes, objectId);
    if (node?.kind !== 'sketch-object' || !node.data.projection) return [];
    const projection = node.data.projection;
    const state =
      projection.mode === 'linked'
        ? document.derived.sketchProjections?.[objectId]
        : undefined;
    return [
      {
        sketchId: sketch.sketchId,
        objectId,
        objectKind: node.data.objectKind,
        mode: projection.mode,
        sourceName: projectionSourceName(document, projection.source),
        ...(state ? { state: state.status } : {}),
        ...(state?.status === 'broken' ? { reason: state.reason } : {})
      }
    ];
  });
}

/** One line for a projected object: its role and where it came from. */
export function projectionRoleLabel(row: SketchProjectionRow): string {
  const from = row.sourceName ? ` from ${row.sourceName}` : '';
  if (row.mode === 'unlinked') return `Independent copy${from}`;
  return row.state === 'broken' ? `Linked${from} · broken` : `Linked${from}`;
}

/** Sketch ids with at least one broken linked projection. */
export function sketchesWithBrokenProjections(
  document: ProjectDocument
): Set<SketchId> {
  const broken = new Set<SketchId>();
  const states = document.derived.sketchProjections ?? {};
  for (const [objectId, state] of Object.entries(states)) {
    if (state.status !== 'broken') continue;
    const sketch = sketchOf(document, objectId);
    if (sketch) broken.add(sketch.sketchId);
  }
  return broken;
}

/**
 * The command that adds a pick's projected objects: to the session's sketch,
 * or as a new sketch when the session has none yet. Object ids are assigned
 * up front so the exact build's verdict on each can be read back.
 */
export function projectionAddCommand(input: {
  sketchId: SketchId | null;
  newSketch?: { name: string; planeRef: SketchPlaneRef };
  objects: SketchObjectData[];
  mode: SketchProjectionMode;
}): { command: AnyCommand; objectIds: EntityId[]; sketchId: SketchId } {
  const count = input.objects.length;
  const label = `Project ${count} ${count === 1 ? 'edge' : 'edges'}${input.mode === 'unlinked' ? ' (unlinked)' : ''}`;
  if (input.sketchId) {
    const objectIds = createSketchFeatureIds(count).objectNodeIds;
    return {
      command: commandFactories.addSketchObjects(
        {
          sketchId: input.sketchId,
          objects: input.objects,
          ids: { objectNodeIds: objectIds }
        },
        label
      ),
      objectIds,
      sketchId: input.sketchId
    };
  }
  if (!input.newSketch) {
    throw new Error('A projection needs a sketch to land in.');
  }
  const ids = createSketchFeatureIds(count);
  return {
    command: commandFactories.addSketch({
      ...input.newSketch,
      objects: input.objects,
      ids
    }),
    objectIds: ids.objectNodeIds,
    sketchId: ids.sketchId
  };
}

/**
 * The exact build's reason when a linked projection's source body does not
 * exist yet at the sketch's place in the history: the edge belongs to a
 * feature after the sketch (packages/kernel-adapter's
 * exact-sketch-projection.ts). The picked geometry is real in the model the
 * user clicked, so an unlinked copy of it builds.
 */
const SOURCE_UNAVAILABLE =
  /^its source body is unavailable at the sketch's place in the history \(source feature "(.*)"\)\.$/;

/**
 * The refusal for a later feature's edge, recovery first: the workspace
 * toast is one line on desktop and cuts the rest off, so the Project tool's
 * Unlinked mode leads and the cause, naming the feature, follows.
 */
export function laterSourceRefusal(featureName: string): string {
  return `Switch Project to Unlinked and pick again: "${featureName}" is after this sketch, so it can't stay linked.`;
}

/**
 * Refuses a candidate unless the exact build re-found every new linked
 * projection at the sketch's place in the history (current, or moved, which
 * the build follows). Broken — an edge made by a later feature, say — is
 * refused naming why; no verdict at all (the sketch is suppressed, or its
 * plane failed before projection ran) is refused too, since nothing then
 * proved the edge exists there.
 *
 * A source that is unavailable at the sketch's place (a later feature's
 * edge) leads with the unlinked route, which builds. A re-pick does not:
 * it replaces a linked source on an existing object, and stepping Project
 * to Unlinked disarms it, so that route would add a copy rather than
 * repair the object.
 */
export function assertProjectionsResolve(
  derived: Pick<DerivedState, 'sketchProjections'>,
  objectIds: readonly string[],
  options: { repick?: boolean } = {}
): void {
  for (const objectId of objectIds) {
    const state = derived.sketchProjections?.[objectId];
    if (state?.status === 'broken') {
      const later = options.repick
        ? null
        : SOURCE_UNAVAILABLE.exec(state.reason);
      throw new Error(
        later
          ? laterSourceRefusal(later[1]!)
          : `That edge cannot be projected linked here: ${state.reason.replace(/^its /, 'the ')}`
      );
    }
    if (!state) {
      throw new Error(
        'That edge cannot be projected linked here: the sketch did not build, so nothing confirmed the edge at its place in the history. Resume or repair the sketch first, or project it unlinked.'
      );
    }
  }
}
