import {
  projectEdgeToSketch,
  projectableCurveFromTopology,
  type PlaneBasis
} from '@openzcad/geometry';
import type {
  EdgeTopology,
  SketchObjectData,
  TopologySelection
} from '@openzcad/shared';

/**
 * I01: the published edges a Project pick names — one edge, or a face's
 * whole boundary less its seams. The projection that commits and the
 * viewport's hover over the Project tool both read a pick through this, so
 * what the hover lights is what the pick would project.
 */
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

/**
 * Whether a re-pick would take this pick as the projected object's new
 * source: it must name exactly one edge (a face with several boundary
 * edges projects several objects), that edge must project onto the sketch
 * plane, and it must project to the same kind of curve the object is —
 * the same rules the re-pick's commit enforces (`repickedProjectionData`).
 */
export function projectionRepickAccepts(input: {
  edges: readonly EdgeTopology[];
  selection: Pick<TopologySelection, 'kind' | 'topologyId' | 'hash'>;
  basis: PlaneBasis;
  objectKind: SketchObjectData['objectKind'];
}): boolean {
  const named = projectionPickEdges(input.edges, input.selection);
  if (named.length !== 1) return false;
  const outcome = projectEdgeToSketch(
    projectableCurveFromTopology(named[0]!),
    input.basis
  );
  return (
    outcome.status !== 'refused' && outcome.data.objectKind === input.objectKind
  );
}

/**
 * Whether a Project pick projects anything onto the sketch plane: at least
 * one edge it names lies in a direction the plane can show (an edge seen
 * end-on projects to a point and is left out, as an unsupported curve is).
 */
export function projectionPickProjects(input: {
  edges: readonly EdgeTopology[];
  selection: Pick<TopologySelection, 'kind' | 'topologyId' | 'hash'>;
  basis: PlaneBasis;
}): boolean {
  return projectionPickEdges(input.edges, input.selection).some(
    (edge) =>
      projectEdgeToSketch(projectableCurveFromTopology(edge), input.basis)
        .status !== 'refused'
  );
}
