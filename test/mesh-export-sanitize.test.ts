import { describe, expect, it } from 'vitest';
import {
  sanitizeBinaryStl,
  sanitizeThreeMfModel
} from '../packages/kernel-adapter/src/mesh-export-sanitize';

function binaryStl(triangles: readonly (readonly number[])[]): Uint8Array {
  const bytes = new Uint8Array(84 + triangles.length * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((positions, triangle) => {
    expect(positions).toHaveLength(9);
    positions.forEach((value, coordinate) =>
      view.setFloat32(84 + triangle * 50 + 12 + coordinate * 4, value, true)
    );
  });
  return bytes;
}

describe('exact mesh export sanitizing', () => {
  it('removes only zero-area binary STL facets', () => {
    const bytes = sanitizeBinaryStl(
      binaryStl([
        [0, 0, 0, 1, 0, 0, 0, 1, 0],
        [0, 0, 0, 1, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 0, 0, 0, 1e-12, 0]
      ])
    );

    expect(new DataView(bytes.buffer).getUint32(80, true)).toBe(2);
    expect(bytes).toHaveLength(84 + 2 * 50);
  });

  it('removes only zero-area 3MF facets and preserves its unit', () => {
    const model =
      '<model unit="millimeter"><resources><object id="1"><mesh>' +
      '<vertices>' +
      '<vertex x="0" y="0" z="0"/>' +
      '<vertex x="1" y="0" z="0"/>' +
      '<vertex x="0" y="1" z="0"/>' +
      '<vertex x="0" y="0.000000000001" z="0"/>' +
      '</vertices><triangles>' +
      '<triangle v1="0" v2="1" v3="2"/>' +
      '<triangle v1="0" v2="1" v3="0"/>' +
      '<triangle v1="0" v2="1" v3="3"/>' +
      '</triangles></mesh></object></resources></model>';

    const sanitized = sanitizeThreeMfModel(model);

    expect(sanitized).toContain('<model unit="millimeter">');
    expect(sanitized.match(/<triangle\b/g)).toHaveLength(2);
    expect(sanitized).not.toContain('v3="0"');
  });
});
