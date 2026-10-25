import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isChunkLoadError,
  loadWhenOnline,
  lazyWithStaleChunkNotice,
  onStaleChunk,
  watchPreloadErrors
} from './staleChunk';

function loaderOf(component: unknown): () => Promise<unknown> {
  // React.lazy stores the loader on the exotic component; calling it is what
  // the first render would do.
  return (component as { _payload: { _result: () => Promise<unknown> } })
    ._payload._result;
}

/** Lets the preload-error watcher make its deferred decision. */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('stale chunk handling', () => {
  it('recognises the chunk-load failures browsers raise after a deploy', () => {
    expect(
      isChunkLoadError(
        new TypeError(
          'Failed to fetch dynamically imported module: https://zcad.app/assets/ModelingOperationsForm-BjEcM817.js'
        )
      )
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError('Importing a module script failed.'))
    ).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of null'))).toBe(
      false
    );
  });

  it('tells subscribers about a missing chunk and still rejects the import', async () => {
    const listener = vi.fn();
    const stop = onStaleChunk(listener);
    const Lazy = lazyWithStaleChunkNotice(() =>
      Promise.reject(
        new TypeError('Failed to fetch dynamically imported module: x.js')
      )
    );
    await expect(loaderOf(Lazy)()).rejects.toThrow('dynamically imported');
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stays quiet for an ordinary import error', async () => {
    const listener = vi.fn();
    const stop = onStaleChunk(listener);
    const Lazy = lazyWithStaleChunkNotice(() =>
      Promise.reject(new Error('module threw during evaluation'))
    );
    await expect(loaderOf(Lazy)()).rejects.toThrow('module threw');
    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});

describe('preload errors', () => {
  it('reports a chunk the preload helper could not load, and only that', async () => {
    const listener = vi.fn();
    const stopListening = onStaleChunk(listener);
    const stopWatching = watchPreloadErrors(window);
    const fire = (payload: unknown) => {
      const event = new Event('vite:preloadError', { cancelable: true });
      Object.assign(event, { payload });
      window.dispatchEvent(event);
      return event;
    };
    const event = fire(
      new TypeError(
        'Failed to fetch dynamically imported module: https://zcad.app/assets/demos-BLYQ4WoN.js'
      )
    );
    await nextTask();
    expect(listener).toHaveBeenCalledOnce();
    // The caller still gets its own rejection.
    expect(event.defaultPrevented).toBe(false);
    fire(new Error('Cannot read properties of null'));
    await nextTask();
    expect(listener).toHaveBeenCalledOnce();
    stopWatching();
    fire(new TypeError('Importing a module script failed.'));
    await nextTask();
    expect(listener).toHaveBeenCalledOnce();
    stopListening();
  });
});

describe('preloadableLazy', () => {
  it('renders a preloaded component on its first render, without suspending', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { Suspense, createElement } = await import('react');
    const { preloadableLazy } = await import('./staleChunk');
    const Surface = preloadableLazy(() =>
      Promise.resolve({
        default: ({ label }: { label: string }) =>
          createElement('p', null, label)
      })
    );
    await Surface.preload();
    render(
      createElement(
        Suspense,
        { fallback: createElement('p', null, 'loading') },
        createElement(Surface, { label: 'Settings' })
      )
    );
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.queryByText('loading')).toBeNull();
  });

  it('keeps a surface mounted when its chunk lands after a first render', async () => {
    const { act, render, screen } = await import('@testing-library/react');
    const { Suspense, createElement, useState } = await import('react');
    const { preloadableLazy } = await import('./staleChunk');
    let mounts = 0;
    function Keypad({ label }: { label: string }) {
      useState(() => (mounts += 1));
      return createElement('p', null, label);
    }
    let finish!: (module: { default: typeof Keypad }) => void;
    const Surface = preloadableLazy(
      () =>
        new Promise<{ default: typeof Keypad }>((resolve) => (finish = resolve))
    );
    const tree = (label: string) =>
      createElement(
        Suspense,
        { fallback: createElement('p', null, 'loading') },
        createElement(Surface, { label })
      );
    const { rerender } = render(tree('1'));
    await act(async () => {
      finish({ default: Keypad });
      await Promise.resolve();
    });
    expect(screen.getByText('1')).toBeTruthy();
    // The parent re-renders (a keystroke's preview): same instance, no
    // remount. The lazy element never commits — the boundary shows its
    // fallback, and the retry already renders the loaded component.
    rerender(tree('12'));
    expect(screen.getByText('12')).toBeTruthy();
    expect(mounts).toBe(1);
  });

  it('does not report a stale chunk when only a preload fails', async () => {
    const { preloadableLazy } = await import('./staleChunk');
    const listener = vi.fn();
    const stop = onStaleChunk(listener);
    const Surface = preloadableLazy(() =>
      Promise.reject(
        new TypeError('Failed to fetch dynamically imported module: x.js')
      )
    );
    await expect(Surface.preload()).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});

describe('warm-up failures', () => {
  it('keeps a failed warm-up out of the preload-error notice', async () => {
    const { preloadableLazy } = await import('./staleChunk');
    const listener = vi.fn();
    const stopNotice = onStaleChunk(listener);
    const target = new EventTarget() as unknown as Window;
    const stopWatch = watchPreloadErrors(target);
    const failure = new TypeError(
      'Failed to fetch dynamically imported module: settings.js'
    );
    const Surface = preloadableLazy(() => {
      // Vite announces the failed preload before the import rejects.
      const event = new Event('vite:preloadError') as Event & {
        payload?: unknown;
      };
      event.payload = failure;
      target.dispatchEvent(event);
      return Promise.reject(failure);
    });
    await expect(Surface.preload()).rejects.toThrow();
    await nextTask();
    expect(listener).not.toHaveBeenCalled();
    // A load nobody started speculatively still reports.
    const event = new Event('vite:preloadError') as Event & {
      payload?: unknown;
    };
    event.payload = new TypeError(
      'Failed to fetch dynamically imported module: demos.js'
    );
    target.dispatchEvent(event);
    await nextTask();
    expect(listener).toHaveBeenCalledTimes(1);
    stopWatch();
    stopNotice();
  });

  it('still reports an unrelated import that fails while a warm-up is in flight', async () => {
    const { preloadableLazy } = await import('./staleChunk');
    const listener = vi.fn();
    const stopNotice = onStaleChunk(listener);
    const target = new EventTarget() as unknown as Window;
    const stopWatch = watchPreloadErrors(target);
    // A slow warm-up that has not settled.
    const Surface = preloadableLazy(() => new Promise<never>(() => undefined));
    void Surface.preload();
    const event = new Event('vite:preloadError') as Event & {
      payload?: unknown;
    };
    event.payload = new TypeError(
      'Failed to fetch dynamically imported module: demos.js'
    );
    target.dispatchEvent(event);
    await nextTask();
    expect(listener).toHaveBeenCalledTimes(1);
    stopWatch();
    stopNotice();
  });
});

describe('loadWhenOnline', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts no download while offline, then loads once the link is back', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const load = vi.fn(() => Promise.resolve('chunk'));
    const result = loadWhenOnline(load);
    await nextTask();
    expect(load).not.toHaveBeenCalled();
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await expect(result).resolves.toBe('chunk');
    expect(load).toHaveBeenCalledOnce();
  });
});
