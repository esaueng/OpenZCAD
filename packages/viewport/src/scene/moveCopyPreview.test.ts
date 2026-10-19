import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MoveCopyPreview } from './moveCopyPreview';
import { bodyDrawnAsBuilt } from './drawnBodies';
import { createBodyEdgeOverlay } from '../render/edgeOverlay';
import { toBodyId } from '@openzcad/shared';

describe('a pending Move copy', () => {
  it.each([1, 0.6])(
    'refreshes the cached copy from source opacity and X-ray (appearance: %s)',
    (appearance) => {
      const root = new THREE.Group();
      const source = new THREE.Mesh(
        new THREE.BoxGeometry(),
        new THREE.MeshPhongMaterial()
      );
      root.add(source);
      const preview = new MoveCopyPreview();
      const copy = new THREE.Mesh(
        new THREE.BoxGeometry(),
        new THREE.MeshPhongMaterial()
      );
      const edges = createBodyEdgeOverlay({
        bodyId: toBodyId('source'),
        topology: {
          faces: [],
          edges: [{ topologyId: 'edge', hash: 1, points: [0, 0, 0, 1, 0, 0] }]
        }
      });
      copy.add(edges);
      preview.target(source, true, () => copy);
      copy.position.x = 40;
      for (const factor of [0.35, 1, 0.35]) {
        source.material.opacity = appearance * factor;
        preview.refreshAppearance('shaded', factor < 1);
        expect(copy.material.opacity).toBeCloseTo(appearance * factor, 12);
        expect(copy.material.depthWrite).toBe(appearance * factor >= 1);
        expect(edges.idleEdges.visible).toBe(factor < 1);
        expect(copy.position.x).toBe(40);
        expect(preview.active).toBe(true);
      }
    }
  );

  it('draws the source and a separate transformed solid, then restores a plain Move', () => {
    const group = new THREE.Group();
    const source = new THREE.Mesh(
      new THREE.BoxGeometry(20, 10, 10),
      new THREE.MeshBasicMaterial()
    );
    group.add(source);
    class BodyOverlay extends THREE.Group {
      constructor(body: { bodyId: string }) {
        super();
        this.name = body.bodyId;
      }
    }
    const overlay = new BodyOverlay({ bodyId: 'body_source' });
    overlay.add(
      new THREE.Mesh(new THREE.BoxGeometry(20, 10, 10), source.material)
    );
    source.add(overlay);
    source.userData.overlay = overlay;
    const preview = new MoveCopyPreview();
    const createCopy = () =>
      new THREE.Mesh(
        new THREE.BoxGeometry(20, 10, 10),
        new THREE.MeshBasicMaterial()
      );
    // Switching an already translated Move to Copy restores the source.
    source.position.x = 40;
    const copy = preview.target(source, true, createCopy);
    copy.position.x = 40;
    expect(new THREE.Box3().setFromObject(source).min.x).toBe(-10);
    expect(new THREE.Box3().setFromObject(copy).min.x).toBe(30);
    expect(group.children).toHaveLength(2);
    expect(bodyDrawnAsBuilt(source)).toBe(false);
    expect(preview.target(source, true, createCopy)).toBe(copy);
    const move = preview.target(source, false, createCopy);
    move.position.x = 12;
    expect(group.children).toEqual([source]);
    expect(new THREE.Box3().setFromObject(source).min.x).toBe(2);
    source.position.x = 0;
    expect(bodyDrawnAsBuilt(source)).toBe(true);
  });

  it('disposes cancelled or rebuilt copies while preserving the source resources', () => {
    const group = new THREE.Group();
    const source = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial()
    );
    group.add(source);
    const disposeGeometry = vi.spyOn(source.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(source.material, 'dispose');
    const preview = new MoveCopyPreview();
    const createCopy = () =>
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const copy = preview.target(source, true, createCopy) as ReturnType<
      typeof createCopy
    >;
    const disposeCopyGeometry = vi.spyOn(copy.geometry, 'dispose');
    const disposeCopyMaterial = vi.spyOn(copy.material, 'dispose');
    const rebuilt = source.clone();
    group.add(rebuilt);
    preview.target(rebuilt, true, createCopy);
    expect(copy.parent).toBeNull();
    expect(bodyDrawnAsBuilt(source)).toBe(true);
    preview.clear();
    expect(group.children).toEqual([source, rebuilt]);
    expect(bodyDrawnAsBuilt(rebuilt)).toBe(true);
    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(disposeMaterial).not.toHaveBeenCalled();
    expect(disposeCopyGeometry).toHaveBeenCalledOnce();
    expect(disposeCopyMaterial).toHaveBeenCalledOnce();
  });
});
