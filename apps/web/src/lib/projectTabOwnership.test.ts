import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimProjectOwnership } from './projectTabOwnership';

/**
 * A single-origin stand-in for the browser's lock manager: one holder per name,
 * the rest queued in arrival order and granted as each holder lets go.
 */
class FakeLockManager {
  private readonly held = new Set<string>();
  private readonly queued = new Map<string, Array<() => void>>();

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
    return new Promise<void>((granted) => {
      const waiters = this.queued.get(name) ?? [];
      waiters.push(() => {
        this.held.add(name);
        void callback(lock).finally(() => {
          this.releaseNext(name);
          granted();
        });
      });
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

function withLockManager(): FakeLockManager {
  const locks = new FakeLockManager();
  vi.stubGlobal('navigator', { locks });
  return locks;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('project tab ownership', () => {
  it('gives the project to the first tab and refuses the second', async () => {
    withLockManager();

    const first = await claimProjectOwnership('project_a', () => undefined);
    const second = await claimProjectOwnership('project_a', () => undefined);

    expect(first.owned).toBe(true);
    expect(second.owned).toBe(false);
    first.release();
    second.release();
  });

  it('keeps ownership of one project from blocking another', async () => {
    withLockManager();

    const first = await claimProjectOwnership('project_a', () => undefined);
    const other = await claimProjectOwnership('project_b', () => undefined);

    expect(first.owned).toBe(true);
    expect(other.owned).toBe(true);
    first.release();
    other.release();
  });

  it('promotes the waiting tab once the owner lets go', async () => {
    withLockManager();
    const promoted = vi.fn();

    const first = await claimProjectOwnership('project_a', () => undefined);
    const second = await claimProjectOwnership('project_a', promoted);
    expect(second.owned).toBe(false);
    expect(promoted).not.toHaveBeenCalled();

    first.release();
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));

    // The promoted tab now holds it against a third.
    const third = await claimProjectOwnership('project_a', () => undefined);
    expect(third.owned).toBe(false);
    second.release();
    third.release();
  });

  it('does not promote a tab that closed the project while waiting', async () => {
    withLockManager();
    const promoted = vi.fn();

    const first = await claimProjectOwnership('project_a', () => undefined);
    const second = await claimProjectOwnership('project_a', promoted);
    second.release();
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(promoted).not.toHaveBeenCalled();
    // The abandoned wait let go of the project rather than sitting on it.
    const third = await claimProjectOwnership('project_a', () => undefined);
    expect(third.owned).toBe(true);
    third.release();
  });

  it('opens the project normally when the browser has no lock manager', async () => {
    vi.stubGlobal('navigator', {});

    const claim = await claimProjectOwnership('project_a', () => undefined);

    expect(claim.owned).toBe(true);
    claim.release();
  });
});
