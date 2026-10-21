import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  buildReferenceImageRig,
  ReferenceTextureCache
} from './referenceImageRig';
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
  artifactId: 'artifact_one',
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

describe('ReferenceTextureCache', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const sum = 'c'.repeat(64);

  it('decodes a picture once and retries one that was not available when its location changes', async () => {
    const decode = vi.fn(async () => new THREE.Texture());
    const cache = new ReferenceTextureCache(decode);
    const onReady = vi.fn();
    // A collaborator's device-only picture: nothing to load yet.
    const load = vi.fn(async () => null as Blob | null);
    cache.sync(
      [{ checksumSha256: sum, artifactId: 'artifact_local_x' }],
      load,
      onReady
    );
    await flush();
    expect(cache.textures.size).toBe(0);
    // The same location again does not hammer the store.
    load.mockClear();
    cache.sync(
      [{ checksumSha256: sum, artifactId: 'artifact_local_x' }],
      load,
      onReady
    );
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    // The owner archives it: the rewritten id makes it loadable.
    load.mockResolvedValue(new Blob([new Uint8Array([1])]));
    cache.sync(
      [{ checksumSha256: sum, artifactId: 'artifact_cloud' }],
      load,
      onReady
    );
    await flush();
    expect(cache.textures.has(sum)).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    // Loaded once: a later sync for the same picture loads nothing.
    load.mockClear();
    cache.sync(
      [{ checksumSha256: sum, artifactId: 'artifact_cloud' }],
      load,
      onReady
    );
    expect(load).not.toHaveBeenCalled();
  });

  it('loads a picture placed several times once, whatever its archives', async () => {
    const decode = vi.fn(async () => new THREE.Texture());
    const cache = new ReferenceTextureCache(decode);
    const load = vi.fn(async () => new Blob([new Uint8Array([1])]));
    cache.sync(
      [
        { checksumSha256: sum, artifactId: 'artifact_local_a' },
        { checksumSha256: sum, artifactId: 'artifact_b' },
        { checksumSha256: sum, artifactId: 'artifact_c' }
      ],
      load,
      vi.fn()
    );
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(cache.textures.has(sum)).toBe(true);
  });

  it('retries a picture whose location changed while its load was failing', async () => {
    const cache = new ReferenceTextureCache(async () => new THREE.Texture());
    let finish: (blob: Blob | null) => void = () => undefined;
    const load = vi
      .fn<(checksum: string) => Promise<Blob | null>>()
      .mockImplementationOnce(
        () => new Promise<Blob | null>((done) => (finish = done))
      )
      .mockResolvedValue(new Blob([new Uint8Array([1])]));
    const onReady = vi.fn();
    cache.sync(
      [{ checksumSha256: sum, artifactId: 'artifact_local_x' }],
      load,
      onReady
    );
    // Archived while the first load is still out: skipped for now...
    cache.sync(
      [{ checksumSha256: sum, artifactId: 'artifact_cloud' }],
      load,
      onReady
    );
    expect(load).toHaveBeenCalledTimes(1);
    // ...and tried as soon as the first load comes back empty.
    finish(null);
    await flush();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.textures.has(sum)).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('drops pictures no image needs, and loads that finish after a clear', async () => {
    const texture = new THREE.Texture();
    const dispose = vi.spyOn(texture, 'dispose');
    const cache = new ReferenceTextureCache(async () => texture);
    let resolve: (blob: Blob) => void = () => undefined;
    const pending = new Promise<Blob>((done) => (resolve = done));
    cache.sync(
      [{ checksumSha256: sum, artifactId: 'a' }],
      () => pending,
      vi.fn()
    );
    cache.clear();
    resolve(new Blob([new Uint8Array([1])]));
    await flush();
    expect(cache.textures.size).toBe(0);
    expect(dispose).toHaveBeenCalled();
    // Still usable after a clear, as a remounted viewer needs.
    const kept = new ReferenceTextureCache(async () => new THREE.Texture());
    kept.sync(
      [{ checksumSha256: sum, artifactId: 'a' }],
      async () => new Blob([new Uint8Array([1])]),
      vi.fn()
    );
    await flush();
    const loaded = kept.textures.get(sum)!;
    const disposeLoaded = vi.spyOn(loaded, 'dispose');
    kept.sync([], vi.fn(), vi.fn());
    expect(kept.textures.size).toBe(0);
    expect(disposeLoaded).toHaveBeenCalled();
  });
});
