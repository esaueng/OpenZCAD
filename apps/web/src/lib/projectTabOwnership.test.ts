import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimProjectOwnership,
  trackProjectStorage,
  writeOwnedProjectStorage,
  writeUnclaimedProjectStorage
} from './projectTabOwnership';
import { withLockManager } from '../test/fakeLockManager';

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
    const locks = withLockManager();
    const promoted = vi.fn();

    const first = await claimProjectOwnership('project_a', () => undefined);
    const second = await claimProjectOwnership('project_a', promoted);
    expect(locks.pendingCount('openzcad-project:project_a')).toBe(1);
    second.release();
    // Cancellation cannot depend on the background tab running a callback
    // after the current owner releases its lock (for example on reload).
    expect(locks.pendingCount('openzcad-project:project_a')).toBe(0);
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(promoted).not.toHaveBeenCalled();
    // The abandoned wait let go of the project rather than sitting on it.
    const third = await claimProjectOwnership('project_a', () => undefined);
    expect(third.owned).toBe(true);
    third.release();
  });

  it('keeps the lock through a retained write, handing it on once the write lets go', async () => {
    withLockManager();
    const promoted = vi.fn();

    const first = await claimProjectOwnership('project_a', () => undefined);
    const second = await claimProjectOwnership('project_a', promoted);
    const letGo = first.retain();
    expect(letGo).not.toBeNull();
    // The owner navigates away while its write is still in flight.
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promoted).not.toHaveBeenCalled();
    // Nothing more can be retained on a released claim.
    expect(first.retain()).toBeNull();

    letGo!();
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));
    // Letting go twice releases nothing more.
    letGo!();
    second.release();
  });

  it('releases at once when no write retains the claim', async () => {
    withLockManager();
    const promoted = vi.fn();

    const first = await claimProjectOwnership('project_a', () => undefined);
    const second = await claimProjectOwnership('project_a', promoted);
    first.retain()!();
    first.release();
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));
    second.release();
  });

  it('opens the project normally when the browser has no lock manager', async () => {
    vi.stubGlobal('navigator', {});

    const claim = await claimProjectOwnership('project_a', () => undefined);

    expect(claim.owned).toBe(true);
    claim.release();
  });
});

describe('writes made before a tab claims the project', () => {
  it('leaves the device copy alone while another tab owns the project', async () => {
    withLockManager();
    const owner = await claimProjectOwnership('project_a', () => undefined);
    const write = vi.fn(() => Promise.resolve());

    await expect(
      writeUnclaimedProjectStorage('project_a', write)
    ).resolves.toBe(false);

    expect(write).not.toHaveBeenCalled();
    owner.release();
  });

  it('writes an unclaimed project and holds it off from a claim meanwhile', async () => {
    withLockManager();
    let finish: () => void = () => undefined;
    const write = writeUnclaimedProjectStorage(
      'project_a',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    await Promise.resolve();

    const claim = await claimProjectOwnership('project_a', () => undefined);
    expect(claim.owned).toBe(false);

    finish();
    await expect(write).resolves.toBe(true);
    claim.release();
  });

  it('writes without the lock API', async () => {
    vi.stubGlobal('navigator', {});
    const write = vi.fn(() => Promise.resolve());

    await expect(
      writeUnclaimedProjectStorage('project_a', write)
    ).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('takes the lock from its holder and reports the loss to that claim', async () => {
    const locks = withLockManager();
    const lost = vi.fn();

    const owner = await claimProjectOwnership('project_a', () => undefined, {
      onLost: lost
    });
    expect(owner.owned).toBe(true);
    const taker = await claimProjectOwnership('project_a', () => undefined, {
      steal: true
    });

    expect(taker.owned).toBe(true);
    await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
    // The displaced claim's release does not free the lock it no longer has.
    owner.release();
    await owner.freed;
    expect(locks.isHeld('openzcad-project:project_a')).toBe(true);
    taker.release();
    await taker.freed;
    expect(locks.isHeld('openzcad-project:project_a')).toBe(false);
  });

  it('never mistakes a stolen lock for a refused request', async () => {
    withLockManager();
    const lost = vi.fn();
    const promoted = vi.fn();

    const first = await claimProjectOwnership('project_a', () => undefined);
    // Waiting, then promoted: the steal lands on a lock taken through the
    // queue rather than on first ask.
    const waiting = await claimProjectOwnership('project_a', promoted, {
      onLost: lost
    });
    first.release();
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));

    const taker = await claimProjectOwnership('project_a', () => undefined, {
      steal: true
    });
    expect(taker.owned).toBe(true);
    await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
    waiting.release();
    taker.release();
  });

  it('reports no loss for a claim released before its lock was taken', async () => {
    withLockManager();
    const lost = vi.fn();
    const owner = await claimProjectOwnership('project_a', () => undefined, {
      onLost: lost
    });
    const letGo = owner.retain();
    // Released, but a write still holds the lock.
    owner.release();

    const taker = await claimProjectOwnership('project_a', () => undefined, {
      steal: true
    });
    expect(taker.owned).toBe(true);
    letGo?.();
    await owner.freed;
    expect(lost).not.toHaveBeenCalled();
    taker.release();
  });

  it('takes a project over, and the tab it was taken from follows', async () => {
    withLockManager();
    const ownerHandlers = {
      onAnswered: vi.fn(),
      onPromoted: vi.fn(),
      onLost: vi.fn()
    };
    const owner = trackProjectStorage('project_a', ownerHandlers);
    await owner.ownership.settled;
    expect(owner.ownership.owned).toBe(true);
    const takerHandlers = {
      onAnswered: vi.fn(),
      onPromoted: vi.fn(),
      onLost: vi.fn()
    };
    const taker = trackProjectStorage('project_a', takerHandlers);
    await taker.ownership.settled;
    expect(taker.ownership.owned).toBe(false);

    await expect(taker.takeOver()).resolves.toBe(true);

    expect(taker.ownership.owned).toBe(true);
    expect(takerHandlers.onPromoted).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(ownerHandlers.onLost).toHaveBeenCalledTimes(1)
    );
    expect(owner.ownership.owned).toBe(false);
    const write = vi.fn(() => Promise.resolve());
    await expect(
      writeOwnedProjectStorage(() => owner.ownership, 'project_a', write)
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();

    // Queued again behind the new owner: promoted when it goes away.
    taker.giveUp();
    await vi.waitFor(() =>
      expect(ownerHandlers.onPromoted).toHaveBeenCalledTimes(1)
    );
    expect(owner.ownership.owned).toBe(true);
    owner.giveUp();
  });

  it('follows the new owner only once the loss has been handled', async () => {
    const locks = withLockManager();
    let finishRecovery: () => void = () => undefined;
    const recovered = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const ownerHandlers = {
      onAnswered: vi.fn(),
      onPromoted: vi.fn(),
      onLost: vi.fn(() => recovered)
    };
    const owner = trackProjectStorage('project_a', ownerHandlers);
    await owner.ownership.settled;
    const taker = trackProjectStorage('project_a', {
      onAnswered: vi.fn(),
      onPromoted: vi.fn()
    });
    await taker.ownership.settled;
    await taker.takeOver();
    await vi.waitFor(() =>
      expect(ownerHandlers.onLost).toHaveBeenCalledTimes(1)
    );
    // Recovering: not queued, so the new owner leaving promotes no one yet.
    expect(locks.pendingCount('openzcad-project:project_a')).toBe(0);

    finishRecovery();
    await vi.waitFor(() =>
      expect(locks.pendingCount('openzcad-project:project_a')).toBe(1)
    );
    expect(ownerHandlers.onPromoted).not.toHaveBeenCalled();
    taker.giveUp();
    await vi.waitFor(() =>
      expect(ownerHandlers.onPromoted).toHaveBeenCalledTimes(1)
    );
    owner.giveUp();
  });

  it('stops waiting when it takes over, so leaving frees the project', async () => {
    const locks = withLockManager();
    const owner = trackProjectStorage('project_a', {
      onAnswered: vi.fn(),
      onPromoted: vi.fn()
    });
    await owner.ownership.settled;
    const taker = trackProjectStorage('project_a', {
      onAnswered: vi.fn(),
      onPromoted: vi.fn()
    });
    await taker.ownership.settled;
    expect(locks.pendingCount('openzcad-project:project_a')).toBe(1);

    await taker.takeOver();
    // The taker's old queued request is gone; only the displaced owner
    // (once it follows) waits.
    await vi.waitFor(() =>
      expect(locks.pendingCount('openzcad-project:project_a')).toBe(1)
    );
    owner.giveUp();
    await vi.waitFor(() =>
      expect(locks.pendingCount('openzcad-project:project_a')).toBe(0)
    );
    taker.giveUp();
    await vi.waitFor(() =>
      expect(locks.isHeld('openzcad-project:project_a')).toBe(false)
    );
  });

  it('queues again when the lock is taken while a grant is still deciding', async () => {
    const locks = withLockManager();
    // Hold the handoff-ticket check, so the steal lands between the queued
    // grant and its promotion.
    const request = locks.request.bind(locks);
    let ticketChecks = 0;
    let openTicket: () => void = () => undefined;
    const ticketGate = new Promise<void>((resolve) => {
      openTicket = resolve;
    });
    locks.request = ((
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>
    ) => {
      if (!name.startsWith('openzcad-project-handoff:')) {
        return request(name, options, callback);
      }
      ticketChecks += 1;
      return ticketGate.then(() => request(name, options, callback));
    }) as typeof locks.request;
    const promoted = vi.fn();
    const lost = vi.fn();

    const owner = await claimProjectOwnership('project_a', () => undefined);
    const waiting = await claimProjectOwnership('project_a', promoted, {
      onLost: lost
    });
    owner.release();
    await vi.waitFor(() => expect(ticketChecks).toBe(1));
    const taker = await claimProjectOwnership('project_a', () => undefined, {
      steal: true
    });
    openTicket();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Never a second writer beside the taker.
    expect(promoted).not.toHaveBeenCalled();
    expect(lost).not.toHaveBeenCalled();
    expect(taker.owned).toBe(true);
    // Still waiting: promoted once the taker lets go.
    taker.release();
    await vi.waitFor(() => expect(promoted).toHaveBeenCalledTimes(1));
    waiting.release();
  });

  it('refuses a write that reaches its commit after the project was taken', async () => {
    withLockManager();
    const owner = trackProjectStorage('project_a', {
      onAnswered: vi.fn(),
      onPromoted: vi.fn()
    });
    await owner.ownership.settled;
    let started = false;
    let commit: () => void = () => undefined;
    const committing = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let heldAtCommit: boolean | null = null;
    const written = writeOwnedProjectStorage(
      () => owner.ownership,
      'project_a',
      async (held) => {
        started = true;
        // The storage transaction opening, slowly.
        await committing;
        heldAtCommit = held();
        if (!heldAtCommit) throw new Error('fenced');
      }
    );
    await vi.waitFor(() => expect(started).toBe(true));
    const taker = trackProjectStorage('project_a', {
      onAnswered: vi.fn(),
      onPromoted: vi.fn()
    });
    await taker.ownership.settled;
    await expect(taker.takeOver()).resolves.toBe(true);
    await vi.waitFor(() => expect(owner.ownership.owned).toBe(false));

    commit();
    await expect(written).resolves.toBe(false);
    expect(heldAtCommit).toBe(false);
    owner.giveUp();
    taker.giveUp();
  });
});
