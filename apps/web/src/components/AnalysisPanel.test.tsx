import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      '1 face drafted away, 3 faces below the minimum, 1 face crossing bands.'
    );
    const legend = within(panel).getByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['≥ 1° · 1', '< 1° · 3', 'Undercut · 1', 'Not evaluated']);
    expect(within(panel).getByRole('note')).toHaveTextContent(
      /^Crosses bands: needs a split at a parting line\.Exact at sample points.*5 of 6 faces exact\.$/
    );
    expect(panel).toHaveTextContent(/not a parting-line check/);
    expect(panel).toHaveTextContent(/needs a split at a parting line/);
    // The provenance and limits wait behind one disclosure.
    expect(panel.querySelector('details')).not.toHaveAttribute('open');
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
    expect(within(panel).getByRole('status')).toHaveTextContent('Analysing…');
    const pull = within(panel).getByRole('radiogroup', { name: 'Pull' });
    expect(within(pull).getByRole('radio', { name: '+Z' })).toBeChecked();
    // One tab stop: only the chosen direction is tabbable.
    expect(
      within(pull)
        .getAllByRole('radio')
        .map((radio) => radio.tabIndex)
    ).toEqual([0, -1, -1, -1, -1, -1]);
    // The arrows move the choice, wrapping at the ends.
    fireEvent.keyDown(within(pull).getByRole('radio', { name: '+Z' }), {
      key: 'ArrowRight'
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...request,
      pull: { x: 0, y: 0, z: -1 }
    });
    fireEvent.keyDown(within(pull).getByRole('radio', { name: '+Z' }), {
      key: 'ArrowLeft'
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...request,
      pull: { x: -1, y: 0, z: 0 }
    });
    fireEvent.click(within(pull).getByRole('radio', { name: '−X' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...request,
      pull: { x: -1, y: 0, z: 0 }
    });
    const minimum = within(panel).getByRole('spinbutton', {
      name: 'Min draft (°)'
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

  it('names the zero-draft band plainly when the minimum is 0°', () => {
    render(
      <AnalysisPanel
        request={{ ...request, minimumDegrees: 0 }}
        run={{ kind: 'running' }}
        nameOf={() => 'Housing'}
        onChange={vi.fn()}
        onOff={vi.fn()}
      />
    );
    expect(
      within(screen.getByRole('list', { name: 'Legend' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['≥ 0°', '0°', 'Undercut']);
  });

  it('says why it shows nothing: a failure, or a preview on screen', () => {
    renderPanel({ kind: 'failed', message: 'Kernel busy' });
    expect(screen.getByRole('status')).toHaveTextContent('Failed: Kernel busy');
  });

  it('pauses while a preview stands in for the build', () => {
    renderPanel({ kind: 'done', report: boxReport() }, true);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Paused during preview.'
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
    const legend = within(panel).getByRole('list', { name: 'Legend' });
    expect(
      ['Concave', 'Flat', 'Convex'].map(
        (name) => within(legend).getByTitle(name).textContent
      )
    ).toEqual(['Concave -0.0833 1/mm', 'Flat 0', 'Convex 0.0833 1/mm']);
    expect(within(panel).getByRole('note')).toHaveTextContent(
      /2 of 2 faces exact\.$/
    );
    expect(panel).toHaveTextContent(/one tight face mutes the rest/);
    fireEvent.click(within(panel).getByRole('radio', { name: 'Gaussian' }));
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
      /^Exact normals at sample points/
    );
    expect(panel).toHaveTextContent(/read by eye/);
    // The stripes themselves are the key: no legend to read.
    expect(within(panel).queryByRole('list', { name: 'Legend' })).toBeNull();
    const stripes = within(panel).getByRole('slider', { name: 'Stripes' });
    // One status only: the stripe count is not a second live region.
    expect(within(panel).getAllByRole('status')).toHaveLength(1);
    fireEvent.change(stripes, { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'zebra', stripes: 20 });
    onChange.mockClear();
    // The slider cannot go below the fewest stripes: it holds at two.
    fireEvent.change(stripes, { target: { value: '1' } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'zebra', stripes: 2 });
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
      [
        'Negative (saddle)',
        'Zero (flat or developable)',
        'Positive (dome or bowl)'
      ].map((name) => within(legend).getByTitle(name).textContent)
    ).toEqual(['Saddle -0.04 1/mm²', 'Flat 0', 'Dome 0.04 1/mm²']);
    expect(legend).not.toHaveTextContent(/Concave|Convex/);
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
    ).toEqual(['< 3 mm · 1', '< 6 mm · 0', '≥ 6 mm · 1']);
    expect(within(panel).getByRole('note')).toHaveTextContent(
      /^Approximate: .*Resolution 0\.004 mm · 2 of 2 faces exact\.$/
    );
    const minimum = within(panel).getByRole('spinbutton', {
      name: 'Min wall (mm)'
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

describe('the analysis panel beside the Display button (M09)', () => {
  const restores: (() => void)[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const restore of restores.splice(0)) restore();
    document.body.innerHTML = '';
  });

  function stub(target: object, key: string, get: (this: never) => unknown) {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, get });
    restores.push(() => {
      if (original) Object.defineProperty(target, key, original);
      else delete (target as Record<string, unknown>)[key];
    });
  }

  function rect(left: number, top: number, width: number, height: number) {
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({})
    } as DOMRect;
  }

  it('re-places once the rail it measured mid-slide finishes animating in', async () => {
    const workspace = document.createElement('div');
    workspace.className = 'workspace';
    const stage = document.createElement('div');
    const rail = document.createElement('div');
    rail.className = 'viewer-rail';
    const trigger = document.createElement('button');
    trigger.setAttribute('data-display-mode-trigger', '');
    rail.append(trigger);
    workspace.append(stage, rail);
    document.body.append(workspace);

    // The rail slides in from 16px right of where it settles; the first
    // placement measures it part-way through.
    let railLeft = 1008;
    const rects = new Map<Element, () => DOMRect>([
      [stage, () => rect(0, 0, 1200, 800)],
      [rail, () => rect(railLeft, 100, 40, 400)],
      [trigger, () => rect(railLeft + 4, 120, 32, 32)]
    ]);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        return rects.get(this)?.() ?? rect(0, 0, 0, 0);
      }
    );
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (
      this: Element
    ) {
      const list = rects.has(this) ? [rects.get(this)!()] : [];
      return Object.assign(list, {
        item: (i: number) => list[i] ?? null
      });
    });
    // happy-dom lays nothing out: the panel's offset parent is the stage,
    // and it has a size.
    stub(HTMLElement.prototype, 'offsetParent', function (this: HTMLElement) {
      return this.classList.contains('analysis-panel') ? stage : null;
    });
    stub(HTMLElement.prototype, 'offsetWidth', () => 300);
    stub(HTMLElement.prototype, 'offsetHeight', () => 200);

    render(
      <AnalysisPanel
        request={request}
        run={{ kind: 'done', report: boxReport() }}
        nameOf={() => 'Housing'}
        onChange={vi.fn()}
        onOff={vi.fn()}
      />,
      { container: stage }
    );
    const panel = screen.getByRole('region', { name: 'Draft analysis' });
    // 1200 − 1008 + 8: beside the rail where it stood mid-slide.
    expect(panel.style.right).toBe('200px');

    // The slide ends: nothing resizes or mutates, only the animation event.
    railLeft = 992;
    await act(async () => {
      fireEvent.animationEnd(rail);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(panel.style.right).toBe('216px');
  });
});
