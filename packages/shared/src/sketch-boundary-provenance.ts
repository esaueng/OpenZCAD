import type { EntityId } from './index';
import { MAX_SKETCH_POLYGON_SIDES } from './index';

/** Authored legacy topology; coordinates never participate in this identity. */
export interface LegacyCompositeTopology {
  kind: 'rectangle' | 'regular-polygon';
  version: 1;
  count: number;
}

export type PrimitiveBoundaryObjectKind =
  'line' | 'circle' | 'arc' | 'ellipse' | 'spline';

export type SketchBoundaryToken =
  | {
      kind: 'composite';
      objectId: EntityId;
      topology: LegacyCompositeTopology;
      edgeIndex: number;
    }
  | {
      kind: 'primitive';
      objectId: EntityId;
      objectKind: PrimitiveBoundaryObjectKind;
    };

/** One token per arrangement curve, including repeated pieces of one edge. */
export interface BoundaryProvenance {
  outer: string[];
  holes: string[][];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSketchBoundaryEntityId(value: unknown): value is EntityId {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

export function isLegacyCompositeTopology(
  value: unknown
): value is LegacyCompositeTopology {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    value.version === 1 &&
    Number.isInteger(value.count) &&
    (value.kind === 'rectangle'
      ? value.count === 4
      : value.kind === 'regular-polygon' &&
        Number(value.count) >= 3 &&
        Number(value.count) <= MAX_SKETCH_POLYGON_SIDES)
  );
}

const primitiveKinds: readonly string[] = [
  'line',
  'circle',
  'arc',
  'ellipse',
  'spline'
];

/** Strict canonical wire grammar. Unknown versions and spellings never coerce. */
export function parseSketchBoundaryToken(
  value: unknown
): SketchBoundaryToken | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (!isSketchBoundaryEntityId(parts[1])) return null;
  const objectId = parts[1];
  if (
    parts.length === 3 &&
    parts[0] === 'p1' &&
    primitiveKinds.includes(parts[2]!)
  ) {
    return {
      kind: 'primitive',
      objectId,
      objectKind: parts[2] as PrimitiveBoundaryObjectKind
    };
  }
  if (
    parts.length !== 7 ||
    parts[0] !== 'b1' ||
    parts[3] !== '1' ||
    parts[5] !== 'e' ||
    !/^[1-9][0-9]*$/.test(parts[4]!) ||
    !/^(0|[1-9][0-9]*)$/.test(parts[6]!)
  )
    return null;
  const topology = {
    kind: parts[2],
    version: 1,
    count: Number(parts[4])
  };
  const edgeIndex = Number(parts[6]);
  if (
    !isLegacyCompositeTopology(topology) ||
    !Number.isInteger(edgeIndex) ||
    edgeIndex < 0 ||
    edgeIndex >= topology.count
  )
    return null;
  return { kind: 'composite', objectId, topology, edgeIndex };
}

export function makeSketchCompositeBoundaryToken(
  objectId: string,
  topology: LegacyCompositeTopology,
  edgeIndex: number
): string {
  if (
    !isSketchBoundaryEntityId(objectId) ||
    !isLegacyCompositeTopology(topology) ||
    !Number.isInteger(edgeIndex) ||
    edgeIndex < 0 ||
    edgeIndex >= topology.count
  )
    throw new Error(
      'A composite boundary token needs a valid source, topology and edge index.'
    );
  return `b1/${objectId}/${topology.kind}/1/${topology.count}/e/${edgeIndex}`;
}

export function makeSketchPrimitiveBoundaryToken(
  objectId: string,
  objectKind: PrimitiveBoundaryObjectKind
): string {
  if (
    !isSketchBoundaryEntityId(objectId) ||
    !primitiveKinds.includes(objectKind)
  )
    throw new Error(
      'A primitive boundary token needs a valid source and curve kind.'
    );
  return `p1/${objectId}/${objectKind}`;
}

function isBoundaryLoop(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    Array.from(value).every((token) => parseSketchBoundaryToken(token) !== null)
  );
}

export function isBoundaryProvenance(
  value: unknown
): value is BoundaryProvenance {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    isBoundaryLoop(value.outer) &&
    Array.isArray(value.holes) &&
    Array.from(value.holes).every(isBoundaryLoop)
  );
}

/** Booth's least rotation keeps repeated-token loops linear in their length. */
function leastRotation(tokens: readonly string[]): string[] {
  const count = tokens.length;
  let a = 0;
  let b = 1;
  let offset = 0;
  while (a < count && b < count && offset < count) {
    const left = tokens[(a + offset) % count]!;
    const right = tokens[(b + offset) % count]!;
    if (left === right) {
      offset += 1;
      continue;
    }
    if (left > right) {
      a += offset + 1;
      if (a <= b) a = b + 1;
    } else {
      b += offset + 1;
      if (b <= a) b = a + 1;
    }
    offset = 0;
  }
  const start = Math.min(a, b);
  return Array.from({ length: count }, (_, i) => tokens[(start + i) % count]!);
}

function compareLoops(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}

/** Traversal direction and starting corner are irrelevant; sequence is not. */
export function canonicalBoundaryLoop(tokens: readonly string[]): string[] {
  if (!isBoundaryLoop(tokens))
    throw new Error(
      'Boundary provenance needs a complete, valid token sequence.'
    );
  const forward = leastRotation(tokens);
  const backward = leastRotation([...tokens].reverse());
  return compareLoops(forward, backward) <= 0 ? forward : backward;
}

export function canonicalBoundaryProvenance(
  value: BoundaryProvenance
): BoundaryProvenance {
  if (!isBoundaryProvenance(value))
    throw new Error(
      'Boundary provenance needs outer and hole loop token sequences.'
    );
  return {
    outer: canonicalBoundaryLoop(value.outer),
    holes: value.holes.map(canonicalBoundaryLoop).sort(compareLoops)
  };
}

export function boundaryProvenanceEqual(
  a: BoundaryProvenance,
  b: BoundaryProvenance
): boolean {
  return (
    JSON.stringify(canonicalBoundaryProvenance(a)) ===
    JSON.stringify(canonicalBoundaryProvenance(b))
  );
}

/** Source dependencies are deduplicated only here, never in loop matching. */
export function boundaryProvenanceObjectIds(
  value: BoundaryProvenance
): EntityId[] {
  if (!isBoundaryProvenance(value))
    throw new Error('Boundary provenance contains malformed tokens.');
  const ids = new Set<EntityId>();
  for (const token of [value.outer, ...value.holes].flat())
    ids.add(parseSketchBoundaryToken(token)!.objectId);
  return [...ids].sort();
}
