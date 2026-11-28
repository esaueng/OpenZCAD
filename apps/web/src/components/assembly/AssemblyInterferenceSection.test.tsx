import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  IDENTITY_PLACEMENT,
  type AssemblyInterferenceReport,
  type BodyClashVerdict,
  type ProjectDocument
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

/**
 * An out-of-date result's live region leads with that, and reads out no
 * result as if it held now: a screen reader reads this line, not the
 * warning under it.
 */
function expectOutdatedStatus(section: HTMLElement) {
  const status = within(section).getByRole('status');
  expect(status).toHaveTextContent(
    /^Out of date\. Check again for the parts as they are now\.$/
  );
  expect(status).not.toHaveTextContent(/overlap|clear/i);
}

/** The sweep's own live line, likewise. */
function expectOutdatedSweepLine(section: HTMLElement) {
  const line = section.querySelector(
    '.assembly-interference-motion [aria-live]'
  );
  expect(line).toHaveTextContent(
    /^Out of date\. Sweep again for the motion and parts as they are now\.$/
  );
  expect(line).not.toHaveTextContent(/overlap|clear/i);
}

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
    expect(within(section()).getByText(/Out of date:/)).toBeInTheDocument();
    expectOutdatedStatus(section());
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
      '1 pair could not be checked exactly; no overlap found among the other pairs at the rest position.'
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
      '1 part had no geometry to check; no overlap found among the other pairs at the rest position.'
    );
    expect(onStatus).toHaveBeenCalledWith(
      'Interference: 1 part had no geometry to check; no overlap found among the other pairs at the rest position.'
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

  it('says the view shows another position while it is exploded', async () => {
    const { section } = renderPanel(async () => ({
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
    }));
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    const status = () => within(section()).getByRole('status');
    expect(status()).toHaveTextContent(
      /^No parts overlap at the rest position\.$/
    );
    // Exploded with no part pulled out, the view is still the rest position.
    act(() => assemblyRuntime.setExploded(true));
    expect(status()).toHaveTextContent(
      /^No parts overlap at the rest position\.$/
    );
    // A part pulled out is drawn away from where the check read it.
    act(() =>
      assemblyRuntime.setExplodeOverride('comp_b', { x: 0, y: 0, z: 30 })
    );
    expect(status()).toHaveTextContent(
      'No parts overlap at the rest position. The view shows another position, which this check does not cover.'
    );
    act(() => assemblyRuntime.setExploded(false));
    expect(status()).toHaveTextContent(
      /^No parts overlap at the rest position\.$/
    );
  });

  it('does not post a result for parts that changed while it was being checked', async () => {
    let finish: (report: AssemblyInterferenceReport) => void = () => {};
    const { section, onStatus, execute, rerender } = renderPanel(
      () =>
        new Promise<AssemblyInterferenceReport>((resolve) => {
          finish = resolve;
        })
    );
    fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    // The part moves before the check returns.
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
    await act(async () => {
      finish({
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
      });
    });
    // The panel shows the result as what it is: of the parts as they were.
    expect(within(section()).getByText(/Out of date:/)).toBeInTheDocument();
    expectOutdatedStatus(section());
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(
      'Interference: the parts or their positions changed during the check. Check again.'
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
      '1 pair could not be checked exactly at any of its 37 positions; no overlap found among the other pairs at';
    expect(section()).toHaveTextContent(`${summary} the 37 positions checked.`);
    expect(onStatus).toHaveBeenCalledWith(
      `Interference through motion: ${summary} 37 positions checked along Pivot (0.0° to 360.0°).`
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

  it('does not post a sweep of one motion once another is chosen', async () => {
    const fixture = scissorsManager({ joint: true });
    fixture.manager.execute(
      commandFactories.setAssemblyStudy({
        study: {
          id: 'st_swing',
          name: 'Swing',
          durationS: 2,
          playback: 'once',
          tracks: [
            {
              jointId: 'joint_pin',
              dof: 0,
              keys: [
                { t: 0, value: 0, easing: 'linear' },
                { t: 2, value: 90, easing: 'linear' }
              ]
            }
          ]
        }
      })
    );
    const onStatus = vi.fn();
    type Answer = Awaited<ReturnType<AssemblySweepCheck>>;
    let finish: (answer: Answer) => void = () => {};
    let asked: Parameters<AssemblySweepCheck>[2] = [];
    render(
      <AssemblyPanel
        document={fixture.live()}
        execute={recordingExecute(fixture.manager).execute}
        onStatus={onStatus}
        checkInterference={async () => ({ pairs: [], missing: [] })}
        checkInterferenceSweep={(_document, _parts, positions) => {
          asked = positions;
          return new Promise<Answer>((resolve) => {
            finish = resolve;
          });
        }}
      />
    );
    const section = () => screen.getByRole('region', { name: 'Interference' });
    const picker = () =>
      within(section()).getByRole('combobox', { name: 'Motion to check' });
    expect(picker()).toHaveDisplayValue('Pivot (0.0° to 360.0°)');
    fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    // Another motion is picked before the sweep of the pivot returns.
    fireEvent.change(picker(), { target: { value: 'study:st_swing' } });
    expect(picker()).toHaveDisplayValue('Swing (2 s study)');
    await act(async () => {
      finish({
        positions: asked.map((position) => ({
          at: position.at,
          pairs: position.pairs.map(([a, b]) => ({
            a,
            b,
            verdict: {
              kind: 'clear' as const,
              touching: false,
              distance: null,
              closest: null,
              atLeast: null
            }
          }))
        })),
        missing: []
      });
    });
    expect(within(section()).getByText(/Out of date:/)).toBeInTheDocument();
    expectOutdatedSweepLine(section());
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(
      'Interference through motion: the parts, their motion or the model changed during the check. Sweep again.'
    );
  });

  it('says which configuration could not be built, under the pair it leaves unknown (#2388)', async () => {
    const { section } = renderSweep(async (_document, _parts, positions) => ({
      positions: positions.map((position) => ({
        at: position.at,
        pairs: position.pairs.map(([a, b]) => ({
          a,
          b,
          verdict: {
            kind: 'unknown' as const,
            reason: 'configuration_unavailable',
            message: 'the Wide configuration of Blade A could not be built'
          }
        }))
      })),
      missing: [],
      configurations: { comp_a: { rowId: 'wide', rowName: 'Wide' } }
    }));
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    });
    fireEvent.click(
      within(section()).getByRole('button', {
        name: 'Blade A (Wide) and Blade B: Unknown at 37 positions'
      })
    );
    expect(section()).toHaveTextContent(
      'Not checked exactly at 0.0°, 10.0°, 20.0°, 30.0°, 40.0°, 50.0°, …: the Wide configuration of Blade A could not be built. Not reported as clear there.'
    );
  });

  it('checks a pair a study holds away from rest, and says it is held', async () => {
    const fixture = scissorsManager({ joint: true });
    // The pivot rests at 12°; the study holds it at 90° for its whole length.
    fixture.manager.execute(
      commandFactories.setAssemblyStudy({
        study: {
          id: 'st_hold',
          name: 'Hold',
          durationS: 1,
          playback: 'once',
          tracks: [
            {
              jointId: 'joint_pin',
              dof: 0,
              keys: [
                { t: 0, value: 90, easing: 'linear' },
                { t: 1, value: 90, easing: 'linear' }
              ]
            }
          ]
        }
      })
    );
    const onStatus = vi.fn();
    const check = vi.fn<AssemblySweepCheck>(
      async (_document, _parts, positions) => ({
        positions: positions.map((position) => ({
          at: position.at,
          pairs: position.pairs.map(([a, b]) => ({
            a,
            b,
            verdict: {
              kind: 'interference' as const,
              volume: 40,
              proof: 'intersect' as const,
              point: null,
              bounds: null,
              complete: true
            }
          }))
        })),
        missing: []
      })
    );
    render(
      <AssemblyPanel
        document={fixture.live()}
        execute={recordingExecute(fixture.manager).execute}
        onStatus={onStatus}
        checkInterference={async () => ({ pairs: [], missing: [] })}
        checkInterferenceSweep={check}
      />
    );
    const section = () => screen.getByRole('region', { name: 'Interference' });
    fireEvent.change(
      within(section()).getByRole('combobox', { name: 'Motion to check' }),
      { target: { value: 'study:st_hold' } }
    );
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    });
    // One request, one position: the pose is the same along the whole study.
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]![2]).toHaveLength(1);
    expect(onStatus).toHaveBeenCalledWith(
      'Interference through motion: 1 pair of parts overlaps along Hold (1 s study).'
    );
    fireEvent.click(
      within(section()).getByRole('button', {
        name: 'Blade A and Blade B: 0 s to 1 s'
      })
    );
    expect(section()).toHaveTextContent(
      'The motion holds these parts in one position, away from where they rest. It was checked once, and the result stands for the whole motion.'
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
      '1 pair could not be checked exactly at any of its 37 positions; no overlap found among the other pairs at the 37 positions checked.'
    );
  });
});

const clearVerdict: BodyClashVerdict = {
  kind: 'clear',
  touching: false,
  distance: null,
  closest: null,
  atLeast: null
};

/** Every pair asked is clear at every position. */
const clearSweep: AssemblySweepCheck = async (
  _document,
  _parts,
  positions
) => ({
  positions: positions.map((position) => ({
    at: position.at,
    pairs: position.pairs.map(([a, b]) => ({ a, b, verdict: clearVerdict }))
  })),
  missing: []
});

describe('Interference results of a model that is no longer the one shown (AS04)', () => {
  /** The same document version, with the first box 45 wide. */
  const widened = (document: ProjectDocument): ProjectDocument => {
    const [key, node] = Object.entries(document.nodes).find(
      ([, entry]) =>
        entry.kind === 'feature' && entry.data.featureKind === 'primitive'
    )!;
    if (node.kind !== 'feature' || node.data.featureKind !== 'primitive')
      throw new Error('no primitive');
    return {
      ...document,
      nodes: {
        ...document.nodes,
        [key]: {
          ...node,
          data: {
            ...node.data,
            dimensions: { ...node.data.dimensions, width: 45 }
          }
        }
      }
    };
  };

  function renderModel(
    check: CheckInterference,
    checkSweep: AssemblySweepCheck = clearSweep
  ) {
    const fixture = scissorsManager({ joint: true });
    const recorder = recordingExecute(fixture.manager);
    const onStatus = vi.fn();
    let document = fixture.live();
    const element = () => (
      <AssemblyPanel
        document={document}
        execute={recorder.execute}
        onStatus={onStatus}
        checkInterference={check}
        checkInterferenceSweep={checkSweep}
      />
    );
    const view = render(element());
    return {
      onStatus,
      unmount: () => view.unmount(),
      /** The room's version taken, or a dimension edited: same version. */
      replaceModel: () => {
        const version = document.version;
        document = widened(document);
        expect(document.version).toBe(version);
        view.rerender(element());
      },
      section: () => screen.getByRole('region', { name: 'Interference' })
    };
  }

  const clearReport: AssemblyInterferenceReport = {
    pairs: [{ a: 'comp_a', b: 'comp_b', verdict: clearVerdict }],
    missing: []
  };

  type Answer = Awaited<ReturnType<AssemblySweepCheck>>;
  const answerClear = (asked: Parameters<AssemblySweepCheck>[2]): Answer => ({
    positions: asked.map((position) => ({
      at: position.at,
      pairs: position.pairs.map(([a, b]) => ({ a, b, verdict: clearVerdict }))
    })),
    missing: []
  });

  it('does not post a static all-clear for a model replaced at the same version', async () => {
    let finish: (report: AssemblyInterferenceReport) => void = () => {};
    const { section, onStatus, replaceModel } = renderModel(
      () =>
        new Promise<AssemblyInterferenceReport>((resolve) => {
          finish = resolve;
        })
    );
    fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    replaceModel();
    await act(async () => {
      finish(clearReport);
    });
    expect(within(section()).getByText(/Out of date:/)).toBeInTheDocument();
    expectOutdatedStatus(section());
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(
      'Interference: the parts or their positions changed during the check. Check again.'
    );
  });

  it('marks a finished static result out of date when the model changes at the same version', async () => {
    const { section, replaceModel } = renderModel(async () => clearReport);
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    expect(within(section()).queryByText(/Out of date/)).toBeNull();
    replaceModel();
    expect(within(section()).getByText(/Out of date:/)).toBeInTheDocument();
    expectOutdatedStatus(section());
  });

  it('does not post a sweep all-clear for a model replaced at the same version', async () => {
    let finish: (answer: Answer) => void = () => {};
    let asked: Parameters<AssemblySweepCheck>[2] = [];
    const { section, onStatus, replaceModel } = renderModel(
      async () => clearReport,
      (_document, _parts, positions) => {
        asked = positions;
        return new Promise<Answer>((resolve) => {
          finish = resolve;
        });
      }
    );
    fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    replaceModel();
    await act(async () => {
      finish(answerClear(asked));
    });
    expect(within(section()).getByText(/Out of date:/)).toBeInTheDocument();
    expectOutdatedSweepLine(section());
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(
      'Interference through motion: the parts, their motion or the model changed during the check. Sweep again.'
    );
  });

  it('posts nothing for a static check that returns after Assemble is left', async () => {
    let finish: (report: AssemblyInterferenceReport) => void = () => {};
    const { section, onStatus, unmount } = renderModel(
      () =>
        new Promise<AssemblyInterferenceReport>((resolve) => {
          finish = resolve;
        })
    );
    fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    unmount();
    await act(async () => {
      finish(clearReport);
    });
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('posts nothing for a failed check or a sweep that returns after Assemble is left', async () => {
    let fail: (error: Error) => void = () => {};
    let finish: (answer: Answer) => void = () => {};
    let asked: Parameters<AssemblySweepCheck>[2] = [];
    const { section, onStatus, unmount } = renderModel(
      () =>
        new Promise<AssemblyInterferenceReport>((_resolve, reject) => {
          fail = reject;
        }),
      (_document, _parts, positions) => {
        asked = positions;
        return new Promise<Answer>((resolve) => {
          finish = resolve;
        });
      }
    );
    fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    unmount();
    await act(async () => {
      fail(new Error('Geometry worker is unavailable.'));
      finish(answerClear(asked));
    });
    expect(onStatus).not.toHaveBeenCalled();
  });
});

describe('Interference through motion accounts for every pair (AS04)', () => {
  const overlap: BodyClashVerdict = {
    kind: 'interference',
    volume: 60,
    proof: 'intersect',
    point: null,
    bounds: null,
    complete: true
  };

  /**
   * Blade B turns on Blade A, and a grounded screw stands beside Blade A.
   * The sweep of the pivot moves Blade B against both, and leaves the blade
   * and the screw where they rest.
   */
  function renderThree(rest: AssemblyInterferenceReport) {
    const fixture = scissorsManager({ joint: true, screw: true });
    const recorder = recordingExecute(fixture.manager);
    recorder.execute(
      commandFactories.addAssemblyComponents({
        components: [
          {
            componentId: 'comp_s',
            name: 'Pivot screw',
            bodyId: fixture.screw!,
            grounded: true
          }
        ]
      })
    );
    const onStatus = vi.fn();
    const element = () => (
      <AssemblyPanel
        document={fixture.live()}
        execute={recorder.execute}
        onStatus={onStatus}
        checkInterference={async () => rest}
        checkInterferenceSweep={clearSweep}
      />
    );
    const view = render(element());
    return {
      execute: recorder.execute,
      onStatus,
      rerender: () => view.rerender(element()),
      section: () => screen.getByRole('region', { name: 'Interference' })
    };
  }

  const restReport = (
    bladeAndScrew: BodyClashVerdict
  ): AssemblyInterferenceReport => ({
    pairs: [
      { a: 'comp_a', b: 'comp_b', verdict: clearVerdict },
      { a: 'comp_a', b: 'comp_s', verdict: bladeAndScrew },
      { a: 'comp_b', b: 'comp_s', verdict: clearVerdict }
    ],
    missing: []
  });

  it('says a pair the motion leaves at rest was not checked, until the rest check covers it', async () => {
    const { section, onStatus } = renderThree(restReport(overlap));
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    });
    // Both of Blade B's pairs are clear along the pivot. The blade and the
    // screw were never checked: that is said, and it is not "no overlap".
    const unchecked =
      '1 pair the motion leaves at rest was not checked; no overlap found among the other pairs at';
    expect(section()).toHaveTextContent(
      `${unchecked} the 37 positions checked.`
    );
    expect(onStatus).toHaveBeenLastCalledWith(
      `Interference through motion: ${unchecked} 37 positions checked along Pivot (0.0° to 360.0°).`
    );
    expect(section()).not.toHaveTextContent('No overlap at the');
    expect(section()).toHaveTextContent(
      '1 pair left at rest, not checked: run Check above'
    );
    // The rest check finds them overlapping: so they do along the motion.
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    expect(section()).toHaveTextContent('1 pair overlaps along the motion.');
    fireEvent.click(
      within(section()).getByRole('button', {
        name: 'Blade A and Pivot screw: 0.0° to 360.0°'
      })
    );
    expect(section()).toHaveTextContent(
      'The motion leaves these parts where they rest. This result is from the check of the rest position above, and stands for the whole motion.'
    );
  });

  it('gives the all-clear once a current rest check covers the pair left at rest, and takes it back when that check goes out of date', async () => {
    const { section, onStatus, execute, rerender } = renderThree(
      restReport(clearVerdict)
    );
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Check' }));
    });
    await act(async () => {
      fireEvent.click(within(section()).getByRole('button', { name: 'Sweep' }));
    });
    expect(section()).toHaveTextContent(
      'No overlap at the 37 positions checked.'
    );
    expect(onStatus).toHaveBeenLastCalledWith(
      'Interference through motion: no overlap at 37 positions checked along Pivot (0.0° to 360.0°).'
    );
    expect(section()).toHaveTextContent(
      '1 pair left at rest, clear in the check above'
    );
    // The screw moves: neither result is of this model any more.
    act(() => {
      execute(
        commandFactories.updateAssemblyComponent({
          componentId: 'comp_s',
          placement: {
            ...IDENTITY_PLACEMENT,
            translation: { x: 40, y: 0, z: 0 }
          }
        })
      );
    });
    rerender();
    expect(section()).not.toHaveTextContent('No overlap at the');
    // Both lines say so first; the sweep's rows no longer take the rest
    // check's verdict for the pair left at rest.
    expectOutdatedStatus(section());
    expectOutdatedSweepLine(section());
    expect(section()).toHaveTextContent(
      '1 pair left at rest, not checked: run Check above'
    );
  });
});
