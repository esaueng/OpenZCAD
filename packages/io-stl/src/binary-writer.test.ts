import { describe, expect, it } from 'vitest';
import { parseStl, writeBinaryStl, StlWriteError } from './index';

describe('binary STL source-mesh export', () => {
  it('round-trips disconnected, duplicate and degenerate facets', () => {
    const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0, 0, 6, 0, 0, 7, 0, 0];
    const indices = [0, 1, 2, 0, 1, 2, 3, 4, 5];
    const output = writeBinaryStl([{ name: 'source', vertices, indices }]);
    const parsed = parseStl(output.buffer, 'source.stl');
    expect(parsed.format).toBe('binary');
    expect(parsed.triangleCount).toBe(3);
    expect(parsed.vertices).toEqual(
      indices.flatMap((i) => vertices.slice(i * 3, i * 3 + 3))
    );
  });

  it.each([NaN, Infinity, 1e100])(
    'refuses a coordinate binary STL cannot represent: %s',
    (value) => {
      expect(() =>
        writeBinaryStl([
          {
            name: 'bad',
            vertices: [value, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2]
          }
        ])
      ).toThrow(StlWriteError);
    }
  );

  it('refuses invalid vertex indices', () => {
    expect(() =>
      writeBinaryStl([{ name: 'bad', vertices: [0, 0, 0], indices: [0, 1, 2] }])
    ).toThrow(StlWriteError);
  });
});
