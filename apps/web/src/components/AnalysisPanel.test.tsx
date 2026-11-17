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

describe('the analysis panel for curvature and zebra (M09)', () => {
  it('gives curvature its scale, units, tightest radius and limits', () => {
    const onChange = vi.fn();
    const report: SurfaceAnalysisReport = {
      request: { kind: 'curvature', measure: 'mean' },
      bodies: [
        {
          bodyId: 'body_a',
          positions: new Float32Array(),
          normals: new Float32Array(),
          indices: new Uint32Array(),
          values: Float32Array.from([-1 / 12, 0]),
          faces: [
            {
              face: 0,
              surface: 'cylinder',
              min: -1 / 12,
              max: -1 / 12,
              samples: 40,
              exact: true,
              minRadius: 6,
              minRadiusExact: true
            },
            {
              face: 1,
              surface: 'plane',
              min: 0,
              max: 0,
              samples: 4,
              exact: true,
              minRadius: null,
              minRadiusExact: true
            }
          ]
        }
      ],
      unsupported: [],
      missing: []
    };
    render(
      <AnalysisPanel
        request={{ kind: 'curvature', measure: 'mean' }}
        run={{ kind: 'done', report }}
        lengthUnit="mm"
        nameOf={() => 'Plate'}
        onChange={onChange}
        onOff={vi.fn()}
      />
    );
    const panel = screen.getByRole('region', { name: 'Curvature analysis' });
    expect(within(panel).getByRole('status')).toHaveTextContent(
      'Tightest radius 6 mm (exact) on Plate, face 1. Mean curvature -0.0833 1/mm to 0 1/mm.'
    );
    expect(
      within(within(panel).getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      'Concave · -0.0833 1/mm',
      'Flat · 0',
      'Convex · 0.0833 1/mm',
      'Not evaluated'
    ]);
    expect(within(panel).getByRole('note')).toHaveTextContent(
      /2 of 2 face ranges exact\.$/
    );
    expect(panel).toHaveTextContent(/one tight face mutes the rest/);
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Measure' }), {
      target: { value: 'gaussian' }
    });
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'curvature',
      measure: 'gaussian'
    });
  });

  it('gives zebra its stripe count and says continuity is read by eye', () => {
    const onChange = vi.fn();
    render(
      <AnalysisPanel
        request={{ kind: 'zebra', stripes: 12 }}
        run={{ kind: 'running' }}
        nameOf={() => 'Plate'}
        onChange={onChange}
        onOff={vi.fn()}
      />
    );
    const panel = screen.getByRole('region', { name: 'Zebra analysis' });
    expect(within(panel).getByRole('note')).toHaveTextContent(
      /^Stripes reflected from the kernel’s exact outward normals/
    );
    expect(panel).toHaveTextContent(/read by eye/);
    const stripes = within(panel).getByRole('spinbutton', { name: 'Stripes' });
    fireEvent.change(stripes, { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'zebra', stripes: 20 });
    onChange.mockClear();
    fireEvent.change(stripes, { target: { value: '1' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('the Gaussian curvature legend (M09)', () => {
  it('reads its sign as saddle and dome or bowl, never concave or convex', () => {
    const report: SurfaceAnalysisReport = {
      request: { kind: 'curvature', measure: 'gaussian' },
      bodies: [
        {
          bodyId: 'body_a',
          positions: new Float32Array(),
          normals: new Float32Array(),
          indices: new Uint32Array(),
          values: Float32Array.from([-0.04, 0.02]),
          faces: [
            {
              face: 0,
              surface: 'torus',
              min: -0.04,
              max: 0.02,
              samples: 40,
              exact: false,
              minRadius: 3,
              minRadiusExact: true
            }
          ]
        }
      ],
      unsupported: [],
      missing: []
    };
    render(
      <AnalysisPanel
        request={{ kind: 'curvature', measure: 'gaussian' }}
        run={{ kind: 'done', report }}
        lengthUnit="mm"
        nameOf={() => 'Ring'}
        onChange={vi.fn()}
        onOff={vi.fn()}
      />
    );
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      'Negative (saddle) · -0.04 1/mm²',
      'Zero (flat or developable) · 0',
      'Positive (dome or bowl) · 0.04 1/mm²',
      'Not evaluated'
    ]);
  });
});

describe('the analysis panel for thickness (M09)', () => {
  it('states the thinnest wall, the resolution, the minimum and the limits', () => {
    const onChange = vi.fn();
    const report: SurfaceAnalysisReport = {
      request: { kind: 'thickness', minimum: 3 },
      bodies: [
        {
          bodyId: 'body_a',
          positions: new Float32Array(),
          normals: new Float32Array(),
          indices: new Uint32Array(),
          values: new Float32Array(),
          faces: [
            {
              face: 0,
              surface: 'plane',
              min: 2,
              max: 2,
              samples: 40,
              exact: true
            },
            {
              face: 1,
              surface: 'plane',
              min: 40,
              max: 40,
              samples: 40,
              exact: true
            }
          ],
          resolution: 0.004
        }
      ],
      unsupported: [],
      missing: []
    };
    render(
      <AnalysisPanel
        request={{ kind: 'thickness', minimum: 3 }}
        run={{ kind: 'done', report }}
        lengthUnit="mm"
        nameOf={() => 'Plate'}
        onChange={onChange}
        onOff={vi.fn()}
      />
    );
    const panel = screen.getByRole('region', { name: 'Thickness analysis' });
    expect(within(panel).getByRole('status')).toHaveTextContent(
      'Thinnest wall 2 mm (exact) on Plate, face 1. 1 face below the 3 mm minimum.'
    );
    expect(
      within(within(panel).getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      'Under 3 mm · 1',
      '3 mm to 6 mm · 0',
      '6 mm or more · 1',
      'Not measured'
    ]);
    expect(within(panel).getByRole('note')).toHaveTextContent(
      /^Approximate: .* Resolution 0\.004 mm\. 2 of 2 face ranges exact\.$/
    );
    const minimum = within(panel).getByRole('spinbutton', {
      name: 'Minimum wall (mm)'
    });
    fireEvent.change(minimum, { target: { value: '0.8' } });
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'thickness',
      minimum: 0.8
    });
    onChange.mockClear();
    fireEvent.change(minimum, { target: { value: '0' } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
