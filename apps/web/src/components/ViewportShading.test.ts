import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  aimCameraKey,
  applySectionPlane,
  createCameraKeyLight,
  createBodyMaterial,
  createFatLineMaterial,
  createObjectForBody,
  createStudioHemisphereLight,
  isBodyMaterial,
  sectionClippingPlane,
  STUDIO_RIG,
  shouldRenderTopologyEdge,
  VIEWPORT_RENDER_ORDER
} from '@openzcad/viewport';
import {
  toBodyId,
  type BodyRepresentation,
  type BodyTopology,
  type MeshGeometry
} from '@openzcad/shared';

function bodyWithMesh(
  mesh: MeshGeometry,
  topology?: BodyTopology,
  source: BodyRepresentation['source'] = 'primitive'
): BodyRepresentation {
  return {
    bodyId: toBodyId('body_shading_test'),
    name: 'Shading test',
    source,
    mesh,
    faceCount: 2,
    color: '#356dff',
    exportableStep: true,
    consumed: false,
    volume: 1,
    bbox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 }
    },
    topology
  };
}

function renderedGeometry(
  mesh: MeshGeometry,
  topology?: BodyTopology
): THREE.BufferGeometry {
  return (createObjectForBody(bodyWithMesh(mesh, topology)) as THREE.Mesh)
    .geometry;
}

describe('CAD viewport shading', () => {
  it('splits normals across hard face boundaries', () => {
    const geometry = renderedGeometry({
      kind: 'mesh',
      vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 3, 1])
    });
    const normals = geometry.getAttribute('normal');
    const renderedIndices = Array.from(geometry.getIndex()!.array);

    expect(normals.count).toBe(6);
    expect(renderedIndices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      new THREE.Vector3().fromBufferAttribute(normals, 0).toArray()
    ).toEqual([0, 0, 1]);
    expect(
      new THREE.Vector3().fromBufferAttribute(normals, 3).toArray()
    ).toEqual([0, 1, 0]);
  });

  it('keeps shallow curved tessellation visually smooth', () => {
    const angle = THREE.MathUtils.degToRad(20);
    const geometry = renderedGeometry({
      kind: 'mesh',
      vertices: Float32Array.from([
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        Math.cos(angle),
        Math.sin(angle)
      ]),
      indices: Uint32Array.from([0, 1, 2, 0, 1, 3])
    });
    const normals = geometry.getAttribute('normal');
    const renderedIndices = Array.from(geometry.getIndex()!.array);
    const firstSharedNormal = new THREE.Vector3().fromBufferAttribute(
      normals,
      0
    );
    const secondSharedNormal = new THREE.Vector3().fromBufferAttribute(
      normals,
      1
    );

    expect(normals.count).toBe(4);
    expect(renderedIndices).toEqual([0, 1, 2, 0, 1, 3]);
    expect(firstSharedNormal.x).toBeCloseTo(0, 6);
    expect(firstSharedNormal.y).toBeCloseTo(-Math.sin(angle / 2), 6);
    expect(firstSharedNormal.z).toBeCloseTo(Math.cos(angle / 2), 6);
    expect(secondSharedNormal.toArray()).toEqual(firstSharedNormal.toArray());
  });

  it('uses exact B-rep face boundaries as shading creases', () => {
    const angle = THREE.MathUtils.degToRad(20);
    const mesh: MeshGeometry = {
      kind: 'mesh',
      vertices: Float32Array.from([
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        Math.cos(angle),
        Math.sin(angle)
      ]),
      indices: Uint32Array.from([0, 1, 2, 0, 1, 3])
    };
    const geometry = renderedGeometry(mesh, {
      faces: [
        {
          topologyId: 'face:1',
          hash: 1,
          triangleStart: 0,
          triangleCount: 1
        },
        {
          topologyId: 'face:2',
          hash: 2,
          triangleStart: 1,
          triangleCount: 1
        }
      ],
      edges: []
    });

    expect(geometry.getAttribute('normal').count).toBe(6);
    expect(Array.from(geometry.getIndex()!.array)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('shades across a tangent face boundary as one smooth surface', () => {
    // Two faces of one smooth surface split at a seam (a sphere's equator, a
    // fillet's rim) meet at a few degrees on the display mesh. Creased, each
    // side kept its own normal and the seam showed as a faint ring (U10).
    const angle = THREE.MathUtils.degToRad(4);
    const mesh: MeshGeometry = {
      kind: 'mesh',
      vertices: Float32Array.from([
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        -Math.cos(angle),
        Math.sin(angle)
      ]),
      indices: Uint32Array.from([0, 1, 2, 1, 0, 3])
    };
    const faces = [
      { topologyId: 'face:1', hash: 1, triangleStart: 0, triangleCount: 1 },
      { topologyId: 'face:2', hash: 2, triangleStart: 1, triangleCount: 1 }
    ];
    const geometry = renderedGeometry(mesh, { faces, edges: [] });

    // The two shared corners each become one render vertex with one normal.
    expect(geometry.getAttribute('normal').count).toBe(4);
    const index = Array.from(geometry.getIndex()!.array);
    expect(index[0]).toBe(index[4]);
    expect(index[1]).toBe(index[3]);
  });

  it('uses the studio satin material for CAD solids', () => {
    const body = bodyWithMesh({
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    });
    const material = createBodyMaterial(body);
    const object = createObjectForBody(body) as THREE.Mesh;

    // Physically based so the studio environment reaches it (U10): Phong
    // ignores scene.environment, which left every face in one narrow band.
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(isBodyMaterial(material)).toBe(true);
    expect(material.roughness).toBe(STUDIO_RIG.material.roughness);
    expect(material.metalness).toBe(0);
    expect(material.dithering).toBe(true);
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.polygonOffset).toBe(true);
    expect(material.polygonOffsetFactor).toBe(1);
    expect(material.polygonOffsetUnits).toBe(1);
    expect(object.castShadow).toBe(true);
    expect(object.receiveShadow).toBe(false);
    expect(object.renderOrder).toBe(VIEWPORT_RENDER_ORDER.BODY_FACE);
  });

  it('keeps coincident line overlays depth-aware without sharing depth writes', () => {
    const bodyEdge = createFatLineMaterial({
      color: '#151c26',
      linewidth: 1.4
    });
    const sketchCurve = createFatLineMaterial({
      color: '#4da3ff',
      linewidth: 1.4
    });

    expect(bodyEdge.depthTest).toBe(true);
    expect(sketchCurve.depthTest).toBe(true);
    expect(bodyEdge.depthWrite).toBe(false);
    expect(sketchCurve.depthWrite).toBe(false);
    expect(VIEWPORT_RENDER_ORDER.BODY_FACE).toBeLessThan(
      VIEWPORT_RENDER_ORDER.BODY_EDGE
    );
    expect(VIEWPORT_RENDER_ORDER.BODY_EDGE).toBeLessThan(
      VIEWPORT_RENDER_ORDER.SKETCH_CURVE
    );
    expect(VIEWPORT_RENDER_ORDER.SKETCH_CURVE).toBeLessThan(
      VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT
    );
    expect(VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT).toBeLessThan(
      VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY
    );
    expect(VIEWPORT_RENDER_ORDER.SELECTED_GEOMETRY).toBeLessThan(
      VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH
    );
  });

  it('puts fallback body edges on the body-edge render layer', () => {
    const object = createObjectForBody(
      bodyWithMesh({
        kind: 'mesh',
        vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: Uint32Array.from([0, 1, 2])
      })
    );
    const edgeOverlay = object.children[0];

    expect(edgeOverlay?.renderOrder).toBe(VIEWPORT_RENDER_ORDER.BODY_EDGE);
  });

  it('keeps periodic B-Rep seams out of the visible edge overlay', () => {
    const points = [0, 0, 0, 0, 0, 10];

    expect(
      shouldRenderTopologyEdge({
        topologyId: 'edge:feature',
        hash: 1,
        displayRole: 'feature',
        points
      })
    ).toBe(true);
    expect(
      shouldRenderTopologyEdge({
        topologyId: 'edge:seam',
        hash: 2,
        displayRole: 'seam',
        points
      })
    ).toBe(false);
  });

  it('uses kernel-oriented front faces for imported STEP solids', () => {
    const material = createBodyMaterial(
      bodyWithMesh(
        {
          kind: 'mesh',
          vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: Uint32Array.from([0, 2, 1])
        },
        undefined,
        'imported-step'
      )
    );

    expect(material.side).toBe(THREE.FrontSide);
  });

  it('section plane clips every material and relaxes culling while active', () => {
    const object = createObjectForBody(
      bodyWithMesh({
        kind: 'mesh',
        vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: Uint32Array.from([0, 1, 2])
      })
    );
    const group = new THREE.Group();
    group.add(object);

    const plane = sectionClippingPlane({ plane: 'XY', offset: 2 });
    // Negative signed distance is clipped, so the XY section's normal points
    // down Z and everything above the offset is cut away.
    expect(plane.normal.toArray()).toEqual([0, 0, -1]);
    expect(plane.constant).toBe(2);

    applySectionPlane(group, plane);
    let materials = 0;
    group.traverse((child) => {
      const material = (child as THREE.Mesh).material as
        THREE.Material | undefined;
      if (!material || Array.isArray(material)) {
        return;
      }
      materials += 1;
      expect(material.clippingPlanes).toEqual([plane]);
      expect(material.clipShadows).toBe(true);
      if (isBodyMaterial(material)) {
        expect(material.side).toBe(THREE.DoubleSide);
      }
    });
    // The body mesh plus its fallback edge overlay both took the plane.
    expect(materials).toBeGreaterThanOrEqual(2);

    applySectionPlane(group, null);
    group.traverse((child) => {
      const material = (child as THREE.Mesh).material as
        THREE.Material | undefined;
      if (!material || Array.isArray(material)) {
        return;
      }
      expect(material.clippingPlanes).toBeNull();
      expect(material.clipShadows).toBe(false);
      if (isBodyMaterial(material)) {
        // The orientation canary returns as soon as the section clears.
        expect(material.side).toBe(THREE.FrontSide);
      }
    });
  });

  it('keeps a dark floor bounce so undersides separate from walls', () => {
    const light = createStudioHemisphereLight();

    // A ground colour almost as bright as the sky (the old #e2e8f0 against
    // #d7e6f7) lifted walls and undersides to the tops' value.
    expect(light.groundColor.getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(
      light.color.getHSL({ h: 0, s: 0, l: 0 }).l * 0.4
    );
    expect(light.intensity).toBe(STUDIO_RIG.hemisphere.intensity);
    expect(light.position.toArray()).toEqual([0, 0, 1]);
  });

  it('turns the key light with the camera', () => {
    const light = createCameraKeyLight();
    expect(light.castShadow).toBe(false);
    const front = light.position.clone();
    // Orbit half a turn about Z: the light swings round with the camera.
    const orbit = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI
    );
    aimCameraKey(light, orbit);
    expect(light.position.x).toBeCloseTo(-front.x, 6);
    expect(light.position.y).toBeCloseTo(-front.y, 6);
    expect(light.position.z).toBeCloseTo(front.z, 6);
  });
});
