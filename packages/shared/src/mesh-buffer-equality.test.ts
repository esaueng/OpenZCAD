import { describe, expect, it } from 'vitest';
import { sameMeshBuffer } from './mesh-buffer-equality';

describe('mesh buffer equality', () => {
  it('compares contents, element type and length', () => {
    const vertices = new Float32Array([0, 1.5, -2, 3]);
    expect(sameMeshBuffer(vertices, vertices)).toBe(true);
    expect(sameMeshBuffer(vertices, vertices.slice())).toBe(true);
    expect(sameMeshBuffer(vertices, new Float32Array([0, 1.5, -2, 3.5]))).toBe(
      false
    );
    expect(sameMeshBuffer(vertices, vertices.subarray(0, 3))).toBe(false);
    expect(
      sameMeshBuffer(new Uint32Array([1, 2]), new Uint32Array([1, 2]))
    ).toBe(true);
    // Same bytes, different element type: not the same buffer.
    const indices = new Uint32Array(vertices.buffer.slice(0));
    expect(sameMeshBuffer(vertices, indices)).toBe(false);
  });

  it('reads views at their own offset', () => {
    const backing = new Float32Array([9, 1, 2, 3, 9]);
    expect(
      sameMeshBuffer(backing.subarray(1, 4), new Float32Array([1, 2, 3]))
    ).toBe(true);
  });

  it('treats a signed zero as a change and identical NaN bytes as equal', () => {
    expect(sameMeshBuffer(new Float32Array([0]), new Float32Array([-0]))).toBe(
      false
    );
    expect(
      sameMeshBuffer(new Float32Array([NaN]), new Float32Array([NaN]))
    ).toBe(true);
  });
});
