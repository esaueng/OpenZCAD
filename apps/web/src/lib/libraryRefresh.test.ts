import { describe, expect, it, vi } from 'vitest';
import {
  LIBRARY_REFRESH_INTERVAL_MS,
  LIBRARY_REFRESH_MIN_GAP_MS,
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

  it('never refreshes a hidden tab', async () => {
    const fake = fakeHost();
    const refresh = vi.fn(async () => undefined);
    watchLibraryFreshness(refresh, fake.host);

    fake.setVisibility('hidden');
    fake.advance(LIBRARY_REFRESH_INTERVAL_MS);
    fake.tick();
    await settle();

    expect(refresh).not.toHaveBeenCalled();
  });

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
});
