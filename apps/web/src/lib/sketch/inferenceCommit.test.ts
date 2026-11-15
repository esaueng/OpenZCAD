import { describe, expect, it } from 'vitest';
import { drawingSessionStillOpen } from './inferenceCommit';

const XY = { type: 'canonical', plane: 'XY', offset: 0 };
const YZ = { type: 'canonical', plane: 'YZ', offset: 0 };

describe('drawingSessionStillOpen (review #1555)', () => {
  it('lets a commit land only in the sketch it was planned in', () => {
    const planned = { sketchId: 'sk1', plane: XY };
    expect(
      drawingSessionStillOpen(planned, {
        mode: 'sketch',
        session: { sketchId: 'sk1', plane: XY }
      })
    ).toBe(true);
    // Left the sketch while the relations were settled.
    expect(drawingSessionStillOpen(planned, { mode: 'idle' })).toBe(false);
    // Another sketch opened meanwhile.
    expect(
      drawingSessionStillOpen(planned, {
        mode: 'sketch',
        session: { sketchId: 'sk2', plane: XY }
      })
    ).toBe(false);
  });

  it('accepts a just-started sketch the session has not learned yet, on its plane', () => {
    expect(
      drawingSessionStillOpen(
        { sketchId: 'sk1', plane: XY },
        { mode: 'sketch', session: { sketchId: null, plane: XY } }
      )
    ).toBe(true);
    expect(
      drawingSessionStillOpen(
        { sketchId: null, plane: XY },
        { mode: 'sketch', session: { sketchId: null, plane: YZ } }
      )
    ).toBe(false);
  });
});
