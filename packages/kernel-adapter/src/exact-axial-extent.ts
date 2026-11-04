/**
 * Checked history reuse through a common translational prism.
 *
 * Every non-invariant carrier and transverse boundary in every prefix must
 * avoid one open x interval. Its remaining planes, axial cylinders and straight
 * axial edges describe a product cross-section. Fixed primitive operands stay
 * to its left. Union, constant-radius blends and perpendicular planar face
 * moves commute with extending that prism. A contraction must leave it open.
 *
 * This is a small history language, not a general deformation. Unknown
 * operations, imported geometry, variable laws, missing references, occupied
 * bands, ambiguous evolution and refused exact moves keep ordinary replay.
 */
import { getParameterScope } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type BodyId,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import type { ExactBuildResult, ExactShape } from './exact-types';
import type { IdleLineageView } from './exact-idle-lineage-view';
import { cloneBuildState, historyFeatureDigest } from './exact-history-cache';
import { resolveDirectEditFace } from './exact-direct-edit-ops';
import { edgeHandlesByFingerprint } from './exact-witnesses';
import { journaledMove } from './exact-face-distance';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import {
  createRemusSemanticLineage,
  mergeRemusLineageStates,
  type RemusLineageState,
  type RemusMoveFacesRelation,
  type RemusSemanticAssignment
} from './remus-lineage';
import {
  censusOfSolids,
  directEditFacetFallbackWarning
} from './boolean-result-validation';

type Interval = readonly [number, number];
export const MIN_AXIAL_HISTORY_FEATURES = 16;
const MAX_INTERVALS = 64;
const MAX_BODIES = 16;
const MAX_CERTIFICATE_BYTES = 32 * 1024;
// Keep axial floating-point transport well below native linear tolerances.
// Larger dimensions retain full reconstruction; this is not a model limit.
const MAX_AXIAL_WIDTH = 1_000_000;

/** Immutable evidence for precisely the checkpoint prefix that owns it. */
export interface AxialExtentCertificate {
  readonly width: number;
  readonly rootKey: string;
  readonly fixedLimit: number;
  readonly influenced: readonly BodyId[];
  readonly occupied: readonly Interval[];
  /** Hash-only selections must remain wholly fixed and uniquely resolvable. */
  readonly fixedPicks?: readonly {
    bodyId: BodyId;
    hashes: readonly number[];
    edges: readonly number[];
  }[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function vector(value: unknown): readonly number[] | null {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? (value as number[])
    : null;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function onlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boxWidth(feature: FeatureNode | undefined): number | null {
  if (!feature || isFeatureSuppressed(feature)) return null;
  const d = feature.data;
  if (
    d.featureKind !== 'primitive' ||
    d.primitiveKind !== 'box' ||
    !onlyKeys(d, ['featureKind', 'primitiveKind', 'dimensions']) ||
    !onlyKeys(d.dimensions, ['width', 'height', 'depth']) ||
    !Object.values(d.dimensions).every(positive)
  )
    return null;
  return positive(d.dimensions.width) && d.dimensions.width <= MAX_AXIAL_WIDTH
    ? d.dimensions.width
    : null;
}

/** A real feature digest, differing only in the literal width slot. */
export function axialRootKey(
  document: ProjectDocument,
  feature: FeatureNode
): string | null {
  if (boxWidth(feature) === null || feature.data.featureKind !== 'primitive')
    return null;
  return historyFeatureDigest(
    document,
    {
      ...feature,
      data: {
        ...feature.data,
        dimensions: { ...feature.data.dimensions, width: 1 }
      }
    },
    0,
    getParameterScope(document).scope
  );
}

export function axialCertificateBytes(
  certificate: AxialExtentCertificate
): number {
  return new TextEncoder().encode(JSON.stringify(certificate)).byteLength;
}

function merged(intervals: readonly Interval[]): Interval[] | null {
  const ordered = [...intervals].sort((a, b) => a[0] - b[0]);
  const result: [number, number][] = [];
  for (const [lo, hi] of ordered) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return null;
    const tail = result.at(-1);
    if (tail && lo <= tail[1]) tail[1] = Math.max(tail[1], hi);
    else result.push([lo, hi]);
    if (result.length > MAX_INTERVALS) return null;
  }
  return result;
}

function clearance(certificate: AxialExtentCertificate): number {
  return (
    1e-6 *
    Math.max(
      1,
      Math.abs(certificate.width),
      ...certificate.occupied.flat().map(Math.abs)
    )
  );
}

/** The widest common open slab beyond every fixed primitive operand. */
function freeBand(certificate: AxialExtentCertificate): Interval | null {
  let from = Math.max(0, certificate.fixedLimit);
  let best: Interval | null = null;
  const margin = clearance(certificate);
  for (const [lo, hi] of certificate.occupied) {
    const until = Math.min(lo, certificate.width);
    if (
      until - from > 2 * margin &&
      (!best || until - from > best[1] - best[0])
    )
      best = [from, until];
    from = Math.max(from, hi);
    if (from >= certificate.width) break;
  }
  return best;
}

/** Positive rational weights bound the whole curve/patch by its control hull. */
function poleBounds(
  points: unknown,
  weights: unknown,
  surface: boolean
): Interval | null {
  if (!Array.isArray(points) || !Array.isArray(weights)) return null;
  const poles: unknown[] = surface ? points.flat() : points;
  const ws: unknown[] = surface ? weights.flat() : weights;
  if (
    !poles.length ||
    poles.length > 65_536 ||
    poles.length !== ws.length ||
    !ws.every(positive)
  )
    return null;
  let lo = Infinity,
    hi = -Infinity;
  for (const pole of poles) {
    const p = vector(pole);
    if (!p) return null;
    lo = Math.min(lo, p[0]!);
    hi = Math.max(hi, p[0]!);
  }
  return [lo, hi];
}

function carrierInterval(
  kernel: RemusKernel,
  face: number
): Interval | 'axial' | null {
  const p = record(
    JSON.parse(kernel.getAnalyticSurfaceParams(face)) as unknown
  );
  if (!p) return null;
  if (p.type === 'plane') {
    const n = vector(p.normal);
    if (!n || typeof p.d !== 'number' || !Number.isFinite(p.d)) return null;
    if (n[0] === 0) return 'axial';
    if (Math.abs(n[0]!) === 1 && n[1] === 0 && n[2] === 0) {
      const x = p.d / n[0]!;
      return [x, x];
    }
    return null;
  }
  if (p.type === 'cylinder') {
    const axis = vector(p.axis),
      origin = vector(p.origin);
    if (!axis || !origin || !positive(p.radius)) return null;
    if (Math.abs(axis[0]!) === 1 && axis[1] === 0 && axis[2] === 0)
      return 'axial';
    if (axis[0] === 0) return [origin[0]! - p.radius, origin[0]! + p.radius];
    return null;
  }
  if (p.type === 'sphere' || p.type === 'torus') {
    const center = vector(p.center);
    const radius =
      p.type === 'sphere'
        ? p.radius
        : positive(p.majorRadius) && positive(p.minorRadius)
          ? p.majorRadius + p.minorRadius
          : null;
    return center && positive(radius)
      ? [center[0]! - radius, center[0]! + radius]
      : null;
  }
  if (p.type === 'nurbs') {
    const data = record(
      JSON.parse(kernel.getNurbsSurfaceDataParity(face)) as unknown
    );
    return data ? poleBounds(data.poles, data.weights, true) : null;
  }
  return null;
}

function occupiedIntervals(
  kernel: RemusKernel,
  solid: number
): Interval[] | null {
  const faces = kernel.getSolidFaces(solid),
    edges = kernel.getSolidEdges(solid);
  if (faces.length > 256 || edges.length > 2048) return null;
  const occupied: Interval[] = [];
  for (const face of faces) {
    const interval = carrierInterval(kernel, face);
    if (interval === null) return null;
    if (interval !== 'axial') occupied.push(interval);
  }
  for (const edge of edges) {
    const curve = record(JSON.parse(kernel.getNurbsCurveData(edge)) as unknown);
    if (!curve) return null;
    const bounds = poleBounds(curve.controlPoints, curve.weights, false);
    if (!bounds) return null;
    const points = curve.controlPoints as unknown[];
    const a = vector(points[0]),
      b = vector(points[1]);
    // Only the exact two-pole linear representation proves an axial edge.
    // Recognition labels or sampled near-collinearity are insufficient.
    if (
      curve.degree === 1 &&
      points.length === 2 &&
      a &&
      b &&
      a[1] === b[1] &&
      a[2] === b[2]
    )
      continue;
    occupied.push(bounds);
  }
  return merged(occupied);
}

/** One rebuild's bounded evidence, seeded only from a verified prefix restore. */
export class AxialExtentTracker {
  private certificate: AxialExtentCertificate | null;
  private previous: Map<BodyId, ExactShape>;
  private next: number;

  constructor(
    private readonly kernel: RemusKernel,
    private readonly document: ProjectDocument,
    private readonly features: readonly FeatureNode[],
    start: number,
    initial: ExactBuildResult | null,
    seed?: AxialExtentCertificate,
    enabled = true
  ) {
    this.next = start;
    this.previous = new Map(initial?.shapes);
    const root = features[0],
      width = boxWidth(root);
    const rootKey = root ? axialRootKey(document, root) : null;
    this.certificate =
      !enabled ||
      features.length < MIN_AXIAL_HISTORY_FEATURES ||
      document.units !== 'mm'
        ? null
        : (seed ??
          (start === 0 && width !== null && rootKey
            ? { width, rootKey, fixedLimit: 0, influenced: [], occupied: [] }
            : null));
  }

  observe(index: number, result: ExactBuildResult): void {
    const c = this.certificate;
    if (!c) return;
    try {
      if (
        index !== this.next++ ||
        result.shapes.size > MAX_BODIES ||
        result.featureWarnings.some((w) => w.kind !== 'advisory')
      )
        throw new Error('unqualified prefix');
      const feature = this.features[index]!;
      if (isFeatureSuppressed(feature)) throw new Error('suppressed');
      const d = feature.data;
      const influenced = new Set(c.influenced);
      const fixedPicks = [...(c.fixedPicks ?? [])];
      let fixedLimit = c.fixedLimit;
      let bodyId: BodyId | undefined;
      let interval: Interval[] | null = null;
      if (index === 0) {
        if (boxWidth(feature) !== c.width || !feature.bodyId)
          throw new Error('root');
        influenced.add(feature.bodyId);
        bodyId = feature.bodyId;
      } else if (
        d.featureKind === 'primitive' &&
        d.primitiveKind === 'cylinder' &&
        onlyKeys(d, ['featureKind', 'primitiveKind', 'dimensions']) &&
        onlyKeys(d.dimensions, ['radius', 'height']) &&
        Object.values(d.dimensions).every(positive) &&
        positive(d.dimensions.radius)
      ) {
        fixedLimit = Math.max(fixedLimit, d.dimensions.radius);
        interval = [[-d.dimensions.radius, d.dimensions.radius]];
      } else if (
        d.featureKind === 'boolean' &&
        d.operation === 'union' &&
        feature.bodyId &&
        onlyKeys(d, ['featureKind', 'operation', 'targetBodyIds']) &&
        d.targetBodyIds.some((id) => influenced.has(id))
      ) {
        influenced.add(feature.bodyId);
        bodyId = feature.bodyId;
      } else if (
        d.featureKind === 'fillet' &&
        feature.bodyId &&
        influenced.has(d.targetBodyId) &&
        positive(d.radius) &&
        (!d.edgeReferences ||
          d.edgeReferences.length === d.edgeHashes.length) &&
        onlyKeys(d, [
          'featureKind',
          'targetBodyId',
          'edgeHashes',
          'edgeReferences',
          'radius'
        ])
      ) {
        if (!d.edgeReferences) {
          const source = this.previous.get(d.targetBodyId);
          if (!source || source.solids.length !== 1)
            throw new Error('legacy source');
          const handles = edgeHandlesByFingerprint(
            this.kernel,
            source.solids[0]!
          );
          const selected: number[] = [];
          for (const hash of d.edgeHashes) {
            const matches = handles.get(hash);
            if (matches?.length !== 1) throw new Error('legacy selection');
            const edge = matches[0]!;
            const curve = record(
              JSON.parse(this.kernel.getNurbsCurveData(edge)) as unknown
            );
            const bounds =
              curve && poleBounds(curve.controlPoints, curve.weights, false);
            if (!bounds) throw new Error('legacy boundary');
            fixedLimit = Math.max(fixedLimit, bounds[1]);
            selected.push(edge);
          }
          fixedPicks.push({
            bodyId: d.targetBodyId,
            hashes: [...d.edgeHashes],
            edges: selected
          });
        }
        influenced.add(feature.bodyId);
        bodyId = feature.bodyId;
      } else if (
        d.featureKind === 'direct-edit' &&
        influenced.has(d.targetBodyId) &&
        d.operation.kind === 'offset-face' &&
        onlyKeys(d.operation, [
          'kind',
          'faceHash',
          'faceReference',
          'sourceSurfaceType',
          'sourceArea',
          'sourceCenter',
          'sourceNormal',
          'offset'
        ]) &&
        typeof d.operation.offset === 'number' &&
        Number.isFinite(d.operation.offset) &&
        d.operation.faceReference
      ) {
        if (fixedPicks.some((pick) => pick.bodyId === d.targetBodyId))
          throw new Error('modified legacy source');
        const source = this.previous.get(d.targetBodyId);
        if (!source || source.solids.length !== 1) throw new Error('source');
        const { face } = resolveDirectEditFace(
          this.kernel,
          source,
          source.solids[0]!,
          d.operation
        );
        const surface = record(
          JSON.parse(this.kernel.getAnalyticSurfaceParams(face)) as unknown
        );
        const n = surface && vector(surface.normal);
        if (surface?.type !== 'plane' || !n || n[0] !== 0)
          throw new Error('nonperpendicular offset');
        bodyId = d.targetBodyId;
      } else throw new Error('operation');
      if (bodyId) {
        const shape = result.shapes.get(bodyId);
        if (
          !shape ||
          shape.solids.length !== 1 ||
          shape.nativeVertices ||
          shape.referenceMesh
        )
          throw new Error('shape');
        interval = occupiedIntervals(this.kernel, shape.solids[0]!);
      }
      const occupied = interval && merged([...c.occupied, ...interval]);
      if (!occupied || influenced.size > MAX_BODIES) throw new Error('bounds');
      this.certificate = {
        ...c,
        fixedLimit,
        influenced: [...influenced],
        occupied,
        ...(fixedPicks.length ? { fixedPicks } : {})
      };
      if (axialCertificateBytes(this.certificate) > MAX_CERTIFICATE_BYTES)
        throw new Error('budget');
      this.previous = new Map(result.shapes);
    } catch {
      this.certificate = null;
    }
  }

  snapshot(): AxialExtentCertificate | undefined {
    const c = this.certificate;
    return c && freeBand(c) ? c : undefined;
  }
}

/** A contraction may consume part of the prism, never a curved or transverse feature. */
export function resizedAxialCertificate(
  certificate: AxialExtentCertificate,
  width: number
): AxialExtentCertificate | null {
  if (
    !positive(width) ||
    width > MAX_AXIAL_WIDTH ||
    certificate.width > MAX_AXIAL_WIDTH ||
    width === certificate.width
  )
    return null;
  const band = freeBand(certificate);
  const delta = width - certificate.width;
  if (!band || band[1] + delta - band[0] <= 2 * clearance(certificate))
    return null;
  const occupied = certificate.occupied.map(([lo, hi]): Interval =>
    lo >= band[1] ? [lo + delta, hi + delta] : [lo, hi]
  );
  return { ...certificate, width, occupied };
}

function edgeFaces(kernel: RemusKernel, solid: number): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const face of kernel.getSolidFaces(solid))
    for (const edge of new Set(kernel.getFaceEdges(face))) {
      const faces = result.get(edge) ?? [];
      faces.push(face);
      result.set(edge, faces);
    }
  return result;
}

function carryLineage(
  kernel: RemusKernel,
  source: RemusLineageState | undefined,
  before: number,
  after: number,
  relation: RemusMoveFacesRelation
): RemusLineageState | undefined {
  if (!source) return undefined;
  const candidates = new Map(
    topologyCandidatesForSolid(kernel, after).map((c) => [
      `${c.kind}:${c.handle}`,
      c
    ])
  );
  const groups = new Map<FeatureId, RemusSemanticAssignment[]>();
  const add = (
    ref: { producingFeatureId: FeatureId; lineageName: string },
    kind: 'face' | 'edge',
    handle: number | undefined
  ) => {
    const candidate = candidates.get(`${kind}:${handle}`);
    if (!candidate) throw new Error('Incomplete axial construction map.');
    const assignments = groups.get(ref.producingFeatureId) ?? [];
    assignments.push({ ...candidate, lineageName: ref.lineageName });
    groups.set(ref.producingFeatureId, assignments);
  };
  for (const [face, ref] of source.faceReferences)
    add(ref, 'face', relation.faceMap.get(face));
  const sourcePairs = edgeFaces(kernel, before),
    resultPairs = edgeFaces(kernel, after);
  for (const [edge, ref] of source.edgeReferences) {
    const faces = sourcePairs.get(edge);
    if (!faces || faces.length !== 2 || faces[0] === faces[1])
      throw new Error('Ambiguous axial boundary.');
    const mapped = faces.map((f) => relation.faceMap.get(f));
    const matches = [...resultPairs].filter(
      ([, pair]) =>
        pair.length === 2 &&
        mapped.every((f) => f !== undefined && pair.includes(f))
    );
    if (matches.length !== 1)
      throw new Error('Ambiguous axial boundary image.');
    add(ref, 'edge', matches[0]![0]);
  }
  const lineage = mergeRemusLineageStates(
    [...groups].map(([producer, assignments]) =>
      createRemusSemanticLineage(producer, 'direct-edit', assignments)
    )
  );
  if (
    lineage.faceReferences.size !== source.faceReferences.size ||
    lineage.edgeReferences.size !== source.edgeReferences.size
  )
    throw new Error('Axial construction identity was withheld.');
  lineage.diagnostics.push(...source.diagnostics);
  return lineage;
}

/** Caller owns checkpoint restore/rollback; every move remains exact and validated. */
export function resizeAxialPrefix(
  kernel: RemusKernel,
  original: ExactBuildResult,
  certificate: AxialExtentCertificate,
  width: number,
  idle?: IdleLineageView
): {
  snapshot: ExactBuildResult;
  certificate: AxialExtentCertificate;
  idle?: IdleLineageView;
  movedSolids: number;
} | null {
  const resized = resizedAxialCertificate(certificate, width);
  if (!resized) return null;
  const snapshot = cloneBuildState(original);
  const view = idle && {
    diverged: idle.diverged,
    lineages: new Map(idle.lineages)
  };
  let movedSolids = 0;
  for (const id of certificate.influenced) {
    const source = original.shapes.get(id);
    if (
      !source ||
      source.solids.length !== 1 ||
      source.nativeVertices ||
      source.referenceMesh
    )
      return null;
    const solid = source.solids[0]!;
    const faces = Array.from(kernel.getSolidFaces(solid));
    const end = faces.filter((f) => {
      const p = record(
        JSON.parse(kernel.getAnalyticSurfaceParams(f)) as unknown
      );
      const n = p && vector(p.normal);
      return (
        p?.type === 'plane' &&
        n?.[0] === 1 &&
        n[1] === 0 &&
        n[2] === 0 &&
        p.d === certificate.width
      );
    });
    if (end.length !== 1) return null;
    const census = {
      getSolidFaces: (s: number) => kernel.getSolidFaces(s),
      getSurfaceType: (f: number) => kernel.getSurfaceType(f)
    };
    const beforeCensus = censusOfSolids(census, [solid]);
    const moved = journaledMove(
      kernel,
      solid,
      new Uint32Array(end),
      width - certificate.width
    );
    const relation = moved.relation;
    const outputs = kernel.getSolidFaces(moved.solid);
    if (
      !relation ||
      relation.conflictedSources.size ||
      relation.faceMap.size !== faces.length ||
      new Set(relation.faceMap.values()).size !== outputs.length ||
      kernel.validateSolidRelaxed(moved.solid) !== 0 ||
      directEditFacetFallbackWarning({
        operands: beforeCensus,
        result: censusOfSolids(census, [moved.solid])
      })
    )
      return null;
    const movedEnd = relation.faceMap.get(end[0]!);
    const endSurface =
      movedEnd === undefined
        ? null
        : record(
            JSON.parse(kernel.getAnalyticSurfaceParams(movedEnd)) as unknown
          );
    const endNormal = endSurface && vector(endSurface.normal);
    if (
      endSurface?.type !== 'plane' ||
      endSurface.d !== width ||
      endNormal?.[0] !== 1 ||
      endNormal[1] !== 0 ||
      endNormal[2] !== 0
    )
      return null;
    snapshot.shapes.set(id, {
      solids: [moved.solid],
      lineage: carryLineage(
        kernel,
        source.lineage,
        solid,
        moved.solid,
        relation
      )
    });
    if (view)
      view.lineages.set(
        id,
        carryLineage(
          kernel,
          view.lineages.get(id),
          solid,
          moved.solid,
          relation
        )
      );
    movedSolids += 1;
  }
  const fixedPicks: NonNullable<
    AxialExtentCertificate['fixedPicks']
  >[number][] = [];
  for (const pick of certificate.fixedPicks ?? []) {
    const after = snapshot.shapes.get(pick.bodyId);
    if (!after || after.solids.length !== 1) return null;
    const handles = edgeHandlesByFingerprint(kernel, after.solids[0]!);
    const edges: number[] = [];
    for (let index = 0; index < pick.hashes.length; index += 1) {
      const matches = handles.get(pick.hashes[index]!);
      const before = pick.edges[index];
      if (matches?.length !== 1 || before === undefined) return null;
      const edge = matches[0]!;
      // Preserve the legacy resolver's unique answer, including exact curve
      // data and endpoint order. A new hash collision or moved selection
      // therefore declines reuse instead of bypassing a replay refusal.
      const beforeVertices = kernel.getEdgeVertices(before);
      const afterVertices = kernel.getEdgeVertices(edge);
      if (
        kernel.getNurbsCurveData(before) !== kernel.getNurbsCurveData(edge) ||
        !Array.from(beforeVertices).every((value, i) =>
          Object.is(value, afterVertices[i])
        )
      )
        return null;
      edges.push(edge);
    }
    fixedPicks.push({ ...pick, edges });
  }
  return {
    snapshot,
    certificate: { ...resized, ...(fixedPicks.length ? { fixedPicks } : {}) },
    ...(view ? { idle: view } : {}),
    movedSolids
  };
}
