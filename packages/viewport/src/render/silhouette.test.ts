import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';
import {
  createSilhouetteLines,
  silhouetteCandidates,
  silhouetteVertexShader
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

  it('patches the fat-line shader to drop segments that do not straddle the view', () => {
    const shader = silhouetteVertexShader(new LineMaterial().vertexShader);
    expect(shader).toContain('attribute vec3 instanceNormalA;');
    expect(shader).toContain('attribute vec3 instanceNormalB;');
    expect(shader).toContain('silhouetteFacingA * silhouetteFacingB > 0.0');
    expect(shader).toContain(
      'gl_Position = silhouetteHidden ? vec4( 0.0, 0.0, 2.0, 1.0 ) : clip;'
    );
    expect(() => silhouetteVertexShader('void main() {}')).toThrow(
      /silhouette anchor/
    );
  });

  it('builds a never-picked outline batch with both normal attributes', () => {
    const { mesh, faces } = cylinderMesh();
    const lines = createSilhouetteLines(silhouetteCandidates(mesh, faces)!, {
      color: 0x000000,
      linewidth: 1.5
    });
    expect(lines.geometry.getAttribute('instanceNormalA').count).toBe(24);
    expect(lines.geometry.getAttribute('instanceNormalB').count).toBe(24);
    expect(lines.material.customProgramCacheKey()).toBe('openzcad-silhouette');
    const hits: THREE.Intersection[] = [];
    lines.raycast(new THREE.Raycaster(), hits);
    expect(hits).toEqual([]);
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

  it('builds no outline without the mesh to derive it from', () => {
    const { mesh, faces } = cylinderMesh();
    const { mesh: _mesh, ...withoutMesh } = body(mesh, faces);
    expect(createBodyEdgeOverlay(withoutMesh).silhouetteEdges).toBeNull();
  });
});
