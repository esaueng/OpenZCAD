import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toBodyId, toFeatureId, toUserId } from '@openzcad/shared';
import { commandFactories } from '@openzcad/command-system';
import {
  blendPreviewSelectionKey,
  canReuseBlendPreview,
  geometryPreviewSelectionKey,
  newBlendValidationTarget
} from './blendPreview';
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

describe('geometry preview selection key', () => {
  it('keys a blend drag by its blend selection, so an edge drag can show one', () => {
    expect(geometryPreviewSelectionKey(selection)).toBe(
      blendPreviewSelectionKey(selection)
    );
  });

  it('keys a face drag by the dragged face and nothing else by default', () => {
    const offset: Extract<InteractionState, { mode: 'face' }> = {
      mode: 'face',
      op: 'offset-face',
      phase: 'dragging',
      lastValue: null,
      error: null,
      target: {
        bodyId: 'body_1',
        topologyId: 'face:2',
        surfaceType: 'planar',
        point: [0, 0, 0],
        normal: [0, 0, 1]
      }
    };
    expect(geometryPreviewSelectionKey(offset)).toBe(
      'offset-face:body_1:face:2:false'
    );
    expect(geometryPreviewSelectionKey({ mode: 'idle' })).toBeNull();
    // A blend preview never stands in for a face drag, or the reverse.
    expect(geometryPreviewSelectionKey(offset)).not.toBe(
      geometryPreviewSelectionKey(selection)
    );
  });
});

describe('new blend validation target', () => {
  const edges = {
    targetBodyId: toBodyId('body_1'),
    edgeHashes: [1],
    size: 1
  };

  it('names the new feature as the kernel does, not the command label', () => {
    for (const command of [
      commandFactories.filletEdges({ ...edges, name: 'Fillet edges 4' }),
      commandFactories.chamferEdges({ ...edges, name: 'Chamfer edges 2' })
    ]) {
      expect(command.label).not.toBe(command.payload.name);
      expect(newBlendValidationTarget(command)).toEqual({
        featureId: command.payload.ids!.featureId,
        featureName: command.payload.name,
        resultBodyId: command.payload.ids!.bodyId
      });
    }
  });

  it('has no target for an edit that creates no blend feature', () => {
    expect(
      newBlendValidationTarget(
        commandFactories.updateFeature(
          { featureId: toFeatureId('fillet_1'), data: { radius: 2 } },
          'Edit Fillet 1'
        )
      )
    ).toBeNull();
  });
});
