import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  LIBRARY_REFRESH_INTERVAL_MS,
  LIBRARY_REFRESH_MAX_BACKOFF_MS,
  LIBRARY_REFRESH_MIN_GAP_MS,
  libraryRefreshBackoffMs,
  watchLibraryFreshness,
  type LibraryRefreshHost
} from './libraryRefresh';

function fakeHost() {
  const win = new EventTarget();
  const visibility: { visibilityState: DocumentVisibilityState } = {
    visibilityState: 'visible'
  };
  const doc = Object.assign(new EventTarget(), visibility);
  let now = 1_000_000;
  let tick: (() => void) | null = null;
  const host: LibraryRefreshHost = {
    window: win,
    document: doc,
    now: () => now,
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    }
  };
  return {
    host,
    advance(ms: number) {
      now += ms;
    },
    tick: () => tick?.(),
    focus: () => win.dispatchEvent(new Event('focus')),
    online: () => win.dispatchEvent(new Event('online')),
    setVisibility(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    hasInterval: () => tick !== null
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('watchLibraryFreshness', () => {
  // Regression: a library tab left open never re-listed the account, so
  // edits from another browser on the same account never appeared.
  it('re-lists when an open library tab regains focus', async () => {
    const fake = fakeHost();
    const refresh = vi.fn(async () => undefined);
    watchLibraryFreshness(refresh, fake.host);

    fake.advance(LIBRARY_REFRESH_MIN_GAP_MS);
    fake.focus();
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('re-lists on the interval and when the tab becomes visible', async () => {
    const fake = fakeHost();
    const refresh = vi.fn(async () => undefined);
    watchLibraryFreshness(refresh, fake.host);

    fake.advance(LIBRARY_REFRESH_INTERVAL_MS);
    fake.tick();
    await settle();
    fake.advance(LIBRARY_REFRESH_MIN_GAP_MS);
    fake.setVisibility('visible');
    await settle();

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('waits out the minimum gap after the listing it was started with', async () => {
    const fake = fakeHost();
    const refresh = vi.fn(async () => undefined);
    watchLibraryFreshness(refresh, fake.host);

    fake.advance(LIBRARY_REFRESH_MIN_GAP_MS - 1);
    fake.focus();
    await settle();
    expect(refresh).not.toHaveBeenCalled();

    fake.advance(1);
    fake.focus();
    fake.focus();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('checks the workspace on focus or reconnect without the shelf gap', async () => {
    const fake = fakeHost();
    const refresh = vi.fn(async () => undefined);
    watchLibraryFreshness(refresh, fake.host, { minimumGapMs: 0 });

    fake.focus();
    fake.online();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    fake.online();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each([0, LIBRARY_REFRESH_MIN_GAP_MS])(
    'never refreshes a hidden tab with a %i ms gap',
    async (minimumGapMs) => {
      const fake = fakeHost();
      const refresh = vi.fn(async () => undefined);
      watchLibraryFreshness(refresh, fake.host, { minimumGapMs });

      fake.setVisibility('hidden');
      fake.advance(LIBRARY_REFRESH_INTERVAL_MS);
      fake.tick();
      fake.online();
      await settle();

      expect(refresh).not.toHaveBeenCalled();
    }
  );

  it('does not overlap a refresh still in flight', async () => {
    const fake = fakeHost();
    let finish!: () => void;
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    watchLibraryFreshness(refresh, fake.host);

    fake.advance(LIBRARY_REFRESH_MIN_GAP_MS);
    fake.focus();
    fake.advance(LIBRARY_REFRESH_INTERVAL_MS);
    fake.tick();
    expect(refresh).toHaveBeenCalledTimes(1);

    finish();
    await settle();
    fake.advance(LIBRARY_REFRESH_MIN_GAP_MS);
    fake.focus();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops listening once stopped', async () => {
    const fake = fakeHost();
    const refresh = vi.fn(async () => undefined);
    const stop = watchLibraryFreshness(refresh, fake.host);

    stop();
    fake.advance(LIBRARY_REFRESH_INTERVAL_MS);
    fake.focus();
    await settle();

    expect(refresh).not.toHaveBeenCalled();
    expect(fake.hasInterval()).toBe(false);
  });

  // Regression: the shelf kept re-listing behind Settings, spending the
  // account's shared read budget (two reads per encrypted project) while
  // the user was on Settings › Encryption, whose Refresh then got a 429.
  it('holds refreshes while the shelf is covered and lists once when uncovered', async () => {
    const fake = fakeHost();
    const refresh = vi.fn(async () => undefined);
    const watch = watchLibraryFreshness(refresh, fake.host);

    watch.setPaused(true);
    fake.advance(LIBRARY_REFRESH_INTERVAL_MS);
    fake.tick();
    fake.focus();
    fake.setVisibility('visible');
    await settle();
    expect(refresh).not.toHaveBeenCalled();

    watch.setPaused(false);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Uncovering again within the gap does not list a second time.
    watch.setPaused(true);
    watch.setPaused(false);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not list on uncovering a hidden tab', async () => {
    const fake = fakeHost();
    const refresh = vi.fn(async () => undefined);
    const watch = watchLibraryFreshness(refresh, fake.host);

    watch.setPaused(true);
    fake.setVisibility('hidden');
    fake.advance(LIBRARY_REFRESH_INTERVAL_MS);
    watch.setPaused(false);
    await settle();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('backs off after a rate limit, doubling, and resets on success', async () => {
    const fake = fakeHost();
    const outcomes: Array<{ rateLimited: object | null }> = [
      { rateLimited: {} },
      { rateLimited: {} },
      { rateLimited: null },
      { rateLimited: null }
    ];
    const refresh = vi.fn(async () => outcomes.shift());
    watchLibraryFreshness(refresh, fake.host);

    fake.advance(LIBRARY_REFRESH_MIN_GAP_MS);
    fake.focus();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    // One interval after the first 429.
    fake.advance(LIBRARY_REFRESH_INTERVAL_MS - 1);
    fake.focus();
    fake.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    fake.advance(1);
    fake.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);

    // Two after the second.
    fake.advance(2 * LIBRARY_REFRESH_INTERVAL_MS - 1);
    fake.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
    fake.advance(1);
    fake.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(3);

    // That one succeeded: only the usual gap applies again.
    fake.advance(LIBRARY_REFRESH_MIN_GAP_MS);
    fake.focus();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it.each([0, LIBRARY_REFRESH_MIN_GAP_MS])(
    'honours Retry-After on a rejected 429 with a %i ms gap',
    async (minimumGapMs) => {
      const fake = fakeHost();
      const limited = new ApiError(
        429,
        'API request limit reached.',
        undefined,
        undefined,
        5 * 60_000
      );
      const failures: Error[] = [limited, new TypeError('offline')];
      const refresh = vi.fn(async () => {
        const failure = failures.shift();
        if (failure) throw failure;
      });
      watchLibraryFreshness(refresh, fake.host, { minimumGapMs });

      fake.advance(minimumGapMs);
      fake.focus();
      await settle();
      fake.advance(5 * 60_000 - 1);
      fake.tick();
      await settle();
      expect(refresh).toHaveBeenCalledTimes(1);
      fake.advance(1);
      fake.tick();
      await settle();
      expect(refresh).toHaveBeenCalledTimes(2);

      // A network failure is not a reason to wait longer.
      fake.advance(minimumGapMs);
      fake.focus();
      await settle();
      expect(refresh).toHaveBeenCalledTimes(3);
    }
  );
});

describe('watchLibraryFreshness requestNow', () => {
  // Regression (review of the read-budget fix): a sealed shelf sync from
  // another browser called the shelf's refresh directly, so it listed
  // behind Settings, inside a rate limit's backoff and over a listing in
  // flight, spending the read budget the watch was holding back.
  it('lists a known change past the gap, but not while covered', async () => {
    const fake = fakeHost();
    const refresh = vi.fn(async () => undefined);
    const watch = watchLibraryFreshness(refresh, fake.host);

    watch.requestNow();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    watch.setPaused(true);
    watch.requestNow();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    // Uncovered within the gap, the held change still lists once.
    watch.setPaused(false);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
    watch.setPaused(true);
    watch.setPaused(false);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('defers a change behind a hidden tab or a listing in flight', async () => {
    const fake = fakeHost();
    let finish!: () => void;
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    const watch = watchLibraryFreshness(refresh, fake.host);

    fake.setVisibility('hidden');
    watch.requestNow();
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    fake.setVisibility('visible');
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    watch.requestNow();
    watch.requestNow();
    expect(refresh).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    // Both requests made during the listing collapse into one more.
    expect(refresh).toHaveBeenCalledTimes(2);
    finish();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('drops a change inside a rate limit backoff', async () => {
    const fake = fakeHost();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(429, 'API request limit reached.'))
      .mockResolvedValue(undefined);
    const watch = watchLibraryFreshness(refresh, fake.host);

    watch.requestNow();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    fake.advance(LIBRARY_REFRESH_MIN_GAP_MS);
    watch.requestNow();
    fake.focus();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    fake.advance(LIBRARY_REFRESH_INTERVAL_MS);
    fake.tick();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('libraryRefreshBackoffMs', () => {
  it('doubles from one interval up to the cap, or takes Retry-After', () => {
    expect(libraryRefreshBackoffMs(1)).toBe(LIBRARY_REFRESH_INTERVAL_MS);
    expect(libraryRefreshBackoffMs(2)).toBe(2 * LIBRARY_REFRESH_INTERVAL_MS);
    expect(libraryRefreshBackoffMs(3)).toBe(4 * LIBRARY_REFRESH_INTERVAL_MS);
    expect(libraryRefreshBackoffMs(20)).toBe(LIBRARY_REFRESH_MAX_BACKOFF_MS);
    expect(libraryRefreshBackoffMs(3, 90_000)).toBe(90_000);
    expect(libraryRefreshBackoffMs(1, 0)).toBe(LIBRARY_REFRESH_MIN_GAP_MS);
  });
});
