import {
  projectEdgeToSketch,
  projectableCurveFromTopology,
  type PlaneBasis,
  type SketchProjectionGeometry
} from '@openzcad/geometry';
import { ownEntry } from '@openzcad/shared';
import type {
  EdgeTopology,
  ProjectDocument,
  SketchNode,
  SketchObjectData,
  SketchProjectionMode,
  SketchProjectionSource,
  TopologySelection
} from '@openzcad/shared';

/**
 * I01: what a Project pick would add to the sketch. The commit
 * (`projectionFromPick`) and the viewport's hover over the Project tool both
 * read a pick through `projectionPickOutcome`, so the hover lights a pick
 * exactly when the click would be accepted for it.
 */

/** Whether two linked sources name the same model edge. */
export function sameProjectionSource(
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
    const node = ownEntry(document.nodes, objectId);
    const projection =
      node?.kind === 'sketch-object' ? node.data.projection : undefined;
    return projection?.mode === 'linked' ? [projection.source] : [];
  });
}

/** The published edges a pick names: one edge, or a face's boundary. */
export function projectionPickEdges(
  edges: readonly EdgeTopology[],
  selection: Pick<TopologySelection, 'kind' | 'topologyId' | 'hash'>
): EdgeTopology[] {
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

/** The published edges a pick names, read from the document's topology. */
export function documentPickEdges(
  document: ProjectDocument,
  selection: TopologySelection
): EdgeTopology[] {
  return projectionPickEdges(
    ownEntry(document.derived.bodyRepresentations, selection.bodyId)?.topology
      ?.edges ?? [],
    selection
  );
}

export interface ProjectionPickInput {
  document: ProjectDocument;
  sketch: SketchNode | null;
  selection: TopologySelection;
  basis: PlaneBasis;
  mode: SketchProjectionMode;
  /** A re-pick: the object whose source the pick replaces. */
  repairing?: string;
  /**
   * The hover's view of a linked pick: an edge whose verified identity has
   * not been published yet counts as projecting, since the click acquires
   * it before deciding. The commit leaves this off and skips such an edge.
   */
  lineagePending?: boolean;
}

/** One edge a pick would add, with its projection onto the plane. */
export interface ProjectionPickEdge {
  edge: EdgeTopology;
  source: SketchProjectionSource | undefined;
  data: SketchProjectionGeometry;
}

/**
 * The edges a pick would add to the sketch, in pick order, after every rule
 * the commit applies: a linked pick leaves out an edge without a verified
 * identity and one the sketch already follows (except the object being
 * re-picked), and any pick leaves out an edge that does not project onto
 * the plane. `skipped` names each reason once.
 */
export function projectionPickOutcome(input: ProjectionPickInput): {
  edges: EdgeTopology[];
  added: ProjectionPickEdge[];
  skipped: string[];
} {
  const { document, selection, basis, mode } = input;
  const edges =
    selection.kind === 'body' ? [] : documentPickEdges(document, selection);
  const existing =
    mode === 'linked'
      ? linkedSources(document, input.sketch, input.repairing)
      : [];
  const added: ProjectionPickEdge[] = [];
  const skipped: string[] = [];
  for (const edge of edges) {
    const source = edge.reference
      ? { bodyId: selection.bodyId, edgeReference: edge.reference }
      : undefined;
    if (mode === 'linked' && !source && !input.lineagePending) {
      skipped.push(
        'an edge has no verified identity, so it cannot stay linked (project it unlinked instead)'
      );
      continue;
    }
    if (
      mode === 'linked' &&
      existing.some((entry) => sameProjectionSource(entry, source))
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
    added.push({ edge, source, data: outcome.data });
  }
  return { edges, added, skipped: [...new Set(skipped)] };
}

/** Whether a Project pick would add anything to the sketch. */
export function projectionPickProjects(input: ProjectionPickInput): boolean {
  return projectionPickOutcome(input).added.length > 0;
}

/**
 * Whether a re-pick would take this pick as the repaired object's new
 * source: after the commit's own filtering it adds exactly one edge (a face
 * whose other boundary edges the sketch already follows qualifies), that
 * edge is not one another object already follows, and it projects to the
 * same kind of curve the object is (`repickedProjectionData`).
 */
export function projectionRepickAccepts(
  input: Omit<ProjectionPickInput, 'mode' | 'repairing'> & {
    repairing: string;
    objectKind: SketchObjectData['objectKind'];
  }
): boolean {
  const { added } = projectionPickOutcome({ ...input, mode: 'linked' });
  return added.length === 1 && added[0]!.data.objectKind === input.objectKind;
}
