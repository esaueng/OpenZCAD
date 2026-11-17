import { describe, expect, it } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import { loneBodyFor } from './loneBody';

const body = (bodyId: string, consumed = false) => ({
  bodyId: bodyId as BodyId,
  consumed
});

describe('the body a command starts on when the model has one', () => {
  it('is the only live body, for every command that takes one body', () => {
    // 13 November review: Move took the lone body while Scale, Mirror,
    // Split, Solid offset and the patterns said "Click the body to …".
    const bodies = { a: body('a'), gone: body('gone', true) };
    for (const tool of [
      'scale',
      'mirror',
      'split',
      'axis-rotate',
      'solid-offset',
      'linear-pattern',
      'circular-pattern',
      'grid-pattern'
    ] as const) {
      expect(loneBodyFor(tool, bodies, new Set())).toBe('a');
    }
  });

  it('is nobody where there is a choice, nothing, or no single body to take', () => {
    expect(
      loneBodyFor('scale', { a: body('a'), b: body('b') }, new Set())
    ).toBeNull();
    expect(
      loneBodyFor('scale', { a: body('a'), b: body('b') }, new Set(['b']))
    ).toBe('a');
    expect(loneBodyFor('scale', {}, new Set())).toBeNull();
    // A boolean takes several bodies; a fillet takes edges.
    expect(loneBodyFor('union', { a: body('a') }, new Set())).toBeNull();
    expect(loneBodyFor('fillet', { a: body('a') }, new Set())).toBeNull();
  });
});
