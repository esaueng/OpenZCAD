import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  toBodyId,
  type BodyTopology,
  type EdgeTopology,
  type MeshGeometry
} from '@openzcad/shared';
import {
  EDGE_IDLE_COLOR,
  EDGE_IDLE_OPACITY,
  EDGE_SELECTED_COLOR,
  EDGE_WIREFRAME_COLOR
} from '../pick/edges';
import { batchedEdgeTarget, createBodyEdgeOverlay } from './edgeOverlay';
import { SELECTION_SEMANTICS } from './semantics';
import { TANGENT_EDGE_MAX_ANGLE, tangentEdgeIds } from './tangentEdges';

const BODY_ID = toBodyId('body-tangent');

/**
 * A profile in the xz plane swept one unit along y, one topology face per
 * run of profile points. Neighbouring runs share their end point, and the
 * mesh is welded there, as the kernel's display mesh is.
 */
function sweptProfile(
  runs: readonly (readonly [number, number])[][],
  options: { weld?: boolean; hashes?: number[] } = {}
): { mesh: MeshGeometry; topology: BodyTopology } {
  const weld = options.weld ?? true;
  const vertices: number[] = [];
  const indices: number[] = [];
  const vertexIds = new Map<string, number>();
  const vertexAt = (x: number, y: number, z: number, face: number) => {
    const key = weld ? `${x},${y},${z}` : `${face}:${x},${y},${z}`;
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = vertices.length / 3;
      vertices.push(x, y, z);
      vertexIds.set(key, id);
    }
    return id;
  };
  const faces: BodyTopology['faces'] = [];
  const edges: EdgeTopology[] = [];
  runs.forEach((run, face) => {
    const triangleStart = indices.length / 3;
    for (let index = 0; index + 1 < run.length; index += 1) {
      const [x0, z0] = run[index]!;
      const [x1, z1] = run[index + 1]!;
      const a = vertexAt(x0, 0, z0, face);
      const b = vertexAt(x1, 0, z1, face);
      const c = vertexAt(x1, 1, z1, face);
      const d = vertexAt(x0, 1, z0, face);
      indices.push(a, b, c, a, c, d);
    }
    const hash = options.hashes?.[face] ?? 100 + face;
    faces.push({
      topologyId: `face-${face}`,
      hash,
      triangleStart,
      triangleCount: indices.length / 3 - triangleStart
    });
    if (face > 0) {
      const [x, z] = run[0]!;
      const previousHash = options.hashes?.[face - 1] ?? 100 + face - 1;
      edges.push({
        topologyId: `edge-${face - 1}-${face}`,
        hash: 10 + face,
        adjacentFaceHashes: [previousHash, hash].sort((l, r) => l - r),
        points: [x, 0, z, x, 1, z]
      });
    }
  });
  return {
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from(vertices),
      indices: Uint32Array.from(indices)
    },
    topology: { faces, edges }
  };
}

/** A quarter-round of radius 1 from (0, 0) to (1, 1), in `steps` chords. */
function fillet(steps: number): [number, number][] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = (index / steps) * (Math.PI / 2);
    // Rounded so the ends land exactly on the floor and wall they weld to.
    const round = (value: number) => Math.round(value * 1e9) / 1e9;
    return [round(Math.sin(angle)), round(1 - Math.cos(angle))];
  });
}

/**
 * A floor, a fillet rolling up into a wall, and a flat top on the wall: two
 * tangent rims and one square corner. The fillet is chorded as coarsely as
 * the display tessellation allows (0.06 rad), so its rims measure as far off
 * tangent as a real one does.
 */
function filletedStep() {
  const round = fillet(Math.ceil(Math.PI / 2 / 0.06));
  return sweptProfile([
    [
      [-2, 0],
      [0, 0]
    ],
    round,
    [
      [1, 1],
      [1, 3]
    ],
    [
      [1, 3],
      [-1, 3]
    ]
  ]);
}

/** Two flat faces meeting at `degrees` off straight. */
function kink(degrees: number) {
  const angle = THREE.MathUtils.degToRad(degrees);
  return sweptProfile([
    [
      [-1, 0],
      [0, 0]
    ],
    [
      [0, 0],
      [Math.cos(angle), Math.sin(angle)]
    ]
  ]);
}

describe('tangentEdgeIds', () => {
  it("finds a fillet's rims tangent and the square corner sharp", () => {
    const { mesh, topology } = filletedStep();
    expect([...tangentEdgeIds(mesh, topology)].sort()).toEqual([
      'edge-0-1',
      'edge-1-2'
    ]);
  });

  it('holds the line at the tangent angle between flat faces', () => {
    const threshold = THREE.MathUtils.radToDeg(TANGENT_EDGE_MAX_ANGLE);
    for (const degrees of [0, 4, threshold - 1]) {
      const { mesh, topology } = kink(degrees);
      expect(tangentEdgeIds(mesh, topology), `${degrees}°`).toEqual(
        new Set(['edge-0-1'])
      );
    }
    for (const degrees of [threshold + 1, 15, 45, 90]) {
      const { mesh, topology } = kink(degrees);
      expect(tangentEdgeIds(mesh, topology).size, `${degrees}°`).toBe(0);
    }
  });

  it('measures a fillet finer than the display limit tangent too', () => {
    const fine = sweptProfile([
      [
        [-2, 0],
        [0, 0]
      ],
      fillet(64)
    ]);
    expect(tangentEdgeIds(fine.mesh, fine.topology)).toEqual(
      new Set(['edge-0-1'])
    );
  });

  it('falls back to sharp where the mesh cannot answer', () => {
    // No shared vertex to measure at.
    const apart = sweptProfile(
      [
        [
          [-1, 0],
          [0, 0]
        ],
        [
          [0, 0],
          [1, 0]
        ]
      ],
      { weld: false }
    );
    expect(tangentEdgeIds(apart.mesh, apart.topology).size).toBe(0);

    // Two faces publishing one hash, as a sphere's hemispheres do.
    const alike = sweptProfile(
      [
        [
          [-1, 0],
          [0, 0]
        ],
        [
          [0, 0],
          [1, 0]
        ],
        [
          [1, 0],
          [2, 0]
        ]
      ],
      { hashes: [100, 101, 101] }
    );
    expect(tangentEdgeIds(alike.mesh, alike.topology).size).toBe(0);

    // An adapter that predates `adjacentFaceHashes`.
    const { mesh, topology } = kink(0);
    const unpublished: BodyTopology = {
      ...topology,
      edges: topology.edges.map(
        ({ adjacentFaceHashes: _omitted, ...edge }) => edge
      )
    };
    expect(tangentEdgeIds(mesh, unpublished).size).toBe(0);
  });

  it('counts a face pair sharp when any shared vertex is sharp', () => {
    // Two flat faces meeting tangentially along x = 0, and again at a far
    // point P where one lies in z = 5 and the other in x = 5.
    // prettier-ignore
    const vertices = [
      -1, 0, 0,  0, 0, 0,  0, 1, 0,  -1, 1, 0,  1, 0, 0,  1, 1, 0,
      5, 5, 5,  4, 5, 5,  4, 4, 5,  5, 5, 4,  5, 4, 4
    ];
    const along = [0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2];
    const atP = [6, 7, 8, 6, 9, 10];
    const pair = (indices: number[], perFace: number) => ({
      mesh: {
        kind: 'mesh' as const,
        vertices: Float32Array.from(vertices),
        indices: Uint32Array.from(indices)
      },
      topology: {
        faces: [0, 1].map((face) => ({
          topologyId: `face-${face}`,
          hash: 100 + face,
          triangleStart: face * perFace,
          triangleCount: perFace
        })),
        edges: [
          {
            topologyId: 'edge-0-1',
            hash: 11,
            adjacentFaceHashes: [100, 101],
            points: [0, 0, 0, 0, 1, 0]
          }
        ]
      }
    });
    const tangentOnly = pair(along, 2);
    expect(tangentEdgeIds(tangentOnly.mesh, tangentOnly.topology)).toEqual(
      new Set(['edge-0-1'])
    );
    const withCorner = pair(
      [
        ...along.slice(0, 6),
        ...atP.slice(0, 3),
        ...along.slice(6),
        ...atP.slice(3)
      ],
      3
    );
    expect(tangentEdgeIds(withCorner.mesh, withCorner.topology).size).toBe(0);
  });
});

describe('BodyEdgeOverlay tangent batch', () => {
  function overlayFor(withMesh = true) {
    const { mesh, topology } = filletedStep();
    return createBodyEdgeOverlay(
      withMesh
        ? { bodyId: BODY_ID, topology, mesh }
        : { bodyId: BODY_ID, topology },
      { width: 800, height: 600 }
    );
  }

  it('splits the tangent edges into their own pickable batch', () => {
    const overlay = overlayFor();

    expect(overlay.ownershipBySegment.map((owner) => owner.topologyId)).toEqual(
      ['edge-2-3']
    );
    expect(
      overlay.tangentOwnershipBySegment.map((owner) => owner.topologyId)
    ).toEqual(['edge-0-1', 'edge-1-2']);
    expect(overlay.idleEdges.geometry.instanceCount).toBe(1);
    expect(overlay.idleTangentEdges.geometry.instanceCount).toBe(2);
    // A hit resolves through the batch it landed on, not by index alone.
    expect(
      batchedEdgeTarget(overlay.idleTangentEdges, 1)?.owner.topologyId
    ).toBe('edge-1-2');
    expect(batchedEdgeTarget(overlay.idleEdges, 0)?.owner.topologyId).toBe(
      'edge-2-3'
    );
    expect(batchedEdgeTarget(overlay.idleEdges, 1)).toBeNull();
    expect(overlay.idleTangentEdges.userData.topologyKind).toBe('edge');
  });

  it('draws every edge sharp when the mesh is not given', () => {
    const overlay = overlayFor(false);
    expect(overlay.ownershipBySegment).toHaveLength(3);
    expect(overlay.tangentOwnershipBySegment).toHaveLength(0);
    expect(overlay.idleTangentEdges.visible).toBe(false);
  });

  it('quiets tangent edges only at rest in the shaded view', () => {
    const overlay = overlayFor();
    const sharp = overlay.idleEdges.material;
    const tangent = overlay.idleTangentEdges.material;

    overlay.setDisplayMode('shaded-edges');
    expect(overlay.idleTangentEdges.visible).toBe(true);
    expect(tangent.color.getHex()).toBe(EDGE_IDLE_COLOR);
    expect(tangent.opacity).toBe(SELECTION_SEMANTICS.idle.tangentEdgeOpacity);
    expect(sharp.opacity).toBe(EDGE_IDLE_OPACITY);
    expect(tangent.opacity).toBeLessThan(sharp.opacity);

    overlay.setDisplayMode('shaded');
    expect(overlay.idleEdges.visible).toBe(false);
    expect(overlay.idleTangentEdges.visible).toBe(false);

    overlay.setDisplayMode('wireframe');
    expect(overlay.idleTangentEdges.visible).toBe(true);
    expect(tangent.color.getHex()).toBe(EDGE_WIREFRAME_COLOR);
    expect(tangent.opacity).toBe(1);

    overlay.setDisplayMode('shaded-edges');
    overlay.setXrayView(true);
    expect(tangent.color.getHex()).toBe(EDGE_WIREFRAME_COLOR);
    expect(tangent.opacity).toBe(1);
    expect(sharp.opacity).toBe(1);
  });

  it('outlines a selected body and restores the faint rims after', () => {
    const overlay = overlayFor();
    const tangent = overlay.idleTangentEdges.material;

    overlay.setBodySelected(true);
    expect(tangent.color.getHex()).toBe(EDGE_SELECTED_COLOR);
    expect(tangent.opacity).toBe(1);
    expect(tangent.linewidth).toBe(SELECTION_SEMANTICS.selected.bodyEdgeWidth);

    const restore = overlay.suspendHighlights();
    expect(tangent.color.getHex()).toBe(EDGE_IDLE_COLOR);
    expect(tangent.opacity).toBe(SELECTION_SEMANTICS.idle.tangentEdgeOpacity);
    restore();
    expect(tangent.color.getHex()).toBe(EDGE_SELECTED_COLOR);

    overlay.setBodySelected(false);
    expect(tangent.opacity).toBe(SELECTION_SEMANTICS.idle.tangentEdgeOpacity);
  });

  it('hovers and selects a tangent edge at full strength', () => {
    const overlay = overlayFor();
    const owner = batchedEdgeTarget(overlay.idleTangentEdges, 0)!.owner;

    overlay.setHovered(owner);
    expect(overlay.hoverEdges.visible).toBe(true);
    expect(overlay.hoverEdges.geometry.instanceCount).toBe(1);
    expect(overlay.hoverEdges.material.opacity).toBe(1);

    overlay.setHovered(null);
    overlay.setSelected([
      { bodyId: BODY_ID, kind: 'edge', topologyId: owner.topologyId }
    ]);
    expect(overlay.selectedEdges.visible).toBe(true);
    expect(overlay.selectedEdges.geometry.instanceCount).toBe(1);
  });
});
