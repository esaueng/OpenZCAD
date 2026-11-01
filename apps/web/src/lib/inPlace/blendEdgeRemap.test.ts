import { describe, expect, it } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import { remappedBlendEdge } from './blendEdgeRemap';
import type { EdgePick } from './tools';

const target = 'body_input' as BodyId;

describe('remapped blend edge', () => {
  it('keeps an unblended edge found on the input', () => {
    const onInput = { bodyId: target, hash: 7, topologyId: 'e7' } as EdgePick;
    expect(remappedBlendEdge(onInput, target, 7, true)).toBe(onInput);
  });

  it('refuses an edge the blend reshaped instead of storing a pick the refresh drops', () => {
    // Regression: the result body's hash was stored on the input body, the
    // pick refresh found no such edge, removed it, and said a saved pick no
    // longer existed.
    expect(remappedBlendEdge(null, target, 99, true)).toBe('reshaped');
  });

  it('leaves the hash to the validated commit when the input topology is unknown', () => {
    expect(remappedBlendEdge(null, target, 99, false)).toEqual({
      bodyId: target,
      hash: 99,
      topologyId: ''
    });
    expect(remappedBlendEdge(null, target, undefined, false)).toBeNull();
  });
});
