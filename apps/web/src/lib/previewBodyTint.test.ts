import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BODY_COLOR,
  PREVIEW_BODY_COLOR,
  type GeometryBodyRepresentation
} from '@openzcad/shared';
import { tintPreviewResultBodies } from './previewBodyTint';

function body(bodyId: string, color = DEFAULT_BODY_COLOR) {
  return {
    bodyId,
    name: bodyId,
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array([0, 0, 0]),
      indices: new Uint32Array([0])
    },
    color,
    faceCount: 6,
    exportableStep: true
  } as unknown as GeometryBodyRepresentation;
}

describe('preview result tint (design review G2)', () => {
  it('draws only what the preview would make in the preview hue', () => {
    const kept = body('body_kept');
    const result = body('body_result');
    const tinted = tintPreviewResultBodies([kept, result], {
      body_kept: kept,
      body_consumed: body('body_consumed')
    });
    // The body the document already has is the same object: its mesh stays.
    expect(tinted[0]).toBe(kept);
    expect(tinted[1]).toMatchObject({
      bodyId: 'body_result',
      color: PREVIEW_BODY_COLOR
    });
    // The preview's own representation is not written to.
    expect(result.color).toBe(DEFAULT_BODY_COLOR);
  });

  it('returns the same array when the preview makes nothing new', () => {
    const bodies = [body('body_a'), body('body_b', '#a78bfa')];
    expect(
      tintPreviewResultBodies(bodies, {
        body_a: bodies[0]!,
        body_b: bodies[1]!
      })
    ).toBe(bodies);
  });
  it('tints an in-place edit while keeping an unchanged copied mesh neutral', () => {
    const applied = body('same-id');
    const changed = body('same-id');
    changed.mesh.vertices[0] = 5;
    expect(
      tintPreviewResultBodies([changed], { 'same-id': applied })[0]?.color
    ).toBe(PREVIEW_BODY_COLOR);
    expect(changed.color).toBe(DEFAULT_BODY_COLOR);
    const unchanged = [body('same-id')];
    expect(tintPreviewResultBodies(unchanged, { 'same-id': applied })).toBe(
      unchanged
    );
  });
});
