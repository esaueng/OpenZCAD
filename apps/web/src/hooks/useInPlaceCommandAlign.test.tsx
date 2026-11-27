import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import {
  useInPlaceCommand,
  type UseInPlaceCommandOptions
} from './useInPlaceCommand';
import { FACE_ALIGN_REFUSALS } from '../lib/inPlace/faceAlign';
import type { FacePick, InPlaceRequest } from '../lib/inPlace/tools';

/**
 * M10 (slice 5b): Align's two ordered face picks in the in-place command:
 * the moving face, then a target on another body; preview, Done, and the
 * typed refusals a click gets.
 */
const MOVING = 'body_moving' as BodyId;
const TARGET = 'body_target' as BodyId;

function setup() {
  const commit = vi.fn<(request: InPlaceRequest, title: string) => void>();
  const onStatus = vi.fn();
  const built: InPlaceRequest[] = [];
  const document = {
    derived: {
      bodyRepresentations: { [MOVING]: {}, [TARGET]: {} },
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
        resultBodyId: MOVING
      };
    },
    commit,
    publishPreview: vi.fn(),
    onStatus,
    liveBodyIds: () => [MOVING, TARGET]
  };
  const hook = renderHook(() => useInPlaceCommand(options));
  return { hook, commit, onStatus, built };
}

const face = (
  bodyId: BodyId,
  hash: number,
  z: number,
  normalZ: 1 | -1,
  surfaceType = 'Plane'
): FacePick => ({
  bodyId,
  hash,
  topologyId: `f${hash}`,
  surfaceType,
  normal: { x: 0, y: 0, z: normalZ },
  centroid: { x: 2, y: 3, z }
});

const bottom = face(MOVING, 1, 20, -1);
const top = face(TARGET, 2, 10, 1);

describe('Align in the in-place command', () => {
  it('takes the moving face, then the target, previews the Move and commits it', async () => {
    const { hook, commit, built } = setup();
    act(() => hook.result.current.start('align'));
    expect(hook.result.current.hint).toMatch(/body to move/);
    act(() => {
      hook.result.current.pickFace(bottom);
    });
    expect(hook.result.current.hint).toMatch(/target/);
    act(() => {
      hook.result.current.pickFace(top);
    });
    expect(hook.result.current.slots.faces.map((f) => f.hash)).toEqual([1, 2]);
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    expect(built.at(-1)).toEqual({
      tool: 'transform',
      targetBodyId: MOVING,
      translation: { x: 0, y: 0, z: -10 }
    });
    act(() => {
      expect(hook.result.current.done()).toBe(true);
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]![0]).toMatchObject({
      tool: 'transform',
      targetBodyId: MOVING
    });
  });

  it('refuses a target on the moving body and a curved face, in plain words', () => {
    const { hook, onStatus } = setup();
    act(() => hook.result.current.start('align'));
    act(() => {
      expect(
        hook.result.current.pickFace(face(MOVING, 3, 5, 1, 'Cylinder'))
      ).toBe(true);
    });
    expect(onStatus).toHaveBeenLastCalledWith(
      FACE_ALIGN_REFUSALS['not-planar']
    );
    expect(hook.result.current.slots.faces).toEqual([]);
    act(() => {
      hook.result.current.pickFace(bottom);
    });
    act(() => {
      hook.result.current.pickFace(face(MOVING, 4, 26, 1));
    });
    expect(onStatus).toHaveBeenLastCalledWith(FACE_ALIGN_REFUSALS['same-body']);
    expect(hook.result.current.slots.faces.map((f) => f.hash)).toEqual([1]);
  });

  it('replaces a target, and takes a pick back out when it is clicked again', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('align'));
    act(() => {
      hook.result.current.pickFace(bottom);
    });
    act(() => {
      hook.result.current.pickFace(top);
    });
    const otherTop = face(TARGET, 5, 12, 1);
    act(() => {
      hook.result.current.pickFace(otherTop);
    });
    expect(hook.result.current.slots.faces.map((f) => f.hash)).toEqual([1, 5]);
    act(() => {
      hook.result.current.pickFace(otherTop);
    });
    expect(hook.result.current.slots.faces.map((f) => f.hash)).toEqual([1]);
    act(() => {
      hook.result.current.pickFace(top);
    });
    // The moving face clicked again takes both back: its target was for it.
    act(() => {
      hook.result.current.pickFace(bottom);
    });
    expect(hook.result.current.slots.faces).toEqual([]);
  });

  it('starts from a selected flat face as the face to move, never a curved one', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('align', [], [bottom]));
    expect(hook.result.current.slots.faces.map((f) => f.hash)).toEqual([1]);
    act(() => {
      hook.result.current.cancel();
    });
    act(() =>
      hook.result.current.start(
        'align',
        [],
        [face(MOVING, 3, 5, 1, 'Cylinder')]
      )
    );
    expect(hook.result.current.slots.faces).toEqual([]);
  });

  it('adds nothing when it is cancelled', async () => {
    const { hook, commit } = setup();
    act(() => hook.result.current.start('align'));
    act(() => {
      hook.result.current.pickFace(bottom);
    });
    act(() => {
      hook.result.current.pickFace(top);
    });
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.cancel();
    });
    expect(commit).not.toHaveBeenCalled();
    expect(hook.result.current.tool).toBeNull();
  });
});
