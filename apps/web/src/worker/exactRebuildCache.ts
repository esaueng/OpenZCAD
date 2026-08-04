import type { ProjectDocument } from '@openzcad/shared';

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

/** Canonical project content for exact rebuilds. Derived projections are output. */
export function canonicalProjectContentKey(document: ProjectDocument): string {
  const { derived: _derived, ...content } = document;
  return stableJson(content);
}

function defaultSizeOf(value: unknown): number {
  try {
    return stableJson(value).length * 2;
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
