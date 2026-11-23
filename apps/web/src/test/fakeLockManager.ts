import { vi } from 'vitest';

/**
 * A single-origin stand-in for the browser's lock manager: one holder per name,
 * the rest queued in arrival order and granted as each holder lets go.
 */
export class FakeLockManager {
  private readonly held = new Set<string>();
  private readonly queued = new Map<string, Array<() => void>>();

  pendingCount(name: string): number {
    return this.queued.get(name)?.length ?? 0;
  }

  request(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => Promise<void>),
    maybeCallback?: (lock: Lock | null) => Promise<void>
  ): Promise<void> {
    const options =
      typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : maybeCallback!;
    const lock = { name, mode: 'exclusive' } as Lock;

    if (!this.held.has(name)) {
      this.held.add(name);
      return callback(lock).finally(() => this.releaseNext(name));
    }
    if (options.ifAvailable) {
      return callback(null);
    }
    return new Promise<void>((granted, reject) => {
      const waiters = this.queued.get(name) ?? [];
      const grant = () => {
        options.signal?.removeEventListener('abort', abort);
        this.held.add(name);
        void callback(lock).finally(() => {
          this.releaseNext(name);
          granted();
        });
      };
      const abort = () => {
        const index = waiters.indexOf(grant);
        if (index !== -1) waiters.splice(index, 1);
        reject(new DOMException('Lock request cancelled', 'AbortError'));
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      waiters.push(grant);
      this.queued.set(name, waiters);
    });
  }

  private releaseNext(name: string): void {
    this.held.delete(name);
    const waiters = this.queued.get(name);
    const next = waiters?.shift();
    if (next) {
      next();
    }
  }
}

export function withLockManager(): FakeLockManager {
  const locks = new FakeLockManager();
  vi.stubGlobal('navigator', { locks });
  return locks;
}
