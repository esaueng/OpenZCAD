import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { toBodyId } from '@openzcad/shared';
import type { TopologySelection } from '@openzcad/shared';
import {
  demandedBodiesForInteraction,
  demandedBodiesForSelections,
  lineageDemandKey,
  mergeLineageDemand,
  normalizeLineageDemand,
  useLineageDemand
} from './lineageDemand';
import { IDLE } from './interaction/machine';

const bodyA = toBodyId('body_a');
const bodyB = toBodyId('body_b');

function edgeOn(bodyId: typeof bodyA, hash = 11): TopologySelection {
  return { bodyId, kind: 'edge', hash };
}

function faceOn(bodyId: typeof bodyA, hash = 21): TopologySelection {
  return { bodyId, kind: 'face', hash };
}

describe('lineageDemand helpers', () => {
  it('normalizes sticky demand: sorted, deduped, empty-safe', () => {
    expect(normalizeLineageDemand(undefined)).toEqual([]);
    expect(normalizeLineageDemand([])).toEqual([]);
    expect(normalizeLineageDemand([bodyB, bodyA, bodyB])).toEqual([
      bodyA,
      bodyB
    ]);
    expect(lineageDemandKey([bodyB, bodyA])).toBe(
      lineageDemandKey([bodyA, bodyB])
    );
    expect(lineageDemandKey([])).toBe('[]');
  });

  it('demands the picked body for face/edge/vertex topology', () => {
    expect(demandedBodiesForSelections(edgeOn(bodyA))).toEqual([bodyA]);
    expect(demandedBodiesForSelections(faceOn(bodyB))).toEqual([bodyB]);
    expect(
      demandedBodiesForSelections([
        edgeOn(bodyA, 11),
        faceOn(bodyA, 21)
      ])
    ).toEqual([bodyA]);
    expect(
      demandedBodiesForSelections({ bodyId: bodyA, kind: 'body' })
    ).toEqual([]);
    expect(demandedBodiesForSelections(null)).toEqual([]);
  });

  it('demands command bodies from interaction state', () => {
    expect(demandedBodiesForInteraction(IDLE)).toEqual([]);
    expect(
      demandedBodiesForInteraction({
        mode: 'edges',
        edges: [edgeOn(bodyA, 1), edgeOn(bodyA, 2)],
        op: 'fillet',
        phase: 'armed',
        lastValue: null,
        error: null
      })
    ).toEqual([bodyA]);
  });

  it('merges without shrinking', () => {
    const merged = mergeLineageDemand(new Set([bodyA]), [bodyB]);
    expect([...merged].sort()).toEqual([bodyA, bodyB]);
    expect(mergeLineageDemand(merged, []).size).toBe(2);
  });
});

describe('useLineageDemand', () => {
  it('stays sticky and clears on document change', () => {
    const { result, rerender } = renderHook(
      ({ projectId, selections }) =>
        useLineageDemand({ projectId, selections, interaction: IDLE }),
      {
        initialProps: {
          projectId: 'project-1',
          selections: [] as TopologySelection[]
        }
      }
    );
    expect(result.current.demand).toEqual([]);

    rerender({
      projectId: 'project-1',
      selections: [edgeOn(bodyA)]
    });
    expect(result.current.demand).toEqual([bodyA]);

    // Never shrinks while the document is open.
    rerender({ projectId: 'project-1', selections: [] });
    expect(result.current.demand).toEqual([bodyA]);

    // Grows monotonically.
    rerender({
      projectId: 'project-1',
      selections: [faceOn(bodyB)]
    });
    expect(result.current.demand).toEqual([bodyA, bodyB].sort());

    // Clears when the open document changes.
    rerender({ projectId: 'project-2', selections: [] });
    expect(result.current.demand).toEqual([]);

    act(() => {
      result.current.addBodies([bodyB]);
    });
    expect(result.current.demand).toEqual([bodyB]);
  });
});
