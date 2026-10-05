/**
 * Per-sync memo for read-only kernel queries, plus the adapter-lifetime store
 * of ADR-011 topology witnesses it draws on.
 *
 * One offset-face sync used to read the same facts many times over: every
 * face's surface class once per caller (~70 `getSurfaceType` calls per face
 * on the hammer holder, mostly from the blend-face scan), every face's plane
 * frame once per planar-distance candidate pair, each solid's edge-to-face
 * map once per consumer, and the source and result bodies' face and edge
 * witnesses up to four times each — resolving the picked face, the edit's
 * source candidates, its result candidates, the boundary-edge lineage and
 * finally the measurement pass. Memoized here: surface classes
 * ({@link surfaceTypeOf}), parsed edge-to-face maps ({@link edgeToFaceMapOf}),
 * face values such as plane frames ({@link SyncReadMemo.faceValue}) and
 * witnesses (`faceWitnessOf` / `edgeWitnessOf`). Each read is pure:
 *
 * - a Remus topology handle is never reassigned to another entity (a
 *   checkpoint restore retires post-checkpoint handles instead of reusing
 *   them), and
 * - every adapter path that changes a body's geometry allocates new solids;
 *   the single in-place `transformSolid` moves a fresh probe copy rigidly,
 *   which changes no surface class, and that copy is never witnessed
 *   (the same invariant `MeasuredBodyCacheEntry` relies on).
 *
 * So a fact read once about a handle is the fact. The memo only ever answers
 * with values the kernel itself returned for that handle; it never derives,
 * rounds or substitutes one, so every published hash, witness and warning is
 * byte-identical to the unmemoized path.
 *
 * Witnesses outlive one sync in {@link TopologyWitnessStore}, keyed by solid
 * handle: the next edit's source body is the body this sync measured. Before
 * a stored record is used it is revalidated against the solid's live face and
 * edge lists — the same recount the measured-body cache performs — and a
 * mismatch discards it.
 *
 * The scope is synchronous ({@link withSyncReadMemo}) and only answers for
 * the kernel that opened it, so it can never leak into another kernel or
 * across an `await`.
 */
import type { EdgeWitnessV1, FaceWitnessV1 } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';

/** Witnesses measured for one solid, keyed by face / edge handle. */
export interface SolidWitnessRecord {
  /** `getSolidFaces(solid)` when the record was (re)validated. */
  readonly faces: readonly number[];
  /** `getSolidEdges(solid)` when the record was (re)validated. */
  readonly edges: readonly number[];
  readonly faceWitnesses: Map<number, FaceWitnessV1>;
  readonly edgeWitnesses: Map<number, EdgeWitnessV1>;
}

/** Retained witness handles across all solids before the oldest are evicted. */
export const MAX_STORED_WITNESS_HANDLES = 50_000;

function sameHandles(left: readonly number[], right: ArrayLike<number>) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Topology witnesses per solid handle for one kernel's lifetime. Owned by the
 * adapter next to the history kernel and cleared with it.
 */
export class TopologyWitnessStore {
  private kernel: RemusKernel | null = null;
  /** Insertion order is recency: a hit is re-inserted at the end. */
  private readonly solids = new Map<number, SolidWitnessRecord>();
  private handleCount = 0;

  constructor(
    private readonly maxHandles: number = MAX_STORED_WITNESS_HANDLES
  ) {}

  clear(): void {
    this.kernel = null;
    this.solids.clear();
    this.handleCount = 0;
  }

  /** Number of solids with a retained record (for tests). */
  get size(): number {
    return this.solids.size;
  }

  /**
   * The record for `solid`, revalidated against its live face and edge
   * lists. A missing or stale record is replaced by an empty one.
   */
  record(kernel: RemusKernel, solid: number): SolidWitnessRecord {
    if (this.kernel !== kernel) {
      this.clear();
      this.kernel = kernel;
    }
    const faces = kernel.getSolidFaces(solid);
    const edges = kernel.getSolidEdges(solid);
    const existing = this.solids.get(solid);
    if (existing) {
      this.solids.delete(solid);
      if (
        sameHandles(existing.faces, faces) &&
        sameHandles(existing.edges, edges)
      ) {
        this.solids.set(solid, existing);
        return existing;
      }
      this.handleCount -= existing.faces.length + existing.edges.length;
    }
    const record = newRecord(faces, edges);
    this.solids.set(solid, record);
    this.handleCount += record.faces.length + record.edges.length;
    for (const [handle, retained] of this.solids) {
      if (this.handleCount <= this.maxHandles || handle === solid) break;
      this.solids.delete(handle);
      this.handleCount -= retained.faces.length + retained.edges.length;
    }
    return record;
  }
}

function newRecord(
  faces: ArrayLike<number>,
  edges: ArrayLike<number>
): SolidWitnessRecord {
  return {
    faces: Array.from(faces),
    edges: Array.from(edges),
    faceWitnesses: new Map(),
    edgeWitnesses: new Map()
  };
}

/** Kernel reads shared by one synchronous build or measurement. */
export class SyncReadMemo {
  readonly surfaceTypes = new Map<number, string>();
  readonly faceWitnesses = new Map<number, FaceWitnessV1>();
  readonly edgeWitnesses = new Map<number, EdgeWitnessV1>();
  /** The stored record each face / edge of a registered solid belongs to. */
  private readonly faceOwners = new Map<number, SolidWitnessRecord>();
  private readonly edgeOwners = new Map<number, SolidWitnessRecord>();
  private readonly records = new Map<number, SolidWitnessRecord>();
  private readonly faceValues = new Map<string, Map<number, unknown>>();
  private readonly edgeToFaceMaps = new Map<number, EdgeToFaceMap>();

  constructor(
    readonly kernel: RemusKernel,
    private readonly store: TopologyWitnessStore | null = null
  ) {}

  /**
   * Registers `solid` once per memo: its stored witnesses (revalidated) are
   * served from now on, and witnesses measured for its faces and edges in
   * this sync are stored for the next one.
   */
  registerSolid(solid: number): void {
    if (this.records.has(solid)) return;
    const record = this.store
      ? this.store.record(this.kernel, solid)
      : newRecord(
          this.kernel.getSolidFaces(solid),
          this.kernel.getSolidEdges(solid)
        );
    this.records.set(solid, record);
    for (const face of record.faces) {
      this.faceOwners.set(face, record);
      const witness = record.faceWitnesses.get(face);
      if (witness) {
        this.faceWitnesses.set(face, witness);
        // A face witness records the kernel's own surface class verbatim.
        this.surfaceTypes.set(face, witness.surfaceType);
      } else {
        const known = this.faceWitnesses.get(face);
        if (known) record.faceWitnesses.set(face, known);
      }
    }
    for (const edge of record.edges) {
      this.edgeOwners.set(edge, record);
      const witness = record.edgeWitnesses.get(edge);
      if (witness) {
        this.edgeWitnesses.set(edge, witness);
      } else {
        const known = this.edgeWitnesses.get(edge);
        if (known) record.edgeWitnesses.set(edge, known);
      }
    }
  }

  /**
   * `read()` for `face`, memoized under `kind` for this sync. A read that
   * throws is not memoized, so it throws again next time.
   */
  faceValue<T>(kind: string, face: number, read: () => T): T {
    let values = this.faceValues.get(kind);
    if (!values) {
      values = new Map();
      this.faceValues.set(kind, values);
    }
    if (values.has(face)) return values.get(face) as T;
    const value = read();
    values.set(face, value);
    return value;
  }

  recordFaceWitness(face: number, witness: FaceWitnessV1): void {
    this.faceWitnesses.set(face, witness);
    this.faceOwners.get(face)?.faceWitnesses.set(face, witness);
  }

  recordEdgeWitness(edge: number, witness: EdgeWitnessV1): void {
    this.edgeWitnesses.set(edge, witness);
    this.edgeOwners.get(edge)?.edgeWitnesses.set(edge, witness);
  }

  edgeToFaceMap(solid: number): EdgeToFaceMap {
    let map = this.edgeToFaceMaps.get(solid);
    if (!map) {
      map = JSON.parse(this.kernel.edgeToFaceMap(solid)) as EdgeToFaceMap;
      this.edgeToFaceMaps.set(solid, map);
    }
    return map;
  }
}

let activeMemo: SyncReadMemo | null = null;

/**
 * Runs `read` with `memo` answering memoized queries for its kernel. The
 * scope is synchronous and closes on return or throw.
 */
export function withSyncReadMemo<T>(memo: SyncReadMemo, read: () => T): T {
  const close = enterSyncReadMemo(memo);
  try {
    return read();
  } finally {
    close();
  }
}

/**
 * Opens `memo` and returns the function that closes it again. The caller
 * must close it in a `finally` around synchronous work only.
 */
export function enterSyncReadMemo(memo: SyncReadMemo): () => void {
  const previous = activeMemo;
  activeMemo = memo;
  return () => {
    activeMemo = previous;
  };
}

/** The open memo for `kernel`, if any. */
export function syncReadMemoFor(kernel: RemusKernel): SyncReadMemo | null {
  return activeMemo !== null && activeMemo.kernel === kernel
    ? activeMemo
    : null;
}

/** `kernel.getSurfaceType(face)`, read at most once per face per sync. */
export function surfaceTypeOf(kernel: RemusKernel, face: number): string {
  const memo = syncReadMemoFor(kernel);
  if (!memo) return kernel.getSurfaceType(face);
  let surfaceType = memo.surfaceTypes.get(face);
  if (surfaceType === undefined) {
    surfaceType = kernel.getSurfaceType(face);
    memo.surfaceTypes.set(face, surfaceType);
  }
  return surfaceType;
}

/** Edge handle (as a string key) to the faces that use it. */
export type EdgeToFaceMap = Record<string, number[]>;

/**
 * The parsed `edgeToFaceMap(solid)`, parsed at most once per solid per sync.
 * Inside a memo every caller shares one object: never mutate it.
 */
export function edgeToFaceMapOf(
  kernel: RemusKernel,
  solid: number
): EdgeToFaceMap {
  const memo = syncReadMemoFor(kernel);
  return memo
    ? memo.edgeToFaceMap(solid)
    : (JSON.parse(kernel.edgeToFaceMap(solid)) as EdgeToFaceMap);
}
