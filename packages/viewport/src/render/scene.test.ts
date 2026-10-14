import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyStagePalette,
  computeFitPose,
  createAxesGizmo,
  createBodyMaterial,
  createGradientBackdrop,
  createShadowCatcher,
  createStudioGrid,
  DARK_STAGE_PALETTE,
  shouldShowGroundShadow,
  sameBodyPickingTopology,
  sameBodyRenderGeometry,
  updateAxesGizmo,
  updateBodyMaterialOpacity,
  updateStudioGrid,
  VIEWPORT_RENDER_ORDER
} from './scene';
import { reuseRenderBodies } from './scene';
import { boxFullyInView, VIEW_DIRECTIONS } from '../camera/views';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';

function bodyFixture(
  overrides: Partial<BodyRepresentation> = {}
): BodyRepresentation {
  return {
    bodyId: toBodyId('body_appearance'),
    name: 'Appearance body',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: 0,
    color: '#4da3ff',
    exportableStep: true,
    consumed: false,
    volume: 0,
    bbox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 }
    },
    ...overrides
  };
}

describe('analysis publications in the viewport', () => {
  it('preserves the drawing array when quantities and optional proofs arrive', () => {
    const original = bodyFixture({
      topology: { faces: [], edges: [] },
      projectionRevision: {
        session: 'worker',
        geometry: 1,
        topology: 2,
        metadata: 3
      }
    });
    const drawing = [original];
    const measured = {
      ...structuredClone(original),
      volume: 123,
      topology: { faces: [], edges: [], recognizedImportedFeatures: [] }
    };
    expect(reuseRenderBodies(drawing, [measured])).toBe(drawing);
    // Appearance still updates, even when geometry is unchanged.
    const recolored = { ...measured, color: '#ff0000' };
    expect(reuseRenderBodies(drawing, [recolored])[0]).toBe(recolored);
    const moved = {
      ...measured,
      mesh: { ...measured.mesh, vertices: Float32Array.of(1, 2, 3) }
    };
    expect(reuseRenderBodies(drawing, [moved])[0]).toBe(moved);
  });
});

describe('createBodyMaterial', () => {
  it('keeps opaque bodies on the depth-writing path', () => {
    const material = createBodyMaterial(bodyFixture());
    expect(material.transparent).toBe(false);
    expect(material.opacity).toBe(1);
    expect(material.depthWrite).toBe(true);
    expect(material.color.getHexString()).toBe('4da3ff');
    expect(material.stencilWrite).toBe(true);
    expect(material.stencilZPass).toBe(THREE.ReplaceStencilOp);
  });

  it('treats an explicit opacity of 1 as opaque', () => {
    const material = createBodyMaterial(bodyFixture({ opacity: 1 }));
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
  });

  it('blends translucent bodies without writing depth', () => {
    const material = createBodyMaterial(bodyFixture({ opacity: 0.45 }));
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBe(0.45);
    expect(material.depthWrite).toBe(false);
    expect(material.stencilWrite).toBe(false);
  });
});

describe('opacity-only body updates', () => {
  it.each(['phong', 'standard'])(
    'updates %s blending on retained geometry without resetting the drag pose',
    (kind) => {
      const original = bodyFixture({
        projectionRevision: {
          session: 'worker',
          geometry: 1,
          topology: 2,
          metadata: 3
        }
      });
      const translucent = { ...original, opacity: 0.35 };
      const retained = reuseRenderBodies([original], [translucent])[0]!;
      expect(retained).toBe(translucent);
      expect(sameBodyRenderGeometry(original, retained)).toBe(true);
      expect(sameBodyPickingTopology(original, retained)).toBe(true);

      const geometry = new THREE.BoxGeometry();
      const material =
        kind === 'phong'
          ? createBodyMaterial(original)
          : new THREE.MeshStandardMaterial({
              color: original.color,
              stencilWrite: true
            });
      const object = new THREE.Mesh(geometry, material);
      object.position.set(1, 2, 3);
      object.rotation.set(0.1, 0.2, 0.3);
      object.scale.set(2, 3, 4);
      object.updateMatrix();
      const pose = object.matrix.clone();
      const positions = geometry.getAttribute(
        'position'
      ) as THREE.BufferAttribute;
      const vertices = positions.array;
      const positionVersion = positions.version;
      const materialVersion = material.version;

      updateBodyMaterialOpacity(material, retained.opacity ?? 1);
      expect(material.opacity).toBe(0.35);
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      expect(material.stencilWrite).toBe(false);
      expect(material.version).toBe(materialVersion + 1);

      updateBodyMaterialOpacity(material, 0.7);
      expect(material.opacity).toBe(0.7);
      expect(material.version).toBe(materialVersion + 1);

      updateBodyMaterialOpacity(material, 1);
      expect(material.opacity).toBe(1);
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
      expect(material.stencilWrite).toBe(true);
      expect(material.version).toBe(materialVersion + 2);
      expect(object.geometry).toBe(geometry);
      expect(object.material).toBe(material);
      expect(geometry.getAttribute('position')).toBe(positions);
      expect(positions.array).toBe(vertices);
      expect(positions.version).toBe(positionVersion);
      object.updateMatrix();
      expect(object.matrix.equals(pose)).toBe(true);
      geometry.dispose();
      material.dispose();
    }
  );
});

describe('applyStagePalette', () => {
  it('repaints the backdrop, grid, shadow and clear colour in place', () => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(DARK_STAGE_PALETTE.backdropBottom);
    const backdrop = createGradientBackdrop();
    const grid = createStudioGrid();
    const shadowCatcher = createShadowCatcher();
    const backdropMaterial = backdrop.material as THREE.ShaderMaterial;
    const gridMaterial = grid.material as THREE.ShaderMaterial;
    const hex = (material: THREE.ShaderMaterial, name: string) =>
      (material.uniforms[name]!.value as THREE.Color).getHexString();

    applyStagePalette(
      { scene, backdrop, grid, shadowCatcher },
      {
        backdropTop: '#f5f5f5',
        backdropMiddle: '#eeeeee',
        backdropBottom: '#e6e6e6',
        gridMinor: '#c4c4c4',
        gridMajor: '#b0b0b0',
        shadowOpacity: 0.18
      }
    );

    // Same materials, new values: a theme change never relinks a shader.
    expect(backdrop.material).toBe(backdropMaterial);
    expect(hex(backdropMaterial, 'topColor')).toBe('f5f5f5');
    expect(hex(backdropMaterial, 'middleColor')).toBe('eeeeee');
    expect(hex(backdropMaterial, 'bottomColor')).toBe('e6e6e6');
    expect(hex(gridMaterial, 'minorColor')).toBe('c4c4c4');
    expect(hex(gridMaterial, 'majorColor')).toBe('b0b0b0');
    expect((shadowCatcher.material as THREE.ShadowMaterial).opacity).toBe(0.18);
    expect(scene.background.getHexString()).toBe('e6e6e6');

    applyStagePalette({ backdrop, grid, shadowCatcher }, DARK_STAGE_PALETTE);
    expect(hex(backdropMaterial, 'middleColor')).toBe('101215');
    expect(hex(gridMaterial, 'majorColor')).toBe('838d9c');
    expect((shadowCatcher.material as THREE.ShadowMaterial).opacity).toBe(0.55);

    for (const mesh of [backdrop, grid, shadowCatcher]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  });
});

describe('createGradientBackdrop', () => {
  it('dithers the steel stage gradient behind scene geometry', () => {
    const backdrop = createGradientBackdrop();
    const material = backdrop.material as THREE.ShaderMaterial;

    expect(backdrop.name).toBe('gradient-backdrop');
    expect(backdrop.renderOrder).toBeLessThan(VIEWPORT_RENDER_ORDER.BODY_FACE);
    expect(backdrop.frustumCulled).toBe(false);
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(false);
    expect(material.toneMapped).toBe(false);
    expect(material.dithering).toBe(true);
    expect(
      (material.uniforms.topColor!.value as THREE.Color).getHexString()
    ).toBe('171a1f');
    expect(
      (material.uniforms.middleColor!.value as THREE.Color).getHexString()
    ).toBe('101215'); // --color-viewport-bg: the stage the islands float on
    expect(
      (material.uniforms.bottomColor!.value as THREE.Color).getHexString()
    ).toBe('0b0c0f');
    expect(material.uniforms.middleStop!.value).toBe(0.45);
    expect(material.fragmentShader).toContain(
      '#include <dithering_pars_fragment>'
    );
    expect(material.fragmentShader).toContain('#include <colorspace_fragment>');
    expect(material.fragmentShader).toContain('#include <dithering_fragment>');

    backdrop.geometry.dispose();
    material.dispose();
  });
});

function cameraLookingFrom(x: number, y: number, z: number) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

describe('shouldShowGroundShadow', () => {
  it('shows the grounding shadow in oblique and elevation views', () => {
    expect(shouldShowGroundShadow(cameraLookingFrom(10, -10, 10), true)).toBe(
      true
    );
    expect(shouldShowGroundShadow(cameraLookingFrom(0, -10, 0), true)).toBe(
      true
    );
  });

  it('hides the shadow slab in top and bottom views or when the grid is off', () => {
    expect(shouldShowGroundShadow(cameraLookingFrom(0, 0, 10), true)).toBe(
      false
    );
    expect(shouldShowGroundShadow(cameraLookingFrom(0, 0, -10), true)).toBe(
      false
    );
    expect(shouldShowGroundShadow(cameraLookingFrom(10, -10, 10), false)).toBe(
      false
    );
  });
});

describe('updateStudioGrid', () => {
  it('filters unresolved grid directions before they alias', () => {
    const grid = createStudioGrid();
    const material = grid.material as THREE.ShaderMaterial;
    const shader = material.fragmentShader.replace(/\s+/g, ' ');

    expect(shader).toContain('vec2 footprint = max(fwidth(coord)');
    expect(shader).toContain(
      'vec2 resolved = 1.0 - smoothstep( vec2(0.25), vec2(0.5), footprint )'
    );
    expect(shader).toContain(
      'max(coverage.x * resolved.x, coverage.y * resolved.y)'
    );
  });

  it('rescales the lattice a decade at a time as the camera zooms', () => {
    const grid = createStudioGrid();
    const material = grid.material as THREE.ShaderMaterial;
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    const target = new THREE.Vector3();

    camera.position.set(0, -150, 0);
    updateStudioGrid(grid, camera, target);
    const farStep = material.uniforms.minorStep!.value as number;

    camera.position.set(0, -15, 0);
    updateStudioGrid(grid, camera, target);
    const nearStep = material.uniforms.minorStep!.value as number;

    // Steps are exact powers of ten, and a 10x zoom-in refines by one decade.
    expect(Math.log10(farStep) % 1).toBeCloseTo(0);
    expect(nearStep).toBeCloseTo(farStep / 10);
    const fract = material.uniforms.levelFract!.value as number;
    expect(fract).toBeGreaterThanOrEqual(0);
    expect(fract).toBeLessThan(1);
  });

  it('follows the orbit target so the plane never runs out under a pan', () => {
    const grid = createStudioGrid();
    const material = grid.material as THREE.ShaderMaterial;
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    const target = new THREE.Vector3(320, -75, 0);
    camera.position.set(320, -225, 0);

    updateStudioGrid(grid, camera, target);

    expect(grid.position.x).toBe(320);
    expect(grid.position.y).toBe(-75);
    const center = material.uniforms.fadeCenter!.value as THREE.Vector2;
    expect(center.x).toBe(320);
    expect(center.y).toBe(-75);
    // The quad always covers the fade radius, so the falloff — not a geometry
    // edge — ends the grid.
    expect(grid.scale.x).toBeCloseTo(
      material.uniforms.fadeRadius!.value as number
    );
  });
});

describe('updateAxesGizmo', () => {
  it('stretches receding axes far while clamping axes aimed at the camera', () => {
    const axes = createAxesGizmo();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    camera.up.set(0, 0, 1);
    // From (+x, -y, +z), +Y recedes from the camera while +X and +Z angle
    // toward it and must stop short of the camera plane.
    camera.position.set(90, -90, 80);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    updateAxesGizmo(axes, camera);

    const [x, y, z] = axes.children as [THREE.Line, THREE.Line, THREE.Line];
    expect(y.scale.x).toBe(100000);
    // +X and +Z both angle toward the camera from this pose: finite, past the
    // orbit distance (off screen), well short of the far plane.
    const originDepth = camera.position.length();
    for (const clamped of [x, z]) {
      expect(clamped.scale.x).toBeGreaterThan(originDepth);
      expect(clamped.scale.x).toBeLessThan(originDepth * 2);
    }
  });
});

describe('computeFitPose', () => {
  it('keeps the established padding when the default fit already fits', () => {
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 4000);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20));
    const pose = computeFitPose(camera, [mesh]);
    const distance = (10 / Math.tan(THREE.MathUtils.degToRad(22.5))) * 2.1;
    expect(pose.position.distanceTo(pose.target)).toBeCloseTo(distance, 10);
    expect(pose.near).toBeCloseTo(distance / 1000, 10);
    expect(pose.far).toBeCloseTo(distance * 12 + 20 * 4, 10);
  });

  it('lands on the shared iso home orientation', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20));
    const pose = computeFitPose(camera, [mesh]);
    const direction = pose.position.clone().sub(pose.target).normalize();
    expect(direction.distanceTo(VIEW_DIRECTIONS.iso)).toBeLessThan(1e-6);
  });

  it('falls back to the iso orientation for an empty scene', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    const pose = computeFitPose(camera, []);
    const direction = pose.position.clone().normalize();
    expect(direction.distanceTo(VIEW_DIRECTIONS.iso)).toBeLessThan(1e-6);
  });

  it('keeps a given view direction, framing everything from there', () => {
    // An automatic reframe backs off along the user's own view instead of
    // spinning the model to iso, and the result has every body in frame.
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 4000);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(80, 40, 5));
    plate.position.set(40, 20, 2.5);
    const flange = new THREE.Mesh(new THREE.BoxGeometry(80, 5, 40));
    flange.position.set(40, 2.5, 20);
    const objects = [plate, flange];
    for (const object of objects) object.updateMatrixWorld();
    const looking = new THREE.Vector3(-1, -2, 0.6).normalize();
    const pose = computeFitPose(
      camera,
      objects,
      looking.clone().multiplyScalar(7)
    );
    const direction = pose.position.clone().sub(pose.target).normalize();
    expect(direction.distanceTo(looking)).toBeLessThan(1e-6);

    camera.position.copy(pose.position);
    camera.near = pose.near;
    camera.far = pose.far;
    camera.lookAt(pose.target);
    camera.updateProjectionMatrix();
    const box = new THREE.Box3();
    for (const object of objects) box.expandByObject(object);
    expect(boxFullyInView(box, camera, 0.05)).toBe(true);
  });

  it.each([
    {
      name: 'portrait front',
      aspect: 375 / 900,
      direction: new THREE.Vector3(0, -1, 0)
    },
    {
      name: 'narrow oblique',
      aspect: 0.2,
      direction: new THREE.Vector3(1, -2, 1)
    },
    {
      name: 'portrait top',
      aspect: 375 / 900,
      direction: new THREE.Vector3(0, 0, 1)
    }
  ])(
    'fits every corner with the requested margin from $name',
    ({ aspect, direction }) => {
      const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 4000);
      camera.up.set(0, 0, 1);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(80, 5, 40));
      mesh.position.set(40, 2.5, 20);
      mesh.updateMatrixWorld();
      const pose = computeFitPose(camera, [mesh], direction, 0.04);
      expect(
        pose.position
          .clone()
          .sub(pose.target)
          .normalize()
          .distanceTo(direction.clone().normalize())
      ).toBeLessThan(1e-6);
      camera.position.copy(pose.position);
      camera.near = pose.near;
      camera.far = pose.far;
      camera.lookAt(pose.target);
      camera.updateProjectionMatrix();
      const box = new THREE.Box3().setFromObject(mesh);
      expect(boxFullyInView(box, camera, 0.04)).toBe(true);

      // The controller mirrors this perspective pose into an orthographic
      // frustum on a projection switch. The same fit must remain complete.
      const halfHeight =
        pose.position.distanceTo(pose.target) *
        Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const orthographic = new THREE.OrthographicCamera(
        -halfHeight * aspect,
        halfHeight * aspect,
        halfHeight,
        -halfHeight,
        0.1,
        pose.far
      );
      orthographic.position.copy(pose.position);
      orthographic.up.copy(camera.up);
      orthographic.lookAt(pose.target);
      orthographic.updateProjectionMatrix();
      expect(boxFullyInView(box, orthographic, 0.04)).toBe(true);
    }
  );
});

describe('computeFitPose into a clear frame', () => {
  // The drawer covers the right of a 1024-wide canvas: the clear stage is
  // NDC x in [-1, 0.2]. Fit must land the part there, not behind the drawer.
  const frame = { minX: -1, maxX: 0.2, minY: -1, maxY: 1 };

  function projectCorners(camera: THREE.Camera, box: THREE.Box3) {
    camera.updateMatrixWorld();
    const corners: THREE.Vector3[] = [];
    for (let index = 0; index < 8; index += 1) {
      corners.push(
        new THREE.Vector3(
          index & 1 ? box.max.x : box.min.x,
          index & 2 ? box.max.y : box.min.y,
          index & 4 ? box.max.z : box.min.z
        ).project(camera)
      );
    }
    return corners;
  }

  function landOn(
    camera: THREE.PerspectiveCamera,
    pose: ReturnType<typeof computeFitPose>
  ) {
    camera.position.copy(pose.position);
    camera.near = pose.near;
    camera.far = pose.far;
    camera.up.set(0, 0, 1);
    camera.lookAt(pose.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  it.each([
    { name: 'oblique', direction: new THREE.Vector3(-1, -2, 0.6) },
    { name: 'front', direction: new THREE.Vector3(0, -1, 0) },
    { name: 'top', direction: VIEW_DIRECTIONS.top.clone() },
    { name: 'iso', direction: VIEW_DIRECTIONS.iso.clone() }
  ])(
    'keeps the $name direction and puts every corner inside the frame',
    ({ direction }) => {
      const camera = new THREE.PerspectiveCamera(45, 1024 / 704, 0.1, 4000);
      camera.up.set(0, 0, 1);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(100, 60, 6));
      plate.position.set(50, 30, 3);
      plate.updateMatrixWorld();
      const pose = computeFitPose(camera, [plate], direction, 0, frame);

      expect(
        pose.position
          .clone()
          .sub(pose.target)
          .normalize()
          .distanceTo(direction.clone().normalize())
      ).toBeLessThan(1e-6);

      landOn(camera, pose);
      const box = new THREE.Box3().setFromObject(plate);
      const center = box.getCenter(new THREE.Vector3()).project(camera);
      expect(center.x).toBeCloseTo(-0.4, 6);
      expect(center.y).toBeCloseTo(0, 6);
      for (const corner of projectCorners(camera, box)) {
        expect(corner.x).toBeGreaterThanOrEqual(frame.minX - 1e-9);
        expect(corner.x).toBeLessThanOrEqual(frame.maxX + 1e-9);
        expect(Math.abs(corner.y)).toBeLessThanOrEqual(1 + 1e-9);
        expect(corner.z).toBeGreaterThanOrEqual(-1);
        expect(corner.z).toBeLessThanOrEqual(1);
      }

      // The orthographic mirror of the pose: the frustum spans the
      // perspective view at the target, as `syncOrthographic` builds it.
      const halfHeight =
        pose.position.distanceTo(pose.target) *
        Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const orthographic = new THREE.OrthographicCamera(
        -halfHeight * camera.aspect,
        halfHeight * camera.aspect,
        halfHeight,
        -halfHeight,
        -2000,
        pose.far
      );
      orthographic.position.copy(pose.position);
      orthographic.quaternion.copy(camera.quaternion);
      orthographic.updateProjectionMatrix();
      for (const corner of projectCorners(orthographic, box)) {
        expect(corner.x).toBeGreaterThanOrEqual(frame.minX - 1e-9);
        expect(corner.x).toBeLessThanOrEqual(frame.maxX + 1e-9);
        expect(Math.abs(corner.y)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  );

  it('keeps the target on the view axis at the model centre depth', () => {
    const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 4000);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20));
    mesh.position.set(5, -3, 8);
    mesh.updateMatrixWorld();
    const direction = new THREE.Vector3(1, -1, 0.4).normalize();
    const pose = computeFitPose(camera, [mesh], direction, 0, frame);
    const center = new THREE.Vector3(5, -3, 8);
    // Sliding sideways leaves the target in the plane through the model
    // centre perpendicular to the view, where `pivotOn` would put it.
    expect(pose.target.clone().sub(center).dot(direction)).toBeCloseTo(0, 9);
    expect(pose.target.distanceTo(center)).toBeGreaterThan(1);
  });

  it('matches the unframed fit for the whole canvas', () => {
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 4000);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(80, 5, 40));
    mesh.position.set(40, 2.5, 20);
    mesh.updateMatrixWorld();
    const direction = new THREE.Vector3(1, -2, 1);
    const plain = computeFitPose(camera, [mesh], direction, 0.04);
    const framed = computeFitPose(camera, [mesh], direction, 0.04, {
      minX: -1,
      maxX: 1,
      minY: -1,
      maxY: 1
    });
    expect(framed.position.distanceTo(plain.position)).toBeLessThan(1e-9);
    expect(framed.target.distanceTo(plain.target)).toBeLessThan(1e-9);
  });

  it('backs off further for a narrower frame', () => {
    // Portrait, and long in X, so the width rather than the established
    // padding sets the fit.
    const camera = new THREE.PerspectiveCamera(45, 0.5, 0.1, 4000);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(300, 10, 10));
    bar.updateMatrixWorld();
    const front = new THREE.Vector3(0, -1, 0);
    const whole = computeFitPose(camera, [bar], front);
    const narrow = computeFitPose(camera, [bar], front, 0, frame);
    expect(narrow.position.distanceTo(narrow.target)).toBeGreaterThan(
      whole.position.distanceTo(whole.target) * 1.5
    );
  });
});

describe('boxFullyInView', () => {
  function cameraAt(position: THREE.Vector3) {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    camera.position.copy(position);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    return camera;
  }
  const box = new THREE.Box3(
    new THREE.Vector3(-5, -5, -5),
    new THREE.Vector3(5, 5, 5)
  );

  it('accepts a box the camera sees whole', () => {
    expect(boxFullyInView(box, cameraAt(new THREE.Vector3(0, -80, 0)))).toBe(
      true
    );
  });

  it('refuses a box that reaches past an edge of the view', () => {
    const tall = box.clone().expandByPoint(new THREE.Vector3(0, 0, 60));
    expect(boxFullyInView(tall, cameraAt(new THREE.Vector3(0, -80, 0)))).toBe(
      false
    );
  });

  it('refuses a box behind the camera', () => {
    const camera = cameraAt(new THREE.Vector3(0, -80, 0));
    const behind = box.clone().translate(new THREE.Vector3(0, -200, 0));
    expect(boxFullyInView(behind, camera)).toBe(false);
  });

  it('counts the margin as off screen', () => {
    // At this distance the box spans most of the view; a wide margin no
    // longer leaves it room.
    const camera = cameraAt(new THREE.Vector3(0, -30, 0));
    expect(boxFullyInView(box, camera, 0)).toBe(true);
    expect(boxFullyInView(box, camera, 0.6)).toBe(false);
  });

  it('works through an orthographic camera', () => {
    const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 500);
    camera.position.set(0, -80, 0);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    expect(boxFullyInView(box, camera)).toBe(true);
    camera.zoom = 5;
    camera.updateProjectionMatrix();
    expect(boxFullyInView(box, camera)).toBe(false);
  });
});
