/**
 * M14 gear edge names: an edge of a gear body is named from the two faces it
 * lies between, `gear.edge.between.<face>|<face>`, the two face names in
 * string order. A gear names every face from its role (`gear.face.cap.start`,
 * `gear.face.collar.end`, `gear.face.tooth[3].tip`, a carried body face), so
 * the pair says which edge is meant however an edit moves or resizes it: the
 * rim between a cap and its collar is that rim at any span, offset, module or
 * tooth count that leaves both faces standing.
 *
 * Nothing here is matched by position. An edge is named only when the result
 * solid's own topology puts it between exactly two faces, both of them named
 * and each name held by one face. Where one pair of faces shares several
 * edges, no one of them is "the" edge between the two: each is
 * `….piece.<i>.of.<n>`, counted along the gear's axis, and the count is part
 * of the name, so a reference to one of two pieces never resolves to the
 * single edge an edit leaves, or the reverse.
 *
 * Pieces at one height are not counted and stay unnamed. Around the axis
 * there is no origin that every edit leaves alone (the gear's x direction is
 * a parameter, and the blank can be turned under the teeth), so an angular
 * count could hand one piece's name to its neighbour. The case that arises is
 * a collar's seam cutting the arc the collar shares with a flush tooth tip in
 * two; both halves are smooth edges no fillet or chamfer applies to. Seams,
 * which bound one face twice, are unnamed as on every other body.
 */
import type { EdgeWitnessV1, FeatureId } from '@openzcad/shared';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';

import { topologyCandidatesForSolid } from './exact-lineage-builders';
import {
  createRemusSemanticLineage,
  mergeRemusLineageStates,
  type RemusLineageState,
  type RemusSemanticAssignment,
  type RemusTopologyCandidate
} from './remus-lineage';
import type { RemusKernel } from './remus-runtime';
import { inspectTopologyWitness } from './topology-lineage';

type Vector = readonly [number, number, number];

/**
 * A point on the gear's axis and the axis direction. Only the order of
 * several edges between one pair of faces reads it.
 */
export interface GearEdgeFrame {
  readonly origin: Vector;
  readonly axis: Vector;
}

/**
 * Pieces this close along the axis (document units) stand at one height,
 * and nothing tells them apart.
 */
const AXIAL_MARGIN = 1e-6;

/** A frame from a point on the gear's axis and its direction, or null. */
export function gearEdgeFrame(
  origin: Vector,
  axis: Vector
): GearEdgeFrame | null {
  const size = Math.hypot(axis[0], axis[1], axis[2]);
  return size > 0 && Number.isFinite(size)
    ? { origin, axis: [axis[0] / size, axis[1] / size, axis[2] / size] }
    : null;
}

/**
 * How far along the axis an edge stands: half way between its ends, or a
 * closed edge's centre. Not the witness's midpoint, which for an arc that
 * ends on a cylinder's seam the kernel reports on the far side of its circle.
 */
function edgeHeight(witness: EdgeWitnessV1, frame: GearEdgeFrame): number {
  const point = witness.closed
    ? witness.center
    : witness.endpoints[0].map(
        (component, index) => (component + witness.endpoints[1][index]!) / 2
      );
  return point.reduce(
    (height, component, index) =>
      height +
      (component * GEOMETRY_LINEAR_TOLERANCE - frame.origin[index]!) *
        frame.axis[index]!,
    0
  );
}

/**
 * The order of several edges between one pair of faces along the gear's
 * axis: the pieces' indices, lowest first. Null when two pieces stand at one
 * height, or when there is no frame.
 */
export function orderGearEdgePieces(
  pieces: readonly EdgeWitnessV1[],
  frame: GearEdgeFrame | null
): number[] | null {
  if (!frame || pieces.length < 2) return null;
  const placed = pieces.map((piece, index) => ({
    index,
    height: edgeHeight(piece, frame)
  }));
  if (placed.some(({ height }) => !Number.isFinite(height))) return null;
  placed.sort((left, right) => left.height - right.height);
  for (let index = 1; index < placed.length; index += 1) {
    if (placed[index]!.height - placed[index - 1]!.height <= AXIAL_MARGIN) {
      return null;
    }
  }
  return placed.map(({ index }) => index);
}

/**
 * The edge names for a gear body, from each edge's two faces.
 *
 * `facesOfEdge` lists the distinct faces of the solid each edge bounds and
 * `faceNames` the lineage name each face publishes. An edge between anything
 * but two differently named faces, each name held by one face, is left out,
 * as is an edge whose exact witness cannot carry a name (a closed spline).
 */
export function gearEdgeAssignments(input: {
  readonly edges: readonly RemusTopologyCandidate[];
  readonly facesOfEdge: ReadonlyMap<number, readonly number[]>;
  readonly faceNames: ReadonlyMap<number, string>;
  readonly frame: GearEdgeFrame | null;
}): RemusSemanticAssignment[] {
  const nameUse = new Map<string, number>();
  for (const name of input.faceNames.values()) {
    nameUse.set(name, (nameUse.get(name) ?? 0) + 1);
  }
  const byPair = new Map<string, RemusTopologyCandidate[]>();
  for (const edge of input.edges) {
    if (edge.kind !== 'edge') continue;
    const faces = input.facesOfEdge.get(edge.handle) ?? [];
    if (faces.length !== 2) continue;
    const [first, second] = faces.map((face) => input.faceNames.get(face));
    if (
      first === undefined ||
      second === undefined ||
      first === second ||
      nameUse.get(first) !== 1 ||
      nameUse.get(second) !== 1
    ) {
      continue;
    }
    const pair = first < second ? `${first}|${second}` : `${second}|${first}`;
    byPair.set(pair, [...(byPair.get(pair) ?? []), edge]);
  }
  const assignments: RemusSemanticAssignment[] = [];
  for (const [pair, edges] of byPair) {
    const witnesses = edges.map((edge) => edge.witness as EdgeWitnessV1);
    // One unreadable piece leaves the count of the rest unknown.
    if (
      witnesses.some(
        (witness) =>
          inspectTopologyWitness('edge', witness).status !== 'supported'
      )
    ) {
      continue;
    }
    if (edges.length === 1) {
      assignments.push({
        ...edges[0]!,
        lineageName: `gear.edge.between.${pair}`
      });
      continue;
    }
    const order = orderGearEdgePieces(witnesses, input.frame);
    if (!order) continue;
    order.forEach((piece, position) => {
      assignments.push({
        ...edges[piece]!,
        lineageName: `gear.edge.between.${pair}.piece.${position}.of.${order.length}`
      });
    });
  }
  return assignments;
}

/**
 * `faces`, the gear body's face lineage, with every edge that lies between
 * two of its named faces named from them. Face names are untouched.
 */
export function withGearEdgeLineage(
  kernel: RemusKernel,
  solid: number,
  producer: FeatureId,
  faces: RemusLineageState,
  frame: GearEdgeFrame | null
): RemusLineageState {
  const facesOfEdge = new Map<number, number[]>();
  for (const face of kernel.getSolidFaces(solid)) {
    for (const edge of new Set(kernel.getFaceEdges(face))) {
      const bounded = facesOfEdge.get(edge) ?? [];
      bounded.push(face);
      facesOfEdge.set(edge, bounded);
    }
  }
  const assignments = gearEdgeAssignments({
    edges: topologyCandidatesForSolid(kernel, solid).filter(
      (candidate) => candidate.kind === 'edge'
    ),
    facesOfEdge,
    faceNames: new Map(
      Array.from(faces.faceReferences, ([handle, reference]) => [
        handle,
        reference.lineageName
      ])
    ),
    frame
  });
  return mergeRemusLineageStates([
    faces,
    createRemusSemanticLineage(producer, 'primitive', assignments)
  ]);
}
