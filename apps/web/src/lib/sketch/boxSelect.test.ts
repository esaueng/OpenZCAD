import { describe, expect, it } from 'vitest';
import { sketchObjectsInBox } from './boxSelect';

const rect = { left: 0, top: 0, right: 100, bottom: 100 };
const outlines = [
  {
    id: 'inside',
    runs: [
      [
        { x: 10, y: 10 },
        { x: 50, y: 60 }
      ]
    ]
  },
  // Crosses the right edge.
  {
    id: 'straddles',
    runs: [
      [
        { x: 90, y: 50 },
        { x: 150, y: 50 }
      ]
    ]
  },
  // Passes through the box with both ends outside it.
  {
    id: 'through',
    runs: [
      [
        { x: -20, y: 30 },
        { x: 140, y: 30 }
      ]
    ]
  },
  {
    id: 'outside',
    runs: [
      [
        { x: 120, y: 120 },
        { x: 160, y: 130 }
      ]
    ]
  },
  { id: 'point', runs: [[{ x: 40, y: 40 }]] },
  {
    id: 'two-runs',
    runs: [
      [
        { x: 5, y: 5 },
        { x: 20, y: 5 }
      ],
      [
        { x: 30, y: 30 },
        { x: 130, y: 30 }
      ]
    ]
  }
];

describe('sketchObjectsInBox', () => {
  it('takes only what a window wholly contains', () => {
    expect(sketchObjectsInBox(outlines, rect, 'window')).toEqual([
      'inside',
      'point'
    ]);
  });

  it('takes whatever a crossing touches, even with both ends outside', () => {
    expect(sketchObjectsInBox(outlines, rect, 'crossing')).toEqual([
      'inside',
      'straddles',
      'through',
      'point',
      'two-runs'
    ]);
  });

  it('skips an entity with nothing drawn', () => {
    expect(
      sketchObjectsInBox([{ id: 'empty', runs: [] }], rect, 'crossing')
    ).toEqual([]);
  });
});
