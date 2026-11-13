import type { ComponentType } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssemblySet } from '@openzcad/shared';
import type { AssemblyPlayerProps } from './AssemblyPlayer';
import { createAssemblyPlayer } from './AssemblyPlayerSlot';
import { PANEL_AUTO_RETRY_DELAY_MS } from '../ErrorBoundary';

type Loaded = { default: ComponentType<AssemblyPlayerProps> };

/** A player chunk the test releases or refuses by hand. */
function heldChunk() {
  let resolve!: (module: Loaded) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Loaded>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { load: () => promise, resolve, reject };
}

const healthy = {
  components: [],
  joints: [],
  studies: []
} as unknown as AssemblySet;
const broken = {
  components: [],
  joints: [],
  studies: []
} as unknown as AssemblySet;

let brokenRenders = 0;
/** Draws a marker, and fails for one project's assembly every time. */
function FakePlayer({ assembly }: AssemblyPlayerProps) {
  if (assembly === broken) {
    brokenRenders += 1;
    throw new Error('This assembly cannot be played.');
  }
  return <p>Player</p>;
}

afterEach(() => vi.restoreAllMocks());

describe('the lazily loaded assembly player', () => {
  it('draws once its chunk arrives', async () => {
    const chunk = heldChunk();
    const Player = createAssemblyPlayer(chunk.load);
    render(<Player projectId="p1" assembly={healthy} />);
    expect(screen.queryByText('Player')).toBeNull();
    await act(async () => {
      chunk.resolve({ default: FakePlayer });
      await Promise.resolve();
    });
    expect(
      await screen.findByText('Player', {}, { timeout: 2_000 })
    ).toBeTruthy();
  }, 10_000);

  it('keeps a chunk that fails to load to its own slot', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const chunk = heldChunk();
    const Player = createAssemblyPlayer(chunk.load);
    render(
      <>
        <p>Workspace</p>
        <Player projectId="p1" assembly={healthy} />
      </>
    );
    await act(async () => {
      chunk.reject(
        new TypeError(
          'Failed to fetch dynamically imported module: /assets/AssemblyPlayer-x.js'
        )
      );
      await Promise.resolve();
    });
    // The page's own boundary never sees it: the workspace stays.
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.queryByText('Player')).toBeNull();
  }, 10_000);

  it('tries again on the next project after one it could not draw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Player = createAssemblyPlayer(() =>
      Promise.resolve({ default: FakePlayer })
    );
    brokenRenders = 0;
    const view = render(<Player projectId="broken" assembly={broken} />);
    // React's own retry and then the boundary's one automatic remount both
    // fail; after that the failure sticks for this project.
    await vi.waitFor(() => expect(brokenRenders).toBeGreaterThanOrEqual(3), {
      timeout: 5_000
    });
    const settled = brokenRenders;
    await act(
      () =>
        new Promise((done) => setTimeout(done, PANEL_AUTO_RETRY_DELAY_MS * 2))
    );
    expect(brokenRenders).toBe(settled);
    expect(screen.queryByText('Player')).toBeNull();
    view.rerender(<Player projectId="healthy" assembly={healthy} />);
    expect(
      await screen.findByText('Player', {}, { timeout: 2_000 })
    ).toBeTruthy();
  }, 10_000);
});
