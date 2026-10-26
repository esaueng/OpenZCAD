import { describe, expect, it } from 'vitest';
import type { BodyId, TopologySelection } from '@openzcad/shared';
import { deleteKeyRemovesFeature } from './selectionFeature';

const bodyId = 'body-1' as BodyId;
const face: TopologySelection = { bodyId, kind: 'face', topologyId: 'f1' };
const body: TopologySelection = { bodyId, kind: 'body' };

describe('deleteKeyRemovesFeature', () => {
  it('deletes a History row feature', () => {
    expect(
      deleteKeyRemovesFeature({
        source: 'pinned',
        topology: null,
        edgeCount: 0
      })
    ).toBe(true);
  });

  it('deletes the feature that defines a picked face or edge', () => {
    expect(
      deleteKeyRemovesFeature({
        source: 'inferred',
        topology: face,
        edgeCount: 0
      })
    ).toBe(true);
    expect(
      deleteKeyRemovesFeature({
        source: 'inferred',
        topology: null,
        edgeCount: 2
      })
    ).toBe(true);
  });

  it('leaves a body pick and an empty selection alone', () => {
    expect(
      deleteKeyRemovesFeature({
        source: 'inferred',
        topology: body,
        edgeCount: 0
      })
    ).toBe(false);
    expect(
      deleteKeyRemovesFeature({
        source: 'inferred',
        topology: null,
        edgeCount: 0
      })
    ).toBe(false);
    expect(
      deleteKeyRemovesFeature({ source: null, topology: face, edgeCount: 0 })
    ).toBe(false);
  });
});
