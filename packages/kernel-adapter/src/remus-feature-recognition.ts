/**
 * The kernel's own feature recognizer, adopted for curved fillet bands and
 * as a backstop for prismatic pockets the exact kernel-neutral recognizer
 * declines.
 *
 * One authority per family, recorded here so it cannot drift:
 *
 * - Holes, counterbores, countersinks, bosses, tapers and exactly proved
 *   prismatic pockets stay the exact recognizer's. `recognizeFeatures` is
 *   read as a cross-check only: where a kernel hole claim covers an exactly
 *   proved feature, the two must agree, and a disagreement withdraws BOTH
 *   answers rather than picking a winner.
 * - Fillet bands are published from the kernel's claims, tagged
 *   `kernel-recognized`, and are read-only, as is a pocket published from a
 *   verified kernel claim on faces no exact proof touched. The claim is
 *   candidate evidence only: nothing is published until the witnesses below
 *   prove it against exact surfaces, and an unprovable claim is dropped
 *   rather than softened.
 *
 * Nothing here consumes tessellation samples, traversal order, or nearest
 * geometry. Every witness is an analytic surface, an outward face normal, an
 * exact edge classification, or a B-Rep adjacency.
 */
import { GEOMETRY_LINEAR_TOLERANCE, type Vec3 } from '@openzcad/geometry';
import { faceVertexCentroid, tangentPlanarNeighbours } from './exact-brep';
import { GEOMETRY_EPSILON, dot, normalized, subtract } from './exact-math';
import type {
  ExactCylinderSurface,
  ExactFaceAdjacencyQuery,
  ImportedFeatureProof
} from './imported-feature-recognition';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
import type { RemusKernel } from './remus-runtime';

/**
 * Recognition is a B-Rep walk on the pinned kernel: the claims a solid yields
 * were identical at deflections from 1e-3 to 1 in probing. The measurement
 * deflection is passed anyway so the one tessellated quantity the recognizer
 * reports (a candidate band's area) is measured the way every other adapter
 * measurement is.
 */
const KERNEL_RECOGNITION_DEFLECTION = MEASUREMENT_DEFLECTION;

/** A pocket wall cycle beyond this is refused rather than walked. */
const MAX_POCKET_WALLS = 64;

/** Bounds the seed set one pocket claim may be re-proved from. */
const MAX_POCKET_SEEDS = 256;

export type KernelFeatureClaim =
  | {
      kind: 'hole';
      /** Cylindrical walls the kernel attributes to one bore. */
      faceIds: readonly number[];
      diameter: number;
      through: boolean;
    }
  | { kind: 'pocket'; floorFaceId: number; wallFaceIds: readonly number[] }
  | { kind: 'fillet-band'; faceId: number };

function finiteHandle(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function handleList(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const handles = value.flatMap((entry) => {
    const handle = finiteHandle(entry);
    return handle === null ? [] : [handle];
  });
  return handles.length === value.length &&
    new Set(handles).size === handles.length
    ? handles
    : null;
}

/**
 * Decodes one `recognizeFeatures` payload.
 *
 * Verified payload shape on the pinned kernel:
 *
 * ```json
 * [{"diameter":5.0,"faces":[21],"through":false,"type":"hole"},
 *  {"floor":45,"type":"pocket","walls":[41,42,43,44]},
 *  {"area":23.56,"face":6,"type":"filletLike"},
 *  {"adjacent":[90,91],"angle":0.785,"face":94,"type":"chamfer"}]
 * ```
 *
 * Types this adapter does not consume (`chamfer`, `pattern`) are skipped; a
 * malformed entry of a type it DOES consume fails the whole payload closed,
 * because a partially decoded payload cannot be cross-checked honestly.
 */
export function parseKernelFeatureClaims(
  payload: string
): KernelFeatureClaim[] | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded)) {
    return null;
  }
  const claims: KernelFeatureClaim[] = [];
  for (const entry of decoded) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const record = entry as Record<string, unknown>;
    if (record.type === 'hole') {
      const faceIds = handleList(record.faces);
      const diameter = record.diameter;
      if (
        !faceIds ||
        typeof diameter !== 'number' ||
        !Number.isFinite(diameter) ||
        diameter <= 0 ||
        typeof record.through !== 'boolean'
      ) {
        return null;
      }
      claims.push({ kind: 'hole', faceIds, diameter, through: record.through });
      continue;
    }
    if (record.type === 'pocket') {
      const floorFaceId = finiteHandle(record.floor);
      const wallFaceIds = handleList(record.walls);
      if (floorFaceId === null || !wallFaceIds) {
        return null;
      }
      claims.push({ kind: 'pocket', floorFaceId, wallFaceIds });
      continue;
    }
    if (record.type === 'filletLike') {
      const faceId = finiteHandle(record.face);
      if (faceId === null) {
        return null;
      }
      claims.push({ kind: 'fillet-band', faceId });
      continue;
    }
  }
  return claims;
}

/**
 * The kernel's claims for one live solid, or `null` when the recognizer is
 * unavailable or its payload cannot be decoded. `null` publishes nothing and
 * cross-checks nothing; it never withdraws an exactly proved feature, because
 * a recognizer that did not answer has not disagreed.
 */
export function readKernelFeatureClaims(
  kernel: RemusKernel,
  solid: number
): KernelFeatureClaim[] | null {
  try {
    return parseKernelFeatureClaims(
      kernel.recognizeFeatures(solid, KERNEL_RECOGNITION_DEFLECTION)
    );
  } catch {
    return null;
  }
}

/** Every cylindrical diameter an exact hole-family proof publishes. */
function provedDiameters(proof: ImportedFeatureProof): number[] {
  switch (proof.kind) {
    case 'blind-cylindrical-hole':
      return [proof.diameter];
    case 'counterbore':
      return [proof.innerDiameter, proof.outerDiameter];
    case 'countersink':
      return [proof.holeDiameter, proof.openingDiameter];
    default:
      return [];
  }
}

function sameMeasure(left: number, right: number): boolean {
  return (
    Math.abs(left - right) <=
    GEOMETRY_EPSILON * Math.max(1, Math.abs(left), Math.abs(right))
  );
}

export type KernelHoleCrossCheck = 'unclaimed' | 'agrees' | 'contradicted';

/**
 * Reads the kernel's hole claims against one exact proof.
 *
 * The kernel publishes a bore as one `hole` entry carrying the bore diameter
 * and every cylindrical wall it attributes to it — a counterbore arrives as a
 * single entry naming both walls. So agreement is: each overlapping claim
 * measures one of the diameters the exact proof published, and no more than one
 * claim overlaps the proof. Anything else contradicts, including a hole claim
 * laid over a family the kernel should not read as a bore at all.
 *
 * Silence is not disagreement: the kernel's recognizer misses features the
 * exact one proves, and an unclaimed proof stands unchanged.
 */
export function crossCheckHoleClaims(
  proof: ImportedFeatureProof,
  claims: readonly KernelFeatureClaim[]
): KernelHoleCrossCheck {
  const participating = new Set(proof.participatingFaceIds);
  const overlapping = claims.filter(
    (claim) =>
      claim.kind === 'hole' &&
      claim.faceIds.some((faceId) => participating.has(String(faceId)))
  );
  if (overlapping.length === 0) {
    return 'unclaimed';
  }
  const diameters = provedDiameters(proof);
  if (overlapping.length > 1 || diameters.length === 0) {
    return 'contradicted';
  }
  const claim = overlapping[0]!;
  if (claim.kind !== 'hole') {
    return 'contradicted';
  }
  return diameters.some((diameter) => sameMeasure(diameter, claim.diameter))
    ? 'agrees'
    : 'contradicted';
}

interface PlanarFaceWitness {
  normal: Vec3;
  point: Vec3;
}

/** One solid's exact face adjacency, read once per recognition pass. */
export class SolidFaceAdjacency {
  private readonly edgeToFaces: Record<string, number[]>;
  private readonly neighbours = new Map<number, Map<number, number[]>>();
  private readonly planes = new Map<number, PlanarFaceWitness | null>();

  constructor(
    private readonly kernel: RemusKernel,
    private readonly solid: number
  ) {
    this.edgeToFaces = JSON.parse(kernel.edgeToFaceMap(solid)) as Record<
      string,
      number[]
    >;
  }

  /** Neighbouring face handle to the edges it shares, or null if non-manifold. */
  adjacent(face: number): Map<number, number[]> | null {
    const cached = this.neighbours.get(face);
    if (cached) {
      return cached;
    }
    const byNeighbour = new Map<number, number[]>();
    for (const edge of this.kernel.getFaceEdges(face)) {
      const uses = this.edgeToFaces[String(edge)] ?? [];
      if (new Set(uses).size > 2) {
        return null;
      }
      for (const neighbour of new Set(uses)) {
        if (neighbour === face) {
          continue;
        }
        byNeighbour.set(neighbour, [
          ...(byNeighbour.get(neighbour) ?? []),
          edge
        ]);
      }
    }
    this.neighbours.set(face, byNeighbour);
    return byNeighbour;
  }

  plane(face: number): PlanarFaceWitness | null {
    if (this.planes.has(face)) {
      return this.planes.get(face) ?? null;
    }
    const witness = this.readPlane(face);
    this.planes.set(face, witness);
    return witness;
  }

  straightEdges(face: number): boolean {
    return Array.from(this.kernel.getFaceEdges(face)).every(
      (edge) => this.kernel.getEdgeCurveType(edge) === 'LINE'
    );
  }

  edgeCount(face: number): number {
    return Array.from(this.kernel.getFaceEdges(face)).length;
  }

  private readPlane(face: number): PlanarFaceWitness | null {
    if (this.kernel.getSurfaceType(face) !== 'plane') {
      return null;
    }
    let normal: Vec3 | null;
    try {
      const raw = this.kernel.getFaceNormal(face);
      normal = normalized({ x: raw[0]!, y: raw[1]!, z: raw[2]! });
    } catch {
      // A NURBS-backed plane has no analytic outward normal; without it the
      // material side cannot be proved, so the face is no witness at all.
      return null;
    }
    const point = faceVertexCentroid(this.kernel, face);
    return normal && point ? { normal, point } : null;
  }
}

export interface VerifiedKernelPocket {
  floorFaceId: number;
  openingFaceId: number;
  wallFaceIds: readonly number[];
  /** Depth from the opening plane down to the floor, along the floor normal. */
  depth: number;
}

/**
 * Proves the exact prismatic shell a planar floor bounds.
 *
 * Every wall is planar and perpendicular to the floor, meets the floor along
 * one straight edge, is a four-sided band, and closes one single cycle with two
 * peers. All walls end on one common opening plane parallel to the floor.
 *
 * The material side is the last witness and the one that separates a pocket
 * from a pad: outward normals point out of the solid, so a depression has its
 * opening plane on the outward side of its floor. A raised pad has the same
 * topology with the opening BEHIND the floor, and is refused here — the
 * kernel's recognizer calls one of those a pocket on a committed fixture.
 */
function provePocketShell(
  adjacency: SolidFaceAdjacency,
  floorFaceId: number
): VerifiedKernelPocket | null {
  const floor = adjacency.plane(floorFaceId);
  if (!floor || !adjacency.straightEdges(floorFaceId)) {
    return null;
  }
  const floorNeighbours = adjacency.adjacent(floorFaceId);
  if (!floorNeighbours) {
    return null;
  }
  const wallFaceIds = Array.from(floorNeighbours.keys()).sort(
    (left, right) => left - right
  );
  if (
    wallFaceIds.length < 3 ||
    wallFaceIds.length > MAX_POCKET_WALLS ||
    // Every floor edge must be a wall edge: a second loop, or a wall meeting
    // the floor twice, is a shape this narrow proof does not cover.
    wallFaceIds.length !== adjacency.edgeCount(floorFaceId)
  ) {
    return null;
  }
  const wallSet = new Set(wallFaceIds);
  const peersByWall = new Map<number, number[]>();
  let openingFaceId: number | null = null;
  for (const wallFaceId of wallFaceIds) {
    const wall = adjacency.plane(wallFaceId);
    const wallNeighbours = adjacency.adjacent(wallFaceId);
    if (
      !wall ||
      !wallNeighbours ||
      Math.abs(dot(wall.normal, floor.normal)) > GEOMETRY_EPSILON ||
      (floorNeighbours.get(wallFaceId) ?? []).length !== 1 ||
      adjacency.edgeCount(wallFaceId) !== 4 ||
      !adjacency.straightEdges(wallFaceId)
    ) {
      return null;
    }
    const peers = Array.from(wallNeighbours.keys()).filter((neighbour) =>
      wallSet.has(neighbour)
    );
    const openings = Array.from(wallNeighbours.keys()).filter(
      (neighbour) => neighbour !== floorFaceId && !wallSet.has(neighbour)
    );
    if (peers.length !== 2 || openings.length !== 1) {
      return null;
    }
    if (openingFaceId === null) {
      openingFaceId = openings[0]!;
    } else if (openingFaceId !== openings[0]!) {
      return null;
    }
    peersByWall.set(wallFaceId, peers);
  }
  if (openingFaceId === null) {
    return null;
  }
  const opening = adjacency.plane(openingFaceId);
  if (
    !opening ||
    Math.abs(Math.abs(dot(opening.normal, floor.normal)) - 1) > GEOMETRY_EPSILON
  ) {
    return null;
  }
  const visited = new Set<number>([wallFaceIds[0]!]);
  const pending = [wallFaceIds[0]!];
  while (pending.length > 0) {
    for (const peer of peersByWall.get(pending.pop()!) ?? []) {
      if (!visited.has(peer)) {
        visited.add(peer);
        pending.push(peer);
      }
    }
  }
  if (visited.size !== wallFaceIds.length) {
    return null;
  }
  const depth = dot(subtract(opening.point, floor.point), floor.normal);
  return depth > GEOMETRY_LINEAR_TOLERANCE
    ? { floorFaceId, openingFaceId, wallFaceIds, depth }
    : null;
}

/**
 * Verifies one kernel pocket claim, or refuses it.
 *
 * The kernel labels the claim loosely — on committed fixtures it has named the
 * opening plane as the floor, over-claimed walls that belong to the outside of
 * the part, and called an open-ended slot and a raised pad pockets. So the
 * claim is read as a candidate region, and the exact shell is proved from every
 * planar face the claim names or touches. A proof counts only when its walls
 * are all named in the claim and the claim's floor is one of the two planes the
 * shell is bounded by; two different accepted shells refuse the claim.
 */
export function verifyKernelPocketClaim(
  kernel: RemusKernel,
  solid: number,
  claim: Extract<KernelFeatureClaim, { kind: 'pocket' }>,
  adjacency = new SolidFaceAdjacency(kernel, solid)
): VerifiedKernelPocket | null {
  const solidFaces = new Set(kernel.getSolidFaces(solid));
  if (
    !solidFaces.has(claim.floorFaceId) ||
    claim.wallFaceIds.some((faceId) => !solidFaces.has(faceId)) ||
    claim.wallFaceIds.length > MAX_POCKET_WALLS
  ) {
    return null;
  }
  const claimedWalls = new Set(claim.wallFaceIds);
  const seeds = new Set<number>([claim.floorFaceId, ...claim.wallFaceIds]);
  for (const wallFaceId of claim.wallFaceIds) {
    for (const neighbour of adjacency.adjacent(wallFaceId)?.keys() ?? []) {
      seeds.add(neighbour);
    }
  }
  if (seeds.size > MAX_POCKET_SEEDS) {
    return null;
  }
  let verified: VerifiedKernelPocket | null = null;
  for (const seed of Array.from(seeds).sort((left, right) => left - right)) {
    const shell = provePocketShell(adjacency, seed);
    if (
      !shell ||
      !shell.wallFaceIds.every((faceId) => claimedWalls.has(faceId)) ||
      (claim.floorFaceId !== shell.floorFaceId &&
        claim.floorFaceId !== shell.openingFaceId)
    ) {
      continue;
    }
    if (verified && verified.floorFaceId !== shell.floorFaceId) {
      return null;
    }
    verified ??= shell;
  }
  return verified;
}

export interface VerifiedKernelFilletBand {
  faceId: number;
  radius: number;
  /** Length of the straight tangent contact the band shares with its walls. */
  length: number;
  sense: 'concave' | 'convex';
}

/**
 * Verifies one kernel fillet-band claim, or refuses it.
 *
 * The kernel's `filletLike` claim carries a face and its area and nothing else:
 * no radius, and no proof the face is a blend at all — on a committed fixture
 * it claims the conical seat of a countersink. What makes a face a rolling-ball
 * band is tangency, so the claim is published only when the face is an exact
 * cylinder running tangent into two or more planar neighbours, which is the
 * same tangency witness the adapter answers edge modifiers with. Radius, length
 * and material side are then measured exactly, never taken from the claim.
 *
 * The band's length is the length of its straight contact edges, not its
 * surface domain: `getSurfaceDomain` reports the untrimmed cylinder, so a
 * quarter-round band reads as a full revolution there. Requiring one straight
 * contact edge per tangent wall, all of equal length, is both the exact
 * measurement and the proof that the band was swept along a straight edge.
 */
export function verifyKernelFilletBandClaim(
  kernel: RemusKernel,
  solid: number,
  claim: Extract<KernelFeatureClaim, { kind: 'fillet-band' }>,
  query: ExactFaceAdjacencyQuery,
  adjacency = new SolidFaceAdjacency(kernel, solid)
): VerifiedKernelFilletBand | null {
  if (!new Set(kernel.getSolidFaces(solid)).has(claim.faceId)) {
    return null;
  }
  const face = query.getFace(String(claim.faceId));
  if (face?.surface.kind !== 'cylinder') {
    return null;
  }
  const band: ExactCylinderSurface = face.surface;
  if (!(band.radius > 0)) {
    return null;
  }
  const walls = tangentPlanarNeighbours(kernel, solid, claim.faceId);
  const neighbours = adjacency.adjacent(claim.faceId);
  if (walls.length < 2 || !neighbours) {
    return null;
  }
  let length: number | null = null;
  for (const wall of walls) {
    const shared = neighbours.get(wall) ?? [];
    if (shared.length !== 1 || kernel.getEdgeCurveType(shared[0]!) !== 'LINE') {
      return null;
    }
    const contact = kernel.edgeLength(shared[0]!);
    if (!(contact > GEOMETRY_LINEAR_TOLERANCE)) {
      return null;
    }
    if (length === null) {
      length = contact;
    } else if (Math.abs(length - contact) > GEOMETRY_LINEAR_TOLERANCE) {
      return null;
    }
  }
  return length === null
    ? null
    : {
        faceId: claim.faceId,
        radius: band.radius,
        length,
        sense: band.radialSense === 'toward-axis' ? 'concave' : 'convex'
      };
}
