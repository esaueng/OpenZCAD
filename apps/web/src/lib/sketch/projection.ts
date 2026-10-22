import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  createSketchFeatureIds,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  projectEdgeToSketch,
  projectableCurveFromTopology,
  type PlaneBasis
} from '@openzcad/geometry';
import type {
  DerivedState,
  EdgeTopology,
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

function sameSource(
  a: SketchProjectionSource | undefined,
  b: SketchProjectionSource | undefined
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.bodyId === b.bodyId &&
    a.edgeReference.producingFeatureId === b.edgeReference.producingFeatureId &&
    a.edgeReference.lineageName === b.edgeReference.lineageName
  );
}

/**
 * The linked sources a sketch already projects, so a pick does not repeat
 * one. A re-pick leaves out the object being repaired: its own source is
 * the one being replaced.
 */
function linkedSources(
  document: ProjectDocument,
  sketch: SketchNode | null,
  except?: string
): SketchProjectionSource[] {
  return (sketch?.objectIds ?? []).flatMap((objectId) => {
    if (objectId === except) return [];
    const node = document.nodes[objectId];
    const projection =
      node?.kind === 'sketch-object' ? node.data.projection : undefined;
    return projection?.mode === 'linked' ? [projection.source] : [];
  });
}

/** The published edges a pick names: one edge, or a face's boundary. */
function pickedEdges(
  document: ProjectDocument,
  selection: TopologySelection
): EdgeTopology[] {
  const edges =
    document.derived.bodyRepresentations[selection.bodyId]?.topology?.edges ??
    [];
  if (selection.kind === 'edge') {
    const edge = edges.find((candidate) =>
      selection.topologyId !== undefined
        ? candidate.topologyId === selection.topologyId
        : candidate.hash === selection.hash
    );
    return edge ? [edge] : [];
  }
  if (selection.kind === 'face' && selection.hash !== undefined) {
    return edges.filter(
      (edge) =>
        edge.displayRole !== 'seam' &&
        edge.adjacentFaceHashes?.includes(selection.hash!) === true
    );
  }
  return [];
}

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
  const { document, selection, basis, mode, construction } = input;
  if (selection.kind === 'body') {
    throw new Error('Pick a model edge, or a face for its whole boundary.');
  }
  const edges = pickedEdges(document, selection);
  if (edges.length === 0) {
    throw new Error(
      selection.kind === 'face'
        ? 'That face has no boundary edges to project.'
        : 'That edge is no longer part of the model.'
    );
  }
  const existing = linkedSources(document, input.sketch, input.repairing);
  const objects: SketchObjectData[] = [];
  const skipped: string[] = [];
  for (const edge of edges) {
    const source = edge.reference
      ? { bodyId: selection.bodyId, edgeReference: edge.reference }
      : undefined;
    if (mode === 'linked' && !source) {
      skipped.push(
        'an edge has no verified identity, so it cannot stay linked (project it unlinked instead)'
      );
      continue;
    }
    if (
      mode === 'linked' &&
      existing.some((entry) => sameSource(entry, source))
    ) {
      skipped.push('an edge is already projected linked into this sketch');
      continue;
    }
    const outcome = projectEdgeToSketch(
      projectableCurveFromTopology(edge),
      basis
    );
    if (outcome.status === 'refused') {
      skipped.push(outcome.reason.replace(/\.$/, ''));
      continue;
    }
    const projection: SketchProjection =
      mode === 'linked'
        ? { mode: 'linked', source: source! }
        : { mode: 'unlinked', ...(source ? { source } : {}) };
    objects.push({
      ...outcome.data,
      ...(construction ? { construction: true } : {}),
      projection
    });
  }
  if (objects.length === 0) {
    throw new Error(`Nothing to project: ${[...new Set(skipped)].join('; ')}.`);
  }
  return { objects, skipped: [...new Set(skipped)] };
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
    const node = document.nodes[objectId];
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
  const { construction: _ignored, ...geometry } = replacement;
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
    const node = document.nodes[objectId];
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
 * Refuses a candidate unless the exact build re-found every new linked
 * projection at the sketch's place in the history (current, or moved, which
 * the build follows). Broken — an edge made by a later feature, say — is
 * refused naming why; no verdict at all (the sketch is suppressed, or its
 * plane failed before projection ran) is refused too, since nothing then
 * proved the edge exists there.
 */
export function assertProjectionsResolve(
  derived: Pick<DerivedState, 'sketchProjections'>,
  objectIds: readonly string[]
): void {
  for (const objectId of objectIds) {
    const state = derived.sketchProjections?.[objectId];
    if (state?.status === 'broken') {
      throw new Error(
        `That edge cannot be projected linked here: ${state.reason.replace(/^its /, 'the ')}`
      );
    }
    if (!state) {
      throw new Error(
        'That edge cannot be projected linked here: the sketch did not build, so nothing confirmed the edge at its place in the history. Resume or repair the sketch first, or project it unlinked.'
      );
    }
  }
}
