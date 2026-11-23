import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';
import {
  createSilhouetteLines,
  installSilhouetteUpdates,
  SILHOUETTE_BUILD_MARK,
  silhouetteCandidates,
  updateSilhouette
} from './silhouette';
import { createBodyEdgeOverlay } from './edgeOverlay';
import { collectPreviewTargets } from './previewDeformation';

/** A capped cylinder whose groups are its side, top and bottom faces. */
function cylinderMesh(segments = 24) {
  const geometry = new THREE.CylinderGeometry(5, 5, 10, segments, 1);
  const mesh = {
    kind: 'mesh' as const,
    vertices: Float32Array.from(geometry.getAttribute('position').array),
    indices: Uint32Array.from(geometry.getIndex()!.array)
  };
  const faces = geometry.groups.map((group, index) => ({
    topologyId: `face:${index}`,
    hash: index + 1,
    triangleStart: group.start / 3,
    triangleCount: group.count / 3
  }));
  geometry.dispose();
  return { mesh, faces };
}

function body(
  mesh: BodyRepresentation['mesh'],
  faces: NonNullable<BodyRepresentation['topology']>['faces']
): BodyRepresentation {
  return {
    bodyId: toBodyId('body_silhouette'),
    name: 'Cylinder',
    source: 'primitive',
    mesh,
    faceCount: faces.length,
    color: '#99a0b2',
    consumed: false,
    exportableStep: true,
    volume: 1,
    bbox: { min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } },
    topology: {
      faces,
      edges: [{ topologyId: 'edge:1', hash: 1, points: [0, 0, 0, 1, 0, 0] }]
    }
  };
}

describe('curved-surface outlines', () => {
  it('collects the curved side’s ruling edges and skips the planar caps', () => {
    const segments = 24;
    const { mesh, faces } = cylinderMesh(segments);
    const candidates = silhouetteCandidates(mesh, faces)!;
    expect(candidates).not.toBeNull();
    // One ruling per seam between adjacent side quads, the periodic seam
    // included (its split vertices weld by position). Each quad's diagonal
    // joins two coplanar triangles and can never straddle a view, and the
    // planar caps contribute nothing.
    expect(candidates.positions.length / 6).toBe(segments);
    expect(candidates.normalsA.length).toBe(candidates.positions.length / 2);
    for (let i = 0; i < candidates.positions.length; i += 6) {
      // Every ruling runs the cylinder's full height along Y.
      expect(
        Math.abs(candidates.positions[i + 1]! - candidates.positions[i + 4]!)
      ).toBeCloseTo(10, 5);
    }
  });

  it('has nothing to outline on a body made only of planar faces', () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const mesh = {
      kind: 'mesh' as const,
      vertices: Float32Array.from(geometry.getAttribute('position').array),
      indices: Uint32Array.from(geometry.getIndex()!.array)
    };
    const faces = geometry.groups.map((group, index) => ({
      topologyId: `face:${index}`,
      hash: index + 1,
      triangleStart: group.start / 3,
      triangleCount: group.count / 3
    }));
    expect(silhouetteCandidates(mesh, faces)).toBeNull();
  });

  it('draws nothing until a view has picked the outline', () => {
    const { mesh, faces } = cylinderMesh();
    const lines = createSilhouetteLines(silhouetteCandidates(mesh, faces)!, {
      color: 0x000000,
      linewidth: 1.5
    });
    expect(lines.geometry.instanceCount).toBe(0);
    // The bounds still cover the whole surface, for frustum culling.
    expect(lines.geometry.boundingSphere!.radius).toBeGreaterThan(5);
    const hits: THREE.Intersection[] = [];
    lines.raycast(new THREE.Raycaster(), hits);
    expect(hits).toEqual([]);
  });

  it('keeps only the two rulings on the outline of a side-on cylinder', () => {
    const segments = 24;
    const { mesh, faces } = cylinderMesh(segments);
    const candidates = silhouetteCandidates(mesh, faces)!;
    const lines = createSilhouetteLines(candidates, {
      color: 0x000000,
      linewidth: 1.5
    });
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    // Looking along -Z at the cylinder's Y axis: the outline is the pair of
    // rulings at x = ±5. The cylinder's rulings sit between its seams, so
    // aim between two of them, where no candidate lies exactly edge-on.
    camera.position.set(0, 0, 50);
    camera.rotateY(Math.PI / segments);
    camera.updateMatrixWorld();
    lines.updateMatrixWorld();
    expect(updateSilhouette(lines, camera)).toBe(true);
    expect(lines.geometry.instanceCount).toBe(2);
    const drawn = lines.geometry.getAttribute(
      'instanceStart'
    ) as THREE.InterleavedBufferAttribute;
    const xs = [drawn.getX(0), drawn.getX(1)].map((x) => Math.abs(x));
    for (const x of xs) expect(x).toBeGreaterThan(4.5);
    // The candidates themselves are untouched by what is drawn.
    expect(candidates.positions.length / 6).toBe(segments);

    // An unchanged view picks nothing again.
    expect(updateSilhouette(lines, camera)).toBe(false);
  });

  it('picks along the eye ray for a perspective camera and follows the body', () => {
    const { mesh, faces } = cylinderMesh(48);
    const lines = createSilhouetteLines(silhouetteCandidates(mesh, faces)!, {
      color: 0x000000,
      linewidth: 1.5
    });
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
    camera.position.set(0, 0, 30);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    lines.updateMatrixWorld();
    updateSilhouette(lines, camera);
    const close = lines.geometry.instanceCount;
    expect(close).toBeGreaterThanOrEqual(2);
    expect(close).toBeLessThanOrEqual(4);
    const drawn = lines.geometry.getAttribute(
      'instanceStart'
    ) as THREE.InterleavedBufferAttribute;
    // Seen from close by, the tangent points from the eye fall short of
    // x = ±5: a perspective outline is not the orthographic one.
    for (let i = 0; i < close; i += 1) {
      expect(Math.abs(drawn.getX(i))).toBeLessThan(5);
      expect(Math.abs(drawn.getX(i))).toBeGreaterThan(4);
    }

    // Turning the body a quarter about Y moves the outline with it: the
    // test runs in the body's own space.
    lines.rotation.y = Math.PI / 2;
    lines.updateMatrixWorld();
    expect(updateSilhouette(lines, camera)).toBe(true);
    for (let i = 0; i < lines.geometry.instanceCount; i += 1) {
      expect(Math.abs(drawn.getZ(i))).toBeGreaterThan(4);
    }
  });

  it('packs exactly the straddling segments across full and partial blocks', () => {
    const { mesh, faces } = cylinderMesh(1_037);
    const candidates = silhouetteCandidates(mesh, faces)!;
    const { positions, normalsA, normalsB } = candidates;
    const count = positions.length / 6;
    expect(count).toBe(1_037);
    // A degenerate neighbour and an edge exactly tangent to the viewing
    // axis both contribute their segments under the inclusive facing rule.
    normalsA.fill(0, 0, 32 * 3);
    normalsB.set([1, 0, 0], (count - 1) * 3);

    const lines = createSilhouetteLines(candidates, { color: 0, linewidth: 1 });
    const buffer = lines.geometry.getAttribute(
      'instanceStart'
    ) as THREE.InterleavedBufferAttribute;
    for (const perspective of [true, false]) {
      const camera = perspective
        ? new THREE.PerspectiveCamera()
        : new THREE.OrthographicCamera();
      for (const position of [
        [0, 0, 10],
        [4.99, 0, 0],
        [-40, 30, -15],
        [1e15, -1e14, 1e14]
      ]) {
        camera.position.fromArray(position);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        updateSilhouette(lines, camera);

        const expected: number[] = [];
        const viewAxis = new THREE.Vector3()
          .setFromMatrixColumn(camera.matrixWorld, 2)
          .normalize();
        for (let i = 0; i < count; i++) {
          const p = i * 6;
          const direction = viewAxis.clone();
          if (perspective) {
            const midpoint = new THREE.Vector3(
              Math.fround((positions[p]! + positions[p + 3]!) / 2),
              Math.fround((positions[p + 1]! + positions[p + 4]!) / 2),
              Math.fround((positions[p + 2]! + positions[p + 5]!) / 2)
            );
            direction.subVectors(camera.position, midpoint);
          }
          const a = new THREE.Vector3()
            .fromArray(normalsA, i * 3)
            .dot(direction);
          const b = new THREE.Vector3()
            .fromArray(normalsB, i * 3)
            .dot(direction);
          if (a * b <= 0) expected.push(...positions.subarray(p, p + 6));
        }
        expect(
          buffer.data.array.slice(0, lines.geometry.instanceCount * 6)
        ).toEqual(Float32Array.from(expected));
      }
    }
  });

  it('retains same-sign neighbours whose facing product underflows to zero', () => {
    const count = 1024;
    const positions = new Float32Array(count * 6);
    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 6 + 4] = 1;
      normals[i * 3] = 1;
    }
    const lines = createSilhouetteLines(
      { positions, normalsA: normals, normalsB: normals },
      { color: 0, linewidth: 1 }
    );
    const camera = new THREE.PerspectiveCamera();
    camera.position.x = 1;
    camera.updateMatrixWorld();
    updateSilhouette(lines, camera);
    expect(lines.geometry.instanceCount).toBe(0);
    camera.position.x = 1e-200;
    camera.updateMatrixWorld();
    updateSilhouette(lines, camera);
    expect(lines.geometry.instanceCount).toBe(count);
  });

  it('tries the blocks again after a view where they skip too little', () => {
    const count = 1024;
    const positions = new Float32Array(count * 6);
    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 6 + 4] = 1;
      normals[i * 3] = 1;
    }
    let reads = 0;
    const counted = new Proxy(normals, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      }
    });
    const lines = createSilhouetteLines(
      { positions, normalsA: counted, normalsB: counted },
      { color: 0, linewidth: 1 }
    );
    const camera = new THREE.OrthographicCamera();
    const view = (x: number, y: number, z: number) => {
      camera.position.set(x, y, z);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      reads = 0;
      updateSilhouette(lines, camera);
      return reads;
    };
    view(1, 0, 0);
    // Edge-on to every normal: each block straddles, so none is skipped.
    view(0, 0, 1);
    expect(lines.geometry.instanceCount).toBe(count);
    const scans: number[] = [];
    for (let k = 1; k <= 17; k++) scans.push(view(1, 0, k * 1e-3));
    expect(lines.geometry.instanceCount).toBe(0);
    // The views straight after the miss scan every edge; a later one skips
    // every block again instead of scanning for the body's lifetime.
    expect(scans[0]).toBe(count * 6);
    expect(scans.at(-1)).toBe(0);
  });

  it('picks the exact outline after a drag preview moves the midpoints', () => {
    const { mesh, faces } = cylinderMesh(1_037);
    const candidates = silhouetteCandidates(mesh, faces)!;
    const { positions, normalsA, normalsB } = candidates;
    const count = positions.length / 6;
    const lines = createSilhouetteLines(candidates, { color: 0, linewidth: 1 });
    const buffer = lines.geometry.getAttribute(
      'instanceStart'
    ) as THREE.InterleavedBufferAttribute;
    const camera = new THREE.PerspectiveCamera();
    const view = (x: number, y: number, z: number) => {
      camera.position.set(x, y, z);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      updateSilhouette(lines, camera);
    };
    view(0, 0, 10);
    view(-40, 30, -15);
    const deformation = collectPreviewTargets(
      lines
    ).deformables[0]!.beginPreviewDeformation((point) =>
      point.set(0, 0, point.y > 0 ? 3 : 0)
    );
    deformation.apply(1);
    deformation.restore();
    view(12, -3, 7);

    const expected: number[] = [];
    for (let i = 0; i < count; i++) {
      const p = i * 6;
      const direction = new THREE.Vector3().subVectors(
        camera.position,
        new THREE.Vector3(
          Math.fround((positions[p]! + positions[p + 3]!) / 2),
          Math.fround((positions[p + 1]! + positions[p + 4]!) / 2),
          Math.fround((positions[p + 2]! + positions[p + 5]!) / 2)
        )
      );
      const a = new THREE.Vector3().fromArray(normalsA, i * 3).dot(direction);
      const b = new THREE.Vector3().fromArray(normalsB, i * 3).dot(direction);
      if (a * b <= 0) expected.push(...positions.subarray(p, p + 6));
    }
    expect(expected.length).toBeGreaterThan(0);
    expect(
      buffer.data.array.slice(0, lines.geometry.instanceCount * 6)
    ).toEqual(Float32Array.from(expected));
  });

  it('picks the outline for whichever camera renders the scene', () => {
    const { mesh, faces } = cylinderMesh(24);
    const scene = new THREE.Scene();
    const previous = vi.fn();
    scene.onBeforeRender = previous;
    installSilhouetteUpdates(scene);
    const lines = createSilhouetteLines(silhouetteCandidates(mesh, faces)!, {
      color: 0x000000,
      linewidth: 1.5
    });
    // The edge overlay replaces the batch's userData; picking must not
    // depend on it.
    lines.userData = { bodyId: 'body', edgeOverlay: true };
    scene.add(lines);
    scene.updateMatrixWorld();
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    camera.position.set(0, 0, 50);
    camera.rotateY(Math.PI / 24);
    camera.updateMatrixWorld();
    const render = () =>
      scene.onBeforeRender(
        {} as THREE.WebGLRenderer,
        scene,
        camera,
        null as never,
        null as never,
        null as never
      );
    render();
    expect(lines.geometry.instanceCount).toBe(2);
    expect(previous).toHaveBeenCalledTimes(1);

    // A hidden outline is left alone.
    lines.visible = false;
    camera.rotateY(Math.PI / 2);
    camera.updateMatrixWorld();
    render();
    expect(lines.geometry.instanceCount).toBe(2);
  });

  it('draws with the resting edges and hides with them in the shaded view', () => {
    const { mesh, faces } = cylinderMesh();
    const overlay = createBodyEdgeOverlay(body(mesh, faces));
    const outline = overlay.silhouetteEdges!;
    expect(outline).not.toBeNull();
    expect(outline.parent).toBe(overlay);
    expect(outline.visible).toBe(true);
    expect(outline.material.opacity).toBe(overlay.idleEdges.material.opacity);
    expect(outline.material.color.getHex()).toBe(
      overlay.idleEdges.material.color.getHex()
    );

    overlay.setDisplayMode('shaded');
    expect(outline.visible).toBe(false);
    overlay.setDisplayMode('shaded-edges');
    expect(outline.visible).toBe(true);

    overlay.setBodySelected(true);
    expect(outline.material.linewidth).toBe(
      overlay.idleEdges.material.linewidth
    );
    expect(outline.material.color.getHex()).toBe(
      overlay.idleEdges.material.color.getHex()
    );
  });

  it('outlines a body edge overlay in a scene that picks per camera', () => {
    const { mesh, faces } = cylinderMesh(24);
    const scene = new THREE.Scene();
    installSilhouetteUpdates(scene);
    const overlay = createBodyEdgeOverlay(body(mesh, faces));
    scene.add(overlay);
    scene.updateMatrixWorld();
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    camera.position.set(0, 0, 50);
    camera.rotateY(Math.PI / 24);
    camera.updateMatrixWorld();
    scene.onBeforeRender(
      {} as THREE.WebGLRenderer,
      scene,
      camera,
      null as never,
      null as never,
      null as never
    );
    expect(overlay.silhouetteEdges!.geometry.instanceCount).toBe(2);
  });

  it('builds no outline without the mesh to derive it from', () => {
    const { mesh, faces } = cylinderMesh();
    const { mesh: _mesh, ...withoutMesh } = body(mesh, faces);
    expect(createBodyEdgeOverlay(withoutMesh).silhouetteEdges).toBeNull();
  });

  it('leaves a timing mark for each body build, for performance timelines', () => {
    performance.clearMarks(SILHOUETTE_BUILD_MARK);
    const { mesh, faces } = cylinderMesh();
    createBodyEdgeOverlay(body(mesh, faces));
    const marks = performance.getEntriesByName(
      SILHOUETTE_BUILD_MARK
    ) as PerformanceMark[];
    expect(marks).toHaveLength(1);
    const detail = marks[0]!.detail as {
      ms: number;
      triangles: number;
      candidates: number;
    };
    expect(detail.ms).toBeGreaterThanOrEqual(0);
    expect(detail.triangles).toBe(mesh.indices.length / 3);
    expect(detail.candidates).toBe(24);
    performance.clearMarks(SILHOUETTE_BUILD_MARK);
  });
});
