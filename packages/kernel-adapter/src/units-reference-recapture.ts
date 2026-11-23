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
  type EdgeWitnessV1,
  type FaceWitnessV1,
  type ProjectDocument,
  type QuantizedTopologyPoint,
  type SketchRegionProfileReference,
  type TopologyReferenceV5,
  type UnitSystem
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type ExactKernelAdapterOptions
} from './exact';
import {
  referenceRecaptureHooks,
  withReferenceRecapture,
  type FingerprintProbe,
  type FingerprintScheme,
  type ReferenceRecaptureHooks
} from './reference-recapture-slot';
import {
  topologyHashOfWitness,
  type LegacyTopologyHashReference,
  type TopologyLineageIdentity,
  type TopologyResolutionCandidate,
  type TopologyResolutionResult
} from './topology-lineage';

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

interface SourceTopologyRecord extends SourceTopologyEntity {
  scheme: FingerprintScheme;
}

interface SourceProfileRecord extends SourceProfileEntity {
  profileId: string;
  regionFingerprint: number;
}

function witnessHash(entity: SourceTopologyEntity): number {
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

/**
 * Records what each stored identity resolves to. Used for the source build
 * and, unchanged, for the verification build, where it shows that every
 * identity resolved.
 */
class RecordingSession implements ReferenceRecaptureHooks {
  readonly topology = new Map<string, SourceTopologyRecord[]>();
  readonly profiles = new Map<string, SourceProfileRecord[]>();

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
      this.addTopology(topologyKey(reference), {
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
          this.addTopology(hashKey(probe.kind, hash), {
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
    const key = profileKey(reference);
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
  'source-conflict' | 'missing' | 'ambiguous' | 'unresolved';

interface Translation {
  values: ConversionReferenceValue[];
  /** For a profile, the new profile id beside the fingerprint. */
  profileIds: string[];
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

  constructor(
    private readonly source: RecordingSession,
    private readonly factor: number
  ) {}

  private entry(key: string): Translation {
    let entry = this.translations.get(key);
    if (!entry) {
      entry = { values: [], profileIds: [], failures: new Set() };
      this.translations.set(key, entry);
    }
    return entry;
  }

  private succeed(
    key: string,
    value: ConversionReferenceValue,
    profileId?: string
  ): void {
    const entry = this.entry(key);
    if (!entry.values.some((other) => sameValue(other, value)))
      entry.values.push(value);
    if (profileId !== undefined && !entry.profileIds.includes(profileId))
      entry.profileIds.push(profileId);
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
    const key = topologyKey(reference);
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
      this.succeed(key, 'producingFeatureId' in next ? next : next.currentHash);
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
      const key = hashKey(probe.kind, hash);
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
      this.succeed(key, probe.hashOf(source.scheme, handle));
      return [handle];
    });
  }

  resolveProfile<P extends SketchProfile>(
    reference: SketchRegionProfileReference,
    profiles: readonly P[],
    resolve: (reference: SketchRegionProfileReference) => P
  ): P {
    const key = profileKey(reference);
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
}

// ---------------------------------------------------------------------------
// Oracle 2: the geometry
// ---------------------------------------------------------------------------

/** Relative tolerance on volume (×k³) and area (×k²), plan §6 step 2. */
export const UNIT_CONVERSION_MEASURE_RTOL = 1e-6;

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

function faceAreaOf(body: BodyRepresentation): number | undefined {
  const faces = body.topology?.faces;
  if (!faces || faces.length === 0) return undefined;
  let area = 0;
  for (const face of faces) {
    if (!face.geometry) return undefined;
    area += face.geometry.area;
  }
  return area;
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
}

/**
 * Oracle 2 (plan §6 step 2): every body of the converted build is the
 * source body scaled by `factor`. Compares per body: the bounding box
 * (solid bounds where both builds publish them) within kernel tolerance;
 * volume ×k³ and summed face area ×k², relative
 * {@link UNIT_CONVERSION_MEASURE_RTOL}; face, edge and vertex counts and
 * the consumed/exportable flags exactly; and the exportable body set and
 * the warnings exactly. The projection publishes no per-body solid count,
 * so solids are covered by the body set and the topology counts.
 */
export function unitConversionGeometryOracle(
  source: DerivedState,
  converted: DerivedState,
  factor: number
): { refusals: ConversionReferenceRefusal[]; stats: GeometryOracleStats } {
  const refusals: ConversionReferenceRefusal[] = [];
  const stats: GeometryOracleStats = { bodies: 0, volumes: 0, areas: 0 };
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
    const areaFrom = faceAreaOf(from);
    const areaTo = faceAreaOf(to);
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
  }
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
  sites: { topology: number; hash: number; profileId: number };
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
  document: ProjectDocument,
  hooks: ReferenceRecaptureHooks,
  options: ConversionReferenceMapOptions
): Promise<{ derived: DerivedState; milliseconds: number }> {
  const adapter = options.createAdapter
    ? await options.createAdapter()
    : await createExactKernelAdapter({
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
    const derived = await withReferenceRecapture(hooks, () =>
      adapter.syncDocument(document)
    );
    return { derived, milliseconds: performance.now() - started };
  } finally {
    adapter.dispose();
  }
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
      message: `${site.subject}: the source build never resolved ${site.field}, so it cannot be re-captured.`
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
  if (referenceRecaptureHooks())
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
  const factor =
    millimetresPerUnit(source.units) / millimetresPerUnit(converted.units);

  const recorded = new RecordingSession();
  const sourceBuild = await coldBuild(source, recorded, options);
  const translating = new TranslatingSession(recorded, factor);
  const translateBuild = await coldBuild(converted, translating, options);

  const sites = listConversionReferenceSites(converted);
  const report: ConversionReferenceReport = {
    factor,
    sites: {
      topology: sites.filter((site) => site.kind === 'topology').length,
      hash: sites.filter((site) => site.kind === 'hash').length,
      profileId: sites.filter((site) => site.kind === 'profile-id').length
    },
    geometry: { bodies: 0, volumes: 0, areas: 0 },
    timings: {
      source: sourceBuild.milliseconds,
      translate: translateBuild.milliseconds,
      verify: 0
    }
  };

  const references: Record<string, ConversionReferenceValue> = {};
  const refusals: ConversionReferenceRefusal[] = [];
  const settle = (
    site: ConversionReferenceSite,
    keys: readonly string[],
    values: readonly ConversionReferenceValue[],
    translations: readonly (Translation | undefined)[]
  ) => {
    const distinct = values.filter(
      (value, index) =>
        values.findIndex((other) => sameValue(other, value)) === index
    );
    if (distinct.length === 1) {
      references[site.pointer] = distinct[0]!;
      return;
    }
    if (distinct.length > 1) {
      refusals.push({
        code: 'conflict',
        subject: site.subject,
        field: site.field,
        message: `${site.subject}: ${site.field} re-captures to ${distinct.length} different values.`
      });
      return;
    }
    const resolvedInSource = keys.some(
      (key) => recorded.topology.has(key) || recorded.profiles.has(key)
    );
    refusals.push(
      failureRefusal(
        site,
        translations.find((translation) => translation !== undefined),
        resolvedInSource
      )
    );
  };

  for (const site of sites) {
    if (site.kind === 'topology') {
      const key = topologyKey(site.reference);
      const translation = translating.translations.get(key);
      settle(site, [key], translation?.values ?? [], [translation]);
    } else if (site.kind === 'profile-id' || site.profile) {
      const key = profileKey(site.profile!);
      const translation = translating.translations.get(key);
      settle(
        site,
        [key],
        site.kind === 'profile-id'
          ? (translation?.profileIds ?? [])
          : (translation?.values ?? []),
        [translation]
      );
    } else {
      // A bare hash: a legacy lookup of either kind, or the hash a v5
      // reference beside it was resolved by.
      const keys = [hashKey('face', site.hash), hashKey('edge', site.hash)];
      const values: ConversionReferenceValue[] = [];
      const translations: (Translation | undefined)[] = [];
      for (const key of keys) {
        const translation = translating.translations.get(key);
        translations.push(translation);
        values.push(...(translation?.values ?? []));
      }
      const besideV5 = (key: string) =>
        key.startsWith('v5|') && key.endsWith(`|${site.hash}`);
      for (const key of recorded.topology.keys())
        if (besideV5(key)) keys.push(key);
      for (const [key, translation] of translating.translations) {
        if (!besideV5(key)) continue;
        translations.push(translation);
        for (const value of translation.values)
          if (typeof value === 'object' && 'currentHash' in value)
            values.push(value.currentHash);
      }
      settle(site, keys, values, translations);
    }
  }
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

  // Oracle 3: built as stored, nothing translated, every identity resolves.
  const verifying = new RecordingSession();
  const verifyBuild = await coldBuild(applied.document, verifying, options);
  report.timings.verify = verifyBuild.milliseconds;
  const derived = verifyBuild.derived;
  for (const site of listConversionReferenceSites(applied.document)) {
    const resolved =
      site.kind === 'topology'
        ? verifying.topology.has(topologyKey(site.reference))
        : site.kind === 'profile-id' || site.profile
          ? verifying.profiles.has(profileKey(site.profile!))
          : verifying.topology.has(hashKey('face', site.hash)) ||
            verifying.topology.has(hashKey('edge', site.hash)) ||
            [...verifying.topology.keys()].some(
              (key) => key.startsWith('v5|') && key.endsWith(`|${site.hash}`)
            );
    if (!resolved)
      refusals.push({
        code: 'unresolved-after-apply',
        subject: site.subject,
        field: site.field,
        message: `${site.subject}: ${site.field} does not resolve when the converted document is rebuilt.`
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
  const oracle = unitConversionGeometryOracle(
    sourceBuild.derived,
    derived,
    factor
  );
  report.geometry = oracle.stats;
  refusals.push(...oracle.refusals);
  if (refusals.length > 0) return { ok: false, refusals, report };
  return { ok: true, references, document: applied.document, report };
}
