/**
 * Persisted history sessions: reopening a project without replaying its
 * feature history.
 *
 * Remus can serialize a whole kernel session (`kernel.snapshot()`) and restore
 * it into a fresh kernel with identical handles and journal
 * (`RemusKernel.fromSnapshot`). The adapter pairs those bytes with the JS half
 * of the same state: the build result of the history's last feature, the
 * per-feature digests the history cache matches checkpoints by, the boolean
 * probe signature and the hash-only edge selections the build recorded. A
 * reopened project seeds the history kernel from them as one checkpoint at
 * its last feature, and the ordinary prefix-restore path takes over.
 *
 * Correctness over speed: a session is only seeded when every digest, the
 * probe signature, the parameter scope, the project and the kernel build
 * identity agree, and the sync it serves publishes nothing until its complete
 * projection matches the {@link projectionSignature} recorded when the
 * session was captured ({@link projectionMatches}). Any refusal, throw or
 * mismatch drops the restored kernel and replays the history as before.
 */
import type { DerivedState } from '@openzcad/shared';
import type { ExactBuildResult } from './exact-types';
import type { EdgeSelectionMemoryState } from './exact-edge-selection-transport';
import { RemusKernel } from './remus-runtime';

/** Bumped whenever the JS half of a persisted session changes shape. */
export const PERSISTED_HISTORY_SESSION_FORMAT = 1;

export interface PersistedHistorySession {
  format: typeof PERSISTED_HISTORY_SESSION_FORMAT;
  /** `RemusKernel.snapshotBuildId()` of the kernel that wrote the bytes. */
  kernelBuildId: string;
  projectId: string;
  /** `historyScopeDigest` of the document the session was built for. */
  scopeKey: string;
  /** One history digest per feature, in feature order. */
  digests: string[];
  /** Boolean-probe signature of the last feature's build. */
  lineageProbeKey: string;
  /** Every hash-only edge pick resolved as stored (see the checkpoint entry). */
  carryNeutral: boolean;
  /** The build result after the last feature (structured-clonable). */
  build: ExactBuildResult;
  /** Hash-only edge selections this project's build recorded. */
  edgeSelections: EdgeSelectionMemoryState;
  /** `kernel.snapshot()` bytes. */
  kernelBytes: Uint8Array;
  /** `RemusKernel.snapshotDigest(kernelBytes)`; detects storage damage early. */
  kernelDigest: string;
  /** {@link projectionSignature} of the projection this session published. */
  projectionSignature: string;
}

interface SnapshotKernelStatics {
  fromSnapshot(bytes: Uint8Array): RemusKernel;
  snapshotDigest(bytes: Uint8Array): string;
  snapshotBuildId(): string;
}

interface SnapshotKernelInstance {
  snapshot(): Uint8Array;
}

/** The snapshot bindings, when the pinned kernel has them. */
export function kernelSnapshotSupport(): SnapshotKernelStatics | null {
  const statics = RemusKernel as unknown as Partial<SnapshotKernelStatics>;
  const prototype =
    RemusKernel.prototype as unknown as Partial<SnapshotKernelInstance>;
  return typeof statics.fromSnapshot === 'function' &&
    typeof statics.snapshotDigest === 'function' &&
    typeof statics.snapshotBuildId === 'function' &&
    typeof prototype.snapshot === 'function'
    ? (statics as SnapshotKernelStatics)
    : null;
}

/** The identity stamped into and required of snapshots, or null. */
export function kernelSnapshotBuildId(): string | null {
  try {
    return kernelSnapshotSupport()?.snapshotBuildId() ?? null;
  } catch {
    return null;
  }
}

/** `kernel.snapshot()`; throws `snapshot:<code>: …` on a refusal. */
export function snapshotKernel(kernel: RemusKernel): Uint8Array {
  return (kernel as unknown as SnapshotKernelInstance).snapshot();
}

/**
 * Restores a session's kernel, all or nothing. The stored digest is checked
 * first, so storage damage is refused before the decode allocates anything.
 */
export function restoreKernelSnapshot(
  session: PersistedHistorySession
): RemusKernel {
  const support = kernelSnapshotSupport();
  if (!support)
    throw new Error('snapshot:unsupported: kernel has no snapshots');
  if (support.snapshotBuildId() !== session.kernelBuildId)
    throw new Error('snapshot:build_mismatch: stored by another kernel build');
  if (support.snapshotDigest(session.kernelBytes) !== session.kernelDigest)
    throw new Error('snapshot:corrupt: stored digest disagrees');
  return support.fromSnapshot(session.kernelBytes);
}

/**
 * Structural checks on a value read back from storage, before any of it is
 * trusted: a record written by an older format, or damaged into another
 * shape, is refused rather than half-used.
 */
export function isPersistedHistorySession(
  value: unknown
): value is PersistedHistorySession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<PersistedHistorySession>;
  const build = session.build as Partial<ExactBuildResult> | undefined;
  return (
    session.format === PERSISTED_HISTORY_SESSION_FORMAT &&
    typeof session.kernelBuildId === 'string' &&
    typeof session.projectId === 'string' &&
    typeof session.scopeKey === 'string' &&
    Array.isArray(session.digests) &&
    session.digests.every((digest) => typeof digest === 'string') &&
    typeof session.lineageProbeKey === 'string' &&
    typeof session.carryNeutral === 'boolean' &&
    session.kernelBytes instanceof Uint8Array &&
    typeof session.kernelDigest === 'string' &&
    typeof session.projectionSignature === 'string' &&
    Array.isArray(session.edgeSelections) &&
    !!build &&
    build.shapes instanceof Map &&
    build.sketchBases instanceof Map &&
    build.datumFrames instanceof Map &&
    build.datumAxes instanceof Map &&
    build.consumed instanceof Set &&
    build.importedStepDiagnostics instanceof Map &&
    build.meshBodies instanceof Set &&
    build.partialRevolveBodies instanceof Set &&
    Array.isArray(build.warnings) &&
    Array.isArray(build.featureWarnings) &&
    Array.isArray(build.referenceRepairs)
  );
}

/**
 * Projection fields that describe how a body was drawn or labelled rather
 * than what the exact model is: display meshes and the per-face triangle
 * ranges and sampled edge polylines cut from them (a held display deflection
 * or a draft display changes those without changing the model), bounds
 * tightened from that mesh, display metadata the document supplies, the
 * worker session's projection revision and lazily integrated mass properties.
 */
const PRESENTATION_KEYS = new Set([
  'mesh',
  'bbox',
  'triangleStart',
  'triangleCount',
  'points',
  'name',
  'color',
  'opacity',
  'displayQuality',
  'projectionRevision',
  'massProperties',
  'updatedAt'
]);

/**
 * Deterministic text of everything a projection says about the exact model:
 * bodies, volumes, face and edge identities (hashes, topology ids, lineage
 * references and their witnesses), measured face/edge geometry, recognition
 * results, warnings and feature warnings. Two projections of the same model
 * state agree here; a restored session that disagrees with the projection it
 * was captured with is never published.
 */
export function projectionSignature(
  derived: Pick<
    DerivedState,
    'bodyRepresentations' | 'warnings' | 'featureWarnings'
  >
): string {
  return JSON.stringify(
    {
      bodies: derived.bodyRepresentations,
      warnings: derived.warnings,
      featureWarnings: derived.featureWarnings ?? []
    },
    (key, entry: unknown) => {
      if (PRESENTATION_KEYS.has(key)) return undefined;
      if (ArrayBuffer.isView(entry)) return undefined;
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const name of Object.keys(record).sort()) {
          if (record[name] !== undefined) sorted[name] = record[name];
        }
        return sorted;
      }
      // JSON has no NaN or Infinity; keep them distinct from null.
      if (typeof entry === 'number' && !Number.isFinite(entry))
        return `#${String(entry)}`;
      return entry;
    }
  );
}

/**
 * Relative agreement required of floating-point measurements (volumes, face
 * and edge measurements, witness positions). The restored topology is the
 * captured one bit for bit, but the kernel's measurement routines are not
 * bit-stable across its cache state: a restored, a replayed and the original
 * session can disagree in the last unit in the last place. Anything beyond
 * this is a different model.
 */
export const PROJECTION_RELATIVE_TOLERANCE = 1e-9;

/**
 * Whether two {@link projectionSignature}s describe the same model: the same
 * structure, every string, boolean, integer (hashes, ids, counts), lineage
 * name and reference exactly equal, and fractional numbers within
 * {@link PROJECTION_RELATIVE_TOLERANCE}.
 */
export function projectionMatches(stored: string, current: string): boolean {
  if (stored === current) return true;
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(stored);
    b = JSON.parse(current);
  } catch {
    return false;
  }
  const stack: [unknown, unknown][] = [[a, b]];
  while (stack.length > 0) {
    const [left, right] = stack.pop()!;
    if (typeof left === 'number' && typeof right === 'number') {
      if (left === right) continue;
      if (Number.isInteger(left) && Number.isInteger(right)) return false;
      const scale = Math.max(1, Math.abs(left), Math.abs(right));
      if (Math.abs(left - right) > PROJECTION_RELATIVE_TOLERANCE * scale)
        return false;
      continue;
    }
    if (left === null || right === null || typeof left !== 'object') {
      if (left !== right) return false;
      continue;
    }
    if (
      typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right)
    )
      return false;
    if (Array.isArray(left)) {
      const other = right as unknown[];
      if (left.length !== other.length) return false;
      for (let index = 0; index < left.length; index += 1)
        stack.push([left[index], other[index]]);
      continue;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    if (keys.length !== Object.keys(rightRecord).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(rightRecord, key)) return false;
      stack.push([leftRecord[key], rightRecord[key]]);
    }
  }
  return true;
}

/**
 * Accounted bytes of a structured-clonable value: typed array storage plus a
 * rough per-entry cost. Bounds what a persisted session may store; it is not
 * a measure of IndexedDB's own encoding.
 */
export function estimateStructuredBytes(value: unknown): number {
  const seen = new Set<object>();
  let bytes = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (typeof entry === 'string') {
      bytes += 8 + entry.length * 2;
      continue;
    }
    if (!entry || typeof entry !== 'object') {
      bytes += 8;
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (ArrayBuffer.isView(entry)) {
      bytes += entry.byteLength;
      continue;
    }
    if (entry instanceof ArrayBuffer) {
      bytes += entry.byteLength;
      continue;
    }
    bytes += 16;
    if (entry instanceof Map) {
      for (const [key, item] of entry) stack.push(key, item);
    } else if (entry instanceof Set) {
      for (const item of entry) stack.push(item);
    } else if (Array.isArray(entry)) {
      for (const item of entry) stack.push(item);
    } else {
      for (const [key, item] of Object.entries(entry)) stack.push(key, item);
    }
  }
  return bytes;
}
