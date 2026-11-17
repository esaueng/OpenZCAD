import { describe, expect, it } from 'vitest';
import {
  OFFSET_FACE_HOLE_CHAMFER_NOT_CARRIED,
  holeChamferNotCarriedRefusal,
  holeChamferRefusalOf,
  type HoleMouthRim
} from './exact-offset-face-hole-mouth';
import { KernelRefusal, kernelRefusalRecordOf } from './kernel-refusal';

const rim: HoleMouthRim = {
  axisPoint: { x: 9, y: 6, z: 0 },
  axis: { x: 0, y: 0, z: 1 },
  radius: 5
};

// The first is captured from Remus on the pin
// (test/parity/offset-face-hole-chamfer.spec.ts, +4 through the commit
// rebuild); the other two are the kernel's words as issue #1595 quotes them.
const LOOP_LEAVES =
  'offset: move-face would change topology at face Some(Id(7)), edge None: strict validation failed with 1 error(s): face 61: inner loop 1 leaves the outer loop (the loops cross, or the inner loop lies outside)';
const INSIDE_OUT =
  'offset: move-face would change topology at face Some(Id(7)), edge None: the outer shell is inside out: it encloses a signed volume of -3770.14';
const REACHES_WALL =
  'resize blend: exact reconstruction refused: swept face reaches nonadjacent face 28';

describe('holeChamferRefusalOf', () => {
  it.each([LOOP_LEAVES, INSIDE_OUT, REACHES_WALL])(
    'types a kernel refusal a cone left in place causes: %s',
    (text) => {
      const cause = new Error(text);
      const refusal = holeChamferRefusalOf(cause, [rim], 4);
      expect(refusal).not.toBeNull();
      expect(refusal!.reason).toContain(
        'offsetting the face cannot move that chamfer with it yet'
      );
      // The kernel's own words stay behind the headline.
      expect(refusal!.message.split('\n')[1]).toBe(text);
      expect(refusal!.cause).toBe(cause);
      expect(kernelRefusalRecordOf(refusal)).toEqual({
        family: 'direct-edit',
        operation: 'offset-face',
        category: 'unsupported',
        code: OFFSET_FACE_HOLE_CHAMFER_NOT_CARRIED
      });
    }
  );

  it('leaves the same refusals alone on a face with no hole-mouth rim', () => {
    expect(holeChamferRefusalOf(new Error(LOOP_LEAVES), [], 4)).toBeNull();
  });

  it('leaves any other kernel refusal alone', () => {
    expect(
      holeChamferRefusalOf(
        new Error(
          'offset: move-face would change topology at face None, edge Some(Id(8)): line edge 8 with one moving end would collapse'
        ),
        [rim],
        4
      )
    ).toBeNull();
  });

  it('never re-types a refusal that is already typed', () => {
    expect(
      holeChamferRefusalOf(holeChamferNotCarriedRefusal(4), [rim], 4)
    ).toBeNull();
    expect(holeChamferNotCarriedRefusal(4)).toBeInstanceOf(KernelRefusal);
  });
});
