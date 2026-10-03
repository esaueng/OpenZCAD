import { describe, expect, it } from 'vitest';
import { editCardFeatureId } from './editCardLifecycle';

describe('editCardFeatureId', () => {
  it('names the Inspector card while no tool runs', () => {
    expect(
      editCardFeatureId({
        tool: null,
        inspectorFeatureId: 'box',
        modelingEditFeatureId: null
      })
    ).toBe('box');
  });

  it('names the reopened modeling form while its tool runs', () => {
    expect(
      editCardFeatureId({
        tool: 'hole',
        inspectorFeatureId: 'hole',
        modelingEditFeatureId: 'hole'
      })
    ).toBe('hole');
  });

  it('names nothing under a create card, so a late edit Apply cannot close it', () => {
    // A Box edit still validating when the user starts a Hole must not close
    // the Hole create card it lands on.
    expect(
      editCardFeatureId({
        tool: 'hole',
        inspectorFeatureId: 'box',
        modelingEditFeatureId: null
      })
    ).toBeNull();
    expect(
      editCardFeatureId({
        tool: 'box',
        inspectorFeatureId: 'box',
        modelingEditFeatureId: null
      })
    ).toBeNull();
  });
});
