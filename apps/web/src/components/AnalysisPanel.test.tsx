import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  SurfaceAnalysisReport,
  SurfaceAnalysisRequest
} from '@openzcad/shared';
import { AnalysisPanel } from './AnalysisPanel';
import type { AnalysisRunState } from '../lib/analysis/useSurfaceAnalysis';

const request: SurfaceAnalysisRequest = {
  kind: 'draft',
  pull: { x: 0, y: 0, z: 1 },
  minimumDegrees: 1
};

function boxReport(): SurfaceAnalysisReport {
  const ranges: [number, number, string][] = [
    [-90, -90, 'plane'],
    [90, 90, 'plane'],
    [0, 0, 'plane'],
    [0, 0, 'plane'],
    [0, 0, 'plane'],
    [0, 90, 'sphere']
  ];
  return {
    request,
    bodies: [
      {
        bodyId: 'body_a',
        positions: new Float32Array(),
        normals: new Float32Array(),
        indices: new Uint32Array(),
        values: new Float32Array(),
        faces: ranges.map(([min, max, surface], face) => ({
          face,
          surface,
          min,
          max,
          samples: 4,
          exact: surface === 'plane'
        }))
      }
    ],
    unsupported: [
      {
        bodyId: 'body_a',
        face: 5,
        reason: 'partly-evaluated',
        message: '1 of 40 samples could not be evaluated: pole'
      }
    ],
    missing: ['body_gone']
  };
}

function renderPanel(run: AnalysisRunState, previewing = false) {
  const onChange = vi.fn();
  const onOff = vi.fn();
  render(
    <AnalysisPanel
      request={request}
      run={run}
      previewing={previewing}
      nameOf={(id) => (id === 'body_a' ? 'Housing' : 'Lid')}
      onChange={onChange}
      onOff={onOff}
    />
  );
  const panel = screen.getByRole('region', { name: 'Draft analysis' });
  return { panel, onChange, onOff };
}

describe('the analysis panel (M09)', () => {
  it('summarises the exact answer with its legend, provenance and limits', () => {
    const { panel } = renderPanel({ kind: 'done', report: boxReport() });
    expect(within(panel).getByRole('status')).toHaveTextContent(
      '1 face drafted away, 3 faces below the minimum, 1 face crossing bands. Crosses bands: the face changes band and needs splitting at a parting line.'
    );
    const legend = within(panel).getByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      '≥ 1° toward the pull · 1',
      'Within ±1° · 3',
      '≥ 1° away (undercut) · 1',
      'Not evaluated'
    ]);
    expect(within(panel).getByRole('note')).toHaveTextContent(
      /^Exact draft from the kernel .* 5 of 6 face ranges exact\.$/
    );
    expect(panel).toHaveTextContent(/not a parting-line check/);
    expect(
      within(within(panel).getByRole('list', { name: 'Not analysed' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      'Lid: no exact geometry to analyse.',
      'Housing, face 6: partly evaluated (1 of 40 samples could not be evaluated: pole).'
    ]);
  });

  it('edits the pull and the minimum, and turns off', () => {
    const { panel, onChange, onOff } = renderPanel({ kind: 'running' });
    expect(within(panel).getByRole('status')).toHaveTextContent(
      'Analysing with the exact kernel…'
    );
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Pull' }), {
      target: { value: '-x' }
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...request,
      pull: { x: -1, y: 0, z: 0 }
    });
    const minimum = within(panel).getByRole('spinbutton', {
      name: 'Minimum draft (°)'
    });
    fireEvent.change(minimum, { target: { value: '3' } });
    expect(onChange).toHaveBeenLastCalledWith({
      ...request,
      minimumDegrees: 3
    });
    // Out of range is not taken.
    onChange.mockClear();
    fireEvent.change(minimum, { target: { value: '95' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn off' }));
    expect(onOff).toHaveBeenCalled();
  });

  it('says why it shows nothing: a failure, or a preview on screen', () => {
    renderPanel({ kind: 'failed', message: 'Kernel busy' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'The analysis failed: Kernel busy'
    );
  });

  it('pauses while a preview stands in for the build', () => {
    renderPanel({ kind: 'done', report: boxReport() }, true);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Paused while a preview is on screen; the colours return with the built model.'
    );
  });
});
