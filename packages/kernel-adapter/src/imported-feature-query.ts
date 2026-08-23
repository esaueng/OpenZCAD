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
          : this.adjacencyRelation(handle, neighbor),
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
    rightHandle: number
  ): ExactFaceAdjacency['relation'] {
    const left = this.getFace(String(leftHandle))?.surface;
    const right = this.getFace(String(rightHandle))?.surface;
    if (left?.kind === 'blend' || right?.kind === 'blend') {
      return 'smooth';
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

  private readSurface(handle: number): ExactRecognitionFace['surface'] {
    const surfaceType = this.kernel.getSurfaceType(handle);
    const geometry = measureFaceGeometry(this.kernel, handle);
    if (surfaceType === 'plane' && geometry?.normal) {
      const normal = normalized(geometry.normal);
      if (normal) {
        return {
          kind: 'plane',
          origin: pointTuple(geometry.center),
          normal: pointTuple(normal),
          area: exactCircularPlanarArea(this.kernel, handle, geometry.area)
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

/**
 * Recognize every full cylindrical/conical seed once. Shared support planes do
 * not count as overlap: two holes in one plate legitimately share an opening
 * face, while their owned walls/floors remain disjoint.
 */
export function collectRecognizedImportedFeatures(
  kernel: RemusKernel,
  solid: number,
  identities: ReadonlyMap<number, ImportedRecognitionFaceIdentity>
): RecognizedImportedFeature[] {
  const query = new RemusImportedFeatureQuery(kernel, solid);
  const claimedOwnedFaces = new Set<string>();
  const recognized: RecognizedImportedFeature[] = [];
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
    const result = recognizeImportedFeature(query, String(face));
    if (result.status !== 'recognized') {
      continue;
    }
    const owned = featureOwnedFaceIds(result.proof);
    if (owned.some((faceId) => claimedOwnedFaces.has(faceId))) {
      continue;
    }
    const published = publishedProof(result.proof, identities);
    if (!published) {
      continue;
    }
    owned.forEach((faceId) => claimedOwnedFaces.add(faceId));
    recognized.push(published);
  }
  return recognized;
}
