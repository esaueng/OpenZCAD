import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimProjectOwnership,
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
});
