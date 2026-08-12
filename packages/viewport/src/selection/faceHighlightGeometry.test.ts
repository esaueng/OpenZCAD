import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createFaceHighlightGeometry } from './faceHighlightGeometry';

describe('createFaceHighlightGeometry', () => {
  it('slices one face while sharing the body position and normal buffers', () => {
    const source = new THREE.BufferGeometry();
    const position = new THREE.Float32BufferAttribute(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      3
    );
    const normal = new THREE.Float32BufferAttribute(
      [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      3
    );
    source.setAttribute('position', position);
    source.setAttribute('normal', normal);
    source.setIndex([0, 1, 2, 2, 1, 3]);
    const object = new THREE.Mesh(source, new THREE.MeshPhongMaterial());

    const highlight = createFaceHighlightGeometry(object, {
      triangleStart: 1,
      triangleCount: 1
    });

    expect(highlight?.getAttribute('position')).toBe(position);
    expect(highlight?.getAttribute('normal')).toBe(normal);
    expect(Array.from(highlight?.getIndex()?.array ?? [])).toEqual([2, 1, 3]);
  });

  it('fails closed when the source has no published normal buffer', () => {
    const source = new THREE.BufferGeometry();
    source.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)
    );
    source.setIndex([0, 1, 2]);

    expect(
      createFaceHighlightGeometry(
        new THREE.Mesh(source, new THREE.MeshPhongMaterial()),
        { triangleStart: 0, triangleCount: 1 }
      )
    ).toBeNull();
  });
});
