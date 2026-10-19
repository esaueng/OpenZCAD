import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BodyTopology } from '@openzcad/shared';
import { rectFromDrag } from './boxSelect';
import { topologyInBox, type TopologyBoxCandidate } from './topologyBoxSelect';

const SIZE = 400;

function lookingDown() {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.up.set(0, 1, 0);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function pixel(camera: THREE.Camera, x: number, y: number, z: number) {
  const projected = new THREE.Vector3(x, y, z).project(camera);
  return {
    x: ((projected.x + 1) / 2) * SIZE,
    y: ((1 - projected.y) / 2) * SIZE
  };
}

function rectBetween(
  camera: THREE.Camera,
  from: [number, number, number],
  to: [number, number, number]
) {
  const a = pixel(camera, ...from);
  const b = pixel(camera, ...to);
  return rectFromDrag(a.x, a.y, b.x, b.y);
}

/**
 * A 20 mm cube centred on the origin: 6 faces of two outward triangles each
 * and 12 two-point edges, named by where they sit.
 */
function cube(): TopologyBoxCandidate {
  const h = 10;
  const corners: [number, number, number][] = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h]
  ];
  // Counter-clockwise seen from outside.
  const quads: [string, [number, number, number, number]][] = [
    ['bottom', [0, 3, 2, 1]],
    ['top', [4, 5, 6, 7]],
    ['front', [0, 1, 5, 4]],
    ['back', [2, 3, 7, 6]],
    ['left', [3, 0, 4, 7]],
    ['right', [1, 2, 6, 5]]
  ];
  const indices: number[] = [];
  const faces: BodyTopology['faces'] = quads.map(([name, [a, b, c, d]], i) => {
    indices.push(a, b, c, a, c, d);
    return {
      topologyId: `face-${name}`,
      hash: i + 1,
      triangleStart: i * 2,
      triangleCount: 2
    };
  });
  const edgePairs: [string, number, number][] = [
    ['bottom-front', 0, 1],
    ['bottom-right', 1, 2],
    ['bottom-back', 2, 3],
    ['bottom-left', 3, 0],
    ['top-front', 4, 5],
    ['top-right', 5, 6],
    ['top-back', 6, 7],
    ['top-left', 7, 4],
    ['vertical-front-left', 0, 4],
    ['vertical-front-right', 1, 5],
    ['vertical-back-right', 2, 6],
    ['vertical-back-left', 3, 7]
  ];
  const edges: BodyTopology['edges'] = edgePairs.map(([name, a, b], i) => ({
    topologyId: `edge-${name}`,
    hash: 100 + i,
    points: [...corners[a]!, ...corners[b]!]
  }));
  return {
    bodyId: 'cube',
    positions: corners.flat(),
    indices,
    topology: { faces, edges }
  };
}

function ids(selections: { topologyId?: string }[]) {
  return selections.map((selection) => selection.topologyId).sort();
}

describe('box selection of edges', () => {
  const camera = lookingDown();
  const options = (selectThrough = false) => ({
    camera,
    width: SIZE,
    height: SIZE,
    kind: 'edge' as const,
    selectThrough
  });
  // The left half of the cube from above, past its front and back.
  const leftHalf = rectBetween(camera, [-16, 16, 10], [0, -16, 10]);

  it('takes a partly covered edge only in a crossing', () => {
    const window = ids(topologyInBox([cube()], leftHalf, 'window', options()));
    const crossing = ids(
      topologyInBox([cube()], leftHalf, 'crossing', options())
    );
    expect(window).toEqual([
      'edge-top-left',
      'edge-vertical-back-left',
      'edge-vertical-front-left'
    ]);
    expect(crossing).toEqual([
      'edge-top-back',
      'edge-top-front',
      'edge-top-left',
      'edge-vertical-back-left',
      'edge-vertical-front-left'
    ]);
  });

  it('leaves the edges the top face hides unless selecting through', () => {
    const window = ids(
      topologyInBox([cube()], leftHalf, 'window', options(true))
    );
    const crossing = ids(
      topologyInBox([cube()], leftHalf, 'crossing', options(true))
    );
    expect(window).toEqual([
      'edge-bottom-left',
      'edge-top-left',
      'edge-vertical-back-left',
      'edge-vertical-front-left'
    ]);
    expect(crossing).toHaveLength(8);
    expect(crossing).toContain('edge-bottom-front');
    expect(crossing).not.toContain('edge-bottom-right');
  });

  it('keeps a concave crease visible from the faces that meet at it', () => {
    // A floor and a wall meeting along y at x = z = 0, seen from the open
    // side: the crease is the farthest point of both faces around it.
    const crease: TopologyBoxCandidate = {
      bodyId: 'corner',
      positions: [
        0, -10, 0, 20, -10, 0, 20, 10, 0, 0, 10, 0, 0, -10, 20, 0, 10, 20
      ],
      indices: [0, 1, 2, 0, 2, 3, 0, 3, 5, 0, 5, 4],
      topology: {
        faces: [
          { topologyId: 'floor', hash: 1, triangleStart: 0, triangleCount: 2 },
          { topologyId: 'wall', hash: 2, triangleStart: 2, triangleCount: 2 }
        ],
        edges: [
          { topologyId: 'crease', hash: 3, points: [0, -10, 0, 0, 10, 0] }
        ]
      }
    };
    const oblique = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    oblique.up.set(0, 0, 1);
    oblique.position.set(40, 25, 40);
    oblique.lookAt(5, 0, 5);
    oblique.updateMatrixWorld(true);
    const a = pixel(oblique, 0, -10, 0);
    const b = pixel(oblique, 0, 10, 0);
    const rect = rectFromDrag(
      Math.min(a.x, b.x) - 4,
      Math.min(a.y, b.y) - 4,
      Math.max(a.x, b.x) + 4,
      Math.max(a.y, b.y) + 4
    );
    expect(
      ids(
        topologyInBox([crease], rect, 'window', {
          camera: oblique,
          width: SIZE,
          height: SIZE,
          kind: 'edge'
        })
      )
    ).toEqual(['crease']);
  });

  it('leaves an edge another body stands in front of', () => {
    const shield: TopologyBoxCandidate = {
      bodyId: 'shield',
      positions: [-30, -30, 40, 30, -30, 40, 30, 30, 40, -30, 30, 40],
      indices: [0, 1, 2, 0, 2, 3],
      topology: {
        faces: [
          { topologyId: 'shield', hash: 9, triangleStart: 0, triangleCount: 2 }
        ],
        edges: []
      }
    };
    expect(
      topologyInBox([cube(), shield], leftHalf, 'crossing', options())
    ).toEqual([]);
    expect(
      topologyInBox([cube(), shield], leftHalf, 'crossing', options(true))
    ).toHaveLength(8);
  });
});

describe('box selection of faces', () => {
  const camera = lookingDown();
  const options = (selectThrough = false) => ({
    camera,
    width: SIZE,
    height: SIZE,
    kind: 'face' as const,
    selectThrough
  });
  const everything = rectBetween(camera, [-20, 20, 10], [20, -20, 10]);
  const centre = rectBetween(camera, [-2, 2, 10], [2, -2, 10]);

  it('takes only the faces the user can see', () => {
    expect(
      ids(topologyInBox([cube()], everything, 'window', options()))
    ).toEqual(['face-top']);
    expect(ids(topologyInBox([cube()], centre, 'crossing', options()))).toEqual(
      ['face-top']
    );
  });

  it('takes the hidden faces too when selecting through', () => {
    expect(
      topologyInBox([cube()], everything, 'window', options(true))
    ).toHaveLength(6);
    expect(
      ids(topologyInBox([cube()], centre, 'crossing', options(true)))
    ).toEqual(['face-bottom', 'face-top']);
  });

  it('takes no face seen edge-on, from just off straight above', () => {
    const ortho = new THREE.OrthographicCamera(-40, 40, 40, -40, 0.1, 1000);
    ortho.up.set(0, 1, 0);
    // The top view's own nudge off vertical, which leaves the front face a
    // sub-pixel sliver facing the camera.
    ortho.position.set(0, -0.01, 100);
    ortho.lookAt(0, 0, 0);
    ortho.updateMatrixWorld(true);
    const rect = rectBetween(ortho, [-20, 20, 10], [20, -20, 10]);
    const sweep = (selectThrough: boolean) =>
      ids(
        topologyInBox([cube()], rect, 'window', {
          camera: ortho,
          width: SIZE,
          height: SIZE,
          kind: 'face',
          selectThrough
        })
      );
    expect(sweep(false)).toEqual(['face-top']);
    expect(sweep(true)).toHaveLength(6);
  });

  it('takes a side face the camera can see past the top', () => {
    const offset = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    offset.up.set(0, 1, 0);
    offset.position.set(40, 0, 100);
    offset.lookAt(40, 0, 0);
    offset.updateMatrixWorld(true);
    const rect = rectBetween(offset, [-20, 20, 10], [20, -20, 10]);
    expect(
      ids(
        topologyInBox([cube()], rect, 'window', {
          camera: offset,
          width: SIZE,
          height: SIZE,
          kind: 'face'
        })
      )
    ).toEqual(['face-right', 'face-top']);
  });

  it('leaves a face the window only partly covers', () => {
    const leftHalf = rectBetween(camera, [-16, 16, 10], [0, -16, 10]);
    expect(
      ids(topologyInBox([cube()], leftHalf, 'window', options(true)))
    ).toEqual(['face-left']);
    expect(topologyInBox([cube()], leftHalf, 'window', options())).toEqual([]);
  });

  it('carries face identity for the selection', () => {
    const [top] = topologyInBox([cube()], centre, 'crossing', options());
    expect(top).toEqual({
      bodyId: 'cube',
      kind: 'face',
      topologyId: 'face-top',
      hash: 2
    });
  });
});
