import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toBodyId, toFeatureId, toUserId } from '@openzcad/shared';
import { blendPreviewSelectionKey, canReuseBlendPreview } from './blendPreview';
import type { InteractionState } from './machine';

const document = createProjectDocument('Blend', toUserId('user_preview'));
const selection: Extract<InteractionState, { mode: 'edges' }> = {
  mode: 'edges',
  op: 'fillet',
  edges: [
    { bodyId: toBodyId('body_1'), kind: 'edge', topologyId: 'edge:1', hash: 1 }
  ],
  phase: 'dragging',
  lastValue: null,
  error: null
};
const candidate = {
  baseProjectId: document.projectId,
  baseVersion: document.version,
  selectionKey: blendPreviewSelectionKey(selection)!,
  size: 2
};

describe('exact blend preview reuse', () => {
  it('accepts the measured value and selection after the gesture phase changes', () => {
    expect(
      canReuseBlendPreview(
        candidate,
        document,
        {
          ...selection,
          phase: 'armed',
          lastValue: 2
        },
        2
      )
    ).toBe(true);
  });

  it('rejects a different operation, edge, body, value, project, or revision', () => {
    for (const state of [
      { ...selection, op: 'chamfer' as const },
      { ...selection, edges: [{ ...selection.edges[0]!, hash: 2 }] },
      {
        ...selection,
        edges: [{ ...selection.edges[0]!, bodyId: toBodyId('body_2') }]
      },
      { mode: 'idle' as const }
    ]) {
      expect(canReuseBlendPreview(candidate, document, state, 2)).toBe(false);
    }
    expect(canReuseBlendPreview(candidate, document, selection, 2.001)).toBe(
      false
    );
    expect(canReuseBlendPreview(candidate, undefined, selection, 2)).toBe(
      false
    );
    expect(
      canReuseBlendPreview(
        candidate,
        { ...document, version: document.version + 1 },
        selection,
        2
      )
    ).toBe(false);
    expect(
      canReuseBlendPreview(
        candidate,
        createProjectDocument('Other', toUserId('user_preview')),
        selection,
        2
      )
    ).toBe(false);
  });

  it('requires the same blend face and producing feature for a radius edit', () => {
    const face: Extract<InteractionState, { mode: 'face' }> = {
      mode: 'face',
      op: 'edit-fillet',
      phase: 'dragging',
      lastValue: null,
      error: null,
      target: {
        bodyId: 'body_1',
        topologyId: 'face:2',
        surfaceType: 'cylindrical',
        point: [0, 0, 0],
        normal: [1, 0, 0],
        filletFeatureId: toFeatureId('fillet_1')
      }
    };
    const preview = {
      ...candidate,
      selectionKey: blendPreviewSelectionKey(face)!
    };
    expect(canReuseBlendPreview(preview, document, face, 2)).toBe(true);
    expect(
      canReuseBlendPreview(
        preview,
        document,
        { ...face, target: { ...face.target, topologyId: 'face:3' } },
        2
      )
    ).toBe(false);
    expect(
      canReuseBlendPreview(
        preview,
        document,
        {
          ...face,
          target: { ...face.target, filletFeatureId: toFeatureId('fillet_2') }
        },
        2
      )
    ).toBe(false);
  });
});
