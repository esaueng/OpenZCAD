import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildReferenceImageRig } from './referenceImageRig';
import type { ReferenceImageDisplay } from '../../lib/referenceImageDisplay';

const display = (
  extra: Partial<ReferenceImageDisplay> = {}
): ReferenceImageDisplay => ({
  imageId: 'rimg_one' as ReferenceImageDisplay['imageId'],
  name: 'Plan',
  frame: {
    center: { x: 5, y: 6, z: 7 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 }
  },
  width: 80,
  height: 40,
  opacity: 0.4,
  checksumSha256: 'c'.repeat(64),
  selected: false,
  ...extra
});

function quadOf(rig: ReturnType<typeof buildReferenceImageRig>) {
  return rig.group.children.find(
    (object): object is THREE.Mesh => object instanceof THREE.Mesh
  )!;
}

describe('buildReferenceImageRig', () => {
  it('lays a textured quad at the image size, upright and see-through', () => {
    const texture = new THREE.Texture();
    const rig = buildReferenceImageRig(
      [display()],
      new Map([['c'.repeat(64), texture]])
    );
    const quad = quadOf(rig);
    expect(quad.position.toArray()).toEqual([5, 6, 7]);
    expect(quad.scale.toArray()).toEqual([80, 40, 1]);
    const material = quad.material as THREE.MeshBasicMaterial;
    expect(material.map).toBe(texture);
    expect(material.opacity).toBe(0.4);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    // The picture's top-left pixel (a decoded bitmap's first row, uploaded
    // unflipped) sits at the quad's top-left corner.
    const position = quad.geometry.getAttribute('position');
    const uv = quad.geometry.getAttribute('uv');
    for (let index = 0; index < position.count; index += 1) {
      if (position.getX(index) < 0 && position.getY(index) > 0) {
        expect([uv.getX(index), uv.getY(index)]).toEqual([0, 0]);
      }
    }
    // Unselected and textured: no outline.
    expect(rig.group.children).toHaveLength(1);
    rig.dispose();
  });

  it('draws a faint outlined frame until the picture arrives', () => {
    const rig = buildReferenceImageRig([display()], new Map());
    const material = quadOf(rig).material as THREE.MeshBasicMaterial;
    expect(material.map).toBeNull();
    expect(rig.group.children).toHaveLength(2);
    rig.dispose();
  });

  it('is never a pick target', () => {
    const rig = buildReferenceImageRig(
      [display({ selected: true })],
      new Map()
    );
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(5, 6, 100),
      new THREE.Vector3(0, 0, -1)
    );
    rig.group.updateMatrixWorld(true);
    expect(raycaster.intersectObject(rig.group, true)).toEqual([]);
    for (const object of rig.group.children)
      expect(object.userData.referenceImageId).toBe('rimg_one');
    rig.dispose();
  });
});
