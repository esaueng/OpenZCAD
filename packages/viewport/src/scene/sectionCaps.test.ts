import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  mergeGeometries,
  mergeVertices
} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  plainFloat32Positions,
  sectionCapGeometry,
  SECTION_CAP
} from './sectionCaps';
import {
  applyDisplayMode,
  applySectionPlane,
  clearGroup,
  sectionClippingPlane
} from './objects';
import { isViewerMesh } from '../pick/meshes';
import { SECTION_HATCH } from './sectionHatch';
import { updateBodyMaterialOpacity } from '../render/scene';

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
type PositionAttribute =
  THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
/** Copies decoded coordinates into `target`, encoding them as it stores. */
function encodeInto<T extends PositionAttribute>(
  source: PositionAttribute,
  target: T,
  scale = 1
) {
  for (let i = 0; i < source.count; i++)
    target.setXYZ(
      i,
      source.getX(i) * scale,
      source.getY(i) * scale,
      source.getZ(i) * scale
    );
  return target;
}
/**
 * Every position layout three.js reads through its accessors. Normalized
 * buffers hold [-1, 1], so they store the part scaled down; the rest keep
 * its size. Integer coordinates survive a plain int16 buffer.
 */
const POSITION_ENCODINGS: Record<
  string,
  (source: PositionAttribute) => PositionAttribute
> = {
  float32: (source) =>
    encodeInto(
      source,
      new THREE.BufferAttribute(new Float32Array(source.count * 3), 3)
    ),
  'half-float': (source) =>
    encodeInto(
      source,
      new THREE.Float16BufferAttribute(new Uint16Array(source.count * 3), 3)
    ),
  'normalized int16': (source) =>
    encodeInto(
      source,
      new THREE.BufferAttribute(new Int16Array(source.count * 3), 3, true),
      1 / 8
    ),
  'normalized int8': (source) =>
    encodeInto(
      source,
      new THREE.BufferAttribute(new Int8Array(source.count * 3), 3, true),
      1 / 8
    ),
  int16: (source) =>
    encodeInto(
      source,
      new THREE.BufferAttribute(new Int16Array(source.count * 3), 3)
    ),
  'interleaved float32': (source) =>
    encodeInto(
      source,
      new THREE.InterleavedBufferAttribute(
        new THREE.InterleavedBuffer(new Float32Array(source.count * 4), 4),
        3,
        1
      )
    ),
  'interleaved normalized int16': (source) =>
    encodeInto(
      source,
      new THREE.InterleavedBufferAttribute(
        new THREE.InterleavedBuffer(new Int16Array(source.count * 4), 4),
        3,
        1,
        true
      ),
      1 / 8
    )
};

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
  it.each(['XY', 'XZ', 'YZ'] as const)(
    'flips %s around the same offset and caps the other side',
    (plane) => {
      const normal = sectionClippingPlane({ plane, offset: 1 });
      const flipped = sectionClippingPlane({ plane, offset: 1, flipped: true });
      const positive = new THREE.Vector3(2, 2, 2);
      expect(normal.distanceToPoint(positive)).toBeLessThan(0);
      expect(flipped.distanceToPoint(positive)).toBeGreaterThan(0);
      const cap = sectionCapGeometry(box(), flipped)!;
      expect(area(cap)).toBeCloseTo(100);
      const positions = cap.getAttribute('position');
      for (let index = 0; index < positions.count; index++) {
        const point = new THREE.Vector3().fromBufferAttribute(positions, index);
        expect(normal.distanceToPoint(point)).toBeCloseTo(0);
        expect(flipped.distanceToPoint(point)).toBeCloseTo(0);
      }
    }
  );

  it.each([
    ['indexed', true],
    ['non-indexed', false]
  ] as const)(
    'sections every %s position encoding as its decoded coordinates',
    (_, indexed) => {
      // Plain float32 buffers take a direct scan; every other encoding must
      // decode through the attribute, as `fromBufferAttribute` does. The
      // reference holds the decoded values in a float64 buffer, which the
      // scan also reads through the attribute.
      const welded = mergeVertices(
        tube().deleteAttribute('normal').deleteAttribute('uv')
      );
      const source = indexed ? welded : welded.toNonIndexed();
      expect(source.index !== null).toBe(indexed);
      const plane = xy(0.25);
      for (const [name, encode] of Object.entries(POSITION_ENCODINGS)) {
        const attribute = encode(source.getAttribute('position'));
        const encoded = new THREE.BufferGeometry();
        encoded.setAttribute('position', attribute);
        encoded.setIndex(source.index);
        const decoded = new THREE.BufferGeometry();
        const values = new Float64Array(attribute.count * 3);
        for (let i = 0; i < attribute.count; i++) {
          values[i * 3] = attribute.getX(i);
          values[i * 3 + 1] = attribute.getY(i);
          values[i * 3 + 2] = attribute.getZ(i);
        }
        decoded.setAttribute('position', new THREE.BufferAttribute(values, 3));
        decoded.setIndex(source.index);
        const reference = sectionCapGeometry(decoded, plane);
        expect(reference, name).not.toBeNull();
        const cap = sectionCapGeometry(encoded, plane);
        expect(cap, name).not.toBeNull();
        expect([...cap!.getAttribute('position').array], name).toEqual([
          ...reference!.getAttribute('position').array
        ]);
      }
    }
  );

  it('caps a half-float box like its float32 source', () => {
    // A Float16BufferAttribute stores encoded 16-bit words; read raw they
    // are no coordinates at all and the cut finds no contour.
    const plane = xy(0.25);
    const source = new THREE.BoxGeometry(2, 2, 2);
    expect(source.index).not.toBeNull();
    const expected = sectionCapGeometry(source, plane)!;
    expect(expected.getAttribute('position').count).toBe(18);
    const half = new THREE.BufferGeometry();
    half.setAttribute(
      'position',
      POSITION_ENCODINGS['half-float']!(source.getAttribute('position'))
    );
    half.setIndex(source.index);
    const cap = sectionCapGeometry(half, plane);
    expect(cap).not.toBeNull();
    expect([...cap!.getAttribute('position').array]).toEqual([
      ...expected.getAttribute('position').array
    ]);
  });

  it('reads only plain float32 positions directly', () => {
    const plain = new THREE.Float32BufferAttribute([0, 1, 2], 3);
    expect(plainFloat32Positions(plain)).toBe(plain.array);
    for (const [name, encode] of Object.entries(POSITION_ENCODINGS)) {
      if (name === 'float32') continue;
      expect(plainFloat32Positions(encode(plain)), name).toBeNull();
    }
  });

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
  it('draws the cut hatched and shaded down, never in the body colour', () => {
    // I49: a cap filled in the body's own colour read as more of its
    // outside, so cut fins looked like shorter fins.
    const mesh = new THREE.Mesh(
      box(),
      new THREE.MeshPhongMaterial({ color: '#e1a948' })
    );
    const root = new THREE.Group().add(mesh);
    applySectionPlane(root, xy());
    const cap = capOf(mesh)!;
    expect(cap.material.userData[SECTION_HATCH]).toBe(true);
    const lightness = (color: THREE.Color) =>
      color.getHSL({ h: 0, s: 0, l: 0 }).l;
    expect(lightness(cap.material.color)).toBeLessThan(
      lightness(mesh.material.color) - 0.1
    );
    // Still shaded down after a hover or appearance change re-reads it.
    cap.onBeforeRender(
      ...([] as unknown as Parameters<typeof cap.onBeforeRender>)
    );
    expect(cap.material.color.getHex()).not.toBe(mesh.material.color.getHex());
    const source = THREE.ShaderLib.phong;
    const shader = {
      uniforms: THREE.UniformsUtils.clone(source.uniforms),
      vertexShader: source.vertexShader,
      fragmentShader: source.fragmentShader
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    cap.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('sectionHatchPhase');
    expect(shader.uniforms.sectionHatchPitch).toBeDefined();
    // Its own program: the body's shader is never hatched.
    expect(cap.material.customProgramCacheKey()).not.toBe(
      mesh.material.customProgramCacheKey()
    );
    // A re-applied plane keeps the hatch though `copy` takes the body's
    // userData.
    applySectionPlane(root, xy(2));
    expect(capOf(mesh)!.material.userData[SECTION_HATCH]).toBe(true);
  });
  it('follows blending changes made after the cap was built', () => {
    const mesh = new THREE.Mesh(box(), new THREE.MeshPhongMaterial());
    const root = new THREE.Group().add(mesh);
    applySectionPlane(root, xy());
    const cap = capOf(mesh)!;
    const render = () =>
      cap.onBeforeRender(
        ...([] as unknown as Parameters<typeof cap.onBeforeRender>)
      );
    expect(cap.material.transparent).toBe(false);
    // X-ray scales the body's opacity without re-applying the section.
    updateBodyMaterialOpacity(mesh.material, 0.35);
    const version = cap.material.version;
    render();
    expect(cap.material.opacity).toBe(0.35);
    expect(cap.material.transparent).toBe(true);
    expect(cap.material.depthWrite).toBe(false);
    expect(cap.material.stencilWrite).toBe(false);
    expect(cap.material.version).toBeGreaterThan(version);
    updateBodyMaterialOpacity(mesh.material, 1);
    render();
    expect(cap.material.opacity).toBe(1);
    expect(cap.material.transparent).toBe(false);
    expect(cap.material.depthWrite).toBe(true);
    expect(cap.material.stencilWrite).toBe(true);
  });
});
