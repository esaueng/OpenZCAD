import * as THREE from 'three';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { InteractionShaderWarmup } from './interactionShaderWarmup';

function fixture() {
  const scene = new THREE.Scene();
  const light = new THREE.DirectionalLight();
  light.castShadow = true;
  scene.add(light);
  scene.environment = new THREE.Texture();
  scene.environmentRotation.set(0, 1, 0);
  const camera = new THREE.PerspectiveCamera();
  const faces = [
    new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshLambertMaterial({
        transparent: true,
        side: THREE.DoubleSide
      })
    ),
    new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        transparent: true,
        side: THREE.DoubleSide
      })
    )
  ];
  const edges = [new THREE.Mesh(), new THREE.Mesh()];
  const renderer = {
    compileAsync: vi.fn().mockResolvedValue(undefined),
    render: vi.fn(),
    autoClear: true,
    shadowMap: { autoUpdate: true, needsUpdate: true }
  };
  const warmup = new InteractionShaderWarmup(
    renderer as unknown as THREE.WebGLRenderer,
    scene
  );
  return { warmup, renderer, scene, camera, faces, edges };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('InteractionShaderWarmup', () => {
  it('prepares the real face/line variants and first use without drawing or clearing the model', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const borrowedDispose = vi.spyOn(f.faces[0]!.material, 'dispose');
    f.warmup.schedule(f.camera, f.faces, f.edges);
    f.warmup.schedule(f.camera, f.faces, f.edges);
    expect(f.renderer.compileAsync).not.toHaveBeenCalled();
    f.renderer.render.mockImplementation((scene: THREE.Scene) => {
      expect(f.renderer.autoClear).toBe(false);
      expect(f.renderer.shadowMap).toMatchObject({
        autoUpdate: false,
        needsUpdate: false
      });
      const meshes = scene.children.filter(
        (child): child is THREE.Mesh<THREE.BufferGeometry, THREE.Material> =>
          child instanceof THREE.Mesh
      );
      expect(meshes).toHaveLength(6);
      expect(meshes.filter((mesh) => mesh.visible)).toHaveLength(1);
      for (const mesh of meshes) {
        expect(mesh.geometry.drawRange).toEqual({ start: 1, count: 0 });
        expect(mesh.geometry.getAttribute('position').count).toBe(0);
        expect(mesh.frustumCulled).toBe(false);
        expect(mesh.geometry.hasAttribute('position')).toBe(true);
      }
      expect(
        meshes.map((mesh) => mesh.geometry.hasAttribute('normal'))
      ).toEqual([true, true, true, true, false, false]);
      expect(
        meshes.slice(0, 4).map((mesh) => mesh.material.side)
      ).toEqual([
        THREE.BackSide,
        THREE.FrontSide,
        THREE.BackSide,
        THREE.FrontSide
      ]);
      expect(meshes[0]!.material).not.toBe(f.faces[0]!.material);
      expect(meshes[4]!.material).not.toBe(f.edges[0]!.material);
      expect(scene.environment).toBe(f.scene.environment);
      expect(
        scene.environmentRotation.equals(f.scene.environmentRotation)
      ).toBe(true);
      expect(
        scene.children.filter((child) => child instanceof THREE.Light)
      ).toHaveLength(1);
    });
    await vi.runAllTimersAsync();
    expect(f.renderer.compileAsync).toHaveBeenCalledOnce();
    expect(f.renderer.render).toHaveBeenCalledTimes(6);
    expect(f.renderer.autoClear).toBe(true);
    expect(f.renderer.shadowMap).toEqual({
      autoUpdate: true,
      needsUpdate: true
    });
    expect(f.scene.children).toHaveLength(1);
    expect(f.faces[0]!.geometry.hasAttribute('normal')).toBe(false);
    expect(borrowedDispose).not.toHaveBeenCalled();
    f.warmup.dispose();
    expect(borrowedDispose).not.toHaveBeenCalled();
  });

  it('retains cloned edge programs through rebuilds and releases each owner once', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const disposals: MockInstance<THREE.Material['dispose']>[] = [];
    f.renderer.compileAsync.mockImplementation((scene: THREE.Scene) => {
      for (const child of scene.children) {
        if (
          child instanceof THREE.Mesh &&
          !f.faces.some((face) => face.material === child.material)
        ) {
          disposals.push(vi.spyOn(child.material as THREE.Material, 'dispose'));
        }
      }
      return Promise.resolve();
    });
    f.warmup.schedule(f.camera, f.faces, f.edges);
    await vi.runAllTimersAsync();
    f.edges.forEach((edge) => (edge.material as THREE.Material).dispose());
    expect(disposals).toHaveLength(6);
    expect(disposals.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    f.warmup.schedule(f.camera, f.faces, f.edges);
    await vi.runAllTimersAsync();
    expect(f.renderer.compileAsync).toHaveBeenCalledOnce();
    f.warmup.dispose();
    f.warmup.dispose();
    expect(disposals.every((spy) => spy.mock.calls.length === 1)).toBe(true);
  });

  it('cancels queued work and skips first use if disposed while linking', async () => {
    vi.useFakeTimers();
    const queued = fixture();
    queued.warmup.schedule(queued.camera, queued.faces, queued.edges);
    queued.warmup.dispose();
    await vi.runAllTimersAsync();
    expect(queued.renderer.compileAsync).not.toHaveBeenCalled();

    const f = fixture();
    let finish!: () => void;
    f.renderer.compileAsync.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    f.warmup.schedule(f.camera, f.faces, f.edges);
    await vi.runAllTimersAsync();
    f.warmup.dispose();
    finish();
    await vi.runAllTimersAsync();
    expect(f.renderer.render).not.toHaveBeenCalled();
  });

  it('restores pending shadow updates and clear state when preparation fails', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    f.renderer.render.mockImplementation(() => {
      throw new Error('lost context');
    });
    f.warmup.schedule(f.camera, f.faces, f.edges);
    await vi.runAllTimersAsync();
    expect(f.renderer.autoClear).toBe(true);
    expect(f.renderer.shadowMap).toEqual({
      autoUpdate: true,
      needsUpdate: true
    });
    expect(warning).toHaveBeenCalledOnce();
    f.warmup.dispose();
  });

  it('stops between reflection tasks when the viewer is disposed', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.renderer.render.mockImplementationOnce(() => {
      setTimeout(() => f.warmup.dispose(), 0);
    });
    f.warmup.schedule(f.camera, f.faces, f.edges);
    await vi.runAllTimersAsync();
    expect(f.renderer.render).toHaveBeenCalledOnce();
    expect(f.renderer.autoClear).toBe(true);
    expect(f.renderer.shadowMap).toEqual({
      autoUpdate: true,
      needsUpdate: true
    });
  });
});
