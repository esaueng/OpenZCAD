/**
 * I03 stored-unit conversion: the scaled-witness rule a re-capture matches
 * by. Pure (types only), so a consumer outside the kernel, such as the web
 * measurement refresh re-attaching a kept reading after a conversion, applies
 * exactly the window and lineage rule the document's own references were
 * re-captured by, without loading the kernel. `units-reference-recapture.ts`
 * re-exports everything here.
 */
import type {
  EdgeTopology,
  EdgeWitnessV1,
  FaceGeometry,
  FaceWitnessV1,
  QuantizedTopologyPoint,
  Vector3
} from '@openzcad/shared';
import type { BlendEdgeOrientation } from './blend-orientation';
import type { TopologyLineageIdentity } from './topology-lineage';

// ---------------------------------------------------------------------------
// The scaled-witness window
// ---------------------------------------------------------------------------

/**
 * How far a re-captured witness integer may sit from the scaled source one,
 * in quanta of the coarser of the two units. Rounding puts each witness
 * within half a quantum of its exact value, so the scaled source integer
 * carries half a source quantum (k/2 target quanta) of error and the target
 * integer half a target quantum: one coarse quantum covers both, and the
 * second covers the kernel's own floating-point differences between the two
 * builds. Two entities closer than this are not told apart, and the match
 * refuses as ambiguous (plan §3.5).
 */
export const RECAPTURE_WINDOW_QUANTA = 2;

/**
 * Direction components use ADR-011's 1000-times-finer direction quantum and
 * do not scale; they get the same two-quantum allowance for kernel noise.
 */
const DIRECTION_WINDOW = 2;

/** The window for scaled lengths and positions, in target quanta. */
export function recaptureWindow(factor: number): number {
  return RECAPTURE_WINDOW_QUANTA * Math.max(1, factor);
}

function near(target: number, source: number, factor: number): boolean {
  return Math.abs(target - source * factor) <= recaptureWindow(factor);
}

function nearPoint(
  target: QuantizedTopologyPoint,
  source: QuantizedTopologyPoint,
  factor: number
): boolean {
  return target.every((value, axis) => near(value, source[axis]!, factor));
}

function nearDirection(
  target: QuantizedTopologyPoint | null,
  source: QuantizedTopologyPoint | null
): boolean {
  if (target === null || source === null) return target === source;
  return target.every(
    (value, axis) => Math.abs(value - source[axis]!) <= DIRECTION_WINDOW
  );
}

function nearNullablePoint(
  target: QuantizedTopologyPoint | null,
  source: QuantizedTopologyPoint | null,
  factor: number
): boolean {
  if (target === null || source === null) return target === source;
  return nearPoint(target, source, factor);
}

/**
 * Whether `target` (measured in the converted build) is `source` (measured in
 * the source build) scaled by `factor`, within the re-capture window.
 * Categorical parts (curve and surface class, closure, analytic kind) must be
 * equal. An open edge's endpoints are compared as an unordered pair: their
 * stored order sorts quantized coordinates, and scaling can reorder a tie.
 */
export function scaledWitnessMatches(
  kind: 'face' | 'edge',
  source: FaceWitnessV1 | EdgeWitnessV1,
  target: FaceWitnessV1 | EdgeWitnessV1,
  factor: number
): boolean {
  if (kind === 'edge') {
    const from = source as EdgeWitnessV1;
    const to = target as EdgeWitnessV1;
    if (
      from.curveType !== to.curveType ||
      from.closed !== to.closed ||
      !near(to.length, from.length, factor)
    )
      return false;
    if (from.closed && to.closed)
      return (
        nearPoint(to.center, from.center, factor) &&
        nearDirection(to.axis, from.axis)
      );
    if (from.closed || to.closed) return false;
    const [a, b] = from.endpoints;
    const [c, d] = to.endpoints;
    return (
      nearPoint(to.midpoint, from.midpoint, factor) &&
      ((nearPoint(c, a, factor) && nearPoint(d, b, factor)) ||
        (nearPoint(c, b, factor) && nearPoint(d, a, factor)))
    );
  }
  const from = source as FaceWitnessV1;
  const to = target as FaceWitnessV1;
  if (
    from.surfaceType !== to.surfaceType ||
    from.closure.u !== to.closure.u ||
    from.closure.v !== to.closure.v ||
    from.analytic.kind !== to.analytic.kind ||
    !near(to.perimeter, from.perimeter, factor) ||
    !nearNullablePoint(to.centroid, from.centroid, factor)
  )
    return false;
  if (from.analytic.kind === 'plane' && to.analytic.kind === 'plane')
    return (
      nearDirection(to.analytic.normal, from.analytic.normal) &&
      near(to.analytic.offset, from.analytic.offset, factor)
    );
  if (from.analytic.kind === 'cylinder' && to.analytic.kind === 'cylinder')
    return (
      nearDirection(to.analytic.axis, from.analytic.axis) &&
      nearPoint(to.analytic.axisFoot, from.analytic.axisFoot, factor) &&
      near(to.analytic.radius, from.analytic.radius, factor)
    );
  return true;
}

/**
 * Which way a matched open edge's witness ends correspond: `same` when the
 * converted end 0 is the source end 0 scaled, `swapped` when it is the
 * source end 1 (the quantized sort reordered a near tie), `ambiguous` when
 * both pairings fit (ends within the window of each other). Null for a
 * closed edge or a face. Only meaningful for a pair that
 * {@link scaledWitnessMatches} accepted.
 */
export type EdgeEndCorrespondence = 'same' | 'swapped' | 'ambiguous';

export function edgeEndCorrespondence(
  source: FaceWitnessV1 | EdgeWitnessV1,
  target: FaceWitnessV1 | EdgeWitnessV1,
  factor: number
): EdgeEndCorrespondence | null {
  if (!('curveType' in source) || !('curveType' in target)) return null;
  if (source.closed || target.closed) return null;
  const [a, b] = source.endpoints;
  const [c, d] = target.endpoints;
  const same = nearPoint(c, a, factor) && nearPoint(d, b, factor);
  const swapped = nearPoint(c, b, factor) && nearPoint(d, a, factor);
  return same && swapped
    ? 'ambiguous'
    : same
      ? 'same'
      : swapped
        ? 'swapped'
        : null;
}

/**
 * Tolerance on one scaled position component, in target units: the kernel's
 * 1e-6 model-unit tolerance plus 1e-9 of the component's own magnitude for
 * floating-point growth. Per component, so a large coordinate on one axis
 * never widens the check on another.
 */
export function positionTolerance(expected: number): number {
  return 1e-6 + 1e-9 * Math.abs(expected);
}

function nearScaledPosition(
  target: readonly number[],
  source: readonly number[],
  factor: number
): boolean {
  return target.every((value, axis) => {
    const expected = source[axis]! * factor;
    return Math.abs(value - expected) <= positionTolerance(expected);
  });
}

/** Relative tolerance on volume (×k³) and area (×k²), plan §6 step 2. */
export const UNIT_CONVERSION_MEASURE_RTOL = 1e-6;

function relativelyNear(target: number, expected: number): boolean {
  return (
    Math.abs(target - expected) <=
    UNIT_CONVERSION_MEASURE_RTOL * Math.max(Math.abs(expected), 1e-300)
  );
}

/**
 * Whether `target` is `source` scaled by `factor`, per component within
 * {@link positionTolerance} plus `allowance` (both in target units). Two
 * absent vectors agree; one absent does not.
 */
export function nearScaledVector(
  target: Vector3 | undefined,
  source: Vector3 | undefined,
  factor: number,
  allowance: number
): boolean {
  if ((source === undefined) !== (target === undefined)) return false;
  if (!source || !target) return true;
  return (['x', 'y', 'z'] as const).every((axis) => {
    const expected = source[axis] * factor;
    return (
      Math.abs(target[axis] - expected) <=
      positionTolerance(expected) + allowance
    );
  });
}

/**
 * How far a face's area centroid may sit from the scaled source one, for a
 * body of size `scale` (target units): 1e-6 of it, twice that for a
 * centroid integrated over an inscribed polygon (a curved boundary).
 */
export function faceCentroidSlack(
  face: Pick<FaceGeometry, 'centroidProvenance'>,
  scale: number
): number {
  return (face.centroidProvenance === 'exact' ? 1e-6 : 2e-6) * scale;
}

/**
 * The geometry oracle's per-face rule for a face whose area is exact: the
 * same surface class, area ×k² within {@link UNIT_CONVERSION_MEASURE_RTOL},
 * vertex-mean centre and area centroid ×k. `scale` is the converted body's
 * size, in its units. A consumer outside the conversion that needs to carry
 * an unnamed face across it matches by exactly the evidence the conversion
 * verified every face against.
 */
export function scaledFaceGeometryMatches(
  source: FaceGeometry,
  target: FaceGeometry,
  factor: number,
  scale: number
): boolean {
  return (
    source.surfaceType === target.surfaceType &&
    relativelyNear(target.area, source.area * factor * factor) &&
    nearScaledVector(target.center, source.center, factor, 1e-6 * scale) &&
    nearScaledVector(
      target.centroid,
      source.centroid,
      factor,
      Math.max(
        faceCentroidSlack(source, scale),
        faceCentroidSlack(target, scale)
      )
    )
  );
}

/**
 * The edge counterpart of {@link scaledFaceGeometryMatches}, by the same
 * tolerances: the same curve class, length ×k, the ends of its sampled
 * curve ×k (as an unordered pair, like a witness's), and for a circle its
 * centre and radius ×k and an unchanged plane. An edge with no exact curve
 * or length never matches: absence is not agreement.
 */
export function scaledEdgeGeometryMatches(
  source: EdgeTopology,
  target: EdgeTopology,
  factor: number,
  scale: number
): boolean {
  if (
    !source.curve ||
    !target.curve ||
    source.curve.type !== target.curve.type ||
    source.length === undefined ||
    target.length === undefined ||
    !relativelyNear(target.length, source.length * factor)
  )
    return false;
  const allowance = 1e-6 * scale;
  const from = source.curve.circle;
  const to = target.curve.circle;
  if ((from === undefined) !== (to === undefined)) return false;
  if (
    from &&
    to &&
    (!nearScaledVector(to.center, from.center, factor, allowance) ||
      !relativelyNear(to.radius, from.radius * factor) ||
      Math.abs(
        Math.abs(
          to.axis.x * from.axis.x +
            to.axis.y * from.axis.y +
            to.axis.z * from.axis.z
        ) - 1
      ) > 1e-9)
  )
    return false;
  const ends = (edge: EdgeTopology): [Vector3, Vector3] | null => {
    const points = edge.points;
    if (points.length < 6) return null;
    const last = points.length - 3;
    return [
      { x: points[0]!, y: points[1]!, z: points[2]! },
      { x: points[last]!, y: points[last + 1]!, z: points[last + 2]! }
    ];
  };
  const a = ends(source);
  const b = ends(target);
  if (!a || !b) return false;
  const near = (to: Vector3, from: Vector3) =>
    nearScaledVector(to, from, factor, allowance);
  return (
    (near(b[0], a[0]) && near(b[1], a[1])) ||
    (near(b[0], a[1]) && near(b[1], a[0]))
  );
}

/**
 * How a blended edge of the converted build is oriented against the same
 * edge of the source build (`blend-orientation.ts`): `same` when its native
 * start, curve samples, end and face order are the source's scaled by
 * `factor`; `reversed` when the edge runs the other way or lists its faces
 * the other way round; `ambiguous` when both readings fit (the samples or
 * faces cannot be told apart); `unmatched` when neither does.
 */
export type BlendOrientationCorrespondence =
  'same' | 'reversed' | 'ambiguous' | 'unmatched';

export function blendOrientationCorrespondence(
  source: BlendEdgeOrientation,
  target: BlendEdgeOrientation,
  factor: number
): BlendOrientationCorrespondence {
  const forward = source.samples.every((sample, index) =>
    nearScaledPosition(target.samples[index]!, sample, factor)
  );
  const backward = source.samples.every((sample, index) =>
    nearScaledPosition(
      target.samples[source.samples.length - 1 - index]!,
      sample,
      factor
    )
  );
  const faces = (order: (index: number) => number) =>
    source.faces.length === target.faces.length &&
    source.faces.every((face, index) =>
      scaledWitnessMatches('face', face, target.faces[order(index)]!, factor)
    );
  const facesKept = faces((index) => index);
  const facesSwapped = source.faces.length === 2 && faces((index) => 1 - index);
  if (forward && facesKept && !backward && !facesSwapped) return 'same';
  if ((forward && backward) || (facesKept && facesSwapped)) return 'ambiguous';
  if (backward || facesSwapped) return 'reversed';
  return 'unmatched';
}

/**
 * A lineage name with every embedded imported-STEP name reduced to its
 * family. An import names its topology by the witness hash (ADR-013 K0.6),
 * which a conversion changes, and later features nest those names
 * (`boolean.face.target.import.step.face.…`).
 */
export function lineageNameFamily(name: string): string {
  return name.replace(
    /import\.step\.(face|edge)\.[0-9a-f]{8}/g,
    'import.step.$1.*'
  );
}

function sameLineage(
  source: TopologyLineageIdentity,
  target: TopologyLineageIdentity
): boolean {
  return (
    source.producingFeatureId === target.producingFeatureId &&
    lineageNameFamily(source.lineageName) ===
      lineageNameFamily(target.lineageName)
  );
}

// ---------------------------------------------------------------------------
// Matching one lookup
// ---------------------------------------------------------------------------

/** What the source build resolved one stored identity to. */
export interface SourceTopologyEntity {
  kind: 'face' | 'edge';
  witness: FaceWitnessV1 | EdgeWitnessV1;
  /** Absent when the entity carried no name (hash resolution). */
  lineage?: TopologyLineageIdentity;
}

export type TopologyMatch<C> =
  | { status: 'matched'; candidate: C }
  | { status: 'missing' | 'ambiguous'; count: number };

/**
 * The one candidate that is `source` scaled by `factor`: same kind, witness
 * within the window, and the same lineage name (family) when the source was
 * named, or no name when it was not. Refuses unless exactly one qualifies.
 */
export function matchScaledTopology<
  C extends {
    kind: 'face' | 'edge';
    witness: FaceWitnessV1 | EdgeWitnessV1;
    lineage?: TopologyLineageIdentity;
  }
>(
  source: SourceTopologyEntity,
  candidates: readonly C[],
  factor: number
): TopologyMatch<C> {
  const matches = candidates.filter(
    (candidate) =>
      candidate.kind === source.kind &&
      (source.lineage
        ? candidate.lineage !== undefined &&
          sameLineage(source.lineage, candidate.lineage)
        : candidate.lineage === undefined) &&
      scaledWitnessMatches(
        source.kind,
        source.witness,
        candidate.witness,
        factor
      )
  );
  if (matches.length === 1)
    return { status: 'matched', candidate: matches[0]! };
  return {
    status: matches.length === 0 ? 'missing' : 'ambiguous',
    count: matches.length
  };
}
