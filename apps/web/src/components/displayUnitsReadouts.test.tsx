import { act, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BodyRepresentation,
  FeatureData,
  FeatureNode,
  ParameterNode
} from '@openzcad/shared';
import {
  DisplayUnitsProvider,
  displayEntryText,
  formatDocumentLength,
  lengthReadout
} from '../lib/displayUnits';
import { featureValueSummary } from '../lib/featureSummary';
import {
  offsetChipText,
  offsetFaceCommitMessage,
  offsetLimitChipText
} from '../lib/offsetChip';
import { BodyStats } from './Inspector';
import { ParameterRow } from './ParameterRows';
import {
  ViewportScaleIndicator,
  type ViewportScaleSink
} from './ViewportScaleIndicator';

/**
 * I03: read-only figures follow the display unit — the Inspector, History
 * rows, the parameter table and the viewport rule — while stored values
 * and what they are built from stay in the document's own units.
 */

describe('lengths, areas and volumes read in the display unit', () => {
  it('scales each power of length once', () => {
    const inches = lengthReadout('mm', 'inch');
    expect(inches.length(25.4)).toBeCloseTo(1, 12);
    expect(inches.power(25.4 * 25.4, 2)).toBeCloseTo(1, 12);
    expect(inches.power(25.4 ** 3, 3)).toBeCloseTo(1, 12);
    expect(inches.symbol).toBe('in');
    const same = lengthReadout('cm');
    expect(same.length(3)).toBe(3);
    expect(same.power(7, 5)).toBe(7);
  });

  it("hands a refusal's proved size back in the unit the panel reads", () => {
    // "Try 2.5 mm" in a project shown in inches is 2.5 mm, not 2.5 in.
    expect(Number(displayEntryText(2.5, true, 'mm', 'inch'))).toBeCloseTo(
      2.5 / 25.4,
      12
    );
    expect(displayEntryText(30, false, 'mm', 'inch')).toBe('30');
    expect(displayEntryText(2.5, true, 'mm', 'mm')).toBe('2.5');
  });

  it('writes a document length in a sentence', () => {
    expect(
      formatDocumentLength({ units: 'mm', displayUnits: 'inch' }, 50.8)
    ).toBe('2 in');
    expect(formatDocumentLength({ units: 'mm' }, 12.5)).toBe('12.5 mm');
    expect(formatDocumentLength(null, 3)).toBe('3');
  });
});

const body: BodyRepresentation = {
  bodyId: 'body_bracket',
  name: 'Bracket',
  source: 'primitive',
  mesh: {
    kind: 'mesh',
    vertices: new Float32Array(),
    indices: new Uint32Array()
  },
  faceCount: 6,
  color: '#ffffff',
  exportableStep: true,
  consumed: false,
  volume: 25.4 ** 3 * 2,
  bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 25.4, y: 50.8, z: 76.2 } }
} as unknown as BodyRepresentation;

describe('the Inspector body measurements', () => {
  it('shows size and volume in the display unit', () => {
    render(
      <DisplayUnitsProvider units="inch">
        <BodyStats body={body} units="mm" />
      </DisplayUnitsProvider>
    );
    expect(screen.getByText(/1 × 2 × 3 in/)).toBeVisible();
    expect(screen.getByText(/^2 in³$/)).toBeVisible();
  });

  it('is unchanged in the stored unit', () => {
    render(<BodyStats body={body} units="mm" />);
    expect(screen.getByText(/25\.4 × 50\.8 × 76\.2 mm/)).toBeVisible();
  });
});

function feature(
  data: Partial<FeatureData> & Pick<FeatureData, 'featureKind'>
) {
  return { data } as unknown as FeatureNode;
}

describe('History row values', () => {
  it('read lengths in the display unit and leave angles and counts', () => {
    const box = feature({
      featureKind: 'primitive',
      primitiveKind: 'box',
      dimensions: { width: 25.4, height: 50.8, depth: 76.2 }
    });
    expect(featureValueSummary(box, {}, 'mm', undefined, 'inch')).toBe(
      '1 × 2 × 3 in'
    );
    const chamfer = feature({
      featureKind: 'chamfer',
      distance: 25.4,
      angleDeg: 45,
      edgeHashes: [1]
    } as never);
    expect(featureValueSummary(chamfer, {}, 'mm', undefined, 'inch')).toContain(
      '1 in × 45°'
    );
    const pattern = feature({
      featureKind: 'pattern',
      patternKind: 'linear',
      count: 4,
      spacingMode: 'total',
      spacing: 101.6
    } as never);
    expect(featureValueSummary(pattern, {}, 'mm', undefined, 'inch')).toBe(
      '× 4 over 4 in'
    );
    const corners = feature({
      featureKind: 'fillet',
      radius: 1,
      edgeHashes: [1],
      vertexRadii: [{ radius: 12.7 }, { radius: 25.4 }]
    } as never);
    expect(featureValueSummary(corners, {}, 'mm', undefined, 'inch')).toContain(
      'R 0.5–1 in by corner'
    );
    // Without a display unit, the stored one, exactly as before.
    expect(featureValueSummary(box, {}, 'mm')).toBe('25.4 × 50.8 × 76.2 mm');
  });
});

function lengthParameter(): ParameterNode {
  return {
    id: 'node_width',
    parentId: null,
    revisionId: null,
    kind: 'parameter',
    parameterId: 'parameter_width',
    name: 'width',
    expression: '50.8',
    value: 50.8,
    quantity: 'length'
  } as unknown as ParameterNode;
}

describe('the parameter table', () => {
  it('shows a length parameter converted, its expression as stored', () => {
    const { container } = render(
      <DisplayUnitsProvider units="inch">
        <ParameterRow
          parameter={lengthParameter()}
          value={50.8}
          units="mm"
          minimum={25.4}
          onSet={vi.fn()}
        />
      </DisplayUnitsProvider>
    );
    expect(container.querySelector('.param-value')?.textContent).toContain(
      '2 in'
    );
    expect(screen.getByText('Minimum 1 in')).toBeVisible();
  });

  it('leaves a unitless parameter as a bare number', () => {
    const { container } = render(
      <DisplayUnitsProvider units="inch">
        <ParameterRow
          parameter={{
            ...lengthParameter(),
            quantity: undefined,
            expression: 'n * 2'
          }}
          value={6}
          units="mm"
          onSet={vi.fn()}
        />
      </DisplayUnitsProvider>
    );
    expect(container.querySelector('.param-value')?.textContent).toBe('6');
  });
});

describe('the viewport rule', () => {
  it('chooses a round step in the display unit', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform() {},
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {}
    } as unknown as CanvasRenderingContext2D);
    const sinkRef: MutableRefObject<ViewportScaleSink | null> = {
      current: null
    };
    render(
      <DisplayUnitsProvider units="inch">
        <ViewportScaleIndicator scaleSinkRef={sinkRef} units="mm" />
      </DisplayUnitsProvider>
    );
    // 50 mm over 100 px: 200 px hold 3.94 in, so the rule reads 2 in.
    act(() => sinkRef.current?.({ value: 50, widthPx: 100 }));
    const output = screen
      .getByTestId('viewport-scale-indicator')
      .querySelector('output');
    expect(output?.textContent).toBe('2 in');
  });
});

describe('face offsets converted into a small display unit', () => {
  // −2 mm shown in metres: hundredths read it as +0 m (review #1936).
  it('keeps their size and sign', () => {
    const chip = {
      mode: 'offset' as const,
      span: null,
      sense: 1,
      units: 'm'
    };
    expect(offsetChipText({ ...chip, rawValue: -0.002, precise: true })).toBe(
      '-0.002 m'
    );
    expect(offsetFaceCommitMessage(-0.002, 'm', null, true)).toBe(
      'Offset face by -0.002 m.'
    );
    expect(offsetLimitChipText({ ...chip, limit: 0.0064, precise: true })).toBe(
      'max 0.0064 m'
    );
    // Total keeps its significant figures too.
    expect(
      offsetChipText({
        ...chip,
        mode: 'total',
        span: 0.024,
        rawValue: 0.0005,
        precise: true
      })
    ).toBe('0.0245 m');
  });

  it('round to hundredths as always without a conversion', () => {
    const chip = { mode: 'offset' as const, span: null, sense: 1, units: 'mm' };
    expect(offsetChipText({ ...chip, rawValue: 10.254 })).toBe('+10.25 mm');
    expect(offsetFaceCommitMessage(10.254, 'mm')).toBe(
      'Offset face by +10.25 mm.'
    );
  });
});
