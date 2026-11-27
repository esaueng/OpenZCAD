import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BodyId, ProjectDocument, Vector3 } from '@openzcad/shared';
import {
  useInPlaceCommand,
  type UseInPlaceCommandOptions
} from './useInPlaceCommand';
import type { BodyPick, InPlaceRequest } from '../lib/inPlace/tools';
import type { PlaneEdgePick } from '../lib/inPlace/splitEdgePlane';
import { SPLIT_EDGE_PLANE_SENTENCES } from '../lib/refusalLanguage';

/**
 * M11 (owner decision D2): Split's plane picked as two straight edges in the
 * in-place command. The pair resolves once into Split's numeric plane; a
 * pair with no single plane is refused by its own code with the edges kept.
 */
const BLOCK = 'body_block' as BodyId;
const OTHER = 'body_other' as BodyId;

function setup() {
  const commit = vi.fn<(request: InPlaceRequest, title: string) => void>();
  const built: InPlaceRequest[] = [];
  const document = {
    derived: {
      bodyRepresentations: { [BLOCK]: {}, [OTHER]: {} },
      warnings: []
    }
  } as unknown as ProjectDocument;
  const options: UseInPlaceCommandOptions = {
    sketchViews: [],
    datumAxes: undefined,
    datumLabel: () => 'Axis',
    baseDocument: () => document,
    derive: async (next) => next.derived,
    buildCommand: (request) => {
      built.push(request);
      return {
        validate: () => undefined,
        apply: (next) => next,
        resultBodyId: BLOCK
      };
    },
    commit,
    publishPreview: vi.fn(),
    onStatus: vi.fn(),
    liveBodyIds: () => [BLOCK, OTHER]
  };
  const hook = renderHook(() => useInPlaceCommand(options));
  return { hook, commit, built };
}

const v = (x: number, y: number, z: number): Vector3 => ({ x, y, z });
const BODY: BodyPick = { bodyId: BLOCK, min: v(0, 0, 0), max: v(20, 20, 20) };
const edge = (
  bodyId: BodyId,
  hash: number,
  from: Vector3,
  to: Vector3
): PlaneEdgePick => ({ bodyId, hash, ends: [from, to] });

/** The 20 mm block's bottom edge at x = 20 and top edge at x = 0. */
const bottom = edge(BLOCK, 1, v(20, 0, 0), v(20, 20, 0));
const top = edge(BLOCK, 2, v(0, 0, 20), v(0, 20, 20));
/** The block's top edge along x at y = 0: skew to `bottom`. */
const across = edge(BLOCK, 3, v(0, 0, 20), v(20, 0, 20));
/** Another body's edge on the line of `bottom`. */
const inLine = edge(OTHER, 7, v(20, 30, 0), v(20, 40, 0));
const S = String(Math.SQRT1_2);

function splitValue(request: InPlaceRequest | undefined) {
  if (request?.tool !== 'modeling' || request.state.operation !== 'split') {
    throw new Error('not a Split request');
  }
  return request.state.value;
}

describe('Split plane through two edges in the in-place command', () => {
  it('takes two edges as the plane, previews, and commits its numbers', async () => {
    const { hook, commit, built } = setup();
    act(() => hook.result.current.start('split', [], [], [BODY]));
    expect(hook.result.current.hint).toBe(
      'Pick a plane or flat face, or two straight edges'
    );
    act(() => {
      expect(hook.result.current.pickPlaneEdge(bottom)).toBe(true);
    });
    expect(hook.result.current.slots.planeEdges).toEqual([bottom]);
    expect(hook.result.current.slots.plane).toBeNull();
    expect(hook.result.current.request).toBeNull();
    expect(hook.result.current.hint).toBe(
      'Pick a second edge for the plane (a straight one)'
    );
    act(() => {
      hook.result.current.pickPlaneEdge(top);
    });
    expect(hook.result.current.refusal).toBeNull();
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    // The plane x + z = 20, through the first edge's middle, as numbers.
    expect(splitValue(built.at(-1))).toMatchObject({
      targetBodyId: BLOCK,
      origin: { x: '20', y: '10', z: '0' },
      normal: { x: S, y: '0', z: S }
    });
    act(() => {
      expect(hook.result.current.done()).toBe(true);
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(JSON.stringify(commit.mock.calls[0]![0])).not.toMatch(/edge/i);
  });

  it('slides the picked pair’s plane along its canonical normal', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('split', [], [], [BODY]));
    act(() => {
      hook.result.current.pickPlaneEdge(top);
    });
    act(() => {
      hook.result.current.pickPlaneEdge(bottom);
    });
    act(() => {
      hook.result.current.setValue('offset', 2);
    });
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const value = splitValue(built.at(-1));
    // The first edge's middle (0, 10, 20), slid 2 along (1, 0, 1)/√2.
    expect(Number(value.origin.x)).toBeCloseTo(Math.SQRT2, 12);
    expect(Number(value.origin.z)).toBeCloseTo(20 + Math.SQRT2, 12);
    expect(value.normal).toEqual({ x: S, y: '0', z: S });
  });

  it.each([
    ['collinear', inLine],
    ['skew', across]
  ] as const)(
    'refuses a %s pair by its code, keeps both edges, and takes a re-pick',
    async (code, second) => {
      const { hook } = setup();
      act(() => hook.result.current.start('split', [], [], [BODY]));
      act(() => {
        hook.result.current.pickPlaneEdge(bottom);
      });
      act(() => {
        hook.result.current.pickPlaneEdge(second);
      });
      expect(hook.result.current.refusal).toBe(
        SPLIT_EDGE_PLANE_SENTENCES[code]
      );
      expect(hook.result.current.refusalInput).toBe('Plane');
      expect(hook.result.current.refusalClassification).toBeNull();
      expect(hook.result.current.slots.planeEdges).toEqual([bottom, second]);
      expect(hook.result.current.request).toBeNull();
      expect(hook.result.current.canFinish).toBe(false);
      act(() => {
        expect(hook.result.current.done()).toBe(false);
      });
      // The next edge replaces the second: the first is kept.
      act(() => {
        hook.result.current.pickPlaneEdge(top);
      });
      expect(hook.result.current.refusal).toBeNull();
      expect(hook.result.current.slots.planeEdges).toEqual([bottom, top]);
      await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    }
  );

  it('refuses a curved edge and changes nothing else', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('split', [], [], [BODY]));
    act(() => {
      hook.result.current.pickPlaneEdge(bottom);
    });
    act(() => {
      hook.result.current.pickPlaneEdge({ refused: 'curved-edge' });
    });
    expect(hook.result.current.refusal).toBe(
      SPLIT_EDGE_PLANE_SENTENCES['curved-edge']
    );
    expect(hook.result.current.slots.planeEdges).toEqual([bottom]);
    act(() => {
      hook.result.current.pickPlaneEdge(top);
    });
    expect(hook.result.current.refusal).toBeNull();
    expect(hook.result.current.slots.plane).not.toBeNull();
  });

  it('takes a held edge back out, and lets go of the edges for a face plane', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('split', [], [], [BODY]));
    act(() => {
      hook.result.current.pickPlaneEdge(bottom);
    });
    act(() => {
      hook.result.current.pickPlaneEdge(top);
    });
    act(() => {
      hook.result.current.pickPlaneEdge(top);
    });
    expect(hook.result.current.slots.planeEdges).toEqual([bottom]);
    expect(hook.result.current.slots.plane).toBeNull();
    act(() => {
      hook.result.current.pickPlane({
        kind: 'face',
        origin: v(10, 10, 20),
        normal: v(0, 0, 1)
      });
    });
    expect(hook.result.current.slots.planeEdges).toBeUndefined();
    expect(hook.result.current.slots.plane?.kind).toBe('face');
  });

  it('takes no edge before the body, nor in Mirror', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('split'));
    act(() => {
      expect(hook.result.current.pickPlaneEdge(bottom)).toBe(false);
    });
    act(() => hook.result.current.start('mirror', [], [], [BODY]));
    act(() => {
      expect(hook.result.current.pickPlaneEdge(bottom)).toBe(false);
    });
  });
});
