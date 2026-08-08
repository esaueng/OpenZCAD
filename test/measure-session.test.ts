import { describe, expect, it } from 'vitest';
import type { BodyId, TopologySelection } from '@openzcad/shared';
import {
  edgeRunIsTotalable,
  nextEdgeRun
} from '../apps/web/src/lib/measureSession';

/**
 * The accumulation rules the measure tool used to borrow from the workspace's
 * selection, now owned outright and testable without a viewport.
 */

function edge(id: string, body = 'body-1'): TopologySelection {
  return {
    bodyId: body as BodyId,
    kind: 'edge',
    topologyId: `edge:${id}`,
    hash: Number(id.replace(/\D/g, '')) || 1
  };
}

function face(id: string): TopologySelection {
  return {
    bodyId: 'body-1' as BodyId,
    kind: 'face',
    topologyId: `face:${id}`,
    hash: 99
  };
}

const ids = (run: readonly TopologySelection[]) =>
  run.map((entry) => entry.topologyId);

describe('the running edge set', () => {
  it('replaces on a plain pick', () => {
    const run = nextEdgeRun([edge('1'), edge('2')], edge('3'), false);
    expect(ids(run)).toEqual(['edge:3']);
  });

  it('extends on an additive pick', () => {
    let run = nextEdgeRun([], edge('1'), false);
    run = nextEdgeRun(run, edge('2'), true);
    run = nextEdgeRun(run, edge('3'), true);
    expect(ids(run)).toEqual(['edge:1', 'edge:2', 'edge:3']);
  });

  it('toggles an edge already in the run', () => {
    // A Shift+Click that only ever adds forces someone to clear the whole run
    // to undo one mis-click.
    let run = [edge('1'), edge('2'), edge('3')];
    run = [...nextEdgeRun(run, edge('2'), true)];
    expect(ids(run)).toEqual(['edge:1', 'edge:3']);
    run = [...nextEdgeRun(run, edge('2'), true)];
    expect(ids(run)).toEqual(['edge:1', 'edge:3', 'edge:2']);
  });

  it('starts over when the pick lands on a different body', () => {
    // An edge total spanning two bodies describes no single part. Restarting
    // where the user is now looking beats producing a number with no referent.
    const run = nextEdgeRun([edge('1'), edge('2')], edge('9', 'body-2'), true);
    expect(ids(run)).toEqual(['edge:9']);
    expect(run[0]?.bodyId).toBe('body-2');
  });

  it('does not confuse equal topology ids on different bodies', () => {
    // Two bodies from the same feature can carry the same topologyId. Matching
    // on it alone would make a toggle on one silently remove the other.
    const run = nextEdgeRun([edge('1', 'body-1')], edge('1', 'body-2'), true);
    expect(ids(run)).toEqual(['edge:1']);
    expect(run[0]?.bodyId).toBe('body-2');
  });

  it('ignores anything that is not an edge', () => {
    const run = [edge('1'), edge('2')];
    expect(nextEdgeRun(run, face('top'), true)).toBe(run);
    expect(nextEdgeRun(run, face('top'), false)).toBe(run);
  });

  it('needs two edges before there is a total to show', () => {
    expect(edgeRunIsTotalable([])).toBe(false);
    expect(edgeRunIsTotalable([edge('1')])).toBe(false);
    expect(edgeRunIsTotalable([edge('1'), edge('2')])).toBe(true);
  });
});
