import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  IDENTITY_PLACEMENT,
  type AssemblyInterferenceReport,
  type BodyClashVerdict
} from '@openzcad/shared';
import { recordingExecute, scissorsManager } from '../../test/assemblyFixture';
import {
  assemblyRuntime,
  getAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import { AssemblyPanel } from './AssemblyPanel';
import type { CheckInterference } from './AssemblyInterferenceSection';
import type { AssemblySweepCheck } from '@openzcad/document-core';

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
      'Checks every pair of parts at the rest position'
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
      '1 pair overlaps at the rest position.'
    );
    expect(onStatus).toHaveBeenCalledWith(
      'Interference: 1 pair of parts overlaps at the rest position.'
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
      'No overlap found at the rest position, but 1 pair could not be checked exactly.'
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

  it('does not claim no overlap while a part had no geometry to check', async () => {
    const { section, onStatus } = renderPanel(async () => ({
      pairs: [
        {
          a: 'comp_a',
          b: 'comp_b',
          verdict: {
            kind: 'clear',
            touching: false,
            distance: 5,
            closest: null,
            atLeast: 5
          }
        }
      ],
      missing: ['comp_c']
    }));
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    expect(within(section()).getByRole('status')).toHaveTextContent(
      'No overlap found at the rest position, but 1 part had no geometry to check.'
    );
    expect(onStatus).toHaveBeenCalledWith(
      'Interference: no overlap found at the rest position, but 1 part had no geometry to check.'
    );
    expect(section()).not.toHaveTextContent('No parts overlap');
  });

  it('says the result is of the rest position, and that the view shows another (#2154)', async () => {
    const clear: AssemblyInterferenceReport = {
      pairs: [
        {
          a: 'comp_a',
          b: 'comp_b',
          verdict: {
            kind: 'clear',
            touching: false,
            distance: 5,
            closest: null,
            atLeast: 5
          }
        }
      ],
      missing: []
    };
    const fixture = scissorsManager({ joint: true });
    const recorder = recordingExecute(fixture.manager);
    const onStatus = vi.fn();
    render(
      <AssemblyPanel
        document={fixture.live()}
        execute={recorder.execute}
        onStatus={onStatus}
        checkInterference={async () => clear}
      />
    );
    const section = () => screen.getByRole('region', { name: 'Interference' });
    // A sweep's "Show", a scrub or a study poses the view, never the model.
    act(() => {
      assemblyRuntime.setOverrides(new Map([['joint_pin', [90]]]), [
        { jointId: 'joint_pin', dof: 0 }
      ]);
    });
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    expect(within(section()).getByRole('status')).toHaveTextContent(
      'No parts overlap at the rest position. The view shows another position, which this check does not cover.'
    );
    expect(onStatus).toHaveBeenCalledWith(
      'Interference: no parts overlap at the rest position.'
    );
    // Back at the saved values the result stands on its own.
    act(() => {
      assemblyRuntime.setOverrides(new Map(), []);
    });
    expect(within(section()).getByRole('status')).toHaveTextContent(
      /^No parts overlap at the rest position\.$/
    );
  });

  it('names the configuration a part was checked in (#2388)', async () => {
    const { section } = renderPanel(async () => ({
      ...overlapping,
      configurations: { comp_a: { rowId: 'wide', rowName: 'Wide' } }
    }));
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    expect(
      within(section()).getByRole('button', {
        name: 'Blade A (Wide) and Blade B: 125 mm³'
      })
    ).toHaveTextContent('Blade A (Wide) · Blade B');
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

describe('Interference through motion (AS04)', () => {
  /** Overlap while the pivot stands strictly between 85° and 185°. */
  const sweep = vi.fn<AssemblySweepCheck>(
    async (_document, _parts, positions) => ({
      positions: positions.map((position) => ({
        at: position.at,
        pairs: position.pairs.map(([a, b]) => ({
          a,
          b,
          verdict:
            position.at > 85 && position.at < 185
              ? {
                  kind: 'interference' as const,
                  volume: position.at,
                  proof: 'intersect' as const,
                  point: null,
                  bounds: null,
                  complete: true
                }
              : {
                  kind: 'clear' as const,
                  touching: false,
                  distance: null,
                  closest: null,
                  atLeast: null
                }
        }))
      })),
      missing: []
    })
  );

  function renderSweep(check: AssemblySweepCheck = sweep) {
    const fixture = scissorsManager({ joint: true });
    const recorder = recordingExecute(fixture.manager);
    const onStatus = vi.fn();
    render(
      <AssemblyPanel
        document={fixture.live()}
        execute={recorder.execute}
        onStatus={onStatus}
        checkInterference={async () => ({ pairs: [], missing: [] })}
        checkInterferenceSweep={check}
      />
    );
    return {
      onStatus,
      section: () => screen.getByRole('region', { name: 'Interference' })
    };
  }

  it('sweeps a joint, locates where the parts start and stop overlapping, and shows the worst position', async () => {
    const { section, onStatus } = renderSweep();
    expect(
      within(section()).getByRole('combobox', { name: 'Motion to check' })
    ).toHaveDisplayValue('Pivot (0.0° to 360.0°)');
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    });
    // 37 even positions, then four rounds halving each turn.
    expect(sweep).toHaveBeenCalledTimes(5);
    expect(sweep.mock.calls[0]![2]).toHaveLength(37);
    expect(sweep.mock.calls[0]![2][0]!.pairs).toEqual([['comp_a', 'comp_b']]);
    expect(onStatus).toHaveBeenCalledWith(
      'Interference through motion: 1 pair of parts overlaps along Pivot (0.0° to 360.0°).'
    );
    const row = within(section()).getByRole('button', {
      name: 'Blade A and Blade B: 85.6° to 184.4°'
    });
    expect(section()).toHaveTextContent(
      'Sampled: 45 positions, every 10.0°, with each start and end found to within 0.6° where the positions beside it could be checked exactly. An overlap shorter than one step can fall between positions.'
    );
    fireEvent.click(row);
    expect(section()).toHaveTextContent('Largest overlap at 184.4°');
    act(() => {
      fireEvent.click(
        within(section()).getByRole('button', { name: 'Show at 184.4°' })
      );
    });
    expect(getAssemblyRuntime().overrides.get('joint_pin')).toEqual([184.375]);
  });

  /** Every pair gets `verdict` at every position asked. */
  const answering =
    (verdict: BodyClashVerdict): AssemblySweepCheck =>
    async (_document, _parts, positions) => ({
      positions: positions.map((position) => ({
        at: position.at,
        pairs: position.pairs.map(([a, b]) => ({ a, b, verdict }))
      })),
      missing: []
    });

  it('never says no overlap for a pair unknown at every position (#2183)', async () => {
    const { section, onStatus } = renderSweep(
      answering({
        kind: 'unknown',
        reason: 'exact_only_unattainable',
        message: 'the bodies could not be intersected exactly.'
      })
    );
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    });
    const summary =
      'but 1 pair could not be checked exactly at any of its 37 positions.';
    expect(section()).toHaveTextContent(
      `No overlap found at the 37 positions checked, ${summary}`
    );
    expect(onStatus).toHaveBeenCalledWith(
      `Interference through motion: no overlap found at 37 positions checked along Pivot (0.0° to 360.0°), ${summary}`
    );
    expect(section()).not.toHaveTextContent('No overlap at the');
    // The row still says which pair, and where.
    expect(
      within(section()).getByRole('button', {
        name: 'Blade A and Blade B: Unknown at 37 positions'
      })
    ).toBeInTheDocument();
  });

  it('keeps the plain all-clear summary when every position was decided', async () => {
    const { section, onStatus } = renderSweep(
      answering({
        kind: 'clear',
        touching: false,
        distance: null,
        closest: null,
        atLeast: null
      })
    );
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    });
    expect(section()).toHaveTextContent(
      'No overlap at the 37 positions checked.'
    );
    expect(onStatus).toHaveBeenCalledWith(
      'Interference through motion: no overlap at 37 positions checked along Pivot (0.0° to 360.0°).'
    );
    expect(section()).toHaveTextContent(
      '1 moving pair clear at every position checked'
    );
  });

  it('does not say no overlap for a position the check never answered', async () => {
    // A worker that drops every pair: no verdict is not a clear verdict.
    const { section } = renderSweep(async (_document, _parts, positions) => ({
      positions: positions.map((position) => ({ at: position.at, pairs: [] })),
      missing: []
    }));
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    });
    expect(section()).toHaveTextContent(
      'No overlap found at the 37 positions checked, but 1 pair could not be checked exactly at any of its 37 positions.'
    );
  });
});
