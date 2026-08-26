import type { ProjectDocument } from '@openzcad/shared';
import { keyableImportedNodes } from '@openzcad/document-core';

export interface ExactRebuildCacheOptions<T> {
  maxEntries: number;
  maxBytes: number;
  maxInFlight: number;
  clone?: (value: T) => T;
  sizeOf?: (value: T) => number;
}

interface CacheEntry<T> {
  value: T;
  bytes: number;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Canonical project content for exact rebuilds. Derived projections are
 * output, and the version/history bookkeeping fields are excluded because the
 * rebuild never reads them: `version` and `revisions` advance on every
 * command *and every undo/redo*, so keying on them would make undo/redo — the
 * main scenario this cache exists for — a guaranteed miss even though the
 * restored nodes are identical to an already-built state. `commandLog` and
 * `checkpoints` are replay/recovery records of how the nodes came to be, not
 * rebuild inputs.
 */
export function canonicalProjectContentKey(document: ProjectDocument): string {
  const {
    derived: _derived,
    version: _version,
    revisions: _revisions,
    checkpoints: _checkpoints,
    commandLog: _commandLog,
    ...content
  } = document;
  return stableJson({ ...content, nodes: keyableImportedNodes(content.nodes) });
}

/**
 * Approximate retained size, counted by walking the value rather than
 * serialising it. The previous measure built a stable JSON string purely to
 * take its length — for a derived projection holding a few hundred thousand
 * mesh floats that is a multi-megabyte transient string on every store, which
 * is a strange price to pay for a number nobody reads.
 *
 * Counting is also closer to the truth: a float costs 8 bytes here, against
 * the ~20 its decimal text occupies. Budgets in terms of this measure are
 * therefore real bytes rather than an inflated proxy.
 */
function defaultSizeOf(value: unknown): number {
  const seen = new Set<object>();
  const measure = (node: unknown): number => {
    if (node === null || node === undefined) {
      return 4;
    }
    switch (typeof node) {
      case 'number':
        return 8;
      case 'boolean':
        return 4;
      case 'string':
        return node.length * 2;
      case 'object':
        break;
      default:
        return 8;
    }
    const object = node;
    if (seen.has(object)) {
      return 0;
    }
    seen.add(object);
    // Typed mesh buffers: their retained size IS their byte length. Without
    // this branch the walker falls through to Object.entries and pays a
    // per-element string key for every float.
    if (ArrayBuffer.isView(object)) {
      return 16 + object.byteLength;
    }
    if (Array.isArray(object)) {
      let total = 16;
      for (const entry of object) {
        total += measure(entry);
      }
      return total;
    }
    let total = 16;
    for (const [key, entry] of Object.entries(object)) {
      total += key.length * 2 + measure(entry);
    }
    return total;
  };
  try {
    return measure(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Bounded LRU results plus bounded promise deduplication. Stored values never
 * escape directly: each caller receives a structured clone.
 */
export class ExactRebuildCache<T> {
  private readonly results = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly pendingRejectors = new Set<(error: Error) => void>();
  private readonly clone: (value: T) => T;
  private readonly sizeOf: (value: T) => number;
  private resultBytes = 0;
  private terminatedError: Error | null = null;

  constructor(private readonly options: ExactRebuildCacheOptions<T>) {
    if (
      options.maxEntries < 1 ||
      options.maxBytes < 1 ||
      options.maxInFlight < 1
    ) {
      throw new Error('Exact rebuild cache limits must be positive.');
    }
    this.clone = options.clone ?? ((value) => structuredClone(value));
    this.sizeOf = options.sizeOf ?? defaultSizeOf;
  }

  get entryCount(): number {
    return this.results.size;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get bytes(): number {
    return this.resultBytes;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    if (this.terminatedError) {
      return Promise.reject(this.terminatedError);
    }
    const cached = this.results.get(key);
    if (cached) {
      this.results.delete(key);
      this.results.set(key, cached);
      return this.withLifecycle(Promise.resolve(this.clone(cached.value)));
    }
    const shared = this.inFlight.get(key);
    if (shared) {
      return this.withLifecycle(shared.then((value) => this.clone(value)));
    }
    if (this.inFlight.size >= this.options.maxInFlight) {
      return Promise.reject(
        new Error('Exact rebuild cache in-flight limit reached.')
      );
    }

    const work = load().then((value) => {
      const internal = this.clone(value);
      if (!this.terminatedError) {
        this.store(key, internal);
      }
      return internal;
    });
    this.inFlight.set(key, work);
    void work.finally(() => this.inFlight.delete(key)).catch(() => undefined);
    return this.withLifecycle(work.then((value) => this.clone(value)));
  }

  terminate(error = new Error('Exact rebuild cache terminated.')): void {
    if (this.terminatedError) {
      return;
    }
    this.terminatedError = error;
    this.results.clear();
    this.resultBytes = 0;
    for (const reject of this.pendingRejectors) {
      reject(error);
    }
    this.pendingRejectors.clear();
  }

  private withLifecycle<TResult>(work: Promise<TResult>): Promise<TResult> {
    if (this.terminatedError) {
      return Promise.reject(this.terminatedError);
    }
    return new Promise<TResult>((resolve, reject) => {
      const rejectForTermination = (error: Error) => reject(error);
      this.pendingRejectors.add(rejectForTermination);
      work.then(resolve, reject).finally(() => {
        this.pendingRejectors.delete(rejectForTermination);
      });
    });
  }

  private store(key: string, value: T): void {
    const bytes = this.sizeOf(value) + key.length * 2;
    if (!Number.isFinite(bytes) || bytes > this.options.maxBytes) {
      return;
    }
    const previous = this.results.get(key);
    if (previous) {
      this.resultBytes -= previous.bytes;
      this.results.delete(key);
    }
    this.results.set(key, { value, bytes });
    this.resultBytes += bytes;
    while (
      this.results.size > this.options.maxEntries ||
      this.resultBytes > this.options.maxBytes
    ) {
      const oldestKey = this.results.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldest = this.results.get(oldestKey)!;
      this.results.delete(oldestKey);
      this.resultBytes -= oldest.bytes;
    }
  }
}

/** Tokens for broadcasts; explicit caller-owned requests are never stale. */
export class LatestBroadcastGate {
  private newest = 0;

  issue(isBroadcast: boolean): number | null {
    if (!isBroadcast) {
      return null;
    }
    this.newest += 1;
    return this.newest;
  }

  isCurrent(token: number | null): boolean {
    return token === null || token === this.newest;
  }
}
