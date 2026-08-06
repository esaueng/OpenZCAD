import { describe, expect, it } from 'vitest';
import {
  appendMeasurement,
  measurementsToCsv,
  measurementsToText,
  MEASUREMENT_LIMIT,
  type Measurement
} from '../apps/web/src/lib/measurements';

function edge(index: number, value = `${index * 10} mm`): Measurement {
  return {
    key: `edge:body/${index}`,
    kind: 'edge',
    label: `Bracket · Edge ${index}`,
    value
  };
}

describe('measurement tape', () => {
  it('appends each new entity in pick order', () => {
    const list = [edge(1), edge(2)].reduce(
      appendMeasurement,
      [] as Measurement[]
    );
    expect(list.map((entry) => entry.label)).toEqual([
      'Bracket · Edge 1',
      'Bracket · Edge 2'
    ]);
  });

  it('does not duplicate a re-picked entity', () => {
    // Clicking an edge again to look at it is normal; a second identical row
    // for it is not.
    const once = appendMeasurement([], edge(1));
    const twice = appendMeasurement(once, edge(1));
    expect(twice).toHaveLength(1);
    // Unchanged means the same reference, which is what lets the capture
    // effect run on every render without causing one.
    expect(twice).toBe(once);
  });

  it('updates a row in place when the same entity measures differently', () => {
    // A rebuild that resizes the edge should correct the tape, not extend it.
    const list = appendMeasurement(
      [edge(1, '84 mm'), edge(2, '20 mm')].reduce(
        appendMeasurement,
        [] as Measurement[]
      ),
      edge(1, '90 mm')
    );
    expect(list).toHaveLength(2);
    expect(list[0]?.value).toBe('90 mm');
    expect(list[1]?.value).toBe('20 mm');
  });

  it('drops the oldest rows past the limit', () => {
    let list: Measurement[] = [];
    for (let index = 0; index < MEASUREMENT_LIMIT + 5; index += 1) {
      list = appendMeasurement(list, edge(index));
    }
    expect(list).toHaveLength(MEASUREMENT_LIMIT);
    expect(list[0]?.label).toBe('Bracket · Edge 5');
  });

  it('copies as tab-separated rows', () => {
    const list = [
      edge(1, '84 mm'),
      {
        key: 'body:b1',
        kind: 'body' as const,
        label: 'Bracket',
        value: '84 × 60 × 35 mm',
        note: '14.21 mm³'
      }
    ];
    expect(measurementsToText(list)).toBe(
      'Bracket · Edge 1\t84 mm\nBracket\t84 × 60 × 35 mm\t14.21 mm³'
    );
  });

  it('quotes CSV cells that would otherwise break the row', () => {
    const list: Measurement[] = [
      {
        key: 'edge:b1/1',
        kind: 'edge',
        label: 'Plate, left · Edge "A"',
        value: '84 mm'
      }
    ];
    const [header, row] = measurementsToCsv(list).split('\n');
    expect(header).toBe('kind,label,value,note');
    expect(row).toBe('edge,"Plate, left · Edge ""A""",84 mm,');
  });
});
