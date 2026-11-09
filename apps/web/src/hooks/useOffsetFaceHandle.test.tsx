import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  toBodyId,
  type BodyRepresentation,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { stepPreviewProfile } from '../lib/interaction/stepPreviewProfile';
import type { FaceTarget, InteractionState } from '../lib/interaction/machine';
import { useOffsetFaceHandle } from './useOffsetFaceHandle';

vi.mock('../lib/interaction/stepPreviewProfile', () => ({
  stepPreviewProfile: vi.fn(() => null)
}));

const recognize = vi.mocked(stepPreviewProfile);
const face = {
  topologyId: 'face:3',
  hash: 3,
  geometry: { surfaceType: 'plane', normal: { x: 0, y: 0, z: 1 } }
} as FaceTopology;
const body = {
  topology: { faces: [face], edges: [] }
} as unknown as BodyRepresentation;
const bodyId = toBodyId('body_1');
const target: FaceTarget = {
  bodyId,
  topologyId: face.topologyId,
  hash: face.hash,
  surfaceType: 'planar',
  normal: [0, 0, 1],
  point: [10, 10, 26]
};
const armed: InteractionState = {
  mode: 'face',
  op: 'offset-face',
  target,
  phase: 'armed',
  lastValue: null,
  error: null
};

function inputs() {
  return {
    document: createProjectDocument(
      'Preview recognition',
      toUserId('user_test')
    ),
    representations: {
      [bodyId]: body
    } as ProjectDocument['derived']['bodyRepresentations'],
    interaction: armed,
    value: 0
  };
}

function useHandle(props: ReturnType<typeof inputs>) {
  return useOffsetFaceHandle(
    props.document,
    props.representations,
    props.interaction,
    props.value,
    false
  );
}

describe('offset face handle source recognition', () => {
  beforeEach(() => recognize.mockClear());

  it.each([
    null,
    {
      normal: { x: 0, y: 0, z: 1 },
      origin: { x: 0, y: 0, z: 0 },
      quantum: 1,
      movingKeys: new Set<number>(),
      span: 10,
      reach: 10
    }
  ])(
    'retains recognition across changing values and operation phases (%o)',
    (profile) => {
      recognize.mockReturnValue(profile);
      const props = inputs();
      const { result, rerender } = renderHook(useHandle, {
        initialProps: props
      });
      expect(result.current?.initialValue).toBe(0);
      expect(recognize).toHaveBeenCalledOnce();
      for (const value of [1, 2, 5, -1]) {
        rerender({ ...props, value });
        expect(result.current?.initialValue).toBe(value);
      }
      rerender({
        ...props,
        value: 5,
        interaction: { ...armed, phase: 'validating', lastValue: 5 }
      });
      expect(result.current?.locked).toBe(true);
      rerender({ ...props, interaction: { ...armed, phase: 'exact-entry' } });
      expect(result.current?.entry).toBe(true);
      expect(result.current?.locked).toBeUndefined();
      expect(recognize).toHaveBeenCalledOnce();
    }
  );

  it('restores the committed anchor but keeps a refused input editable', () => {
    const props = inputs();
    const { result, rerender } = renderHook(useHandle, { initialProps: props });
    rerender({
      ...props,
      value: -7.5,
      interaction: { ...armed, phase: 'validating', lastValue: -7.5 }
    });
    expect(result.current?.initialValue).toBe(-7.5);
    rerender({
      ...props,
      value: -7.5,
      interaction: {
        ...armed,
        phase: 'failed',
        lastValue: -7.5,
        error: { message: 'Exact check refused' }
      }
    });
    expect(result.current).toMatchObject({
      point: { x: 10, y: 10, z: 26 },
      initialValue: 0,
      refusedValue: -7.5
    });
    // Reopening entry does not move the pin until the user changes the input.
    rerender({
      ...props,
      interaction: { ...armed, phase: 'exact-entry', lastValue: -7.5 }
    });
    expect(result.current?.initialValue).toBe(0);
    expect(result.current?.refusedValue).toBeUndefined();
    rerender({ ...props, interaction: { mode: 'idle' } });
    expect(result.current).toBeNull();
  });

  it('rechecks a replacement source and declines a pick missing from its topology', () => {
    recognize.mockReturnValue(null);
    const props = inputs();
    const { result, rerender } = renderHook(useHandle, { initialProps: props });
    const changedFace = { ...face };
    const replacement = {
      ...body,
      topology: { faces: [changedFace], edges: [] }
    };
    rerender({ ...props, representations: { [bodyId]: replacement } });
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(recognize).toHaveBeenLastCalledWith(replacement, changedFace);
    rerender({
      ...props,
      representations: {
        [bodyId]: {
          ...body,
          topology: { faces: [{ ...face, hash: 4 }], edges: [] }
        }
      }
    });
    expect(result.current).toBeNull();
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it('rechecks changed history or selection but ignores an unrelated body update', () => {
    const props = inputs();
    const { result, rerender } = renderHook(useHandle, { initialProps: props });
    const firstHandle = result.current;
    rerender({
      ...props,
      representations: { ...props.representations, [toBodyId('body_2')]: body }
    });
    expect(recognize).toHaveBeenCalledOnce();
    expect(result.current).toBe(firstHandle);
    rerender({
      ...props,
      document: { ...props.document, version: props.document.version + 1 }
    });
    expect(recognize).toHaveBeenCalledTimes(2);
    rerender({
      ...props,
      interaction: { ...armed, target: { ...target, localFaceOffset: true } }
    });
    expect(recognize).toHaveBeenCalledTimes(3);
    rerender({ ...props, interaction: { mode: 'idle' } });
    expect(result.current).toBeNull();
  });
});
