import { describe, expect, it } from 'vitest';
import { regionsOutsideHoles } from './extrudePreselect';

const square = (half: number) => [
  { x: -half, y: -half },
  { x: half, y: -half },
  { x: half, y: half },
  { x: -half, y: half }
];

describe('regionsOutsideHoles (I42)', () => {
  it('leaves out a region that fills another region’s hole', () => {
    const plate = {
      id: 'plate',
      samplePoint: { x: 8, y: 0 },
      holes: [square(4)]
    };
    const hole = { id: 'hole', samplePoint: { x: 0, y: 0 }, holes: [] };
    expect(regionsOutsideHoles([plate, hole]).map(({ id }) => id)).toEqual([
      'plate'
    ]);
  });

  it('takes an island inside a hole, and side-by-side regions together', () => {
    const plate = {
      id: 'plate',
      samplePoint: { x: 9, y: 0 },
      holes: [square(6)]
    };
    const ring = {
      id: 'ring',
      samplePoint: { x: 5, y: 0 },
      holes: [square(3)]
    };
    const island = { id: 'island', samplePoint: { x: 0, y: 0 }, holes: [] };
    const beside = { id: 'beside', samplePoint: { x: 30, y: 0 }, holes: [] };
    expect(
      regionsOutsideHoles([plate, ring, island, beside]).map(({ id }) => id)
    ).toEqual(['plate', 'island', 'beside']);
  });

  it('keeps every region when none is outside a hole', () => {
    const only = { id: 'only', samplePoint: { x: 0, y: 0 }, holes: [] };
    expect(regionsOutsideHoles([only])).toEqual([only]);
  });
});
