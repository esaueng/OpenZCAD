/**
 * Live-Remus bridge for the kernel-neutral imported-feature recognizer.
 * Recognition runs while exact handles are available and publishes only the
 * bounded proof data that synchronous document recipes need later.
 */
import type { Vec3 } from '@openzcad/geometry';
import type {
  FaceTopologyReferenceV5,
  RecognizedImportedFeature
} from '@openzcad/shared';
import { isBlendFace } from './exact-brep';
import {
  recognizeImportedFeature,
  type ExactFaceAdjacency,
  type ExactFaceAdjacencyQuery,
  type ExactPoint3,
  type ExactRecognitionFace,
  type ImportedFeatureProof,
  type ImportedFeatureRecognition
} from './imported-feature-recognition';
import {
  FULL_REVOLUTION,
  dot,
  finiteVec3,
  length,
  normalized,
  scale,
  subtract
} from './exact-math';
import { measureFaceGeometry } from './exact-measure';
import {
  SolidFaceAdjacency,
  crossCheckHoleClaims,
  readKernelFeatureClaims,
  verifyKernelFilletBandClaim,
  verifyKernelPocketClaim
} from './remus-feature-recognition';
import type { RemusKernel } from './remus-runtime';

export interface ImportedRecognitionFaceIdentity {
  hash: number;
  reference?: FaceTopologyReferenceV5;
}

function pointTuple(point: Vec3): ExactPoint3 {
  return [point.x, point.y, point.z];
}

function vectorFrom(values: ArrayLike<number>): Vec3 | null {
  return finiteVec3(Array.from(values));
}

function surfacePoint(
  kernel: RemusKernel,
  face: number,
  u: number,
  v: number
): Vec3 | null {
  try {
    return vectorFrom(kernel.evaluateSurface(face, u, v));
  } catch {
    return null;
  }
}

function radialSense(
  kernel: RemusKernel,
  face: number,
  axisOrigin: Vec3,
  axisDirection: Vec3,
  domain: readonly number[]
): 'toward-axis' | 'away-from-axis' | null {
  const u = (domain[0]! + domain[1]!) / 2;
  const v = (domain[2]! + domain[3]!) / 2;
  const point = surfacePoint(kernel, face, u, v);
  let normal: Vec3 | null;
  try {
    normal = vectorFrom(kernel.evaluateSurfaceNormal(face, u, v));
  } catch {
    return null;
  }
  if (!point || !normal) {
    return null;
  }
  const along = dot(subtract(point, axisOrigin), axisDirection);
  const radial = normalized(
    subtract(point, {
      x: axisOrigin.x + axisDirection.x * along,
      y: axisOrigin.y + axisDirection.y * along,
      z: axisOrigin.z + axisDirection.z * along
    })
  );
  const outward = normalized(normal);
  if (!radial || !outward) {
    return null;
  }
  const alignment = dot(outward, radial);
  if (Math.abs(alignment) <= 1e-8) {
    return null;
  }
  return alignment > 0 ? 'away-from-axis' : 'toward-axis';
}

function exactCircularPlanarArea(
  kernel: RemusKernel,
  face: number,
  fallback: number
): number {
  const edges = Array.from(kernel.getFaceEdges(face));
  if (
    edges.length === 0 ||
    !edges.every((edge) => {
      const vertices = Array.from(kernel.getEdgeVertexHandles(edge));
      return (
        kernel.getEdgeCurveType(edge) === 'CIRCLE' &&
        vertices.length === 2 &&
        vertices[0] === vertices[1]
      );
    })
  ) {
    return fallback;
  }
  const radii = edges
    .map((edge) => kernel.edgeLength(edge) / FULL_REVOLUTION)
    .sort((left, right) => right - left);
  return (
    Math.PI * radii[0]! ** 2 -
    radii.slice(1).reduce((area, radius) => area + Math.PI * radius ** 2, 0)
  );
}

/**
 * Exact ordered vertices of a planar face's single straight-edged outer
 * loop, or `undefined` when the face proves no such loop.
 *
 * Fail-closed by construction: multiple wires (a holed face), any non-LINE
 * edge, a non-manifold or open vertex chain, or any unreadable vertex
 * publishes nothing. The pocket proof's own area check then decides whether
 * the loop proves the floor; this helper never guesses.
 *
 * Chaining is topological (shared vertex handles), never geometric
 * snapping, so traversal order and tessellation samples cannot leak in.
 */
function exactStraightEdgePolygon(
  kernel: RemusKernel,
  face: number
): ExactPoint3[] | undefined {
  try {
    const wires = Array.from(kernel.getFaceWires(face));
    if (wires.length !== 1) {
      return undefined;
    }
    const outer = kernel.getFaceOuterWire(face);
    if (outer !== wires[0]) {
      return undefined;
    }
    const edges = Array.from(kernel.getWireEdges(outer));
    if (edges.length < 3 || new Set(edges).size !== edges.length) {
      return undefined;
    }
    for (const edge of edges) {
      if (kernel.getEdgeCurveType(edge) !== 'LINE') {
        return undefined;
      }
    }
    const endpoints = new Map<number, [number, number]>();
    const incidence = new Map<number, number[]>();
    for (const edge of edges) {
      const handles = Array.from(kernel.getEdgeVertexHandles(edge));
      if (handles.length !== 2 || handles[0] === handles[1]) {
        return undefined;
      }
      const [start, end] = [handles[0]!, handles[1]!];
      endpoints.set(edge, [start, end]);
      for (const vertex of [start, end]) {
        incidence.set(vertex, [...(incidence.get(vertex) ?? []), edge]);
      }
    }
    // A single closed loop meets every vertex exactly twice.
    for (const uses of incidence.values()) {
      if (uses.length !== 2) {
        return undefined;
      }
    }
    const ordered: number[] = [];
    const usedEdges = new Set<number>();
    const [firstStart, firstEnd] = endpoints.get(edges[0]!)!;
    ordered.push(firstStart);
    usedEdges.add(edges[0]!);
    let current = firstEnd;
    for (let step = 1; step < edges.length; step += 1) {
      ordered.push(current);
      const candidates = (incidence.get(current) ?? []).filter(
        (edge) => !usedEdges.has(edge)
      );
      if (candidates.length !== 1) {
        return undefined;
      }
      const edge = candidates[0]!;
      usedEdges.add(edge);
      const [start, end] = endpoints.get(edge)!;
      current = start === current ? end : start;
    }
    if (current !== ordered[0] || usedEdges.size !== edges.length) {
      return undefined;
    }
    const polygon: ExactPoint3[] = [];
    for (const vertex of ordered) {
      const position = Array.from(kernel.getVertexPosition(vertex));
      if (
        position.length !== 3 ||
        !position.every((coordinate) => Number.isFinite(coordinate))
      ) {
        return undefined;
      }
      polygon.push([position[0]!, position[1]!, position[2]!]);
    }
    return polygon;
  } catch {
    return undefined;
  }
}

/**
 * Planar faces that can seed an exact prismatic-pocket proof: one
 * straight-edged outer loop with three or more vertices.
 *
 * Sorted by handle so recognition order is deterministic and independent of
 * the kernel's face enumeration. Faces without a proved loop are not seeds;
 * they still reach the recognizer only as neighbours, never as a pocket
 * floor.
 */
export function listPlanarFloorSeeds(
  kernel: RemusKernel,
  solid: number,
  query?: ExactFaceAdjacencyQuery
): number[] {
  const view = query ?? new RemusImportedFeatureQuery(kernel, solid);
  const seeds: number[] = [];
  let faces: ArrayLike<number>;
  try {
    faces = kernel.getSolidFaces(solid);
  } catch {
    return seeds;
  }
  for (const face of Array.from(faces)) {
    const candidate = view.getFace(String(face));
    if (candidate?.surface.kind !== 'plane') {
      continue;
    }
    if (
      candidate.surface.polygon !== undefined &&
      candidate.surface.polygon.length >= 3
    ) {
      seeds.push(face);
    }
  }
  seeds.sort((left, right) => left - right);
  return seeds;
}

function axialEndpoint(
  kernel: RemusKernel,
  face: number,
  axisOrigin: Vec3,
  axisDirection: Vec3,
  u: number,
  v: number
): { coordinate: number; radius: number } | null {
  const point = surfacePoint(kernel, face, u, v);
  if (!point) {
    return null;
  }
  const delta = subtract(point, axisOrigin);
  const coordinate = dot(delta, axisDirection);
  const radial = subtract(delta, scale(axisDirection, coordinate));
  return { coordinate, radius: length(radial) };
}

function revolutionEndpoints(
  kernel: RemusKernel,
  face: number,
  axisOrigin: Vec3,
  axisDirection: Vec3,
  domain: readonly number[]
):
  | [
      { coordinate: number; radius: number },
      { coordinate: number; radius: number }
    ]
  | null {
  const circles = Array.from(kernel.getFaceEdges(face)).flatMap((edge) => {
    const vertices = Array.from(kernel.getEdgeVertexHandles(edge));
    if (
      kernel.getEdgeCurveType(edge) !== 'CIRCLE' ||
      vertices.length !== 2 ||
      vertices[0] !== vertices[1]
    ) {
      return [];
    }
    const edgeDomain = Array.from(kernel.getEdgeCurveParameters(edge));
    if (edgeDomain.length !== 2 || !edgeDomain.every(Number.isFinite)) {
      return [];
    }
    const center = { x: 0, y: 0, z: 0 };
    for (let sample = 0; sample < 4; sample += 1) {
      const parameter =
        edgeDomain[0]! + ((edgeDomain[1]! - edgeDomain[0]!) * sample) / 4;
      const point = vectorFrom(kernel.evaluateEdgeCurve(edge, parameter));
      if (!point) {
        return [];
      }
      center.x += point.x / 4;
      center.y += point.y / 4;
      center.z += point.z / 4;
    }
    return [
      {
        coordinate: dot(subtract(center, axisOrigin), axisDirection),
        radius: kernel.edgeLength(edge) / FULL_REVOLUTION
      }
    ];
  });
  if (circles.length === 2) {
    return [circles[0]!, circles[1]!];
  }
  const first = axialEndpoint(
    kernel,
    face,
    axisOrigin,
    axisDirection,
    domain[0]!,
    domain[2]!
  );
  const second = axialEndpoint(
    kernel,
    face,
    axisOrigin,
    axisDirection,
    domain[0]!,
    domain[3]!
  );
  return first && second ? [first, second] : null;
}

/** Exact face/adjacency view over one live solid. */
export class RemusImportedFeatureQuery implements ExactFaceAdjacencyQuery {
  private readonly faceHandles: Set<number>;
  private readonly edgeToFaces: Record<string, number[]>;
  private readonly faces = new Map<number, ExactRecognitionFace>();
  private readonly adjacency = new Map<number, ExactFaceAdjacency[]>();

  constructor(
    private readonly kernel: RemusKernel,
    private readonly solid: number
  ) {
    this.faceHandles = new Set(kernel.getSolidFaces(solid));
    this.edgeToFaces = JSON.parse(kernel.edgeToFaceMap(solid)) as Record<
      string,
      number[]
    >;
  }

  getFace(faceId: string): ExactRecognitionFace | undefined {
    const handle = Number(faceId);
    if (!Number.isSafeInteger(handle) || !this.faceHandles.has(handle)) {
      return undefined;
    }
    const cached = this.faces.get(handle);
    if (cached) {
      return cached;
    }
    const surface = this.readSurface(handle);
    const face = { id: String(handle), surface } satisfies ExactRecognitionFace;
    this.faces.set(handle, face);
    return face;
  }

  getAdjacentFaces(faceId: string): readonly ExactFaceAdjacency[] {
    const handle = Number(faceId);
    if (!Number.isSafeInteger(handle) || !this.faceHandles.has(handle)) {
      return [];
    }
    const cached = this.adjacency.get(handle);
    if (cached) {
      return cached;
    }
    const byNeighbor = new Map<
      number,
      { edges: number[]; nonManifold: boolean }
    >();
    for (const edge of this.kernel.getFaceEdges(handle)) {
      const uses = this.edgeToFaces[String(edge)] ?? [];
      const neighbors = [...new Set(uses.filter((face) => face !== handle))];
      for (const neighbor of neighbors) {
        const entry = byNeighbor.get(neighbor) ?? {
          edges: [],
          nonManifold: false
        };
        entry.edges.push(edge);
        entry.nonManifold ||= new Set(uses).size > 2;
        byNeighbor.set(neighbor, entry);
      }
    }
    const adjacent = Array.from(byNeighbor, ([neighbor, entry]) => {
      const edge = entry.edges[0]!;
      const vertices = Array.from(this.kernel.getEdgeVertexHandles(edge));
      const closed =
        entry.edges.length === 1 &&
        vertices.length === 2 &&
        vertices[0] === vertices[1];
      const curveTypes = new Set(
        entry.edges.map((candidate) => this.kernel.getEdgeCurveType(candidate))
      );
      const boundary =
        curveTypes.size === 1 && curveTypes.has('CIRCLE')
          ? ('circle' as const)
          : curveTypes.size === 1 && curveTypes.has('LINE')
            ? ('line' as const)
            : ('curve' as const);
      return {
        faceId: String(neighbor),
        relation: entry.nonManifold
          ? ('non-manifold' as const)
          : this.adjacencyRelation(handle, neighbor, entry.edges),
        boundary,
        closed
      };
    });
    adjacent.sort((left, right) => Number(left.faceId) - Number(right.faceId));
    this.adjacency.set(handle, adjacent);
    return adjacent;
  }

  private adjacencyRelation(
    leftHandle: number,
    rightHandle: number,
    sharedEdges: readonly number[] = []
  ): ExactFaceAdjacency['relation'] {
    const left = this.getFace(String(leftHandle))?.surface;
    const right = this.getFace(String(rightHandle))?.surface;
    if (left?.kind === 'blend' || right?.kind === 'blend') {
      return 'smooth';
    }
    if (
      left?.kind === 'plane' &&
      right?.kind === 'plane' &&
      sharedEdges.length > 0
    ) {
      return this.planePlaneRelation(left.normal, right.normal, sharedEdges[0]!);
    }
    const senses = [left, right].flatMap((surface) =>
      surface?.kind === 'cylinder' || surface?.kind === 'cone'
        ? [surface.radialSense]
        : []
    );
    if (senses.length > 0 && senses.every((sense) => sense === senses[0])) {
      return senses[0] === 'toward-axis' ? 'concave' : 'convex';
    }
    return senses.length > 0 ? 'intersection' : 'convex';
  }

  /**
   * Concave/convex for two planar faces sharing a straight edge, proved by
   * sampling the solid on both sides of the edge's diagonal wedge.
   *
   * A convex outer edge leaves both diagonal neighbours outside the solid
   * while a concave pocket edge keeps both inside; anything else (a
   * boundary hit, a mixed answer, a non-straight or skewed edge) is not a
   * simple two-plane junction and fails closed as `intersection`. Coplanar
   * neighbours stay `convex`: they never satisfy the pocket proof's
   * perpendicularity check, so this label cannot promote them into a wall.
   */
  private planePlaneRelation(
    leftNormal: ExactPoint3,
    rightNormal: ExactPoint3,
    sharedEdge: number
  ): ExactFaceAdjacency['relation'] {
    try {
      const cross: ExactPoint3 = [
        leftNormal[1] * rightNormal[2] - leftNormal[2] * rightNormal[1],
        leftNormal[2] * rightNormal[0] - leftNormal[0] * rightNormal[2],
        leftNormal[0] * rightNormal[1] - leftNormal[1] * rightNormal[0]
      ];
      const crossLength = Math.hypot(cross[0], cross[1], cross[2]);
      if (!(crossLength > 1e-10)) {
        return 'convex';
      }
      if (this.kernel.getEdgeCurveType(sharedEdge) !== 'LINE') {
        return 'intersection';
      }
      const handles = Array.from(this.kernel.getEdgeVertexHandles(sharedEdge));
      if (handles.length !== 2 || handles[0] === handles[1]) {
        return 'intersection';
      }
      const start = Array.from(this.kernel.getVertexPosition(handles[0]!));
      const end = Array.from(this.kernel.getVertexPosition(handles[1]!));
      if (
        start.length !== 3 ||
        end.length !== 3 ||
        ![...start, ...end].every((coordinate) => Number.isFinite(coordinate))
      ) {
        return 'intersection';
      }
      const tangent: ExactPoint3 = [
        end[0]! - start[0]!,
        end[1]! - start[1]!,
        end[2]! - start[2]!
      ];
      const tangentLength = Math.hypot(tangent[0], tangent[1], tangent[2]);
      if (!(tangentLength > 0)) {
        return 'intersection';
      }
      const alignment =
        Math.abs(
          (tangent[0] * cross[0] + tangent[1] * cross[1] + tangent[2] * cross[2]) /
            (tangentLength * crossLength)
        );
      if (!(alignment > 1 - 1e-9)) {
        return 'intersection';
      }
      const diagonal: ExactPoint3 = [
        leftNormal[0] - rightNormal[0],
        leftNormal[1] - rightNormal[1],
        leftNormal[2] - rightNormal[2]
      ];
      const diagonalLength = Math.hypot(
        diagonal[0],
        diagonal[1],
        diagonal[2]
      );
      if (!(diagonalLength > 1e-10)) {
        return 'convex';
      }
      let edgeLength = 0;
      try {
        edgeLength = this.kernel.edgeLength(sharedEdge);
      } catch {
        return 'intersection';
      }
      if (!Number.isFinite(edgeLength) || !(edgeLength > 0)) {
        return 'intersection';
      }
      const step = Math.min(0.25, Math.max(1e-4, edgeLength * 0.05));
      const midpoint = [
        (start[0]! + end[0]!) / 2,
        (start[1]! + end[1]!) / 2,
        (start[2]! + end[2]!) / 2
      ];
      const offset = [
        (diagonal[0] / diagonalLength) * step,
        (diagonal[1] / diagonalLength) * step,
        (diagonal[2] / diagonalLength) * step
      ];
      const first = this.kernel.classifyPoint(
        this.solid,
        midpoint[0]! + offset[0]!,
        midpoint[1]! + offset[1]!,
        midpoint[2]! + offset[2]!,
        1e-7
      );
      const second = this.kernel.classifyPoint(
        this.solid,
        midpoint[0]! - offset[0]!,
        midpoint[1]! - offset[1]!,
        midpoint[2]! - offset[2]!,
        1e-7
      );
      if (first === 'inside' && second === 'inside') {
        return 'concave';
      }
      if (first === 'outside' && second === 'outside') {
        return 'convex';
      }
      return 'intersection';
    } catch {
      return 'intersection';
    }
  }

  private readSurface(handle: number): ExactRecognitionFace['surface'] {
    const surfaceType = this.kernel.getSurfaceType(handle);
    const geometry = measureFaceGeometry(this.kernel, handle);
    if (surfaceType === 'plane' && geometry?.normal) {
      const normal = normalized(geometry.normal);
      if (normal) {
        const polygon = exactStraightEdgePolygon(this.kernel, handle);
        return {
          kind: 'plane',
          origin: pointTuple(geometry.center),
          normal: pointTuple(normal),
          area: exactCircularPlanarArea(this.kernel, handle, geometry.area),
          ...(polygon ? { polygon } : {})
        };
      }
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(this.kernel.getAnalyticSurfaceParams(handle));
    } catch {
      decoded = null;
    }
    const record = (decoded ?? {}) as Record<string, unknown>;
    const domain = Array.from(this.kernel.getSurfaceDomain(handle));
    if (domain.length !== 4 || !domain.every(Number.isFinite)) {
      return { kind: 'other', typeName: surfaceType };
    }

    if (surfaceType === 'cylinder') {
      const axisOrigin = finiteVec3(record.origin);
      const rawAxis = finiteVec3(record.axis);
      const axisDirection = rawAxis ? normalized(rawAxis) : null;
      const radius = record.radius;
      if (
        axisOrigin &&
        axisDirection &&
        typeof radius === 'number' &&
        Number.isFinite(radius)
      ) {
        const sense = radialSense(
          this.kernel,
          handle,
          axisOrigin,
          axisDirection,
          domain
        );
        const endpoints = revolutionEndpoints(
          this.kernel,
          handle,
          axisOrigin,
          axisDirection,
          domain
        );
        if (sense && endpoints) {
          const [first, second] = endpoints;
          return {
            kind: 'cylinder',
            axisOrigin: pointTuple(axisOrigin),
            axisDirection: pointTuple(axisDirection),
            radius,
            axialStart: first.coordinate,
            axialEnd: second.coordinate,
            sweepRadians: Math.abs(domain[1]! - domain[0]!),
            radialSense: sense
          };
        }
      }
    }

    if (surfaceType === 'cone') {
      const axisOrigin = finiteVec3(record.apex);
      const rawAxis = finiteVec3(record.axis);
      const axisDirection = rawAxis ? normalized(rawAxis) : null;
      const semiAngle =
        record.halfAngle ?? record.half_angle ?? record.semiAngle;
      if (
        axisOrigin &&
        axisDirection &&
        typeof semiAngle === 'number' &&
        Number.isFinite(semiAngle)
      ) {
        const sense = radialSense(
          this.kernel,
          handle,
          axisOrigin,
          axisDirection,
          domain
        );
        const endpoints = revolutionEndpoints(
          this.kernel,
          handle,
          axisOrigin,
          axisDirection,
          domain
        );
        if (sense && endpoints) {
          const [first, second] = endpoints;
          return {
            kind: 'cone',
            axisOrigin: pointTuple(axisOrigin),
            axisDirection: pointTuple(axisDirection),
            axialStart: first.coordinate,
            axialEnd: second.coordinate,
            radiusAtStart: first.radius,
            radiusAtEnd: second.radius,
            semiAngleRadians: semiAngle,
            sweepRadians: Math.abs(domain[1]! - domain[0]!),
            radialSense: sense
          };
        }
      }
    }

    if (isBlendFace(this.kernel, this.solid, handle)) {
      return { kind: 'blend', typeName: surfaceType };
    }
    return {
      kind:
        surfaceType === 'bspline' || surfaceType === 'nurbs'
          ? 'bspline'
          : 'other',
      typeName: surfaceType
    };
  }
}

export function recognizeImportedFeatureOnSolid(
  kernel: RemusKernel,
  solid: number,
  seedFace: number
): ImportedFeatureRecognition {
  return recognizeImportedFeature(
    new RemusImportedFeatureQuery(kernel, solid),
    String(seedFace)
  );
}

function featureOwnedFaceIds(proof: ImportedFeatureProof): string[] {
  switch (proof.kind) {
    case 'blind-cylindrical-hole':
      return [proof.wallFaceId, proof.bottomFaceId];
    case 'counterbore':
      return [
        proof.outerWallFaceId,
        proof.innerWallFaceId,
        proof.stepFaceId,
        proof.bottomFaceId,
        ...(proof.entryChamferFaceId ? [proof.entryChamferFaceId] : [])
      ];
    case 'countersink':
      return [
        proof.conicalFaceId,
        proof.cylindricalWallFaceId,
        proof.bottomFaceId
      ];
    case 'cylindrical-boss':
      return [proof.wallFaceId, proof.capFaceId];
    case 'prismatic-pocket':
      return [proof.floorFaceId, ...proof.wallFaceIds];
    case 'conical-taper':
      return [proof.conicalFaceId, proof.capFaceId];
  }
}

function canonicalSeedFaceId(proof: ImportedFeatureProof): string {
  switch (proof.kind) {
    case 'blind-cylindrical-hole':
      return proof.wallFaceId;
    case 'counterbore':
      return proof.outerWallFaceId;
    case 'countersink':
      return proof.conicalFaceId;
    case 'cylindrical-boss':
      return proof.wallFaceId;
    case 'prismatic-pocket':
      return proof.floorFaceId;
    case 'conical-taper':
      return proof.conicalFaceId;
  }
}

/**
 * Display dimensions carried by one {@link ImportedFeatureProof}, keyed by
 * the proof's own field names minus identity fields. Lengths are in kernel
 * millimetres; the worker scales them into document units before publishing,
 * and angles stay in radians.
 */
export function importedProofDisplayDimensions(
  proof: ImportedFeatureProof
): Record<string, number> {
  switch (proof.kind) {
    case 'blind-cylindrical-hole':
      return { diameter: proof.diameter, depth: proof.depth };
    case 'counterbore':
      return {
        outerDiameter: proof.outerDiameter,
        innerDiameter: proof.innerDiameter,
        counterboreDepth: proof.counterboreDepth,
        totalDepth: proof.totalDepth
      };
    case 'countersink':
      return {
        openingDiameter: proof.openingDiameter,
        holeDiameter: proof.holeDiameter,
        angleRadians: proof.angleRadians,
        countersinkDepth: proof.countersinkDepth,
        totalDepth: proof.totalDepth
      };
    case 'cylindrical-boss':
      return { diameter: proof.diameter, height: proof.height };
    case 'prismatic-pocket':
      return { depth: proof.depth };
    case 'conical-taper':
      return {
        referenceRadius: proof.referenceRadius,
        oppositeRadius: proof.oppositeRadius,
        length: proof.length,
        angleRadians: proof.angleRadians
      };
  }
}

function vec(point: ExactPoint3): Vec3 {
  return { x: point[0], y: point[1], z: point[2] };
}

function publishedProof(
  proof: ImportedFeatureProof,
  identities: ReadonlyMap<number, ImportedRecognitionFaceIdentity>
): RecognizedImportedFeature | null {
  const seed = identities.get(Number(canonicalSeedFaceId(proof)));
  if (!seed) {
    return null;
  }
  const participatingFaceHashes = proof.participatingFaceIds.flatMap(
    (faceId) => {
      const identity = identities.get(Number(faceId));
      return identity ? [identity.hash] : [];
    }
  );
  if (participatingFaceHashes.length !== proof.participatingFaceIds.length) {
    return null;
  }
  const base = {
    seedFaceHash: seed.hash,
    ...(seed.reference ? { seedFaceReference: seed.reference } : {}),
    participatingFaceHashes
  };
  switch (proof.kind) {
    case 'blind-cylindrical-hole':
      return {
        ...base,
        kind: proof.kind,
        openingPoint: vec(proof.openingPoint),
        axisDirection: vec(proof.directionIntoBody),
        diameter: proof.diameter,
        depth: proof.depth
      };
    case 'counterbore':
      return {
        ...base,
        kind: proof.kind,
        openingPoint: vec(proof.openingPoint),
        axisDirection: vec(proof.directionIntoBody),
        boreDiameter: proof.innerDiameter,
        counterboreDiameter: proof.outerDiameter,
        counterboreDepth: proof.counterboreDepth,
        totalDepth: proof.totalDepth,
        entryChamfered: proof.entryChamferFaceId !== undefined
      };
    case 'countersink':
      return {
        ...base,
        kind: proof.kind,
        openingPoint: vec(proof.openingPoint),
        axisDirection: vec(proof.directionIntoBody),
        boreDiameter: proof.holeDiameter,
        sinkDiameter: proof.openingDiameter,
        angleRadians: proof.angleRadians,
        countersinkDepth: proof.countersinkDepth,
        totalDepth: proof.totalDepth
      };
    case 'cylindrical-boss':
      return {
        ...base,
        kind: proof.kind,
        diameter: proof.diameter,
        height: proof.height
      };
    case 'prismatic-pocket':
      return { ...base, kind: proof.kind, depth: proof.depth };
    case 'conical-taper':
      return {
        ...base,
        kind: proof.kind,
        referenceRadius: proof.referenceRadius,
        oppositeRadius: proof.oppositeRadius,
        length: proof.length,
        angleRadians: proof.angleRadians
      };
  }
}

function publishedFaceHashes(
  faceIds: readonly number[],
  identities: ReadonlyMap<number, ImportedRecognitionFaceIdentity>
): number[] | null {
  const hashes = faceIds.flatMap((faceId) => {
    const identity = identities.get(faceId);
    return identity ? [identity.hash] : [];
  });
  return hashes.length === faceIds.length ? hashes : null;
}

function publishedKernelFeature(
  seedFaceId: number,
  participatingFaceIds: readonly number[],
  identities: ReadonlyMap<number, ImportedRecognitionFaceIdentity>,
  measurements:
    | { kind: 'prismatic-pocket'; depth: number }
    | {
        kind: 'fillet-band';
        radius: number;
        length: number;
        sense: 'concave' | 'convex';
      }
): RecognizedImportedFeature | null {
  const seed = identities.get(seedFaceId);
  const participatingFaceHashes = publishedFaceHashes(
    participatingFaceIds,
    identities
  );
  if (!seed || !participatingFaceHashes) {
    return null;
  }
  return {
    seedFaceHash: seed.hash,
    ...(seed.reference ? { seedFaceReference: seed.reference } : {}),
    participatingFaceHashes,
    provenance: 'kernel-recognized',
    ...measurements
  };
}

/**
 * Recognize every full cylindrical/conical seed once, then every planar
 * floor seed with a proved straight-edge loop, then read the kernel's own
 * recognizer for the families the exact proofs did not already claim.
 *
 * Shared support planes do not count as overlap: two holes in one plate
 * legitimately share an opening face, while their owned walls/floors remain
 * disjoint.
 *
 * Authority is fixed per family. An exactly proved hole, counterbore,
 * countersink, boss, taper or prismatic pocket is published unchanged when
 * the kernel agrees with it or says nothing about it, and withdrawn —
 * together with every kernel claim over the same faces — when the kernel
 * contradicts it. A pocket or fillet band with no exact proof is published
 * from a verified kernel claim, marked `kernel-recognized` and read-only,
 * and only on faces no exact proof touched, so no consumer can be shown two
 * answers for one feature.
 *
 * Planar seeds publish no UI or AI edit: pocket/boss/taper families have no
 * coordinated direct-edit replay, the Inspector renders them read-only, and
 * the assistant's edit binding accepts only the hole-family proofs.
 */
export function collectRecognizedImportedFeatures(
  kernel: RemusKernel,
  solid: number,
  identities: ReadonlyMap<number, ImportedRecognitionFaceIdentity>
): RecognizedImportedFeature[] {
  const query = new RemusImportedFeatureQuery(kernel, solid);
  const claimedOwnedFaces = new Set<string>();
  const exactProofs: ImportedFeatureProof[] = [];
  const attemptSeed = (face: number): void => {
    const result = recognizeImportedFeature(query, String(face));
    if (result.status !== 'recognized') {
      return;
    }
    const owned = featureOwnedFaceIds(result.proof);
    if (owned.some((faceId) => claimedOwnedFaces.has(faceId))) {
      return;
    }
    if (!publishedProof(result.proof, identities)) {
      return;
    }
    owned.forEach((faceId) => claimedOwnedFaces.add(faceId));
    exactProofs.push(result.proof);
  };
  for (const face of kernel.getSolidFaces(solid)) {
    const candidate = query.getFace(String(face));
    if (
      candidate?.surface.kind !== 'cylinder' &&
      candidate?.surface.kind !== 'cone'
    ) {
      continue;
    }
    if (Math.abs(candidate.surface.sweepRadians - FULL_REVOLUTION) > 1e-5) {
      continue;
    }
    attemptSeed(face);
  }
  for (const face of listPlanarFloorSeeds(kernel, solid, query)) {
    attemptSeed(face);
  }

  const claims = readKernelFeatureClaims(kernel, solid);
  const recognized: RecognizedImportedFeature[] = [];
  // Faces an exact proof touched are off limits to the kernel's families even
  // when the proof itself was withdrawn: a contradiction must cost both
  // answers, not promote the kernel's.
  const exactFaces = new Set<string>();
  for (const proof of exactProofs) {
    proof.participatingFaceIds.forEach((faceId) => exactFaces.add(faceId));
    if (claims && crossCheckHoleClaims(proof, claims) === 'contradicted') {
      continue;
    }
    const published = publishedProof(proof, identities);
    if (published) {
      recognized.push(published);
    }
  }
  if (!claims) {
    // The seed-ambiguity guard belongs to the published contract, not to the
    // kernel-claim path: an unreadable or absent payload must not publish a
    // pair that the claims path would have dropped.
    return withoutAmbiguousSeeds(recognized);
  }

  const adjacency = new SolidFaceAdjacency(kernel, solid);
  const kernelFaces = new Set<number>();
  const isFree = (faceIds: readonly number[]) =>
    faceIds.every(
      (faceId) => !exactFaces.has(String(faceId)) && !kernelFaces.has(faceId)
    );
  for (const claim of claims) {
    if (claim.kind !== 'pocket') {
      continue;
    }
    const pocket = verifyKernelPocketClaim(kernel, solid, claim, adjacency);
    // The opening plane bounds the pocket but belongs to the surrounding
    // material, exactly as a hole's opening face does; it is not owned here.
    const owned = pocket
      ? [pocket.floorFaceId, ...pocket.wallFaceIds]
      : undefined;
    if (!pocket || !owned || !isFree(owned)) {
      continue;
    }
    const published = publishedKernelFeature(
      pocket.floorFaceId,
      [...owned, pocket.openingFaceId],
      identities,
      { kind: 'prismatic-pocket', depth: pocket.depth }
    );
    if (!published) {
      continue;
    }
    owned.forEach((faceId) => kernelFaces.add(faceId));
    recognized.push(published);
  }
  for (const claim of claims) {
    if (claim.kind !== 'fillet-band') {
      continue;
    }
    const band = verifyKernelFilletBandClaim(
      kernel,
      solid,
      claim,
      query,
      adjacency
    );
    if (!band || !isFree([band.faceId])) {
      continue;
    }
    const published = publishedKernelFeature(
      band.faceId,
      [band.faceId],
      identities,
      {
        kind: 'fillet-band',
        radius: band.radius,
        length: band.length,
        sense: band.sense
      }
    );
    if (!published) {
      continue;
    }
    kernelFaces.add(band.faceId);
    recognized.push(published);
  }
  return withoutAmbiguousSeeds(recognized);
}

/**
 * Drops every feature that does not own its (kind, seed face hash) pair.
 *
 * Proposals bind to an imported feature by that pair, so two features sharing
 * one would let a proposal see two different answers for the same feature. The
 * face-disjointness above makes that unreachable through geometry; this is the
 * enforcement that does not depend on it.
 */
function withoutAmbiguousSeeds(
  recognized: readonly RecognizedImportedFeature[]
): RecognizedImportedFeature[] {
  const seedKey = (feature: RecognizedImportedFeature) =>
    `${feature.kind}:${feature.seedFaceHash}`;
  const occurrences = new Map<string, number>();
  for (const feature of recognized) {
    occurrences.set(
      seedKey(feature),
      (occurrences.get(seedKey(feature)) ?? 0) + 1
    );
  }
  return recognized.filter(
    (feature) => occurrences.get(seedKey(feature)) === 1
  );
}
