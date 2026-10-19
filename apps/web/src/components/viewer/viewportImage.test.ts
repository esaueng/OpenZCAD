import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  captureSamples,
  fitCameraToAspect,
  renderViewportImage,
  type ViewportImageScene
} from './viewportImage';

/** Where a world point lands in normalized device coordinates. */
function ndc(camera: THREE.Camera, point: THREE.Vector3): THREE.Vector3 {
  camera.updateMatrixWorld();
  return point.clone().project(camera);
}

describe('fitCameraToAspect', () => {
  it('keeps everything the view shows when the image is narrower or wider', () => {
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 1000);
    camera.position.set(0, -50, 0);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    // A point on the view's right edge, and one on its top edge.
    const halfHeight = 50 * Math.tan((20 * Math.PI) / 180);
    const right = new THREE.Vector3(halfHeight * (16 / 9), 0, 0);
    const top = new THREE.Vector3(0, 0, halfHeight);
    expect(ndc(camera, right).x).toBeCloseTo(1, 9);

    // Square: narrower, so the right edge stays the right edge.
    let restore = fitCameraToAspect(camera, 1);
    expect(ndc(camera, right).x).toBeCloseTo(1, 9);
    expect(Math.abs(ndc(camera, top).y)).toBeLessThan(1);
    restore();
    expect(camera.aspect).toBeCloseTo(16 / 9, 12);
    expect(camera.fov).toBe(40);

    // Ultra-wide: wider, so the top edge stays the top edge.
    restore = fitCameraToAspect(camera, 4);
    expect(ndc(camera, top).y).toBeCloseTo(1, 9);
    expect(Math.abs(ndc(camera, right).x)).toBeLessThan(1);
    restore();
    expect(ndc(camera, right).x).toBeCloseTo(1, 9);
  });

  it('widens an orthographic frustum the same way and restores it', () => {
    const camera = new THREE.OrthographicCamera(-16, 16, 9, -9, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    let restore = fitCameraToAspect(camera, 1);
    expect([camera.left, camera.right, camera.top, camera.bottom]).toEqual([
      -16, 16, 16, -16
    ]);
    restore();
    expect([camera.left, camera.right, camera.top, camera.bottom]).toEqual([
      -16, 16, 9, -9
    ]);
    restore = fitCameraToAspect(camera, 4);
    expect([camera.left, camera.right, camera.top, camera.bottom]).toEqual([
      -36, 36, 9, -9
    ]);
    restore();
  });
});

/**
 * A renderer that records what the scene render saw. No GL: the capture's
 * scope and restore logic is what is under test, not the driver.
 */
function stubScene() {
  const scene = new THREE.Scene();
  const light = new THREE.AmbientLight();
  const bodies = new THREE.Group();
  const sketches = new THREE.Group();
  const gizmo = new THREE.Group();
  const backdrop = new THREE.Group();
  const grid = new THREE.Group();
  const bodyA = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial({ emissive: 0x112233 })
  );
  const bodyB = new THREE.Mesh(new THREE.BoxGeometry());
  bodyB.visible = false; // hidden in the view
  bodies.add(bodyA, bodyB);
  // A picked face's fill, hung under the body as ModelViewer does.
  const faceOverlay = new THREE.Group();
  faceOverlay.name = 'body-selection-overlay';
  faceOverlay.add(new THREE.Mesh(new THREE.PlaneGeometry()));
  bodyA.add(faceOverlay);
  const taggedFill = new THREE.Mesh(new THREE.PlaneGeometry());
  taggedFill.userData.selectionOverlay = true;
  bodyA.add(taggedFill);
  // An edge batch with a selection: suspended for the picture.
  const edgeBatch = Object.assign(new THREE.Group(), {
    suspended: false,
    suspendHighlights() {
      edgeBatch.suspended = true;
      return () => {
        edgeBatch.suspended = false;
      };
    }
  });
  bodyA.add(edgeBatch);
  scene.add(backdrop, grid, light, bodies, sketches, gizmo);
  const seen: Record<string, boolean | number>[] = [];
  const renderer = {
    capabilities: { maxTextureSize: 4096, maxSamples: 4 },
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { needsUpdate: false },
    getClearColor: (color: THREE.Color) => color.set(0x0b0c0f),
    getClearAlpha: () => 1,
    setClearColor: vi.fn(),
    getRenderTarget: () => null,
    setRenderTarget: vi.fn(),
    clear: vi.fn(),
    render: vi.fn((object: THREE.Object3D) => {
      if (object !== scene) return;
      seen.push({
        bodyA: bodyA.visible,
        bodyB: bodyB.visible,
        sketches: sketches.visible,
        gizmo: gizmo.visible,
        backdrop: backdrop.visible,
        grid: grid.visible,
        shadowUpdate: renderer.shadowMap.needsUpdate,
        faceOverlay: faceOverlay.visible,
        taggedFill: taggedFill.visible,
        edgesSuspended: edgeBatch.suspended,
        colorsEmphasized: emphasized,
        emissive: bodyA.material.emissive.getHex()
      });
    }),
    readRenderTargetPixels: vi.fn()
  };
  const refreshShadowMap = vi.fn();
  // Stands in for the viewer's undo of the selection's context dimming.
  let emphasized = false;
  const emphasizeBodyColors = vi.fn(() => {
    emphasized = true;
    return () => {
      emphasized = false;
    };
  });
  const camera = new THREE.PerspectiveCamera(40, 2, 0.1, 100);
  const parts: ViewportImageScene = {
    renderer: renderer as unknown as THREE.WebGLRenderer,
    scene,
    camera,
    backdrop,
    grid: [grid],
    content: [light, bodies, sketches],
    sketches: [sketches],
    objectsByBodyId: new Map<string, THREE.Object3D>([
      ['a', bodyA],
      ['b', bodyB]
    ]),
    refreshShadowMap,
    emphasizeBodyColors
  };
  return {
    parts,
    seen,
    bodyA,
    bodyB,
    sketches,
    gizmo,
    renderer,
    faceOverlay,
    taggedFill,
    edgeBatch,
    grid,
    refreshShadowMap,
    emphasizeBodyColors,
    isEmphasized: () => emphasized
  };
}

describe('renderViewportImage', () => {
  it('draws the view as shown, without UI, and restores everything', () => {
    const stub = stubScene();
    const image = renderViewportImage(stub.parts, {
      width: 32,
      height: 16,
      transparent: true,
      showGrid: false
    });
    expect([image.width, image.height, image.rgba.length]).toEqual([
      32,
      16,
      32 * 16 * 4
    ]);
    expect(stub.seen).toEqual([
      {
        bodyA: true,
        bodyB: false,
        sketches: true,
        gizmo: false,
        backdrop: false,
        grid: false,
        shadowUpdate: false,
        faceOverlay: false,
        taggedFill: false,
        edgesSuspended: true,
        colorsEmphasized: true,
        emissive: 0
      }
    ]);
    expect(stub.edgeBatch.suspended).toBe(false);
    expect(stub.faceOverlay.visible).toBe(true);
    expect(stub.taggedFill.visible).toBe(true);
    expect(stub.bodyA.visible).toBe(true);
    expect(stub.bodyB.visible).toBe(false);
    expect(stub.gizmo.visible).toBe(true);
    expect(stub.bodyA.material.emissive.getHex()).toBe(0x112233);
    expect(stub.refreshShadowMap).not.toHaveBeenCalled();
  });

  it('draws a selected body alone, even one the view hides, with its own shadow', () => {
    const stub = stubScene();
    renderViewportImage(stub.parts, {
      width: 32,
      height: 16,
      transparent: false,
      showGrid: true,
      bodyIds: ['b']
    });
    // The hidden selected body is drawn; the other body and the sketches
    // are not; the shadow map is redrawn for the scoped picture.
    expect(stub.seen[0]).toMatchObject({
      bodyA: false,
      bodyB: true,
      sketches: false,
      backdrop: true,
      grid: true,
      shadowUpdate: true
    });
    expect(stub.bodyA.visible).toBe(true);
    expect(stub.bodyB.visible).toBe(false);
    expect(stub.sketches.visible).toBe(true);
    // ...and the live view rebuilds its map with every body afterwards.
    expect(stub.refreshShadowMap).toHaveBeenCalledTimes(1);
  });

  it('leaves an uncommitted copy projection out of a selected-body image', () => {
    const stub = stubScene();
    const pendingCopy = new THREE.Group();
    // Move's pending copies share the model container but have no committed
    // body identity in objectsByBodyId.
    stub.bodyA.parent!.add(pendingCopy);
    const seen: boolean[] = [];
    const render = stub.renderer.render.getMockImplementation()!;
    stub.renderer.render.mockImplementation((object) => {
      if (object === stub.parts.scene) seen.push(pendingCopy.visible);
      render(object);
    });
    renderViewportImage(stub.parts, {
      width: 32,
      height: 16,
      transparent: true,
      showGrid: false,
      bodyIds: ['a']
    });
    expect(seen).toEqual([false]);
    expect(pendingCopy.visible).toBe(true);
  });
});

describe('captureSamples', () => {
  it('multisamples up to 4K and not above, within the GPU limit', () => {
    expect(captureSamples(3840, 2160, 8)).toBe(4);
    expect(captureSamples(3840, 2160, 2)).toBe(2);
    expect(captureSamples(3841, 2160, 8)).toBe(0);
    expect(captureSamples(8000, 5000, 8)).toBe(0);
  });
});

describe('renderViewportImage grid and colours', () => {
  it('draws the grid when asked even if the viewport has it switched off', () => {
    const stub = stubScene();
    stub.grid.visible = false;
    renderViewportImage(stub.parts, {
      width: 16,
      height: 16,
      transparent: false,
      showGrid: true
    });
    expect(stub.seen[0]).toMatchObject({ grid: true });
    expect(stub.grid.visible).toBe(false);
  });

  it('renders bodies in their own colours, undoing selection dimming, then restores it', () => {
    const stub = stubScene();
    renderViewportImage(stub.parts, {
      width: 16,
      height: 16,
      transparent: false,
      showGrid: false
    });
    expect(stub.seen[0]).toMatchObject({ colorsEmphasized: true });
    expect(stub.emphasizeBodyColors).toHaveBeenCalledTimes(1);
    expect(stub.isEmphasized()).toBe(false);
  });
});
