import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  computeFitPose,
  createAxesGizmo,
  createBodyMaterial,
  createGradientBackdrop,
  createStudioGrid,
  shouldShowGroundShadow,
  updateAxesGizmo,
  updateStudioGrid,
  VIEWPORT_RENDER_ORDER
} from './scene';
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
