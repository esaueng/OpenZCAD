import { act, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { preloadableSlot } from './PreloadableSlot';

type Loaded = { default: ComponentType<{ name: string }> };

/** A surface's chunk, released or refused by hand: a cold or broken load. */
function heldChunk() {
  let resolve!: (module: Loaded) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Loaded>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { load: () => promise, resolve, reject };
}

function Bar({ name }: { name: string }) {
  return <p>{name} bar</p>;
}

function renderInPage(Slot: ComponentType<{ name: string }>) {
  render(
    <ErrorBoundary label="OpenZCAD" scope="page">
      <p>Workspace</p>
      <Slot name="Extrude" />
    </ErrorBoundary>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('an on-demand surface in its own slot', () => {
  it('draws once its chunk arrives, and renders directly once loaded', async () => {
    const chunk = heldChunk();
    const Slot = preloadableSlot('Extrude', chunk.load);
    renderInPage(Slot);
    expect(screen.queryByText('Extrude bar')).toBeNull();
    expect(Slot.isLoaded()).toBe(false);
    await act(async () => chunk.resolve({ default: Bar }));
    expect(await screen.findByText('Extrude bar')).toBeTruthy();
    expect(Slot.isLoaded()).toBe(true);
  });

  it('keeps a chunk that cannot load to its own place', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The failed chunk is re-fetched past the cache for the Reload offered.
    const refetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(''));
    const chunk = heldChunk();
    renderInPage(preloadableSlot('Extrude', chunk.load));
    await act(async () =>
      chunk.reject(
        new TypeError(
          'Failed to fetch dynamically imported module: /assets/ExtrudeCommand-gone.js'
        )
      )
    );
    expect(await screen.findByText('Extrude did not load.')).toBeTruthy();
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Part of OpenZCAD could not load' })
    ).toBeNull();
    expect(refetch).toHaveBeenCalledWith(
      expect.stringContaining('/assets/ExtrudeCommand-gone.js'),
      { cache: 'reload' }
    );
  });
});
