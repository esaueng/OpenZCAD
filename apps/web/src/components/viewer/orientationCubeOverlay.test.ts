import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { AxisProjection } from '@openzcad/viewport';
import { DARK_CUBE_PALETTE } from '../../lib/stagePalette';
import { projectCube } from './orientationCube';
import { OrientationCubeOverlay } from './orientationCubeOverlay';

/** Looking straight at the front face: +X right, +Z up, +Y into the screen. */
const FRONT: AxisProjection = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 0, z: -1 },
  z: { x: 0, y: -1, z: 0 }
};

/** The parts of WebGLRenderer the overlay touches, recording what it does. */
function stubRenderer(pixelRatio = 2, bufferHeight = 1000) {
  const viewport = new THREE.Vector4(0, 0, 800, 500);
  const calls: { viewport: THREE.Vector4; scene: THREE.Scene }[] = [];
  const renderer = {
    autoClear: true,
    shadowMap: { needsUpdate: true },
    capabilities: { getMaxAnisotropy: () => 8 },
    getPixelRatio: () => pixelRatio,
    getDrawingBufferSize: (target: THREE.Vector2) =>
      target.set(1600, bufferHeight),
    getViewport: (target: THREE.Vector4) => target.copy(viewport),
    setViewport: vi.fn(
      (x: number | THREE.Vector4, y?: number, w?: number, h?: number) => {
        if (x instanceof THREE.Vector4) viewport.copy(x);
        else viewport.set(x, y ?? 0, w ?? 0, h ?? 0);
      }
    ),
    render: vi.fn((scene: THREE.Scene) => {
      expect(renderer.autoClear).toBe(false);
      calls.push({ viewport: viewport.clone(), scene });
    })
  };
  return {
    renderer: renderer as unknown as THREE.WebGLRenderer,
    stub: renderer,
    calls,
    viewport
  };
}

/** The first vertex colour of the facet batch: the first face's fill. */
function firstFacetFill(scene: THREE.Scene) {
  const mesh = scene.children.find(
    (child): child is THREE.Mesh =>
      child instanceof THREE.Mesh && child.renderOrder === 2
  );
  const color = mesh?.geometry.getAttribute('color');
  if (!color) throw new Error('no facet batch');
  return [color.getX(0), color.getY(0), color.getZ(0)];
}

function linear(hex: string) {
  const color = new THREE.Color(hex);
  return [color.r, color.g, color.b];
}

describe('OrientationCubeOverlay', () => {
  it('draws over the cube box on whole device pixels and restores state', () => {
    const overlay = new OrientationCubeOverlay(DARK_CUBE_PALETTE);
    const { renderer, stub, calls, viewport } = stubRenderer();
    overlay.render(renderer, projectCube(FRONT), {
      left: 700.3,
      top: 20.6,
      width: 88
    });

    expect(calls).toHaveLength(1);
    const drawn = calls[0]!.viewport;
    // Every edge lands on a device pixel at DPR 2, and the box plus its
    // margin for the triad's tips is inside the viewport.
    for (const value of [drawn.x, drawn.y, drawn.z, drawn.w]) {
      expect(Number.isInteger(value * 2)).toBe(true);
    }
    expect(drawn.x).toBeLessThanOrEqual(700.3 - 24);
    expect(drawn.x + drawn.z).toBeGreaterThanOrEqual(700.3 + 88 + 24);
    // y counts from the bottom of the 500 px (1000 device px) buffer.
    expect(500 - (drawn.y + drawn.w)).toBeLessThanOrEqual(20.6 - 24);

    // The frame's own viewport, clear and pending shadow refresh survive.
    expect(viewport.toArray()).toEqual([0, 0, 800, 500]);
    expect(stub.autoClear).toBe(true);
    expect(stub.shadowMap.needsUpdate).toBe(true);
    overlay.dispose();
  });

  it('draws nothing while the cube has no box on the page', () => {
    const overlay = new OrientationCubeOverlay(DARK_CUBE_PALETTE);
    const { renderer, calls } = stubRenderer();
    overlay.render(renderer, projectCube(FRONT), { left: 0, top: 0, width: 0 });
    expect(calls).toHaveLength(0);
    overlay.dispose();
  });

  it('lights a head-on face frontal and fades it to the hover fill', () => {
    const overlay = new OrientationCubeOverlay(DARK_CUBE_PALETTE);
    const { renderer, calls } = stubRenderer();
    const projection = projectCube(FRONT);
    // Head-on, only the front face (FACES index 3) shows.
    expect(projection.faces.filter(Boolean)).toHaveLength(1);
    expect(projection.faces[3]?.facing).toBeCloseTo(1);

    overlay.render(renderer, projection, { left: 0, top: 0, width: 88 });
    const scene = calls[0]!.scene;
    firstFacetFill(scene).forEach((value, channel) =>
      expect(value).toBeCloseTo(linear(DARK_CUBE_PALETTE.frontal)[channel]!, 4)
    );

    overlay.setHighlight({
      hovered: { kind: 'face', index: 3 },
      focusVisible: null
    });
    // Halfway through the 100 ms fade it is still moving.
    expect(overlay.step(50, false)).toBe(true);
    expect(overlay.step(60, false)).toBe(false);
    overlay.render(renderer, projection, { left: 0, top: 0, width: 88 });
    firstFacetFill(scene).forEach((value, channel) =>
      expect(value).toBeCloseTo(linear(DARK_CUBE_PALETTE.hover)[channel]!, 4)
    );

    // Reduced motion lands the fade back in one step.
    overlay.setHighlight({ hovered: null, focusVisible: null });
    expect(overlay.step(1, true)).toBe(false);
    overlay.dispose();
  });

  it('takes a new palette without rebuilding anything', () => {
    const overlay = new OrientationCubeOverlay(DARK_CUBE_PALETTE);
    const { renderer, calls } = stubRenderer();
    overlay.setPalette({ ...DARK_CUBE_PALETTE, frontal: '#ffffff' });
    overlay.render(renderer, projectCube(FRONT), {
      left: 0,
      top: 0,
      width: 88
    });
    firstFacetFill(calls[0]!.scene).forEach((value) =>
      expect(value).toBeCloseTo(1, 4)
    );
    overlay.dispose();
  });
});
