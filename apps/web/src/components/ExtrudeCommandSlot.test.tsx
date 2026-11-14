import { createRef, type MutableRefObject } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBodyId, toSketchId, type ParamValue } from '@openzcad/shared';
import type * as ExtrudeCommandModule from './ExtrudeCommand';
import type { ExtrudeCommandHandle } from './ExtrudeCommand';
import { ErrorBoundary } from './ErrorBoundary';
import { extrudeCommandSlot } from './ExtrudeCommandSlot';

type Loaded = typeof ExtrudeCommandModule;

/** The bar's chunk, released or refused by hand: a cold load. */
function heldChunk() {
  let resolve!: (module: Loaded) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Loaded>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { load: () => promise, resolve, reject };
}

function props() {
  const distanceSetterRef = createRef<
    (value: ParamValue) => void
  >() as MutableRefObject<((value: ParamValue) => void) | null>;
  return {
    scope: {},
    units: 'mm' as const,
    bodies: [{ bodyId: toBodyId('plate'), name: 'Plate' }],
    initial: { name: 'Extrude', sketchId: toSketchId('layout'), distance: 0 },
    profileCount: 1,
    disabled: false,
    distanceSetterRef,
    commandRef: createRef<ExtrudeCommandHandle>(),
    onOpenValue: vi.fn(),
    onDraft: vi.fn(),
    onPreview: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn()
  };
}

afterEach(() => vi.restoreAllMocks());

describe('the lazily loaded Extrude bar', () => {
  it('keeps a distance the arrow set while the bar was loading', async () => {
    const user = userEvent.setup();
    const chunk = heldChunk();
    const ExtrudeCommand = extrudeCommandSlot(chunk.load);
    const bar = props();
    render(<ExtrudeCommand {...bar} />);
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    // The region's arrow is the viewer's: it can be dragged and released
    // before the bar's chunk arrives.
    expect(bar.distanceSetterRef.current).not.toBeNull();
    act(() => bar.distanceSetterRef.current?.(12));
    await act(async () => chunk.resolve(await import('./ExtrudeCommand')));
    const done = await screen.findByRole('button', { name: 'Done' });
    expect(bar.onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ distance: 12, endCondition: 'blind' })
    );
    expect(done).toBeEnabled();
    await user.click(done);
    expect(bar.onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ distance: 12 })
    );
    // Once loaded, the arrow drives the bar directly.
    act(() => bar.distanceSetterRef.current?.(20));
    expect(bar.onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ distance: 20 })
    );
  });

  it('lets go of the arrow when it closes', () => {
    const ExtrudeCommand = extrudeCommandSlot(heldChunk().load);
    const bar = props();
    const { unmount } = render(<ExtrudeCommand {...bar} />);
    unmount();
    expect(bar.distanceSetterRef.current).toBeNull();
  });

  it('keeps a chunk that cannot load to its own place', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The failed chunk is re-fetched past the cache for the Reload offered.
    const refetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(''));
    const chunk = heldChunk();
    const ExtrudeCommand = extrudeCommandSlot(chunk.load);
    render(
      <ErrorBoundary label="OpenZCAD" scope="page">
        <p>Workspace</p>
        <ExtrudeCommand {...props()} />
      </ErrorBoundary>
    );
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
