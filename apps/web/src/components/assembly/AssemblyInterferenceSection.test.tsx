import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  IDENTITY_PLACEMENT,
  type AssemblyInterferenceReport
} from '@openzcad/shared';
import { recordingExecute, scissorsManager } from '../../test/assemblyFixture';
import {
  assemblyRuntime,
  getAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import { AssemblyPanel } from './AssemblyPanel';
import type { CheckInterference } from './AssemblyInterferenceSection';

afterEach(() => {
  act(() => {
    assemblyRuntime.reset();
    assemblyRuntime.setActive(false);
  });
});

const overlapping: AssemblyInterferenceReport = {
  pairs: [
    {
      a: 'comp_a',
      b: 'comp_b',
      verdict: {
        kind: 'interference',
        volume: 125,
        proof: 'intersect',
        point: { x: 7.5, y: 7.5, z: 7.5 },
        bounds: { min: { x: 5, y: 5, z: 5 }, max: { x: 10, y: 10, z: 10 } },
        complete: true
      }
    }
  ],
  missing: []
};

function renderPanel(check: CheckInterference) {
  const fixture = scissorsManager({ components: true });
  const recorder = recordingExecute(fixture.manager);
  const onStatus = vi.fn();
  const element = () => (
    <AssemblyPanel
      document={fixture.live()}
      execute={recorder.execute}
      onStatus={onStatus}
      checkInterference={check}
    />
  );
  const view = render(element());
  return {
    ...recorder,
    onStatus,
    rerender: () => view.rerender(element()),
    section: () => screen.getByRole('region', { name: 'Interference' })
  };
}

describe('Assembly interference section (AS04)', () => {
  it('checks every pair at its assembled pose and shows the witness', async () => {
    const check = vi.fn<CheckInterference>(async () => overlapping);
    const { section, onStatus } = renderPanel(check);
    expect(within(section()).getByRole('status')).toHaveTextContent(
      'Checks every pair of parts as assembled'
    );
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    // The query receives both components, posed (not exploded).
    expect(check).toHaveBeenCalledTimes(1);
    const operands = check.mock.calls[0]![1];
    expect(operands.map((o) => o.componentId)).toEqual(['comp_a', 'comp_b']);
    expect(operands[0]!.matrix).toHaveLength(16);
    expect(within(section()).getByRole('status')).toHaveTextContent(
      '1 pair overlap.'
    );
    expect(onStatus).toHaveBeenCalledWith(
      'Interference: 1 pair of parts overlap.'
    );
    const row = within(section()).getByRole('button', {
      name: 'Blade A and Blade B: 125 mm³'
    });
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    // Picking a pair picks both parts on the model.
    expect(getAssemblyRuntime().selectedComponentIds).toEqual([
      'comp_a',
      'comp_b'
    ]);
    expect(section()).toHaveTextContent(
      '125 mm³ shared, measured by an exact intersection. Overlap region 5 × 5 × 5 mm. Inside both at (7.5, 7.5, 7.5) mm.'
    );
  });

  it('marks a result out of date once a part moves', async () => {
    const { section, execute, rerender } = renderPanel(async () => overlapping);
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    expect(within(section()).queryByText(/Out of date/)).toBeNull();
    act(() => {
      execute(
        commandFactories.updateAssemblyComponent({
          componentId: 'comp_b',
          placement: {
            ...IDENTITY_PLACEMENT,
            translation: { x: 40, y: 0, z: 0 }
          }
        })
      );
    });
    rerender();
    expect(within(section()).getByText(/Out of date/)).toBeInTheDocument();
    expect(
      within(section()).getByRole('button', { name: 'Check again' })
    ).toBeEnabled();
  });

  it('never calls an unchecked pair clear', async () => {
    const { section } = renderPanel(async () => ({
      pairs: [
        {
          a: 'comp_a',
          b: 'comp_b',
          verdict: {
            kind: 'unknown',
            reason: 'exact_only_unattainable',
            message: 'the exact pipeline could not build this result.'
          }
        }
      ],
      missing: []
    }));
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    expect(within(section()).getByRole('status')).toHaveTextContent(
      'No overlap found in the pairs checked exactly.'
    );
    expect(section()).toHaveTextContent('1 pair not checked exactly');
    fireEvent.click(
      within(section()).getByRole('button', {
        name: 'Blade A and Blade B: Unknown'
      })
    );
    expect(section()).toHaveTextContent(
      'Not checked exactly: the exact pipeline could not build this result. This pair is not reported as clear.'
    );
  });

  it('reports a failed check in place', async () => {
    const { section, onStatus } = renderPanel(() =>
      Promise.reject(new Error('Geometry worker is unavailable.'))
    );
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    expect(within(section()).getByRole('status')).toHaveTextContent(
      'The check failed: Geometry worker is unavailable.'
    );
    expect(onStatus).toHaveBeenCalledWith(
      'Interference check failed: Geometry worker is unavailable.'
    );
  });
});
