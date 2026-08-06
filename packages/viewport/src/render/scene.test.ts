import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  computeFitPose,
  createAxesGizmo,
  createBodyMaterial,
  createStudioGrid,
  shouldShowGroundShadow,
  updateAxesGizmo,
  updateStudioGrid
} from './scene';
import { VIEW_DIRECTIONS } from '../camera/views';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';

function bodyFixture(
  overrides: Partial<BodyRepresentation> = {}
): BodyRepresentation {
  return {
    bodyId: toBodyId('body_appearance'),
    name: 'Appearance body',
    source: 'primitive',
    mesh: { kind: 'mesh', vertices: [], indices: [] },
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
});
