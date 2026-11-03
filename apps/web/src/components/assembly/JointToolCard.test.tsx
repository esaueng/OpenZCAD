import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssemblyFrame } from '@openzcad/shared';
import { PIVOT, scissorsManager } from '../../test/assemblyFixture';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  registerAssemblyCommitHandlers
} from '../../lib/assembly/assemblyRuntime';
import { JointToolCard } from './JointToolCard';

afterEach(() => {
  act(() => {
    assemblyRuntime.reset();
    assemblyRuntime.setActive(false);
  });
  registerAssemblyCommitHandlers(null);
});

const AWAY: AssemblyFrame = { ...PIVOT, origin: { x: 50, y: 0, z: 0 } };

describe('JointToolCard', () => {
  it('walks the picks, suggests a type and creates through the runtime', () => {
    const { a, b, live } = scissorsManager({ components: true });
    const createJoint = vi.fn();
    registerAssemblyCommitHandlers({ commitPose: vi.fn(), createJoint });
    act(() => assemblyRuntime.openJointTool());
    const { rerender } = render(<JointToolCard document={live()} />);
    expect(screen.getByText('Moving part')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    act(() =>
      assemblyRuntime.pickJointFrame({
        componentId: 'comp_b',
        bodyId: b,
        frame: AWAY,
        source: { kind: 'plane', label: 'Top face' }
      })
    );
    act(() =>
      assemblyRuntime.pickJointFrame({
        componentId: 'comp_a',
        bodyId: a,
        frame: PIVOT,
        source: { kind: 'plane', label: 'Bottom face' }
      })
    );
    rerender(<JointToolCard document={live()} />);
    expect(screen.getByText('Blade B · Top face')).toBeInTheDocument();
    expect(screen.getByText('Blade A · Bottom face')).toBeInTheDocument();
    // Flat onto flat suggests Rigid, and the picks choose it.
    expect(getAssemblyRuntime().jointTool?.kind).toBe('rigid');
    expect(screen.getByText('Suggested')).toBeInTheDocument();
    // Not aligned: Flip and Rotate are offered instead of the as-built note.
    fireEvent.click(screen.getByRole('button', { name: 'Flip' }));
    expect(getAssemblyRuntime().jointTool?.flip).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate 90°' }));
    expect(getAssemblyRuntime().jointTool?.quarterTurns).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /Slider/ }));
    expect(getAssemblyRuntime().jointTool?.kind).toBe('slider');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Distance' }));
    expect(getAssemblyRuntime().jointTool?.limits).toEqual([
      { min: 0, max: 100 }
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(createJoint).toHaveBeenCalledTimes(1);
    expect(createJoint.mock.calls[0]?.[0]).toMatchObject({
      kind: 'slider',
      flip: true,
      quarterTurns: 1
    });
    expect(getAssemblyRuntime().jointTool).toBeNull();
  });

  it('says when the picks already coincide, and refuses a joined pair', () => {
    const { a, b, live } = scissorsManager({ joint: true });
    act(() => {
      assemblyRuntime.openJointTool();
      assemblyRuntime.pickJointFrame({
        componentId: 'comp_b',
        bodyId: b,
        frame: PIVOT,
        source: { kind: 'circle', label: 'Hole' }
      });
      assemblyRuntime.pickJointFrame({
        componentId: 'comp_a',
        bodyId: a,
        frame: PIVOT,
        source: { kind: 'circle', label: 'Hole' }
      });
    });
    render(<JointToolCard document={live()} />);
    expect(screen.getByText(/Already aligned/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Flip' })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'These components are already joined by Pivot.'
    );
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(getAssemblyRuntime().jointTool).toBeNull();
  });

  it('re-picks one end', () => {
    const { b, live } = scissorsManager({ components: true });
    act(() => {
      assemblyRuntime.openJointTool();
      assemblyRuntime.pickJointFrame({
        componentId: 'comp_b',
        bodyId: b,
        frame: PIVOT,
        source: { kind: 'circle', label: 'Hole' }
      });
    });
    render(<JointToolCard document={live()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-pick' }));
    expect(getAssemblyRuntime().jointTool).toMatchObject({
      step: 'child',
      child: null
    });
  });
});
