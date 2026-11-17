import { describe, expect, it } from 'vitest';
import { drawingSessionStillOpen } from './inferenceCommit';

const XY = { type: 'canonical', plane: 'XY', offset: 0 };
const YZ = { type: 'canonical', plane: 'YZ', offset: 0 };
const sketch = (sketchId: string | null, plane: unknown) => ({
  mode: 'sketch' as const,
  session: { sketchId, plane }
});

describe('drawingSessionStillOpen (review #1555)', () => {
  it('lets a commit land only in the sketch it was planned in', () => {
    const planned = { sketchId: 'sk1', plane: XY, generation: 3 };
    expect(drawingSessionStillOpen(planned, sketch('sk1', XY), 3)).toBe(true);
    // Left the sketch while the relations were settled.
    expect(drawingSessionStillOpen(planned, { mode: 'idle' }, 3)).toBe(false);
    // Another sketch opened meanwhile.
    expect(drawingSessionStillOpen(planned, sketch('sk2', XY), 3)).toBe(false);
  });

  it('accepts a just-started sketch the session has not learned yet, on its plane', () => {
    expect(
      drawingSessionStillOpen(
        { sketchId: 'sk1', plane: XY, generation: 3 },
        sketch(null, XY),
        3
      )
    ).toBe(true);
    expect(
      drawingSessionStillOpen(
        { sketchId: null, plane: XY, generation: 3 },
        sketch(null, YZ),
        3
      )
    ).toBe(false);
  });

  it('refuses a new session on the same plane after the sketch was left (re-check #1555)', () => {
    // Sketch A was left while its commit settled; a fresh sketch opened on
    // the same plane has no id yet, but it is a later session.
    expect(
      drawingSessionStillOpen(
        { sketchId: 'skA', plane: XY, generation: 3 },
        sketch(null, XY),
        4
      )
    ).toBe(false);
  });
});
