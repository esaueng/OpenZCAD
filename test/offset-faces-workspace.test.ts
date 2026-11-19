import { describe, expect, it } from 'vitest';
import { OFFSET_FACES_MIXED_DIRECTIONS } from '../packages/kernel-adapter/src/exact-direct-edit-ops';
import { MAX_REMOVED_FACES } from '../packages/kernel-adapter/src/exact-direct-edit-guards';
import {
  MAX_OFFSET_SET_FACES,
  OFFSET_SET_NOT_SAME_NORMAL
} from '../apps/web/src/lib/faceSetOffset';

/**
 * M07: the workspace refuses a face set whose faces do not all face the same
 * way before any handle appears, in the words a rebuild would refuse it
 * with, and bounds the set as the kernel does. A reworded or rebounded
 * kernel guard fails here instead of leaving the verb saying something
 * else. (Parallel faces at different heights the kernel chains; the
 * workspace's own refusal for them is not a kernel string.)
 */
describe('face set offset workspace contract', () => {
  it('refuses in the kernel’s words and bounds the set as the kernel does', () => {
    expect(OFFSET_SET_NOT_SAME_NORMAL).toBe(OFFSET_FACES_MIXED_DIRECTIONS);
    expect(MAX_OFFSET_SET_FACES).toBe(MAX_REMOVED_FACES);
  });
});
