import type {
  FaceTopologyReferenceV5,
  FaceWitnessV1,
  FeatureId
} from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import type { HoleToolSpec } from './exact-cylinder-ops';
import {
  cylinderCarrier,
  planeCarrier,
  sameAnalyticCarrier,
  topologyCandidatesForSolid
} from './exact-lineage-builders';
import {
  createRemusSemanticLineage,
  mergeRemusLineageStates,
  type RemusLineageState,
  type RemusSemanticAssignment
} from './remus-lineage';
import {
  topologyHashOfWitness,
  topologyWitnessesEqual
} from './topology-lineage';
import {
  add,
  cross,
  dot,
  length,
  normalized,
  scale,
  subtract
} from './exact-math';
import { faceVertexCentroid } from './exact-brep';
import { GEOMETRY_LINEAR_TOLERANCE, type Vec3 } from '@openzcad/geometry';

/** Unique exact analytic carriers preserve face identity when only trims change. */
export function carryAnalyticFaces(
  kernel: RemusKernel,
  sourceSolid: number,
  resultSolid: number,
  source: RemusLineageState | undefined
): RemusLineageState {
  const state: RemusLineageState = {
    faceReferences: new Map(),
    edgeReferences: new Map(),
    diagnostics: []
  };
  if (!source) return state;
  const before = topologyCandidatesForSolid(kernel, sourceSolid).filter(
    (c) => c.kind === 'face'
  );
  const after = topologyCandidatesForSolid(kernel, resultSolid).filter(
    (c) => c.kind === 'face'
  );
  const identity = (r: FaceTopologyReferenceV5) =>
    JSON.stringify([r.producingFeatureId, r.lineageName]);
  for (const [handle, reference] of source.faceReferences) {
    const origin = before.find((c) => c.handle === handle);
    if (
      !origin ||
      reference.currentHash !==
        topologyHashOfWitness('face', reference.witness) ||
      !topologyWitnessesEqual('face', reference.witness, origin.witness) ||
      [...source.faceReferences.values()].filter(
        (r) => identity(r) === identity(reference)
      ).length !== 1
    )
      continue;
    const matchesWitness = (c: (typeof before)[number]) =>
      topologyWitnessesEqual('face', reference.witness, c.witness);
    let matches = after.filter(matchesWitness);
    if (before.filter(matchesWitness).length !== 1 || matches.length !== 1) {
      if (
        reference.witness.analytic.kind !== 'plane' &&
        reference.witness.analytic.kind !== 'cylinder'
      )
        continue;
      const matchesCarrier = (c: (typeof before)[number]) =>
        sameAnalyticCarrier(
          (c.witness as FaceWitnessV1).analytic,
          reference.witness.analytic
        );
      matches = after.filter(matchesCarrier);
      if (before.filter(matchesCarrier).length !== 1 || matches.length !== 1)
        continue;
    }
    const candidate = matches[0]!;
    const witness = candidate.witness as FaceWitnessV1;
    state.faceReferences.set(candidate.handle, {
      ...reference,
      witness,
      currentHash: topologyHashOfWitness('face', witness)
    });
  }
  return state;
}

/** Name a constructed face only when its exact carrier is unique in the result. */
export function assignCarrierFace(
  kernel: RemusKernel,
  solid: number,
  state: RemusLineageState,
  producer: FeatureId,
  name: string,
  carrier: FaceWitnessV1['analytic'] | null
): void {
  if (!carrier || carrier.kind === 'none') return;
  const matches = topologyCandidatesForSolid(kernel, solid).filter(
    (c) =>
      c.kind === 'face' &&
      sameAnalyticCarrier((c.witness as FaceWitnessV1).analytic, carrier)
  );
  if (matches.length !== 1 || state.faceReferences.has(matches[0]!.handle))
    return;
  const proven = createRemusSemanticLineage(producer, 'boolean', [
    { ...matches[0]!, lineageName: name }
  ]);
  for (const [handle, reference] of proven.faceReferences)
    state.faceReferences.set(handle, reference);
}

/**
 * A unique boundary between two named faces has a stable construction role.
 * Seams and repeated boundaries between the same pair remain unnamed.
 */
export function withBoundaryEdgeLineage(
  kernel: RemusKernel,
  solid: number,
  producer: FeatureId,
  source: RemusLineageState
): RemusLineageState {
  const candidates = topologyCandidatesForSolid(kernel, solid);
  const facesByEdge = new Map<number, number[]>();
  for (const face of kernel.getSolidFaces(solid)) {
    for (const edge of new Set(kernel.getFaceEdges(face))) {
      const faces = facesByEdge.get(edge) ?? [];
      faces.push(face);
      facesByEdge.set(edge, faces);
    }
  }
  const assignments: RemusSemanticAssignment[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== 'edge') continue;
    const faces = facesByEdge.get(candidate.handle) ?? [];
    if (faces.length !== 2) continue;
    const references = faces.map((face) => source.faceReferences.get(face));
    if (references.some((reference) => !reference)) continue;
    const verified = references as FaceTopologyReferenceV5[];
    if (
      verified.some(
        (reference) =>
          [...source.faceReferences.values()].filter(
            (other) =>
              other.producingFeatureId === reference.producingFeatureId &&
              other.lineageName === reference.lineageName
          ).length !== 1
      )
    )
      continue;
    const identities = verified
      .map((r) => JSON.stringify([r.producingFeatureId, r.lineageName]))
      .sort();
    if (identities[0] === identities[1]) continue;
    for (let i = 0; i < faces.length; i++) {
      const face = candidates.find(
        (c) => c.kind === 'face' && c.handle === faces[i]
      );
      if (
        !face ||
        !topologyWitnessesEqual('face', verified[i]!.witness, face.witness) ||
        verified[i]!.currentHash !==
          topologyHashOfWitness('face', verified[i]!.witness)
      ) {
        references.length = 0;
        break;
      }
    }
    if (references.length !== 2) continue;
    assignments.push({
      ...candidate,
      lineageName: `boundary.edge.${JSON.stringify(identities)}`
    });
  }
  // The semantic publisher rejects every repeated role, rather than choosing
  // an edge by traversal order or proximity.
  return mergeRemusLineageStates([
    createRemusSemanticLineage(producer, 'boolean', assignments),
    source
  ]);
}

export function holeLineage(
  kernel: RemusKernel,
  sourceSolid: number,
  resultSolid: number,
  source: RemusLineageState | undefined,
  producer: FeatureId,
  spec: HoleToolSpec
): RemusLineageState {
  const state = carryAnalyticFaces(kernel, sourceSolid, resultSolid, source);
  assignCarrierFace(
    kernel,
    resultSolid,
    state,
    producer,
    'hole.face.bore',
    cylinderCarrier(spec.surfacePoint, spec.axis, spec.radius)
  );
  if (
    spec.style === 'counterbore' &&
    spec.counterboreRadius !== undefined &&
    spec.counterboreDepth !== undefined
  ) {
    assignCarrierFace(
      kernel,
      resultSolid,
      state,
      producer,
      'hole.face.counterbore',
      cylinderCarrier(spec.surfacePoint, spec.axis, spec.counterboreRadius)
    );
    assignCarrierFace(
      kernel,
      resultSolid,
      state,
      producer,
      'hole.face.shoulder',
      planeCarrier(
        spec.axis,
        add(spec.surfacePoint, scale(spec.axis, spec.counterboreDepth))
      )
    );
  }
  if (spec.exitExtension === 0) {
    assignCarrierFace(
      kernel,
      resultSolid,
      state,
      producer,
      'hole.face.floor',
      planeCarrier(
        spec.axis,
        add(spec.surfacePoint, scale(spec.axis, spec.depth))
      )
    );
  }
  return withBoundaryEdgeLineage(kernel, resultSolid, producer, state);
}

/** A planar face read in its own orientation: outward normal and a point on it. */
interface OrientedPlane {
  normal: Vec3;
  point: Vec3;
}

/**
 * Sine of the largest angle two plane normals may differ by and still be one
 * carrier. Draft carriers are computed with a sine and cosine, so they cannot
 * match a quantised witness bit for bit; uniqueness, not closeness, names.
 */
const PARALLEL_SINE = 1e-9;

function orientedPlaneOf(
  kernel: RemusKernel,
  face: number
): OrientedPlane | null {
  try {
    const raw = kernel.getFaceNormal(face);
    const normal = normalized({
      x: Number(raw[0]),
      y: Number(raw[1]),
      z: Number(raw[2])
    });
    const point = faceVertexCentroid(kernel, face);
    if (
      !normal ||
      !point ||
      ![normal.x, normal.y, normal.z, point.x, point.y, point.z].every(
        Number.isFinite
      )
    )
      return null;
    return { normal, point };
  } catch {
    return null;
  }
}

function liesOnPlane(face: OrientedPlane, normal: Vec3, point: Vec3): boolean {
  return (
    length(cross(face.normal, normal)) <= PARALLEL_SINE &&
    Math.abs(dot(normal, subtract(face.point, point))) <=
      GEOMETRY_LINEAR_TOLERANCE
  );
}

/**
 * A source face's reference when it is evidence about that face: its stored
 * hash is its own witness's, the witness is the face's, and no other face in
 * the source carries the same identity.
 */
function verifiedSourceFace(
  source: RemusLineageState,
  handle: number,
  witness: FaceWitnessV1 | undefined
): FaceTopologyReferenceV5 | null {
  const reference = source.faceReferences.get(handle);
  if (
    !reference ||
    !witness ||
    reference.currentHash !==
      topologyHashOfWitness('face', reference.witness) ||
    !topologyWitnessesEqual('face', reference.witness, witness)
  )
    return null;
  let count = 0;
  for (const other of source.faceReferences.values()) {
    if (
      other.producingFeatureId === reference.producingFeatureId &&
      other.lineageName === reference.lineageName
    )
      count += 1;
  }
  return count === 1 ? reference : null;
}

function withoutFaces(
  source: RemusLineageState,
  handles: ReadonlySet<number>
): RemusLineageState {
  return {
    faceReferences: new Map(
      [...source.faceReferences].filter(([handle]) => !handles.has(handle))
    ),
    edgeReferences: new Map(),
    diagnostics: []
  };
}

function identityOf(reference: FaceTopologyReferenceV5): string {
  return JSON.stringify([reference.producingFeatureId, reference.lineageName]);
}

/**
 * Of several candidate carriers, the one result face that lies on exactly
 * one of them, or null. Any second match — a face on another candidate, or
 * two faces on the same one — leaves the face unnamed.
 */
function uniqueFaceOn(
  planes: ReadonlyMap<number, OrientedPlane>,
  carriers: readonly { normal: Vec3; point: Vec3 }[]
): number | null {
  const matches = new Set<number>();
  for (const carrier of carriers) {
    for (const [handle, plane] of planes) {
      if (liesOnPlane(plane, carrier.normal, carrier.point))
        matches.add(handle);
    }
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

/**
 * Every planar result face, measured, or null when any one cannot be: an
 * unmeasured face may lie on a constructed carrier, so a match that looks
 * unique among the others proves nothing.
 */
function resultPlanes(
  kernel: RemusKernel,
  candidates: readonly { handle: number; kind: string; witness: unknown }[]
): Map<number, OrientedPlane> | null {
  const planes = new Map<number, OrientedPlane>();
  for (const candidate of candidates) {
    if (
      candidate.kind !== 'face' ||
      (candidate.witness as FaceWitnessV1).surfaceType !== 'plane'
    )
      continue;
    const plane = orientedPlaneOf(kernel, candidate.handle);
    if (!plane) return null;
    planes.set(candidate.handle, plane);
  }
  return planes;
}

/** A plane carrier: a normal (either sense) and a point on it. */
interface Carrier {
  normal: Vec3;
  point: Vec3;
}

function sameCarrier(left: Carrier, right: Carrier): boolean {
  return liesOnPlane(left, right.normal, right.point);
}

/**
 * Whether a source face other than `handle` — named or not — could produce a
 * result face on one of `carriers`. A constructed name is evidence only when
 * its source alone can land there: if a coplanar unnamed patch could too, an
 * upstream edit that removes the named patch's result while the other one
 * survives would hand the name to the wrong face, and a saved reference
 * would bind to it instead of refusing.
 */
function contested(
  handle: number,
  carriers: readonly Carrier[],
  claims: ReadonlyMap<number, readonly Carrier[]>
): boolean {
  for (const [other, claimed] of claims) {
    if (other === handle) continue;
    if (claimed.some((claim) => carriers.some((c) => sameCarrier(claim, c))))
      return true;
  }
  return false;
}

/** Every planar source face, measured once, named or not. */
function sourcePlanes(
  kernel: RemusKernel,
  witnesses: ReadonlyMap<number, FaceWitnessV1>
): Map<number, OrientedPlane> | null {
  const planes = new Map<number, OrientedPlane>();
  for (const [handle, witness] of witnesses) {
    if (witness.surfaceType !== 'plane') continue;
    const plane = orientedPlaneOf(kernel, handle);
    // A planar face that cannot be measured could land anywhere.
    if (!plane) return null;
    planes.set(handle, plane);
  }
  return planes;
}

/**
 * Shell: the faces the shell kept outside carry their identity by exact
 * witness or unique carrier, as a hole's do. Two kinds of face are new, and
 * take a name the shell owns only when one result face alone lies on the
 * carrier the operation constructs for it:
 *
 * - `shell.face.rim.<source>`: the band left on an opening face's plane;
 * - `shell.face.inner.<source>`: the wall one thickness inside a kept planar
 *   face. The side is not assumed — both offsets are tried, and a face on
 *   either one, or two faces, leave the wall unnamed.
 *
 * Neither is named when another source face, named or not, could land on
 * the same carrier (`contested`).
 *
 * Edges between two named faces then take boundary roles, so a later fillet
 * or chamfer on a shelled body follows an upstream dimension edit by name
 * instead of by a geometry hash the edit moves.
 */
export function shellLineage(
  kernel: RemusKernel,
  sourceSolid: number,
  resultSolid: number,
  source: RemusLineageState | undefined,
  producer: FeatureId,
  openingFaces: readonly number[],
  thickness: number
): RemusLineageState | null {
  if (!source || !(Math.abs(thickness) > GEOMETRY_LINEAR_TOLERANCE))
    return null;
  const openings = new Set(openingFaces);
  const carried = carryAnalyticFaces(
    kernel,
    sourceSolid,
    resultSolid,
    withoutFaces(source, openings)
  );
  const sourceWitnesses = new Map(
    topologyCandidatesForSolid(kernel, sourceSolid)
      .filter((c) => c.kind === 'face')
      .map((c) => [c.handle, c.witness as FaceWitnessV1])
  );
  const candidates = topologyCandidatesForSolid(kernel, resultSolid);
  // Every planar face counts against uniqueness, named or not; only an
  // unnamed one can take the constructed name.
  const planes = resultPlanes(kernel, candidates);
  const assignments: RemusSemanticAssignment[] = [];
  // An unmeasurable source or result plane could sit on any carrier: name
  // nothing new, but still publish what was carried.
  const measured = sourcePlanes(kernel, sourceWitnesses);
  // What each planar source face can become: an opening leaves a rim on
  // its own plane; a kept face stays on its plane and may grow a wall one
  // thickness to either side.
  const constructed = new Map<number, Carrier[]>();
  const claims = new Map<number, Carrier[]>();
  for (const [handle, plane] of measured ?? []) {
    const built = openings.has(handle)
      ? [plane]
      : [-thickness, thickness].map((step) => ({
          normal: plane.normal,
          point: add(plane.point, scale(plane.normal, step))
        }));
    constructed.set(handle, built);
    claims.set(handle, openings.has(handle) ? built : [plane, ...built]);
  }
  for (const handle of measured && planes ? source.faceReferences.keys() : []) {
    const witness = sourceWitnesses.get(handle);
    if (witness?.surfaceType !== 'plane') continue;
    const reference = verifiedSourceFace(source, handle, witness);
    const carriers = reference ? constructed.get(handle) : undefined;
    if (!reference || !carriers || contested(handle, carriers, claims))
      continue;
    const opening = openings.has(handle);
    const face = planes ? uniqueFaceOn(planes, carriers) : null;
    if (face === null || carried.faceReferences.has(face)) continue;
    const candidate = candidates.find(
      (c) => c.kind === 'face' && c.handle === face
    );
    if (!candidate) continue;
    assignments.push({
      ...candidate,
      lineageName: `shell.face.${opening ? 'rim' : 'inner'}.${identityOf(reference)}`
    });
  }
  return withBoundaryEdgeLineage(
    kernel,
    resultSolid,
    producer,
    mergeRemusLineageStates([
      createRemusSemanticLineage(producer, 'boolean', assignments),
      carried
    ])
  );
}

/**
 * Draft: undrafted faces carry their identity by exact witness or unique
 * carrier. A drafted planar face perpendicular to the pull direction turns
 * about its hinge — the line where it meets the neutral plane — by the draft
 * angle, toward or away from the pull. It takes `draft.face.<source>` only
 * when exactly one result face lies on either of those two constructed
 * carriers, and no other source face could land on either. A drafted
 * planar face the pull is not perpendicular to has no predictable carrier,
 * so its presence leaves every drafted face unnamed.
 */
export function draftLineage(
  kernel: RemusKernel,
  sourceSolid: number,
  resultSolid: number,
  source: RemusLineageState | undefined,
  producer: FeatureId,
  draftedFaces: readonly number[],
  pullDirection: Vec3,
  neutralPoint: Vec3,
  angleDegrees: number
): RemusLineageState | null {
  const pull = normalized(pullDirection);
  const angle = (angleDegrees * Math.PI) / 180;
  if (!source || !pull || !Number.isFinite(angle) || angle === 0) return null;
  const drafted = new Set(draftedFaces);
  const carried = carryAnalyticFaces(
    kernel,
    sourceSolid,
    resultSolid,
    withoutFaces(source, drafted)
  );
  const sourceWitnesses = new Map(
    topologyCandidatesForSolid(kernel, sourceSolid)
      .filter((c) => c.kind === 'face')
      .map((c) => [c.handle, c.witness as FaceWitnessV1])
  );
  const candidates = topologyCandidatesForSolid(kernel, resultSolid);
  // Every planar face counts against uniqueness, named or not; only an
  // unnamed one can take the constructed name.
  const planes = resultPlanes(kernel, candidates);
  const assignments: RemusSemanticAssignment[] = [];
  // An unmeasurable source or result plane could sit on any carrier: name
  // nothing new, but still publish what was carried.
  const measured = sourcePlanes(kernel, sourceWitnesses);
  // What each planar source face can become: an undrafted face stays on its
  // plane; a drafted one turns about its hinge either way. A drafted plane
  // the pull is not perpendicular to has no carrier this can predict, so it
  // could land on any, and no drafted face is named.
  const tilted = new Map<number, Carrier[]>();
  const claims = new Map<number, Carrier[]>();
  let unpredictable = !measured || !planes;
  for (const [handle, plane] of measured ?? []) {
    if (!drafted.has(handle)) {
      claims.set(handle, [plane]);
      continue;
    }
    if (Math.abs(dot(plane.normal, pull)) > PARALLEL_SINE) {
      unpredictable = true;
      continue;
    }
    const hinge = add(
      neutralPoint,
      scale(
        plane.normal,
        dot(plane.normal, subtract(plane.point, neutralPoint))
      )
    );
    const turned = [1, -1].map((sense) => ({
      normal: add(
        scale(plane.normal, Math.cos(angle)),
        scale(pull, sense * Math.sin(angle))
      ),
      point: hinge
    }));
    tilted.set(handle, turned);
    claims.set(handle, turned);
  }
  for (const handle of unpredictable ? [] : drafted) {
    const witness = sourceWitnesses.get(handle);
    if (witness?.surfaceType !== 'plane') continue;
    const reference = verifiedSourceFace(source, handle, witness);
    const carriers = reference ? tilted.get(handle) : undefined;
    if (!reference || !carriers || contested(handle, carriers, claims))
      continue;
    const face = planes ? uniqueFaceOn(planes, carriers) : null;
    if (face === null || carried.faceReferences.has(face)) continue;
    const candidate = candidates.find(
      (c) => c.kind === 'face' && c.handle === face
    );
    if (!candidate) continue;
    assignments.push({
      ...candidate,
      lineageName: `draft.face.${identityOf(reference)}`
    });
  }
  return withBoundaryEdgeLineage(
    kernel,
    resultSolid,
    producer,
    mergeRemusLineageStates([
      createRemusSemanticLineage(producer, 'boolean', assignments),
      carried
    ])
  );
}
