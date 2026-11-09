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
