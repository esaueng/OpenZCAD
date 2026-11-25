import { vi } from 'vitest';

/**
 * A single-origin stand-in for the browser's lock manager: one holder per name,
 * the rest queued in arrival order and granted as each holder lets go. A
 * `steal` request is granted at once, ahead of the queue; the holder it
 * displaces has its request rejected with an AbortError, as browsers do,
 * while its callback runs on.
 */
export class FakeLockManager {
  private readonly held = new Map<
    string,
    { stolen: boolean; reject(error: unknown): void }
  >();
  private readonly queued = new Map<string, Array<() => void>>();

  pendingCount(name: string): number {
    return this.queued.get(name)?.length ?? 0;
  }

  isHeld(name: string): boolean {
    return this.held.has(name);
  }

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => Promise<T>),
    maybeCallback?: (lock: Lock | null) => Promise<T>
  ): Promise<T> {
    const options =
      typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : maybeCallback!;
    const lock = { name, mode: 'exclusive' } as Lock;

    if (options.steal) {
      const holder = this.held.get(name);
      if (holder) {
        holder.stolen = true;
        holder.reject(
          new DOMException(
            'Lock broken by another request with the steal option',
            'AbortError'
          )
        );
      }
      return this.grant(name, lock, callback);
    }
    if (!this.held.has(name)) {
      return this.grant(name, lock, callback);
    }
    if (options.ifAvailable) {
      return callback(null);
    }
    return new Promise<T>((granted, reject) => {
      const waiters = this.queued.get(name) ?? [];
      const grant = () => {
        options.signal?.removeEventListener('abort', abort);
        this.grant(name, lock, callback).then(granted, reject);
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

  private grant<T>(
    name: string,
    lock: Lock,
    callback: (lock: Lock | null) => Promise<T>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const holder = { stolen: false, reject };
      this.held.set(name, holder);
      const settle = () => {
        // A stolen lock already belongs to the tab that took it.
        if (!holder.stolen) this.releaseNext(name);
      };
      callback(lock).then(
        (value) => {
          settle();
          resolve(value);
        },
        (error: Error) => {
          settle();
          reject(error);
        }
      );
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
