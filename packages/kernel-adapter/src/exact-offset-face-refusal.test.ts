import { describe, expect, it } from 'vitest';
import { kernelRefusalRecordOf } from './kernel-refusal';
import {
  OFFSET_FACE_COLLAPSES_NEIGHBOR,
  offsetFaceRefusalOf
} from './exact-offset-face-refusal';

// Captured from Remus on the pin (test/parity/offset-face-fillet-limit.spec.ts).
const kernelText = (verb: 'collapse' | 'reverse', move: number) =>
  `resize blend: exact reconstruction refused: remove/rebuild failed (resize blend: exact reconstruction refused: blend region has unsupported support surfaces ["torus", "plane"]; expected all planes or one supported analytic pair); exact prismatic blend translation failed (offset: move-face would change topology at face None, edge Some(Id(8)): line edge 8 with one moving end would ${verb}: a move of ${move} against a fixed-to-moving extent of 6.400000000000002)`;

describe('offsetFaceRefusalOf', () => {
  it('types a neighbour collapse and names the signed limit', () => {
    const cause = new Error(kernelText('reverse', -9));
    const refusal = offsetFaceRefusalOf(cause, -9);
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).toBe(
      'A neighbouring face would shrink to nothing past 6.4. Try a smaller offset.'
    );
    expect(refusal!.message.split('\n')[1]).toBe(cause.message);
    expect(refusal!.cause).toBe(cause);
    expect(kernelRefusalRecordOf(refusal)).toEqual({
      family: 'direct-edit',
      operation: 'offset-face',
      category: 'invalid_topology',
      code: OFFSET_FACE_COLLAPSES_NEIGHBOR,
      reason: 'reverse',
      limit: -6.4
    });
  });

  it('reads the collapse wording and an outward move alike', () => {
    expect(
      offsetFaceRefusalOf(new Error(kernelText('collapse', 6.4)), 6.4)?.limit
    ).toBe(6.4);
  });

  it('offers no limit when the kernel moved something else', () => {
    const refusal = offsetFaceRefusalOf(
      new Error(kernelText('reverse', -3)),
      -9
    );
    expect(refusal?.category).toBe('invalid_topology');
    expect(refusal?.limit).toBeUndefined();
    expect(refusal?.reason).toBe(
      'A neighbouring face would shrink to nothing at this distance. Try a smaller offset.'
    );
  });

  it('leaves every other failure alone', () => {
    expect(
      offsetFaceRefusalOf(new Error('swept face reaches nonadjacent face'), -9)
    ).toBeNull();
    expect(offsetFaceRefusalOf('not an error', -9)).toBeNull();
  });
});
