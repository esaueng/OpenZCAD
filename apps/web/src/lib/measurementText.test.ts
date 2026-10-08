import { describe, expect, it } from 'vitest';
import {
  formatMeasurement,
  measurementToViewportAnnotation,
  measurementsToCsv,
  measurementsToText,
  type Measurement,
  type MeasurementDisplayOptions
} from './measurements';

const DISPLAY: MeasurementDisplayOptions = {
  unit: 'mm',
  precision: 2,
  radialDisplay: 'diameter'
};

const target = {
  bodyId: 'b1' as Measurement['targets'][number]['bodyId'],
  bodyName: 'Bracket',
  kind: 'body' as const,
  label: 'Bracket',
  semantic: 'body-center' as const,
  quality: 'exact-kernel' as const
};

function row(overrides: Partial<Measurement>): Measurement {
  return {
    id: 'm1',
    kind: 'angle',
    label: 'Bracket · Angle',
    targets: [target],
    result: { value: 90, dimension: 'angle' },
    quality: 'exact-analytic',
    status: 'current',
    sourceRevision: 1,
    sourceUnit: 'mm',
    visible: true,
    annotation: { anchor: { x: 0, y: 0, z: 0 }, segments: [] },
    ...overrides
  };
}

const angle = row({});
const body = row({
  id: 'm2',
  kind: 'body',
  label: 'Bracket',
  result: {
    value: 12960,
    dimension: 'volume',
    components: { x: 30, y: 18, z: 24 }
  },
  quality: 'exact-kernel'
});

describe('measurement text on screen and on the clipboard', () => {
  it('sets the degree sign on its number on screen, as every other angle does', () => {
    expect(formatMeasurement(angle, DISPLAY).value).toBe('90.00°');
    expect(measurementToViewportAnnotation(angle, DISPLAY, false)?.label).toBe(
      '90.00°'
    );
  });

  it('keeps a body size unit on the last number’s line on screen', () => {
    expect(formatMeasurement(body, DISPLAY).value).toBe(
      '30.00 × 18.00 × 24.00\u00a0mm'
    );
  });

  it('leaves the copied rows and the CSV exactly as they were', () => {
    const copied = measurementsToText([angle, body], DISPLAY);
    expect(copied).toContain('Bracket · Angle\t90.00 °\t');
    expect(copied).toContain('Bracket\t30.00 × 18.00 × 24.00 mm\t');
    expect(copied).not.toContain('\u00a0');
    expect(measurementsToCsv([angle], DISPLAY).split('\n')[1]).toContain(
      ',90,°,'
    );
  });
});
