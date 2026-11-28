/**
 * I03 stored-unit conversion, phase 4 (plan
 * `docs/plans/i03-stored-unit-conversion-plan.md` §3.2, §3.5, §6 steps 2–3):
 * re-captures every persisted topology reference of a converted document
 * from rebuilds, and checks the converted model against the original.
 *
 * Witnesses and every hash derived from them quantize on a frozen 1e-6
 * document-unit quantum (ADR-013), so scaling the integers would land a
 * fraction of them one quantum off at cell boundaries and break them
 * nondeterministically. Instead:
 *
 * 1. **Source build (record).** The source document is built cold (no
 *    history, import or measurement cache), and every reference lookup the
 *    build makes is recorded with the entity it resolved to: its exact
 *    witness, lineage identity, and for a legacy hash the scheme that hash
 *    was computed in.
 * 2. **Converted build (translate).** The converted document (the output of
 *    `convertDocumentUnits`, whose references still hold the old witnesses)
 *    is built cold. Its own reference resolution is replaced: at each lookup
 *    the old reference is mapped to the one candidate of the current
 *    build whose witness is the recorded source witness scaled by k, within
 *    {@link RECAPTURE_WINDOW_QUANTA} quanta, and, when the source entity was
 *    named, carries the same lineage name. The build then proceeds with the
 *    re-captured reference, so later features build on the same entities.
 *    The converted build never resolves an old reference on its own.
 * 3. The re-captured witness, hash and name (an imported STEP name embeds
 *    its hash) come from the converted build, never from arithmetic.
 * 4. The result is a map keyed by the JSON pointer of every place the
 *    document stores an identity (`listConversionReferenceSites`), applied
 *    purely by `applyReferenceMap` (phase 5 replays it without a kernel).
 * 5. **Verification build.** The converted document with the map applied is
 *    built cold, with nothing replaced. Every reference must resolve with no
 *    repair proposed (oracle 3), and every body must match the source build
 *    scaled by k (oracle 2, {@link unitConversionGeometryOracle}).
 *
 * Any lookup without a unique match, any stored identity the source build
 * never resolved or the converted build never looked up, and any oracle
 * mismatch refuses the whole conversion, naming the node and field.
 *
 * **Placement.** This needs the kernel, so it lives in the kernel adapter
 * beside the resolvers it observes (`reference-recapture-slot.ts`). It
 * creates its own cold adapters and claims the realm-wide hook slot, so the
 * phase-5 authoring path runs it as one task on the geometry worker's serial
 * queue, then records the map in the `units.convert` command.
 */
import {
  applyReferenceMap,
  listConversionReferenceSites,
  unitsConversionSubject,
  type ConversionReferenceMap,
  type ConversionReferenceSite,
  type ConversionReferenceValue
} from '@openzcad/document-core';
import type { SketchProfile } from '@openzcad/geometry';
import { profileContainsPoint } from '@openzcad/geometry';
import {
  millimetresPerUnit,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type FeatureId,
  type EdgeWitnessV1,
  type FaceGeometry,
  type FaceWitnessV1,
  type ProjectDocument,
  type SketchRegionProfileReference,
  type TopologyReferenceV5,
  type UnitSystem
} from '@openzcad/shared';
// Types only: `exact.ts` re-exports this module, and its graph awaits the
// Remus runtime at load. A value import back into it is an import cycle
// whose two async module inits wait on each other forever in the bundle
// (the geometry worker never got past loading the kernel), so the adapter
// factory is imported when a build runs, after `exact.ts` has loaded.
import type { ExactKernelAdapter, ExactKernelAdapterOptions } from './exact';
import type { BlendOrientationReport } from './blend-orientation';
import {
  claimReferenceRecapture,
  referenceRecaptureFeature,
  type FingerprintProbe,
  type ReferenceRecaptureClaim,
  type FingerprintScheme,
  type ReferenceRecaptureHooks
} from './reference-recapture-slot';
import { measureAreaProvenance } from './exact-measure';
import { MEASUREMENT_DEFLECTION } from './measurement-deflection';
import type { RemusKernel } from './remus-runtime';
import {
  topologyHashOfWitness,
  type LegacyTopologyHashReference,
  type TopologyResolutionCandidate,
  type TopologyResolutionResult
} from './topology-lineage';
import {
  blendOrientationCorrespondence,
  edgeEndCorrespondence,
  faceCentroidSlack,
  matchScaledTopology,
  nearScaledVector,
  positionTolerance,
  RECAPTURE_WINDOW_QUANTA,
  UNIT_CONVERSION_MEASURE_RTOL,
  type EdgeEndCorrespondence,
  type SourceTopologyEntity,
  type TopologyMatch
} from './units-witness-match';

export {
  blendOrientationCorrespondence,
  edgeEndCorrespondence,
  lineageNameFamily,
  matchScaledTopology,
  nearScaledVector,
  positionTolerance,
  recaptureWindow,
  RECAPTURE_WINDOW_QUANTA,
  scaledEdgeGeometryMatches,
  scaledFaceGeometryMatches,
  scaledWitnessMatches,
  UNIT_CONVERSION_MEASURE_RTOL,
  type BlendOrientationCorrespondence,
  type EdgeEndCorrespondence,
  type SourceTopologyEntity,
  type TopologyMatch
} from './units-witness-match';

/** What the source build resolved one profile reference to. */
export interface SourceProfileEntity {
  sourceEntityIds: string;
  area: number;
  samplePoint: { x: number; y: number };
  outline: boolean;
}

/** Relative tolerance on a profile's area against the scaled source area. */
const PROFILE_AREA_RTOL = 1e-9;

function entityKey(ids: readonly string[]): string {
  return [...ids].sort().join('|');
}

/**
 * The one current sketch profile that is the source profile scaled by
 * `factor`: bounded by the same sketch entities, of the scaled area, and
 * containing the scaled sample point the source profile reported.
 */
export function matchScaledProfile<P extends SketchProfile>(
  source: SourceProfileEntity,
  profiles: readonly P[],
  factor: number
): TopologyMatch<P> {
  const area = source.area * factor * factor;
  const point = {
    x: source.samplePoint.x * factor,
    y: source.samplePoint.y * factor
  };
  const matches = profiles.filter(
    (profile) =>
      entityKey(profile.sourceEntityIds) === source.sourceEntityIds &&
      Boolean(profile.outline) === source.outline &&
      Math.abs(profile.area - area) <=
        PROFILE_AREA_RTOL * Math.max(Math.abs(area), 1e-300) &&
      profileContainsPoint(profile, point)
  );
  if (matches.length === 1)
    return { status: 'matched', candidate: matches[0]! };
  return {
    status: matches.length === 0 ? 'missing' : 'ambiguous',
    count: matches.length
  };
}

// ---------------------------------------------------------------------------
// Keys and the build sessions
// ---------------------------------------------------------------------------

/*
 * Every lookup is keyed by the feature whose build made it (the build loop
 * reports each feature boundary) and then by what it looked up. A stored
 * identity is therefore matched and verified only from its own feature's
 * lookups: two features whose stored hashes happen to be equal (identical
 * quantized geometry on two bodies) never share a resolution, and a
 * feature that never looks its identity up (suppressed, failed, or never
 * reached) is refused rather than handed another feature's result.
 */

function topologyKey(
  reference: TopologyReferenceV5 | LegacyTopologyHashReference
): string {
  return 'producingFeatureId' in reference
    ? `v5|${reference.kind}|${reference.producingFeatureId}|${reference.lineageName}|${reference.currentHash}`
    : hashKey(reference.kind, reference.currentHash);
}

function hashKey(kind: 'face' | 'edge', hash: number): string {
  return `hash|${kind}|${hash}`;
}

function profileKey(reference: SketchRegionProfileReference): string {
  return `profile|${reference.profileId ?? ''}|${reference.regionFingerprint}`;
}

/** A lookup key qualified by the feature that made it. */
function scoped(feature: string | null, key: string): string {
  return `${feature ?? ''}#${key}`;
}

function currentScoped(key: string): string {
  return scoped(referenceRecaptureFeature(), key);
}

interface SourceTopologyRecord extends SourceTopologyEntity {
  scheme: FingerprintScheme;
}

interface SourceProfileRecord extends SourceProfileEntity {
  profileId: string;
  regionFingerprint: number;
}

function witnessHash(entity: {
  kind: 'face' | 'edge';
  witness: FaceWitnessV1 | EdgeWitnessV1;
}): number {
  return entity.kind === 'edge'
    ? topologyHashOfWitness('edge', entity.witness as EdgeWitnessV1)
    : topologyHashOfWitness('face', entity.witness as FaceWitnessV1);
}

const SCHEMES: readonly FingerprintScheme[] = [
  'witness',
  'fingerprint',
  'legacy'
];

/** A Map whose `get` reports to a callback: what the legacy resolvers call. */
class ObservedFingerprintMap extends Map<number, number[]> {
  constructor(
    source: Map<number, number[]>,
    private readonly onGet: (
      hash: number,
      direct: number[] | undefined
    ) => number[] | undefined
  ) {
    super(source);
  }

  override get(hash: number): number[] | undefined {
    return this.onGet(hash, super.get(hash));
  }

  override has(hash: number): boolean {
    return this.get(hash) !== undefined;
  }
}

/** Every asymmetric blend a build reported, by feature, in build order. */
type BlendOrientationLog = Map<string, BlendOrientationReport[]>;

function logBlendOrientation(
  log: BlendOrientationLog,
  report: BlendOrientationReport
): void {
  const feature = referenceRecaptureFeature() ?? '';
  log.set(feature, [...(log.get(feature) ?? []), report]);
}

// ---------------------------------------------------------------------------
// Tessellated-area faces (oracle 2)
// ---------------------------------------------------------------------------

/**
 * What the source build keeps of a body with a face whose area the kernel
 * only estimates, so the verification build can compare that face with its
 * own in one kernel, in one unit.
 *
 * `faceArea` is exact for planes and analytic surfaces, but on a NURBS face
 * it integrates a tessellation at the absolute chord `deflection` the
 * projection passes, {@link MEASUREMENT_DEFLECTION} model units: 0.08 mm in
 * a millimetre document, 2.03 mm in an inch one. Measured on a 40 × 12 ×
 * 10 mm box with one edge filleted 1 → 3 mm (a B-spline blend face), the
 * area at 0.08 units is 125.459 mm² built in mm, 115.899 in inches and
 * 125.140 in centimetres, converging to 125.677 mm² in all three as the
 * deflection shrinks; the volume agrees to 1e-15. Nor is the area usable
 * re-measured in a common unit: the mm face, serialized, scaled into the
 * cm build's kernel and measured there, has control points within 3e-17 cm
 * of the cm build's own face, yet measures 7.4% less at the same
 * deflection. No tolerance derived from the deflection bounds that, so the
 * area of such a face is not compared at all. In its place the scaled
 * source face and the converted face must have the same NURBS structure
 * (degrees, knots, weights) with every control point within tolerance,
 * which bounds the whole untrimmed surfaces (below), and their trimmed
 * faces must each lie on the other at sampled points, boundary included.
 */
export interface TessellatedBodyRecord {
  /** The body's solids, serialized by the source build's kernel. */
  solids: Uint8Array;
  /**
   * Per face in `topology.faces` order: its surface class, its vertex
   * positions, which check that a deserialized copy lists its faces in the
   * same order, and whether its area is a tessellation estimate.
   */
  faces: {
    surfaceType: string;
    vertices: Float64Array;
    tessellated: boolean;
  }[];
}

/** Most points sampled per face, evenly strided from its tessellation. */
const FACE_SAMPLE_POINTS = 4096;

function vertexPositions(kernel: RemusKernel, face: number): Float64Array {
  const positions: number[] = [];
  for (const vertex of kernel.getFaceVertices(face))
    positions.push(...kernel.getVertexPosition(vertex));
  return Float64Array.from(positions);
}

function faceHandles(kernel: RemusKernel, solids: readonly number[]): number[] {
  return solids.flatMap((solid) => Array.from(kernel.getSolidFaces(solid)));
}

/** Why a body's tessellated faces could not be compared. */
export interface TessellatedFailure {
  failure: string;
}

const failureText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The source build's record of a body; null when none of its faces is
 * measured by tessellation, and the reason when it cannot be recorded,
 * which refuses the body.
 */
export function recordTessellatedBody(
  kernel: RemusKernel,
  solids: readonly number[],
  faces: readonly number[]
): TessellatedBodyRecord | TessellatedFailure | null {
  let tessellated = false;
  try {
    const records = faces.map((face) => {
      const surfaceType = kernel.getSurfaceType(face);
      return {
        surfaceType,
        vertices: vertexPositions(kernel, face),
        tessellated:
          measureAreaProvenance(kernel, face, surfaceType) === undefined
      };
    });
    tessellated = records.some((record) => record.tessellated);
    if (!tessellated) return null;
    return {
      solids: kernel.serializeSolids(Uint32Array.from(solids)),
      faces: records
    };
  } catch (error) {
    return {
      failure: `the source build could not ${tessellated ? 'save' : 'classify'} the body (${failureText(error)})`
    };
  }
}

/**
 * A face's free-form surface, as `getNurbsSurfaceDataParity` reports it,
 * normalized: each direction's knots mapped affinely onto [0, 1] and the
 * weights divided by their largest, neither of which changes the surface.
 */
export interface SurfaceNet {
  structure: string;
  knotsU: number[];
  knotsV: number[];
  weights: number[];
  poles: number[];
}

/** A net from the kernel's parity record; null when it is not one. */
export function surfaceNetOf(
  data: Record<string, unknown> | null
): SurfaceNet | null {
  if (!data) return null;
  const flat = (value: unknown): number[] =>
    Array.isArray(value) ? value.flatMap(flat) : [Number(value)];
  const nbU = Number(data.nbPolesU);
  const nbV = Number(data.nbPolesV);
  const poles = flat(data.poles);
  const weights = flat(data.weights);
  const knotsU = flat(data.knotsU);
  const knotsV = flat(data.knotsV);
  if (
    !(nbU > 0 && nbV > 0) ||
    poles.length !== nbU * nbV * 3 ||
    weights.length !== nbU * nbV ||
    knotsU.length < 2 ||
    knotsV.length < 2 ||
    ![...poles, ...weights, ...knotsU, ...knotsV].every(Number.isFinite) ||
    !weights.every((weight) => weight > 0)
  )
    return null;
  const span = (knots: number[]): number[] | null => {
    const first = knots[0]!;
    const width = knots.at(-1)! - first;
    return width > 0 ? knots.map((knot) => (knot - first) / width) : null;
  };
  const u = span(knotsU);
  const v = span(knotsV);
  if (!u || !v) return null;
  const heaviest = Math.max(...weights);
  return {
    structure: JSON.stringify([
      data.degreeU,
      data.degreeV,
      nbU,
      nbV,
      data.multiplicitiesU,
      data.multiplicitiesV,
      data.isPeriodicU,
      data.isPeriodicV,
      data.isRational
    ]),
    knotsU: u,
    knotsV: v,
    weights: weights.map((weight) => weight / heaviest),
    poles
  };
}

function surfaceNet(kernel: RemusKernel, face: number): SurfaceNet | null {
  return surfaceNetOf(
    JSON.parse(kernel.getNurbsSurfaceDataParity(face)) as Record<
      string,
      unknown
    > | null
  );
}

/**
 * A bound on how far apart two surfaces are, over the whole surface, or
 * Infinity when it cannot be bounded: a different structure, knots that
 * differ at all after normalization, or weights more than half apart.
 *
 * With the same knots, S = Σ Rᵢ Pᵢ and C = Σ R′ᵢ Qᵢ, whose rational basis
 * functions Rᵢ = wᵢNᵢ / Σ wⱼNⱼ ≥ 0 each sum to 1. Write w′ᵢ = wᵢ(1 + εᵢ)
 * with |εᵢ| ≤ δ < 1, δ the largest relative weight difference. Then
 * C − S = Σ R′ᵢ (Qᵢ − Pᵢ) + Σ (R′ᵢ − Rᵢ)(Pᵢ − X) for any point X, since
 * Σ (R′ᵢ − Rᵢ) = 0. R′ᵢ / Rᵢ = (1 + εᵢ) / Σ Rⱼ(1 + εⱼ) lies in
 * [(1 − δ)/(1 + δ), (1 + δ)/(1 − δ)], so |R′ᵢ − Rᵢ| ≤ Rᵢ · 2δ/(1 − δ), and
 * with X the centre of S's control points, at most D from each of them:
 *
 *   |C − S| ≤ maxᵢ |Qᵢ − Pᵢ| + 2δ/(1 − δ) · D
 *
 * at every parameter. The measured δ goes into the bound, not an allowance,
 * so the bound is what the oracle compares with its position tolerance.
 * Identical weights (δ = 0, every non-rational net) leave the pole term.
 */
export function netDistance(a: SurfaceNet, b: SurfaceNet): number {
  const same = (x: readonly number[], y: readonly number[]) =>
    x.length === y.length && x.every((value, index) => value === y[index]);
  if (
    a.structure !== b.structure ||
    !same(a.knotsU, b.knotsU) ||
    !same(a.knotsV, b.knotsV) ||
    a.weights.length !== b.weights.length
  )
    return Infinity;
  let delta = 0;
  for (const [index, weight] of a.weights.entries())
    delta = Math.max(delta, Math.abs(b.weights[index]! - weight) / weight);
  if (!(delta <= 0.5)) return Infinity;
  const count = a.poles.length / 3;
  const centre = [0, 1, 2].map((axis) => {
    let sum = 0;
    for (let at = axis; at < a.poles.length; at += 3) sum += a.poles[at]!;
    return sum / count;
  });
  let poles = 0;
  let reach = 0;
  for (let at = 0; at < a.poles.length; at += 3) {
    poles = Math.max(
      poles,
      Math.hypot(
        a.poles[at]! - b.poles[at]!,
        a.poles[at + 1]! - b.poles[at + 1]!,
        a.poles[at + 2]! - b.poles[at + 2]!
      )
    );
    reach = Math.max(
      reach,
      Math.hypot(
        a.poles[at]! - centre[0]!,
        a.poles[at + 1]! - centre[1]!,
        a.poles[at + 2]! - centre[2]!
      )
    );
  }
  return poles + ((2 * delta) / (1 - delta)) * reach;
}

/** Tessellation vertices of a face, boundary included, at most a few thousand. */
function facePoints(kernel: RemusKernel, face: number): Float64Array {
  // Density relative to the face, so it does not depend on the unit.
  const size = Math.sqrt(
    Math.max(kernel.faceArea(face, MEASUREMENT_DEFLECTION), 0)
  );
  const mesh = kernel.tessellateFace(face, Math.max(size * 1e-2, 1e-9));
  let positions: Float64Array;
  try {
    positions = mesh.positions;
  } finally {
    mesh.free();
  }
  const count = positions.length / 3;
  const stride = Math.max(1, Math.ceil(count / FACE_SAMPLE_POINTS));
  const points: number[] = [];
  for (let vertex = 0; vertex < count; vertex += stride)
    points.push(
      positions[vertex * 3]!,
      positions[vertex * 3 + 1]!,
      positions[vertex * 3 + 2]!
    );
  return Float64Array.from(points);
}

/** The largest distance from the points to the trimmed face. */
function farthestFrom(
  kernel: RemusKernel,
  points: Float64Array,
  face: number
): number {
  if (points.length === 0) return Infinity;
  let worst = 0;
  for (let at = 0; at < points.length; at += 3) {
    const distance = kernel.pointToFaceDistance(
      points[at]!,
      points[at + 1]!,
      points[at + 2]!,
      face
    )[0];
    worst = Math.max(
      worst,
      distance !== undefined && Number.isFinite(distance) ? distance : Infinity
    );
  }
  return worst;
}

/**
 * In the verification build's kernel: the source body deserialized and
 * scaled by `factor`, then, for every source face measured by tessellation
 * and every converted such face of its surface class, how far apart they
 * are in target units. That is the larger of the control-point bound
 * ({@link netDistance}) and the farthest sampled point of either trimmed
 * face from the other trimmed face (`pointToFaceDistance`, accurate to
 * about 1e-7 model units). Infinity when the surfaces are not comparable.
 * Null when the copy cannot be made or does not list its faces in the
 * recorded order. The copies stay in the kernel until the build's adapter
 * is disposed: deleting them could free handles a later lookup reuses.
 */
export function tessellatedFaceDistances(
  kernel: RemusKernel,
  solids: readonly number[],
  faces: readonly number[],
  record: TessellatedBodyRecord,
  factor: number
): Map<number, Map<number, number>> | TessellatedFailure {
  // A pair whose control nets are already past the oracle's tolerance is
  // not projected: its distance is recorded as infinite, which refuses
  // only. The box here is the converted body's; the oracle's own box can
  // differ slightly, so the threshold is the tolerance of ten times its
  // size, which is never below the oracle's.
  let skipBeyond = Infinity;
  try {
    let extent = 0;
    for (const solid of solids)
      for (const value of kernel.boundingBox(solid))
        extent = Math.max(extent, Math.abs(value));
    if (Number.isFinite(extent) && extent > 0)
      skipBeyond = bboxTolerance(10 * extent);
  } catch {
    // Without a box every agreeing structure is projected.
  }
  let copies: number[];
  try {
    copies = Array.from(kernel.deserializeSolids(record.solids));
  } catch (error) {
    return {
      failure: `the verification build could not load the source body (${failureText(error)})`
    };
  }
  try {
    const copied = faceHandles(kernel, copies);
    if (
      copied.length !== record.faces.length ||
      !copied.every((face, index) => {
        const recorded = record.faces[index]!;
        const vertices = vertexPositions(kernel, face);
        return (
          kernel.getSurfaceType(face) === recorded.surfaceType &&
          vertices.length === recorded.vertices.length &&
          vertices.every((value, at) => value === recorded.vertices[at])
        );
      })
    )
      return {
        failure: 'the loaded source body does not list its faces as built'
      };
    const matrix = Float64Array.of(
      factor,
      0,
      0,
      0,
      0,
      factor,
      0,
      0,
      0,
      0,
      factor,
      0,
      0,
      0,
      0,
      1
    );
    const scaledFaces = faceHandles(
      kernel,
      copies.map((solid) => kernel.copyAndTransformSolid(solid, matrix))
    );
    if (
      scaledFaces.length !== record.faces.length ||
      !scaledFaces.every((face, index) => {
        const recorded = record.faces[index]!;
        const vertices = vertexPositions(kernel, face);
        return (
          kernel.getSurfaceType(face) === recorded.surfaceType &&
          vertices.length === recorded.vertices.length &&
          vertices.every((value, at) => {
            const expected = recorded.vertices[at]! * factor;
            return Math.abs(value - expected) <= positionTolerance(expected);
          })
        );
      })
    )
      return {
        failure: 'the scaled source body does not list its faces as built'
      };
    const targets = faces.flatMap((face, index) => {
      const surfaceType = kernel.getSurfaceType(face);
      return measureAreaProvenance(kernel, face, surfaceType) === undefined
        ? [{ face, index, surfaceType, net: surfaceNet(kernel, face) }]
        : [];
    });
    const targetPoints = new Map<number, Float64Array>();
    const distances = new Map<number, Map<number, number>>();
    for (const [index, recorded] of record.faces.entries()) {
      if (!recorded.tessellated) continue;
      const face = scaledFaces[index]!;
      const net = surfaceNet(kernel, face);
      let points: Float64Array | undefined;
      const row = new Map<number, number>();
      for (const target of targets) {
        if (target.surfaceType !== recorded.surfaceType) continue;
        let distance =
          net && target.net ? netDistance(net, target.net) : Infinity;
        if (!(distance <= skipBeyond)) distance = Infinity;
        // Sampled only for a surface that already agrees: an unrelated face
        // fails on its structure or control points without a projection.
        if (Number.isFinite(distance)) {
          points ??= facePoints(kernel, face);
          let theirs = targetPoints.get(target.index);
          if (!theirs) {
            theirs = facePoints(kernel, target.face);
            targetPoints.set(target.index, theirs);
          }
          distance = Math.max(
            distance,
            farthestFrom(kernel, points, target.face),
            farthestFrom(kernel, theirs, face)
          );
        }
        row.set(target.index, distance);
      }
      distances.set(index, row);
    }
    return distances;
  } catch (error) {
    return {
      failure: `the verification build could not compare the faces (${failureText(error)})`
    };
  }
}

/**
 * Records what each stored identity resolves to, per feature. Used for the
 * source build and, unchanged, for the verification build, where it shows
 * that every identity resolved, and to which entity.
 */
class RecordingSession implements ReferenceRecaptureHooks {
  readonly topology = new Map<string, SourceTopologyRecord[]>();
  readonly profiles = new Map<string, SourceProfileRecord[]>();
  readonly blends: BlendOrientationLog = new Map();
  /** Per body with a tessellated-area face, its record (source build). */
  readonly tessellatedBodies = new Map<BodyId, TessellatedBodyRecord>();
  /** Per body, how far its faces are from the source's (verification). */
  readonly faceDistances: Map<BodyId, Map<number, Map<number, number>>> =
    new Map();
  /** Per body, why its tessellated faces could not be compared. */
  readonly tessellatedFailures = new Map<BodyId, string>();

  /**
   * `against`: the source build's records and the factor to scale them by,
   * for the verification build; absent, this build records its own.
   */
  constructor(
    private readonly against?: {
      bodies: ReadonlyMap<BodyId, TessellatedBodyRecord>;
      factor: number;
    }
  ) {}

  noteBlendOrientation(report: BlendOrientationReport): void {
    logBlendOrientation(this.blends, report);
  }

  noteBodyFaces(
    bodyId: BodyId,
    kernel: RemusKernel,
    solids: readonly number[],
    faces: readonly number[]
  ): void {
    if (!this.against) {
      const record = recordTessellatedBody(kernel, solids, faces);
      if (record && 'failure' in record)
        this.tessellatedFailures.set(bodyId, record.failure);
      else if (record) this.tessellatedBodies.set(bodyId, record);
      return;
    }
    const record = this.against.bodies.get(bodyId);
    if (!record) return;
    const distances = tessellatedFaceDistances(
      kernel,
      solids,
      faces,
      record,
      this.against.factor
    );
    if ('failure' in distances)
      this.tessellatedFailures.set(bodyId, distances.failure);
    else this.faceDistances.set(bodyId, distances);
  }

  private addTopology(key: string, record: SourceTopologyRecord): void {
    const records = this.topology.get(key) ?? [];
    const hash = witnessHash(record);
    if (!records.some((other) => witnessHash(other) === hash))
      records.push(record);
    this.topology.set(key, records);
  }

  resolveTopology(
    reference: TopologyReferenceV5 | LegacyTopologyHashReference,
    _candidates: readonly TopologyResolutionCandidate[],
    _availability: unknown,
    resolve: (
      reference: TopologyReferenceV5 | LegacyTopologyHashReference
    ) => TopologyResolutionResult
  ): TopologyResolutionResult {
    const result = resolve(reference);
    if (result.status === 'resolved')
      this.addTopology(currentScoped(topologyKey(reference)), {
        kind: result.candidate.kind,
        witness: result.candidate.witness,
        ...(result.candidate.lineage
          ? { lineage: result.candidate.lineage.identity }
          : {}),
        scheme: 'witness'
      });
    return result;
  }

  fingerprintMap(
    map: Map<number, number[]>,
    probe: FingerprintProbe
  ): Map<number, number[]> {
    return new ObservedFingerprintMap(map, (hash, direct) => {
      if (direct?.length === 1) {
        const handle = direct[0]!;
        const scheme = SCHEMES.find(
          (candidate) => probe.hashOf(candidate, handle) === hash
        );
        if (scheme)
          this.addTopology(currentScoped(hashKey(probe.kind, hash)), {
            kind: probe.kind,
            witness: probe.witnessOf(handle),
            scheme
          });
      }
      return direct;
    });
  }

  resolveProfile<P extends SketchProfile>(
    reference: SketchRegionProfileReference,
    _profiles: readonly P[],
    resolve: (reference: SketchRegionProfileReference) => P
  ): P {
    const profile = resolve(reference);
    const key = currentScoped(profileKey(reference));
    const records = this.profiles.get(key) ?? [];
    if (!records.some((other) => other.profileId === profile.profileId))
      records.push({
        sourceEntityIds: entityKey(profile.sourceEntityIds),
        area: profile.area,
        samplePoint: { x: profile.samplePoint.x, y: profile.samplePoint.y },
        outline: Boolean(profile.outline),
        profileId: profile.profileId,
        regionFingerprint: profile.regionFingerprint
      });
    this.profiles.set(key, records);
    return profile;
  }
}

type TranslationFailure =
  'source-conflict' | 'missing' | 'ambiguous' | 'unresolved' | 'non-injective';

interface Translation {
  values: ConversionReferenceValue[];
  /** For a profile, the new profile id beside the fingerprint. */
  profileIds: string[];
  /** Witness hashes of the source entity and of what it re-captured to. */
  sourceWitnesses: Set<number>;
  targetWitnesses: Set<number>;
  /** For an open edge, how the matched ends correspond. */
  ends: Set<EdgeEndCorrespondence>;
  failures: Set<TranslationFailure>;
  /** Kernel message of the last failed lookup, for the refusal. */
  detail?: string;
}

function sameValue(
  left: ConversionReferenceValue,
  right: ConversionReferenceValue
): boolean {
  return typeof left === 'object' || typeof right === 'object'
    ? JSON.stringify(left) === JSON.stringify(right)
    : left === right;
}

/** Replaces every lookup with the scaled match of what the source resolved. */
class TranslatingSession implements ReferenceRecaptureHooks {
  readonly translations = new Map<string, Translation>();
  readonly blends: BlendOrientationLog = new Map();

  noteBlendOrientation(report: BlendOrientationReport): void {
    logBlendOrientation(this.blends, report);
  }

  constructor(
    private readonly source: RecordingSession,
    private readonly factor: number
  ) {}

  private entry(key: string): Translation {
    let entry = this.translations.get(key);
    if (!entry) {
      entry = {
        values: [],
        profileIds: [],
        sourceWitnesses: new Set(),
        targetWitnesses: new Set(),
        ends: new Set(),
        failures: new Set()
      };
      this.translations.set(key, entry);
    }
    return entry;
  }

  private succeed(
    key: string,
    value: ConversionReferenceValue,
    profileId?: string
  ): Translation {
    const entry = this.entry(key);
    if (!entry.values.some((other) => sameValue(other, value)))
      entry.values.push(value);
    if (profileId !== undefined && !entry.profileIds.includes(profileId))
      entry.profileIds.push(profileId);
    return entry;
  }

  private succeedTopology(
    key: string,
    value: ConversionReferenceValue,
    source: SourceTopologyRecord,
    target: { kind: 'face' | 'edge'; witness: FaceWitnessV1 | EdgeWitnessV1 }
  ): void {
    const entry = this.succeed(key, value);
    entry.sourceWitnesses.add(witnessHash(source));
    entry.targetWitnesses.add(witnessHash(target));
    const ends = edgeEndCorrespondence(
      source.witness,
      target.witness,
      this.factor
    );
    if (ends) entry.ends.add(ends);
  }

  private fail(
    key: string,
    failure: TranslationFailure,
    detail?: string
  ): void {
    const entry = this.entry(key);
    entry.failures.add(failure);
    if (detail) entry.detail = detail;
  }

  /** The one source record for `key`, or a recorded failure. */
  private sourceTopology(key: string): SourceTopologyRecord | undefined {
    const records = this.source.topology.get(key);
    if (!records) return undefined; // Never resolved in the source build.
    if (records.length !== 1) {
      this.fail(key, 'source-conflict');
      return undefined;
    }
    return records[0];
  }

  resolveTopology(
    reference: TopologyReferenceV5 | LegacyTopologyHashReference,
    candidates: readonly TopologyResolutionCandidate[],
    _availability: unknown,
    resolve: (
      reference: TopologyReferenceV5 | LegacyTopologyHashReference
    ) => TopologyResolutionResult
  ): TopologyResolutionResult {
    const key = currentScoped(topologyKey(reference));
    const source = this.sourceTopology(key);
    if (!source) return resolve(reference);
    const match = matchScaledTopology(
      source,
      candidates.map((candidate) => ({
        kind: candidate.kind,
        witness: candidate.witness,
        ...(candidate.lineage ? { lineage: candidate.lineage.identity } : {}),
        candidate
      })),
      this.factor
    );
    if (match.status !== 'matched') {
      this.fail(key, match.status);
      return resolve(reference);
    }
    const chosen = match.candidate.candidate;
    const next: TopologyReferenceV5 | LegacyTopologyHashReference =
      'producingFeatureId' in reference
        ? {
            kind: chosen.kind,
            producingFeatureId:
              chosen.lineage?.identity.producingFeatureId ??
              reference.producingFeatureId,
            lineageName:
              chosen.lineage?.identity.lineageName ?? reference.lineageName,
            currentHash: chosen.currentHash,
            witnessVersion: 1,
            witness: chosen.witness
          }
        : { kind: chosen.kind, currentHash: chosen.currentHash };
    const result = resolve(next);
    if (result.status === 'resolved' && result.candidate === chosen)
      this.succeedTopology(
        key,
        'producingFeatureId' in next ? next : next.currentHash,
        source,
        chosen
      );
    else
      this.fail(
        key,
        'unresolved',
        result.status === 'failed' ? result.message : undefined
      );
    return result;
  }

  fingerprintMap(
    map: Map<number, number[]>,
    probe: FingerprintProbe
  ): Map<number, number[]> {
    const handles = [...new Set([...map.values()].flat())];
    return new ObservedFingerprintMap(map, (hash, direct) => {
      const key = currentScoped(hashKey(probe.kind, hash));
      const source = this.sourceTopology(key);
      if (!source) return direct;
      const match = matchScaledTopology(
        source,
        handles.map((handle) => ({
          kind: probe.kind,
          witness: probe.witnessOf(handle),
          handle
        })),
        this.factor
      );
      // A legacy pick carries no name: the source record has none, so the
      // match above compared witnesses only, over every entity of the kind.
      if (match.status !== 'matched') {
        this.fail(key, match.status);
        return direct;
      }
      const handle = match.candidate.handle;
      this.succeedTopology(
        key,
        probe.hashOf(source.scheme, handle),
        source,
        match.candidate
      );
      return [handle];
    });
  }

  resolveProfile<P extends SketchProfile>(
    reference: SketchRegionProfileReference,
    profiles: readonly P[],
    resolve: (reference: SketchRegionProfileReference) => P
  ): P {
    const key = currentScoped(profileKey(reference));
    const records = this.source.profiles.get(key);
    if (!records) return resolve(reference);
    if (records.length !== 1) {
      this.fail(key, 'source-conflict');
      return resolve(reference);
    }
    const match = matchScaledProfile(records[0]!, profiles, this.factor);
    if (match.status !== 'matched') {
      this.fail(key, match.status);
      return resolve(reference);
    }
    const chosen = match.candidate;
    const next: SketchRegionProfileReference = {
      ...reference,
      regionFingerprint: chosen.regionFingerprint,
      ...(reference.profileId !== undefined
        ? { profileId: chosen.profileId }
        : {})
    };
    let resolved: P;
    try {
      resolved = resolve(next);
    } catch (error) {
      this.fail(
        key,
        'unresolved',
        error instanceof Error ? error.message : undefined
      );
      throw error;
    }
    if (resolved.profileId === chosen.profileId)
      this.succeed(key, chosen.regionFingerprint, chosen.profileId);
    else this.fail(key, 'unresolved');
    return resolved;
  }

  /**
   * Within one feature, the re-capture must be one-to-one: two distinct
   * source entities re-captured to one converted entity (or one to two)
   * would merge or split the feature's selection. Marks every lookup that
   * takes part as `non-injective`.
   */
  checkInjective(): void {
    const byFeature = new Map<string, [string, Translation][]>();
    for (const [key, translation] of this.translations) {
      if (translation.sourceWitnesses.size === 0) continue;
      const feature = key.slice(0, key.indexOf('#'));
      byFeature.set(feature, [
        ...(byFeature.get(feature) ?? []),
        [key, translation]
      ]);
    }
    for (const entries of byFeature.values()) {
      const forward = new Map<number, Set<number>>();
      const backward = new Map<number, Set<number>>();
      for (const [, translation] of entries)
        for (const from of translation.sourceWitnesses)
          for (const to of translation.targetWitnesses) {
            forward.set(from, (forward.get(from) ?? new Set()).add(to));
            backward.set(to, (backward.get(to) ?? new Set()).add(from));
          }
      for (const [, translation] of entries) {
        const split = [...translation.sourceWitnesses].some(
          (from) => forward.get(from)!.size > 1
        );
        const merged = [...translation.targetWitnesses].some(
          (to) => backward.get(to)!.size > 1
        );
        if (split || merged) translation.failures.add('non-injective');
      }
    }
  }
}

/**
 * Every asymmetric blend of the source build must be built in `build` (the
 * converted or the verification build) on edges with the same native
 * orientation: the same features, the same reports in the same order, the
 * same edge count, and each edge {@link blendOrientationCorrespondence}
 * `same`. A reversed edge would mirror the blend along the edge or across
 * it under a reference that still matches, so it refuses, naming the
 * feature and edge. Swapping the feature's radii or setbacks to follow it
 * would edit parameters, not references, and is not attempted.
 */
export function compareBlendOrientations(
  source: ReadonlyMap<string, readonly BlendOrientationReport[]>,
  build: ReadonlyMap<string, readonly BlendOrientationReport[]>,
  factor: number,
  subjectOf: (featureId: string) => string,
  buildName: string
): ConversionReferenceRefusal[] {
  const refusals: ConversionReferenceRefusal[] = [];
  const features = [...new Set([...source.keys(), ...build.keys()])].sort();
  for (const feature of features) {
    const subject = subjectOf(feature);
    const from = source.get(feature) ?? [];
    const to = build.get(feature) ?? [];
    const refuse = (field: string, message: string) =>
      refusals.push({
        code: 'blend-orientation',
        subject,
        field,
        message: `${subject}: ${message}`
      });
    if (
      from.length !== to.length ||
      from.some(
        (report, index) =>
          report.label !== to[index]!.label ||
          report.edges.length !== to[index]!.edges.length
      )
    ) {
      refuse(
        'edgeHashes',
        `the ${buildName} build applied this blend to ${to.length} edge set(s), not the source build's ${from.length}, so the direction of its edges cannot be checked.`
      );
      continue;
    }
    from.forEach((report, index) =>
      report.edges.forEach((edge, position) => {
        const order = blendOrientationCorrespondence(
          edge,
          to[index]!.edges[position]!,
          factor
        );
        if (order === 'same') return;
        const field =
          report.label === 'selection'
            ? `edgeHashes.${position}`
            : `${report.label} edge ${position}`;
        refuse(
          field,
          `${report.reads}, and in the ${buildName} build ${field} ${
            order === 'reversed'
              ? 'runs the other way or lists its faces the other way round'
              : order === 'ambiguous'
                ? 'has a direction that cannot be told apart'
                : 'no longer lies where the source edge does'
          }, so the blend would be built mirrored; refusing rather than swapping its sides.`
        );
      })
    );
  }
  return refusals;
}

// ---------------------------------------------------------------------------
// Oracle 2: the geometry
// ---------------------------------------------------------------------------

/**
 * Bounding-box tolerance in target units: the kernel's 1e-6 model-unit
 * direct-edit tolerance (`DIRECT_EDIT_TOLERANCE`), plus 1e-9 of the box's
 * own scale for floating-point growth on large parts.
 */
function bboxTolerance(scale: number): number {
  return 1e-6 + 1e-9 * scale;
}

export type ConversionReferenceRefusalCode =
  | 'unsupported-unit'
  | 'busy'
  | 'source-unresolved'
  | 'not-recaptured'
  | 'missing-match'
  | 'ambiguous-match'
  | 'conflict'
  | 'endpoint-order'
  | 'blend-orientation'
  | 'apply-refused'
  | 'unresolved-after-apply'
  | 'reference-repair'
  | 'geometry-mismatch'
  | 'warnings-differ';

export interface ConversionReferenceRefusal {
  code: ConversionReferenceRefusalCode;
  /** A node (`Fillet 1 (feat_…)`), a body, or `document`. */
  subject: string;
  field?: string;
  message: string;
}

/** Summed face area, leaving out the faces at `skip` (by index). */
function faceAreaOf(
  body: BodyRepresentation,
  skip?: ReadonlySet<number>
): number | undefined {
  const faces = body.topology?.faces;
  if (!faces || faces.length === 0) return undefined;
  let area = 0;
  for (const [index, face] of faces.entries()) {
    if (!face.geometry) return undefined;
    if (!skip?.has(index)) area += face.geometry.area;
  }
  return area;
}

/**
 * Oracle 2's evidence for the faces whose area is a tessellation estimate
 * (see {@link TessellatedBodyRecord}): per body, for each such source face
 * by index, how far it lies, scaled by k, from each converted face of its
 * surface class, by index, in target units ({@link tessellatedFaceDistances}).
 * A body with such a face but without an entry, or whose entry does not
 * cover exactly those faces, refuses; its area is never compared instead.
 */
export type TessellatedFaceEvidence = ReadonlyMap<
  BodyId,
  ReadonlyMap<number, ReadonlyMap<number, number>>
>;

function tessellatedFaceEvidence(
  records: ReadonlyMap<BodyId, TessellatedBodyRecord>,
  distances: ReadonlyMap<
    BodyId,
    ReadonlyMap<number, ReadonlyMap<number, number>>
  >
): TessellatedFaceEvidence {
  const evidence = new Map<
    BodyId,
    ReadonlyMap<number, ReadonlyMap<number, number>>
  >();
  for (const [body, record] of records) {
    const measured = distances.get(body);
    const sampled = [...record.faces.entries()]
      .filter(([, face]) => face.tessellated)
      .map(([index]) => index);
    if (
      measured &&
      measured.size === sampled.length &&
      sampled.every((index) => measured.has(index))
    )
      evidence.set(body, measured);
  }
  return evidence;
}

/** A body's faces the kernel measures by tessellation, by index. */
function tessellatedIndices(body: BodyRepresentation): Set<number> {
  const indices = new Set<number>();
  for (const [index, face] of (body.topology?.faces ?? []).entries())
    if (face.geometry && face.geometry.areaProvenance === undefined)
      indices.add(index);
  return indices;
}

interface TessellatedFaces {
  source: ReadonlySet<number>;
  converted: ReadonlySet<number>;
  distances: ReadonlyMap<number, ReadonlyMap<number, number>>;
}

/**
 * The evidence for one body, when it covers exactly the source faces the
 * projection marks as tessellated (no `areaProvenance`); otherwise null.
 */
function tessellatedFacesOf(
  from: BodyRepresentation,
  to: BodyRepresentation,
  distances: ReadonlyMap<number, ReadonlyMap<number, number>> | undefined
): TessellatedFaces | null {
  if (!distances) return null;
  const source = tessellatedIndices(from);
  if (
    source.size === 0 ||
    source.size !== distances.size ||
    ![...source].every((index) => distances.has(index))
  )
    return null;
  return { source, converted: tessellatedIndices(to), distances };
}

function relativeMismatch(
  target: number,
  expected: number,
  rtol: number
): boolean {
  return (
    Math.abs(target - expected) > rtol * Math.max(Math.abs(expected), 1e-300)
  );
}

/** What the geometry oracle compared, for the report. */
export interface GeometryOracleStats {
  bodies: number;
  volumes: number;
  areas: number;
  /** Faces compared one by one (area, surface class, centre, centroid). */
  faces: number;
  /**
   * Of those, faces whose area is a tessellation estimate, compared by
   * their surfaces and trimmed faces instead of by area.
   */
  sampledFaces: number;
  /** Datum planes, axes, points and coordinate systems compared. */
  datums: number;
}

/**
 * Datum direction tolerance: unit-vector components, which do not scale. A
 * datum is derived from exact kernel positions, so the two builds agree to
 * floating-point noise; a datum moved onto other geometry differs by far
 * more.
 */
const DATUM_DIRECTION_TOLERANCE = 1e-9;

type Vector = { x: number; y: number; z: number };

/**
 * Every datum the source build resolved must resolve in the converted build
 * at the source's position scaled by `factor` and with the same directions.
 * A datum owns no body, so without this a datum moved onto other geometry
 * (a vertex re-captured at the other end of its edge) passes every body
 * check.
 */
function compareDatums(
  source: DerivedState,
  converted: DerivedState,
  factor: number,
  mismatch: (subject: string, field: string, message: string) => void
): number {
  const groups: [
    string,
    Record<string, Record<string, Vector>> | undefined,
    Record<string, Record<string, Vector>> | undefined,
    readonly string[],
    readonly string[]
  ][] = [
    [
      'datumFrames',
      source.datumFrames as never,
      converted.datumFrames as never,
      ['origin'],
      ['u', 'v', 'normal']
    ],
    [
      'datumAxes',
      source.datumAxes as never,
      converted.datumAxes as never,
      ['origin'],
      ['direction']
    ],
    [
      'datumCsys',
      source.datumCsys as never,
      converted.datumCsys as never,
      ['origin'],
      ['x', 'y', 'z']
    ]
  ];
  let compared = 0;
  const check = (
    subject: string,
    field: string,
    from: Vector,
    to: Vector,
    scaled: boolean
  ) => {
    const expected = scaled
      ? { x: from.x * factor, y: from.y * factor, z: from.z * factor }
      : from;
    // Per component (review): a tolerance taken from the largest
    // coordinate let a datum far out on X drift on Y.
    const tolerance = (value: number) =>
      scaled ? positionTolerance(value) : DATUM_DIRECTION_TOLERANCE;
    for (const axis of ['x', 'y', 'z'] as const)
      if (!(Math.abs(to[axis] - expected[axis]) <= tolerance(expected[axis])))
        mismatch(
          subject,
          `${field}.${axis}`,
          `The datum's ${field}.${axis} is ${to[axis]}, not ${scaled ? `${from[axis]} × ${factor} = ` : ''}${expected[axis]}.`
        );
  };
  const presence = (
    group: string,
    from: Record<string, unknown> | undefined,
    to: Record<string, unknown> | undefined
  ): string[] => {
    const ids = [
      ...new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})])
    ].sort();
    return ids.filter((id) => {
      if (from?.[id] && to?.[id]) return true;
      mismatch(
        `datum ${id}`,
        group,
        `The datum resolves only in the ${from?.[id] ? 'source' : 'converted'} build.`
      );
      return false;
    });
  };
  for (const [group, from, to, positions, directions] of groups)
    for (const id of presence(group, from, to)) {
      compared += 1;
      for (const field of positions)
        check(
          `datum ${id}`,
          `${group}.${field}`,
          from![id]![field]!,
          to![id]![field]!,
          true
        );
      for (const field of directions)
        check(
          `datum ${id}`,
          `${group}.${field}`,
          from![id]![field]!,
          to![id]![field]!,
          false
        );
    }
  for (const id of presence(
    'datumPoints',
    source.datumPoints,
    converted.datumPoints
  )) {
    compared += 1;
    check(
      `datum ${id}`,
      'datumPoints',
      source.datumPoints![id as FeatureId]!,
      converted.datumPoints![id as FeatureId]!,
      true
    );
  }
  return compared;
}

type MeasuredFace = FaceGeometry & { readonly index: number };

function measuredFaces(body: BodyRepresentation): MeasuredFace[] | undefined {
  const faces = body.topology?.faces;
  if (!faces || faces.length === 0) return undefined;
  const measured: MeasuredFace[] = [];
  for (const [index, face] of faces.entries()) {
    if (!face.geometry) return undefined;
    measured.push({ ...face.geometry, index });
  }
  return measured;
}

/**
 * Face by face: every source face, scaled by `factor`, must be matched by as
 * many converted faces as there are source faces it cannot be told from
 * (same surface class, area ×k², vertex-mean centre and planar area centroid
 * ×k). Totals cannot see a blend built mirrored on a symmetric body: an
 * asymmetric fillet or chamfer whose sides swapped keeps the volume, the
 * total area and the counts, but moves the area centroid of every face it
 * trims. A face whose area is a tessellation estimate is matched by the
 * kernel's surface and trim comparison instead of its area, one to one
 * (`tessellated`). Returns how many faces were compared, and how many of
 * them that way.
 */
function compareFaces(
  from: BodyRepresentation,
  to: BodyRepresentation,
  factor: number,
  scale: number,
  mismatch: (field: string, message: string) => void,
  tessellated: TessellatedFaces | null
): { faces: number; sampledFaces: number } {
  const source = measuredFaces(from);
  const converted = measuredFaces(to);
  if (!source || !converted) return { faces: 0, sampledFaces: 0 };
  // Positions here tell faces apart; the box and volume checks carry the
  // precision. An imported body's vertices carry the import's own noise
  // (about 1e-6 mm on a 40 mm plate brought back from inches), so each
  // position gets 1e-6 of the body's scale, and a centroid integrated over
  // an inscribed polygon (a curved boundary) twice that. A blend built
  // mirrored moves a trimmed face's centroid by a fraction of the blend.
  const slack = (face: MeasuredFace) => faceCentroidSlack(face, scale);
  const close = nearScaledVector;
  // A tessellated face's area is not comparable across units (see
  // TessellatedBodyRecord), so across the builds it is matched instead by
  // the kernel's surface and trimmed-face distance, within the bounding
  // box's kernel tolerance, and one to one (below).
  const sameArea = (
    a: MeasuredFace,
    b: MeasuredFace,
    k: number,
    across: boolean
  ) => {
    if (
      !across ||
      !tessellated ||
      (!tessellated.source.has(a.index) && !tessellated.converted.has(b.index))
    )
      return !relativeMismatch(
        b.area,
        a.area * k * k,
        UNIT_CONVERSION_MEASURE_RTOL
      );
    if (!tessellated.source.has(a.index) || !tessellated.converted.has(b.index))
      return false;
    const distance = tessellated.distances.get(a.index)?.get(b.index);
    return distance !== undefined && distance <= bboxTolerance(scale);
  };
  const alike = (
    a: MeasuredFace,
    b: MeasuredFace,
    k: number,
    across: boolean
  ) =>
    a.surfaceType === b.surfaceType &&
    sameArea(a, b, k, across) &&
    close(b.center, a.center, k, 1e-6 * scale) &&
    close(b.centroid, a.centroid, k, Math.max(slack(a), slack(b)));
  let sampledFaces = 0;
  for (const face of source) {
    if (tessellated?.source.has(face.index)) {
      sampledFaces += 1;
      continue;
    }
    const twins = source.filter((other) => alike(face, other, 1, false)).length;
    const matches = converted.filter((other) =>
      alike(face, other, factor, true)
    ).length;
    if (matches !== twins)
      mismatch(
        `faces.${face.index}`,
        `The ${face.surfaceType} face ${face.index} (area ${face.area}) is matched by ${matches} converted face(s) of its area and position scaled by ${factor}, not ${twins}.`
      );
  }
  // Tessellated faces pair one to one: without their areas, two source
  // faces could otherwise both claim one converted face and leave another
  // unchecked. Any face matched by other than exactly one refuses.
  if (tessellated) {
    for (const face of source) {
      if (!tessellated.source.has(face.index)) continue;
      const matches = converted.filter((other) =>
        alike(face, other, factor, true)
      ).length;
      if (matches !== 1)
        mismatch(
          `faces.${face.index}`,
          `The ${face.surfaceType} face ${face.index} is matched by ${matches} converted face(s) of its surface, trim and position scaled by ${factor}, not exactly one.`
        );
    }
    for (const face of converted) {
      if (!tessellated.converted.has(face.index)) continue;
      const matches = source.filter((other) =>
        alike(other, face, factor, true)
      ).length;
      if (matches !== 1)
        mismatch(
          `convertedFaces.${face.index}`,
          `The converted ${face.surfaceType} face ${face.index} matches ${matches} source face(s) of its surface, trim and position, not exactly one.`
        );
    }
  }
  return { faces: source.length, sampledFaces };
}

/**
 * Oracle 2 (plan §6 step 2): every body of the converted build is the
 * source body scaled by `factor`. Compares per body: the bounding box
 * (solid bounds where both builds publish them) within kernel tolerance;
 * volume ×k³ and summed face area ×k², relative
 * {@link UNIT_CONVERSION_MEASURE_RTOL}; face, edge and vertex counts and
 * the consumed/exportable flags exactly; and the exportable body set and
 * the warnings exactly. The projection publishes no per-body solid count,
 * so solids are covered by the body set and the topology counts. With
 * `tessellatedEvidence` for a body, the faces whose area the kernel only
 * estimates by tessellation leave the area total and are matched by sampled
 * surfaces and trimmed faces instead, one to one (see
 * {@link TessellatedBodyRecord}).
 */
export function unitConversionGeometryOracle(
  source: DerivedState,
  converted: DerivedState,
  factor: number,
  tessellatedEvidence: TessellatedFaceEvidence = new Map(),
  /** Per body, why its tessellated faces could not be compared. */
  tessellatedFailures: ReadonlyMap<BodyId, string> = new Map()
): { refusals: ConversionReferenceRefusal[]; stats: GeometryOracleStats } {
  const refusals: ConversionReferenceRefusal[] = [];
  const stats: GeometryOracleStats = {
    bodies: 0,
    volumes: 0,
    areas: 0,
    faces: 0,
    sampledFaces: 0,
    datums: 0
  };
  const mismatch = (subject: string, field: string, message: string) =>
    refusals.push({ code: 'geometry-mismatch', subject, field, message });
  const ids = [
    ...new Set([
      ...Object.keys(source.bodyRepresentations),
      ...Object.keys(converted.bodyRepresentations)
    ])
  ].sort() as BodyId[];
  for (const id of ids) {
    const from = source.bodyRepresentations[id];
    const to = converted.bodyRepresentations[id];
    const subject = `${(from ?? to)!.name} (${id})`;
    if (!from || !to) {
      mismatch(
        subject,
        'body',
        `The body exists only in the ${from ? 'source' : 'converted'} build.`
      );
      continue;
    }
    stats.bodies += 1;
    const before = refusals.length;
    const counts: [string, number | undefined, number | undefined][] = [
      ['faceCount', from.faceCount, to.faceCount],
      ['faces', from.topology?.faces.length, to.topology?.faces.length],
      ['edges', from.topology?.edges.length, to.topology?.edges.length],
      [
        'vertices',
        from.topology?.vertices?.length,
        to.topology?.vertices?.length
      ],
      [
        'importedStepDeclaredSolidCount',
        from.importedStepDeclaredSolidCount,
        to.importedStepDeclaredSolidCount
      ]
    ];
    for (const [field, a, b] of counts)
      if (a !== b) mismatch(subject, field, `${field} ${a} became ${b}.`);
    if (from.consumed !== to.consumed)
      mismatch(
        subject,
        'consumed',
        'Whether a later feature consumes the body changed.'
      );
    if (from.exportableStep !== to.exportableStep)
      mismatch(
        subject,
        'exportableStep',
        'Whether the body exports to STEP changed.'
      );

    const boxFrom =
      from.solidBounds && to.solidBounds ? from.solidBounds : from.bbox;
    const boxTo = from.solidBounds && to.solidBounds ? to.solidBounds : to.bbox;
    const corners = [
      ...(['x', 'y', 'z'] as const).map((axis) => [
        `min.${axis}`,
        boxFrom.min[axis],
        boxTo.min[axis]
      ]),
      ...(['x', 'y', 'z'] as const).map((axis) => [
        `max.${axis}`,
        boxFrom.max[axis],
        boxTo.max[axis]
      ])
    ] as [string, number, number][];
    const scale = Math.max(...corners.map(([, a]) => Math.abs(a * factor)));
    for (const [field, a, b] of corners)
      if (Math.abs(b - a * factor) > bboxTolerance(scale))
        mismatch(
          subject,
          `bbox.${field}`,
          `The bounding box ${field} is ${b}, not ${a} × ${factor} = ${a * factor}.`
        );

    if (!from.meshReference && !to.meshReference) {
      stats.volumes += 1;
      const expected = from.volume * factor ** 3;
      if (relativeMismatch(to.volume, expected, UNIT_CONVERSION_MEASURE_RTOL))
        mismatch(
          subject,
          'volume',
          `The volume is ${to.volume}, not ${from.volume} × k³ = ${expected}.`
        );
    }
    // Tessellated faces leave the total: their areas are compared by
    // surface and trim face by face below, and refused there if they differ.
    const tessellated = tessellatedFacesOf(
      from,
      to,
      tessellatedEvidence.get(id)
    );
    // A body with such a face and no complete comparison refuses: its
    // area is never evidence across units, and without the surface
    // comparison material could move unseen (patches swapped in and out
    // on a symmetric body keep every other measure).
    const fromTessellated = tessellatedIndices(from);
    const toTessellated = tessellatedIndices(to);
    if (!tessellated && (fromTessellated.size > 0 || toTessellated.size > 0))
      mismatch(
        subject,
        'tessellatedFaces',
        `${fromTessellated.size} face(s) whose area the kernel only estimates (${toTessellated.size} converted) could not be compared surface to surface: ${tessellatedFailures.get(id) ?? 'no comparison was made'}. Their areas cannot be compared across units.`
      );
    if (tessellated && tessellated.source.size !== tessellated.converted.size)
      mismatch(
        subject,
        'sampledFaces',
        `${tessellated.source.size} faces measured by tessellation became ${tessellated.converted.size}.`
      );
    const areaFrom = faceAreaOf(from, tessellated?.source ?? fromTessellated);
    const areaTo = faceAreaOf(to, tessellated?.converted ?? toTessellated);
    if ((areaFrom === undefined) !== (areaTo === undefined))
      mismatch(subject, 'area', 'Only one build measured the face areas.');
    else if (areaFrom !== undefined && areaTo !== undefined) {
      stats.areas += 1;
      const expected = areaFrom * factor ** 2;
      if (relativeMismatch(areaTo, expected, UNIT_CONVERSION_MEASURE_RTOL))
        mismatch(
          subject,
          'area',
          `The surface area is ${areaTo}, not ${areaFrom} × k² = ${expected}.`
        );
    }
    // Face by face only for a body whose totals matched: past a total that
    // already refused, every face it changed would repeat the refusal.
    if (refusals.length === before) {
      const compared = compareFaces(
        from,
        to,
        factor,
        scale,
        (field, message) => mismatch(subject, field, message),
        tessellated
      );
      stats.faces += compared.faces;
      stats.sampledFaces += compared.sampledFaces;
    }
  }
  stats.datums = compareDatums(source, converted, factor, mismatch);
  const exportFrom = [...source.exportableBodyIds].sort();
  const exportTo = [...converted.exportableBodyIds].sort();
  if (JSON.stringify(exportFrom) !== JSON.stringify(exportTo))
    mismatch(
      'document',
      'exportableBodyIds',
      `The exportable bodies changed from [${exportFrom.join(', ')}] to [${exportTo.join(', ')}].`
    );
  if (JSON.stringify(source.warnings) !== JSON.stringify(converted.warnings))
    refusals.push({
      code: 'warnings-differ',
      subject: 'document',
      field: 'warnings',
      message: `The build warnings changed from ${JSON.stringify(source.warnings)} to ${JSON.stringify(converted.warnings)}.`
    });
  return { refusals, stats };
}

// ---------------------------------------------------------------------------
// The whole computation
// ---------------------------------------------------------------------------

const CONVERTIBLE: readonly UnitSystem[] = ['mm', 'cm', 'inch'];

export interface ConversionReferenceMapOptions {
  /**
   * Makes the cold adapter for each of the three builds; one per build, and
   * each is disposed after it. The default is an exact adapter with every
   * history, import, mesh and measurement cache disabled.
   */
  createAdapter?: () => Promise<ExactKernelAdapter>;
  /** Passed to the default adapter for reference-form imports. */
  resolveSourceBytes?: ExactKernelAdapterOptions['resolveSourceBytes'];
}

export interface ConversionReferenceReport {
  /** k: millimetres per source unit over millimetres per target unit. */
  factor: number;
  sites: {
    topology: number;
    hash: number;
    profileId: number;
    /** Datum vertex ends and fillet end radii / edge runs. */
    edgeEnd: number;
  };
  geometry: GeometryOracleStats;
  /** Wall-clock milliseconds of each build. */
  timings: { source: number; translate: number; verify: number };
}

export type ConversionReferenceMapResult =
  | {
      ok: true;
      references: ConversionReferenceMap;
      /** The converted document with `references` applied and verified. */
      document: ProjectDocument;
      report: ConversionReferenceReport;
    }
  | {
      ok: false;
      refusals: ConversionReferenceRefusal[];
      report?: ConversionReferenceReport;
    };

async function coldBuild(
  claim: ReferenceRecaptureClaim,
  document: ProjectDocument,
  hooks: ReferenceRecaptureHooks,
  options: ConversionReferenceMapOptions
): Promise<{ derived: DerivedState; milliseconds: number }> {
  const adapter = options.createAdapter
    ? await options.createAdapter()
    : await (
        await import('./exact')
      ).createExactKernelAdapter({
        historyCheckpointLimit: 0,
        importedStepCacheBytes: 0,
        importedMeshCacheBytes: 0,
        measuredShapeCacheBytes: 0,
        ...(options.resolveSourceBytes
          ? { resolveSourceBytes: options.resolveSourceBytes }
          : {})
      });
  const started = performance.now();
  try {
    const derived = await claim.build(hooks, () =>
      adapter.syncDocument(document)
    );
    return { derived, milliseconds: performance.now() - started };
  } finally {
    adapter.dispose();
  }
}

/**
 * The feature whose build looks up each node's stored identities: a
 * feature node's own, and for a sketch or one of its objects the sketch
 * feature that builds it. A node with none (or more than one) maps to
 * nothing, and its sites are refused as never resolved.
 */
function siteFeatures(document: ProjectDocument): Map<string, string> {
  const byNode = new Map<string, string>();
  const sketchFeatures = new Map<string, string[]>();
  for (const node of Object.values(document.nodes)) {
    if (node.kind !== 'feature') continue;
    byNode.set(node.id, node.featureId);
    if (node.data.featureKind === 'sketch')
      sketchFeatures.set(node.data.sketchId, [
        ...(sketchFeatures.get(node.data.sketchId) ?? []),
        node.featureId
      ]);
  }
  for (const node of Object.values(document.nodes)) {
    if (node.kind !== 'sketch') continue;
    const features = sketchFeatures.get(node.sketchId);
    if (features?.length !== 1) continue;
    byNode.set(node.id, features[0]!);
    for (const objectId of node.objectIds)
      if (document.nodes[objectId]?.kind === 'sketch-object')
        byNode.set(objectId, features[0]!);
  }
  return byNode;
}

/** One line per repair a build proposed: its kind, feature and extent. */
function repairAdvice(derived: DerivedState): string[] {
  return [
    ...(derived.referenceRepairs ?? []).map(
      (repair) =>
        `edge references ${repair.featureId} ×${repair.edgeReferences.length}`
    ),
    ...(derived.faceReferenceRepairs ?? []).map(
      (repair) => `face reference ${repair.featureId} ${repair.role ?? 'face'}`
    ),
    ...(derived.edgeHashRepairs ?? []).map(
      (repair) => `edge hashes ${repair.featureId} ×${repair.to.length}`
    )
  ].sort();
}

function failureRefusal(
  site: ConversionReferenceSite,
  translation: Translation | undefined,
  everResolvedInSource: boolean
): ConversionReferenceRefusal {
  const where = { subject: site.subject, field: site.field };
  if (!everResolvedInSource)
    return {
      code: 'source-unresolved',
      ...where,
      message: `${site.subject}: the source build never resolved ${site.field} while building this feature, so it cannot be re-captured.`
    };
  const failures = translation?.failures ?? new Set<TranslationFailure>();
  if (failures.has('source-conflict'))
    return {
      code: 'conflict',
      ...where,
      message: `${site.subject}: ${site.field} resolved to different entities during the source build.`
    };
  if (failures.has('ambiguous'))
    return {
      code: 'ambiguous-match',
      ...where,
      message: `${site.subject}: more than one converted entity matches ${site.field} within ${RECAPTURE_WINDOW_QUANTA} quanta; they are too close to tell apart.`
    };
  if (failures.has('missing'))
    return {
      code: 'missing-match',
      ...where,
      message: `${site.subject}: no converted entity matches ${site.field} scaled to the new unit.`
    };
  if (failures.has('unresolved'))
    return {
      code: 'missing-match',
      ...where,
      message: `${site.subject}: the re-captured ${site.field} did not resolve${translation?.detail ? ` (${translation.detail})` : ''}.`
    };
  return {
    code: 'not-recaptured',
    ...where,
    message: `${site.subject}: the converted build never looked up ${site.field}.`
  };
}

/** What one site re-captured to, gathered from its feature's lookups. */
interface SiteCapture {
  /** The lookup keys (feature-scoped) the site's identity may be under. */
  keys: string[];
  values: ConversionReferenceValue[];
  translations: Translation[];
}

/**
 * The feature-scoped lookup keys a site's stored identity is looked up
 * under: a v5 reference by its whole identity, a profile by its
 * fingerprint and id, and a bare hash as a legacy face or edge pick or as
 * the hash of a v5 reference the same feature looked up.
 */
function siteKeys(
  site: Exclude<ConversionReferenceSite, { kind: 'edge-end' }>,
  feature: string,
  lookedUp: Iterable<string>
): string[] {
  if (site.kind === 'topology')
    return [scoped(feature, topologyKey(site.reference))];
  if (site.kind === 'profile-id' || site.profile)
    return [scoped(feature, profileKey(site.profile!))];
  const keys = [
    scoped(feature, hashKey('face', site.hash)),
    scoped(feature, hashKey('edge', site.hash))
  ];
  const prefix = scoped(feature, 'v5|');
  for (const key of lookedUp)
    if (key.startsWith(prefix) && key.endsWith(`|${site.hash}`)) keys.push(key);
  return keys;
}

function distinctValues(
  values: readonly ConversionReferenceValue[]
): ConversionReferenceValue[] {
  return values.filter(
    (value, index) =>
      values.findIndex((other) => sameValue(other, value)) === index
  );
}

/**
 * Re-captures every persisted reference of `converted` (the output of
 * `convertDocumentUnits(source, …)`) and verifies the result by rebuilding
 * (plan §3.2, §6 steps 2–3). See the module comment.
 */
export async function computeConversionReferenceMap(
  source: ProjectDocument,
  converted: ProjectDocument,
  options: ConversionReferenceMapOptions = {}
): Promise<ConversionReferenceMapResult> {
  for (const unit of [source.units, converted.units])
    if (!CONVERTIBLE.includes(unit))
      return {
        ok: false,
        refusals: [
          {
            code: 'unsupported-unit',
            subject: 'document',
            message: `Stored units convert only between millimetres, centimetres and inches, not "${unit}".`
          }
        ]
      };
  // Claimed before the first await, so a concurrent caller is refused here.
  const claim = claimReferenceRecapture();
  if (!claim)
    return {
      ok: false,
      refusals: [
        {
          code: 'busy',
          subject: 'document',
          message: 'Another stored-unit conversion is being checked; try again.'
        }
      ]
    };
  try {
    return await recapture(claim, source, converted, options);
  } finally {
    claim.release();
  }
}

async function recapture(
  claim: ReferenceRecaptureClaim,
  source: ProjectDocument,
  converted: ProjectDocument,
  options: ConversionReferenceMapOptions
): Promise<ConversionReferenceMapResult> {
  const factor =
    millimetresPerUnit(source.units) / millimetresPerUnit(converted.units);

  const recorded = new RecordingSession();
  const sourceBuild = await coldBuild(claim, source, recorded, options);
  const translating = new TranslatingSession(recorded, factor);
  const translateBuild = await coldBuild(
    claim,
    converted,
    translating,
    options
  );
  translating.checkInjective();

  const featureSubjects = new Map<string, string>();
  for (const node of Object.values(converted.nodes))
    if (node.kind === 'feature')
      featureSubjects.set(node.featureId, unitsConversionSubject(node));
  const subjectOfFeature = (feature: string) =>
    featureSubjects.get(feature) ??
    (feature === '' ? 'document' : `feature ${feature}`);

  const sites = listConversionReferenceSites(converted);
  const features = siteFeatures(converted);
  const report: ConversionReferenceReport = {
    factor,
    sites: {
      topology: sites.filter((site) => site.kind === 'topology').length,
      hash: sites.filter((site) => site.kind === 'hash').length,
      profileId: sites.filter((site) => site.kind === 'profile-id').length,
      edgeEnd: sites.filter((site) => site.kind === 'edge-end').length
    },
    geometry: {
      bodies: 0,
      volumes: 0,
      areas: 0,
      faces: 0,
      sampledFaces: 0,
      datums: 0
    },
    timings: {
      source: sourceBuild.milliseconds,
      translate: translateBuild.milliseconds,
      verify: 0
    }
  };

  const references: Record<string, ConversionReferenceValue> = {};
  const refusals: ConversionReferenceRefusal[] = [];
  /** Per site, the converted witnesses it must resolve to when verified. */
  const expected = new Map<string, Set<number>>();
  /** Per edge topology site, how its matched ends correspond. */
  const edgeEnds = new Map<string, Set<EdgeEndCorrespondence>>();

  const capture = (
    site: Exclude<ConversionReferenceSite, { kind: 'edge-end' }>,
    feature: string
  ): SiteCapture => {
    const keys = siteKeys(site, feature, translating.translations.keys());
    const found = keys.flatMap((key) => {
      const translation = translating.translations.get(key);
      return translation ? [[key, translation] as const] : [];
    });
    const translations = found.map(([, translation]) => translation);
    const values = found.flatMap(([key, translation]) => {
      if (site.kind === 'profile-id') return translation.profileIds;
      // A bare hash beside a v5 lookup takes that reference's new hash.
      if (site.kind === 'hash' && key.includes('#v5|'))
        return translation.values.flatMap((value) =>
          typeof value === 'object' && 'currentHash' in value
            ? [value.currentHash]
            : []
        );
      return translation.values;
    });
    return { keys, values, translations };
  };

  for (const site of sites) {
    if (site.kind === 'edge-end') continue;
    const feature = features.get(site.nodeId);
    const { keys, values, translations } = feature
      ? capture(site, feature)
      : { keys: [], values: [], translations: [] };
    const failed = translations.find(
      (translation) => translation.failures.size > 0
    );
    if (failed?.failures.has('non-injective')) {
      refusals.push({
        code: 'conflict',
        subject: site.subject,
        field: site.field,
        message: `${site.subject}: ${site.field} and another reference of this feature re-capture one-to-many or many-to-one; refusing rather than merging or splitting the selection.`
      });
      continue;
    }
    const distinct = distinctValues(values);
    if (distinct.length === 1 && !failed) {
      references[site.pointer] = distinct[0]!;
      expected.set(
        site.pointer,
        new Set(translations.flatMap((t) => [...t.targetWitnesses]))
      );
      if (site.kind === 'topology' && site.reference.kind === 'edge')
        edgeEnds.set(
          site.pointer,
          new Set(translations.flatMap((t) => [...t.ends]))
        );
      continue;
    }
    if (distinct.length > 1) {
      refusals.push({
        code: 'conflict',
        subject: site.subject,
        field: site.field,
        message: `${site.subject}: ${site.field} re-captures to ${distinct.length} different values.`
      });
      continue;
    }
    const resolvedInSource = keys.some(
      (key) => recorded.topology.has(key) || recorded.profiles.has(key)
    );
    refusals.push(failureRefusal(site, failed, resolvedInSource));
  }

  // Witness end order (finding: a near tie on the leading axis sorts the
  // two ends the other way in the new unit). The correspondence comes from
  // the ends actually matched, never from the stored index.
  const endOrderOf = (pointer: string | undefined) => {
    const ends = pointer ? edgeEnds.get(pointer) : undefined;
    if (!ends || ends.size === 0) return ends ? 'closed' : undefined;
    return ends.size === 1 ? [...ends][0]! : 'ambiguous';
  };
  for (const site of sites) {
    if (site.kind === 'topology' && site.endpointOrder === 'significant') {
      const order = endOrderOf(site.pointer);
      if (order === 'swapped' || order === 'ambiguous') {
        delete references[site.pointer];
        refusals.push({
          code: 'endpoint-order',
          subject: site.subject,
          field: site.field,
          message: `${site.subject}: ${site.field} is an edge whose end order this feature reads, and in the new unit its ends ${order === 'swapped' ? 'sort the other way' : 'cannot be told apart'}; re-select the edge after converting.`
        });
      }
    }
    if (site.kind !== 'edge-end') continue;
    const order = endOrderOf(site.edgePointer);
    if (order === undefined) {
      // The edge itself was refused above, or the document names none.
      if (
        site.edgePointer === undefined ||
        references[site.edgePointer] !== undefined
      )
        refusals.push({
          code: 'endpoint-order',
          subject: site.subject,
          field: site.field,
          message: `${site.subject}: ${site.field} names an end of an edge this document does not reference by lineage, so its end cannot be re-captured.`
        });
      continue;
    }
    if (order === 'ambiguous') {
      refusals.push({
        code: 'endpoint-order',
        subject: site.subject,
        field: site.field,
        message: `${site.subject}: ${site.field} names an end of an edge whose two ends cannot be told apart in the new unit.`
      });
      continue;
    }
    references[site.pointer] =
      order !== 'swapped'
        ? site.value
        : typeof site.value === 'boolean'
          ? !site.value
          : 1 - site.value;
  }
  refusals.push(
    ...compareBlendOrientations(
      recorded.blends,
      translating.blends,
      factor,
      subjectOfFeature,
      'converted'
    )
  );
  if (refusals.length > 0) return { ok: false, refusals, report };

  const applied = applyReferenceMap(converted, references);
  if (!applied.ok)
    return {
      ok: false,
      refusals: applied.refusals.map((refusal) => ({
        code: 'apply-refused',
        subject: refusal.subject ?? 'document',
        ...(refusal.field ? { field: refusal.field } : {}),
        message: refusal.message
      })),
      report
    };

  // Oracle 3: built as stored, nothing translated, every identity resolves
  // in its own feature, to the entity it was re-captured to.
  const verifying = new RecordingSession({
    bodies: recorded.tessellatedBodies,
    factor
  });
  const verifyBuild = await coldBuild(
    claim,
    applied.document,
    verifying,
    options
  );
  report.timings.verify = verifyBuild.milliseconds;
  const derived = verifyBuild.derived;
  const verifyFeatures = siteFeatures(applied.document);
  for (const site of listConversionReferenceSites(applied.document)) {
    if (site.kind === 'edge-end') continue;
    const feature = verifyFeatures.get(site.nodeId);
    const keys = feature
      ? siteKeys(site, feature, verifying.topology.keys())
      : [];
    const witnesses = keys.flatMap((key) =>
      (verifying.topology.get(key) ?? []).map(witnessHash)
    );
    const profiles = keys.flatMap((key) => verifying.profiles.get(key) ?? []);
    const want = expected.get(site.pointer);
    const resolved =
      site.kind === 'profile-id' || (site.kind === 'hash' && site.profile)
        ? profiles.length > 0 &&
          profiles.every(
            (profile) =>
              profile.regionFingerprint === site.profile!.regionFingerprint &&
              (site.kind !== 'profile-id' ||
                profile.profileId === site.profileId)
          )
        : witnesses.length > 0 &&
          want !== undefined &&
          witnesses.every((witness) => want.has(witness));
    if (!resolved)
      refusals.push({
        code: 'unresolved-after-apply',
        subject: site.subject,
        field: site.field,
        message: `${site.subject}: ${site.field} does not resolve to its re-captured entity when the converted document is rebuilt.`
      });
  }
  // A legacy hash-only pick gets upgrade advice (a proposed v5 reference)
  // in every build of the source document too, so "no repairs" means none
  // the source build did not also propose, at the same features.
  const sourceRepairs = repairAdvice(sourceBuild.derived);
  const convertedRepairs = repairAdvice(derived);
  if (JSON.stringify(sourceRepairs) !== JSON.stringify(convertedRepairs))
    refusals.push({
      code: 'reference-repair',
      subject: 'document',
      message: `The converted rebuild proposed reference repairs [${convertedRepairs.join(', ')}] where the source build proposed [${sourceRepairs.join(', ')}].`
    });
  refusals.push(
    ...compareBlendOrientations(
      recorded.blends,
      verifying.blends,
      factor,
      subjectOfFeature,
      'verification'
    )
  );
  const oracle = unitConversionGeometryOracle(
    sourceBuild.derived,
    derived,
    factor,
    tessellatedFaceEvidence(
      recorded.tessellatedBodies,
      verifying.faceDistances
    ),
    new Map([...recorded.tessellatedFailures, ...verifying.tessellatedFailures])
  );
  report.geometry = oracle.stats;
  refusals.push(...oracle.refusals);
  if (refusals.length > 0) return { ok: false, refusals, report };
  return { ok: true, references, document: applied.document, report };
}
