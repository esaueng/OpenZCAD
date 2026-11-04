import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assemblyRuntime,
  getAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import { AssemblyPlayer } from './AssemblyPlayer';
import { pivotProject } from './motionTestFixture';

let frames: FrameRequestCallback[] = [];

/** Runs the pending animation frame at `nowMs`. */
function frame(nowMs: number) {
  const pending = frames;
  frames = [];
  act(() => {
    for (const callback of pending) callback(nowMs);
  });
}

beforeEach(() => {
  frames = [];
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
  assemblyRuntime.setActive(false);
  assemblyRuntime.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  assemblyRuntime.setActive(false);
  assemblyRuntime.reset();
});

describe('AssemblyPlayer', () => {
  it('shows nothing for a project without motion studies', () => {
    const { container } = render(
      <AssemblyPlayer
        assembly={pivotProject({ study: false }).document.assembly}
      />
    );
    expect(container.innerHTML).toBe('');
    render(<AssemblyPlayer assembly={undefined} />);
    expect(screen.queryByRole('group', { name: 'Motion player' })).toBeNull();
  });

  it('plays a study on its own clock and shows the poses', () => {
    const manager = pivotProject();
    const before = JSON.stringify(manager.document);
    render(<AssemblyPlayer assembly={manager.document.assembly} />);
    expect(screen.getByText('Motion 1')).toBeTruthy();
    expect(getAssemblyRuntime().active).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(getAssemblyRuntime().active).toBe(true);
    // Elapsed time alone sets the pose.
    frame(1500);
    expect(getAssemblyRuntime().overrides.get('j_pivot')).toEqual([22.5]);
    expect(screen.getByText('0.50 / 2.00 s')).toBeTruthy();
    // The study loops by default (its playback is loop).
    frame(3500);
    expect(screen.getByText('0.50 / 2.00 s')).toBeTruthy();

    // Pause keeps the pose and the runtime on.
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(frames).toHaveLength(0);
    expect(getAssemblyRuntime().active).toBe(true);
    expect(getAssemblyRuntime().overrides.get('j_pivot')).toEqual([22.5]);
    // Nothing a viewer does is saved.
    expect(JSON.stringify(manager.document)).toBe(before);
  });

  it('plays once with loop off, scrubs, and stops back to the model', () => {
    render(<AssemblyPlayer assembly={pivotProject().document.assembly} />);
    const loop = screen.getByRole('button', { name: 'Loop' });
    expect(loop.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(loop);
    expect(loop.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    frame(4000);
    expect(screen.getByText('2.00 / 2.00 s')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(frames).toHaveLength(0);

    fireEvent.change(screen.getByRole('slider', { name: 'Position' }), {
      target: { value: '1' }
    });
    expect(getAssemblyRuntime().overrides.get('j_pivot')).toEqual([45]);
    expect(screen.getByText('1.00 / 2.00 s')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(getAssemblyRuntime().active).toBe(false);
    expect(getAssemblyRuntime().overrides.size).toBe(0);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('turns the runtime off when it leaves, only if it turned it on', () => {
    const assembly = pivotProject().document.assembly;
    const first = render(<AssemblyPlayer assembly={assembly} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(getAssemblyRuntime().active).toBe(true);
    first.unmount();
    expect(getAssemblyRuntime().active).toBe(false);

    // Already on (another owner): the player leaves it on.
    assemblyRuntime.setActive(true);
    const second = render(<AssemblyPlayer assembly={assembly} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    second.unmount();
    expect(getAssemblyRuntime().active).toBe(true);
  });
});
