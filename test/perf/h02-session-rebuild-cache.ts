/** Observe the real worker memo with its unchanged options, only in session builds. */
export * from '../../apps/web/src/worker/exactRebuildCache';
import {
  ExactRebuildCache as Base,
  type ExactRebuildCacheOptions
} from '../../apps/web/src/worker/exactRebuildCache';

export class ExactRebuildCache<T> extends Base<T> {
  private evictions = 0;
  constructor(options: ExactRebuildCacheOptions<T>) {
    super(options);
    (globalThis as unknown as { __h02Memo: () => unknown }).__h02Memo = () => ({
      entries: this.entryCount,
      bytes: this.bytes,
      inFlight: this.inFlightCount,
      evictions: this.evictions,
      maxEntries: options.maxEntries,
      maxBytes: options.maxBytes
    });
  }
  override async get(key: string, load: () => Promise<T>): Promise<T> {
    const state = this as unknown as { results: Map<string, unknown> };
    const previous = [...state.results.keys()];
    const value = await super.get(key, load);
    this.evictions += previous.filter(
      (entry) => !state.results.has(entry)
    ).length;
    return value;
  }
}
