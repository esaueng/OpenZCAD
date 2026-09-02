import { describe, expect, it } from 'vitest';
import type { ExtrudeInput } from '@openzcad/document-core';
import type { BodyId, SketchId } from '@openzcad/shared';
import { previewExtrudeInput, previewExtrudeOperation } from './extrudePreview';

const body = 'body_1' as BodyId;
const facePlane = { type: 'face' as const, bodyId: body };
const input: ExtrudeInput = {
  name: 'Extrude',
  sketchId: 'sketch_1' as SketchId,
  distance: 5,
  operation: 'add',
  targetBodyId: 'stale_body' as BodyId
};

describe('previewExtrudeOperation', () => {
  it('cuts the face body when the drag runs into it', () => {
    expect(previewExtrudeOperation(facePlane, -3)).toEqual({
      operation: 'cut',
      targetBodyId: body
    });
  });

  it('adds onto the face body when the drag runs away from it', () => {
    expect(previewExtrudeOperation(facePlane, 3)).toEqual({
      operation: 'add',
      targetBodyId: body
    });
  });

  it('previews a new body on a free plane in either direction', () => {
    const plane = { type: 'xy' };
    expect(previewExtrudeOperation(plane, 3)).toEqual({
      operation: 'new-body'
    });
    expect(previewExtrudeOperation(plane, -3)).toEqual({
      operation: 'new-body'
    });
    expect(previewExtrudeOperation(undefined, 3)).toEqual({
      operation: 'new-body'
    });
  });

  it('never previews a boolean for a zero or non-finite distance', () => {
    expect(previewExtrudeOperation(facePlane, 0)).toEqual({
      operation: 'new-body'
    });
    expect(previewExtrudeOperation(facePlane, Number.NaN)).toEqual({
      operation: 'new-body'
    });
  });
});

describe('previewExtrudeInput', () => {
  it('replaces a stale stored operation instead of layering on it', () => {
    expect(previewExtrudeInput(input, facePlane, -2)).toEqual({
      name: 'Extrude',
      sketchId: 'sketch_1',
      distance: 5,
      operation: 'cut',
      targetBodyId: body
    });
    expect(previewExtrudeInput(input, { type: 'xy' }, 2)).toEqual({
      name: 'Extrude',
      sketchId: 'sketch_1',
      distance: 5,
      operation: 'new-body'
    });
  });
});
