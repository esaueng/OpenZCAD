import { describe, expect, it } from 'vitest';
import { projectReferenceMesh } from './mesh-reference';

function triangle() {
  return {
    vertices: Float64Array.of(0, 0, 0, 10, 0, 0, 0, 20, 5),
    indices: Uint32Array.of(0, 1, 2)
  };
}

describe('reference mesh display projection', () => {
  it('projects float32 display buffers and the source bounds', () => {
    const { mesh, bbox } = projectReferenceMesh(triangle());
    expect(mesh.kind).toBe('mesh');
    expect(Array.from(mesh.vertices)).toEqual([0, 0, 0, 10, 0, 0, 0, 20, 5]);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
    expect(bbox).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 20, z: 5 }
    });
  });

  it('reuses the projection of the same mesh but hands out fresh buffers', () => {
    const source = triangle();
    const first = projectReferenceMesh(source);
    // A caller may mutate or transfer what it was given.
    first.mesh.vertices[0] = 99;
    first.mesh.indices[0] = 7;
    first.bbox.min.x = -1;
    // Reference meshes are immutable, so a change behind the cache's back
    // is how a test sees the kept projection served instead of a new one.
    source.vertices[3] = 50;
    const second = projectReferenceMesh(source);
    expect(second.mesh.vertices).not.toBe(first.mesh.vertices);
    expect(second.mesh.indices).not.toBe(first.mesh.indices);
    expect(Array.from(second.mesh.vertices)).toEqual([
      0, 0, 0, 10, 0, 0, 0, 20, 5
    ]);
    expect(Array.from(second.mesh.indices)).toEqual([0, 1, 2]);
    expect(second.bbox.min.x).toBe(0);
    // A different mesh object is projected afresh.
    expect(projectReferenceMesh({ ...source }).bbox.max.x).toBe(50);
  });

  it('still refuses coordinates beyond the float32 display range', () => {
    expect(() =>
      projectReferenceMesh({
        vertices: Float64Array.of(1e39, 0, 0, 0, 0, 0, 0, 0, 0),
        indices: Uint32Array.of(0, 1, 2)
      })
    ).toThrow('Mesh coordinates exceed the browser display range.');
  });
});
