import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sectionCapGeometry, SECTION_CAP } from './sectionCaps';
import {
  applyDisplayMode,
  applySectionPlane,
  clearGroup,
  sectionClippingPlane
} from './objects';
import { isViewerMesh } from '../pick/meshes';

const xy = (offset = 0) => sectionClippingPlane({ plane: 'XY', offset });
function area(geometry: THREE.BufferGeometry | null) {
  expect(geometry).not.toBeNull();
  const p = geometry!.getAttribute('position');
  let sum = 0;
  for (let i = 0; i < p.count; i += 3) {
    sum += new THREE.Triangle(
      ...([0, 1, 2].map((j) =>
        new THREE.Vector3().fromBufferAttribute(p, i + j)
      ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3])
    ).getArea();
  }
  return sum;
}
function box(size = 10) {
  return new THREE.BoxGeometry(size, size, size);
}
function tube() {
  const shape = new THREE.Shape();
  shape.moveTo(-5, -5);
  shape.lineTo(5, -5);
  shape.lineTo(5, 5);
  shape.lineTo(-5, 5);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-2, -2);
  hole.lineTo(-2, 2);
  hole.lineTo(2, 2);
  hole.lineTo(2, -2);
  hole.closePath();
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, {
    depth: 10,
    bevelEnabled: false
  }).translate(0, 0, -5);
}
function capOf(mesh: THREE.Object3D) {
  return mesh.getObjectByName(SECTION_CAP) as
    THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial> | undefined;
}

describe('display-only solid section caps', () => {
  it.each(['XY', 'XZ', 'YZ'] as const)(
    'fills a box on %s, including tessellation seams',
    (plane) => {
      const geometry = box();
      const source = geometry.getAttribute('position').array.slice();
      const cut = sectionClippingPlane({ plane, offset: 1 });
      const cap = sectionCapGeometry(geometry, cut)!;
      expect(area(cap)).toBeCloseTo(100);
      const p = cap.getAttribute('position');
      for (let i = 0; i < p.count; i++)
        expect(
          cut.distanceToPoint(new THREE.Vector3().fromBufferAttribute(p, i))
        ).toBeCloseTo(0);
      expect(geometry.getAttribute('position').array).toEqual(source);
    }
  );
  it('preserves a through hole without covering it with cap triangles', () => {
    const cap = sectionCapGeometry(tube(), xy())!;
    expect(area(cap)).toBeCloseTo(84);
    const mesh = new THREE.Mesh(
      cap,
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    );
    const ray = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 20),
      new THREE.Vector3(0, 0, -1)
    );
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    ray.ray.origin.x = 4;
    expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
  });
  it('keeps islands inside cavities and disconnected contours', () => {
    const geometry = mergeGeometries([
      tube().toNonIndexed(),
      box(2).toNonIndexed(),
      box(4).translate(20, 0, 0).toNonIndexed()
    ]);
    expect(area(sectionCapGeometry(geometry, xy()))).toBeCloseTo(84 + 4 + 16);
  });
  it('handles a section exactly through triangle vertices and edges', () => {
    const geometry = new THREE.SphereGeometry(5, 32, 16);
    expect(area(sectionCapGeometry(geometry, xy()))).toBeCloseTo(
      (32 * 25 * Math.sin((2 * Math.PI) / 32)) / 2,
      4
    );
  });
  it.each([-6, -5, 5, 6])(
    'adds no duplicate or phantom face at offset %s',
    (offset) => {
      expect(sectionCapGeometry(box(), xy(offset))).toBeNull();
    }
  );
  it('does not close an open contour or fill a broken hole', () => {
    const geometry = box().toNonIndexed();
    const p = geometry.getAttribute('position');
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(p.array.slice(18), 3)
    );
    expect(sectionCapGeometry(geometry, xy())).toBeNull();
    const brokenHole = new THREE.PlaneGeometry(4, 10)
      .rotateX(Math.PI / 2)
      .toNonIndexed();
    expect(
      sectionCapGeometry(
        mergeGeometries([box().toNonIndexed(), brokenHole]),
        xy()
      )
    ).toBeNull();
  });
  it('moves, reuses, rebuilds and disposes caps without exposing fake topology', () => {
    const mesh = new THREE.Mesh(box(), new THREE.MeshPhongMaterial());
    mesh.castShadow = true;
    const root = new THREE.Group().add(mesh);
    applySectionPlane(root, xy());
    const first = capOf(mesh)!;
    expect(area(first.geometry)).toBeCloseTo(100);
    expect(isViewerMesh(first)).toBe(false);
    expect(first.castShadow).toBe(true);
    expect(
      new THREE.Raycaster(
        new THREE.Vector3(0, 0, 20),
        new THREE.Vector3(0, 0, -1)
      ).intersectObject(first)
    ).toHaveLength(0);
    applySectionPlane(root, xy());
    expect(capOf(mesh)).toBe(first);
    applyDisplayMode(root, 'wireframe');
    expect(first.material.visible).toBe(false);
    applyDisplayMode(root, 'shaded');
    expect(first.material.visible).toBe(true);
    const disposeGeometry = vi.spyOn(first.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(first.material, 'dispose');
    applySectionPlane(root, xy(1));
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(capOf(mesh)).not.toBe(first);
    const second = capOf(mesh)!;
    mesh.geometry.scale(2, 1, 1);
    applySectionPlane(root, xy(1));
    expect(capOf(mesh)).not.toBe(second);
    expect(area(capOf(mesh)!.geometry)).toBeCloseTo(200);
    applySectionPlane(root, null);
    expect(capOf(mesh)).toBeUndefined();
    expect(mesh.material.side).toBe(THREE.FrontSide);
    applySectionPlane(root, xy());
    const finalDispose = vi.spyOn(capOf(mesh)!.geometry, 'dispose');
    clearGroup(root);
    expect(finalDispose).toHaveBeenCalledOnce();
  });
  it('respects transformed bodies and hidden/translucent materials', () => {
    const mesh = new THREE.Mesh(
      box(),
      new THREE.MeshPhongMaterial({
        visible: false,
        transparent: true,
        opacity: 0.4,
        depthWrite: false
      })
    );
    mesh.position.z = 20;
    const root = new THREE.Group().add(mesh);
    applySectionPlane(root, xy(21));
    const cap = capOf(mesh)!;
    expect(area(cap.geometry)).toBeCloseTo(100);
    expect(cap.geometry.getAttribute('position').getZ(0)).toBeCloseTo(1);
    expect(cap.material.visible).toBe(false);
    expect(cap.material.opacity).toBe(0.4);
    expect(cap.material.depthWrite).toBe(false);
    expect(cap.material.clippingPlanes).toBeNull();
  });
});
