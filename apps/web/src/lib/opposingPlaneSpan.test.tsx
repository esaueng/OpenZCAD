import * as THREE from 'three';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type FaceTopology } from '@openzcad/shared';
import { NumericKeypad } from '../components/NumericKeypad';
import { faceDepthBehind } from './faceDepthBehind';
import { planFaceOffset } from './interaction/faceOffsetPlan';
import { faceOffsetChipState, offsetChipText } from './offsetChip';
import {
  OPPOSING_PLANE_ANGLE_TOLERANCE,
  faceTotalSpan,
  opposingPlaneSpan
} from './opposingPlaneSpan';

afterEach(cleanup);

const BODY = new THREE.MeshStandardMaterial();
const RIGHT = new THREE.Vector3(1, 0, 0);
const FRONT = new THREE.Vector3(0, -1, 0);

interface FaceClass {
  id: string;
  surfaceType: string;
  normal?: { x: number; y: number; z: number };
  centroid?: { x: number; y: number; z: number };
}

/**
 * Regroups a non-indexed geometry's triangles into contiguous per-face runs
 * and attaches a topology table to the mesh, as the viewer does with the
 * kernel's: each triangle's face comes from `classify`.
 */
function withTopology(
  source: THREE.BufferGeometry,
  classify: (corners: THREE.Vector3[]) => FaceClass
): THREE.Mesh {
  const geometry = source.index ? source.toNonIndexed() : source;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const runs = new Map<string, { face: FaceClass; triangles: number[] }>();
  for (let triangle = 0; triangle * 3 < position.count; triangle += 1) {
    const corners = [0, 1, 2].map((k) =>
      new THREE.Vector3().fromBufferAttribute(position, triangle * 3 + k)
    );
    const face = classify(corners);
    const run = runs.get(face.id) ?? { face, triangles: [] };
    run.triangles.push(triangle);
    runs.set(face.id, run);
  }
  const positions: number[] = [];
  const normals: number[] = [];
  const faces: Partial<FaceTopology>[] = [];
  let start = 0;
  for (const { face, triangles } of runs.values()) {
    for (const triangle of triangles) {
      for (let k = 0; k < 3; k += 1) {
        const at = triangle * 3 + k;
        positions.push(position.getX(at), position.getY(at), position.getZ(at));
        normals.push(normal.getX(at), normal.getY(at), normal.getZ(at));
      }
    }
    faces.push({
      topologyId: face.id,
      triangleStart: start,
      triangleCount: triangles.length,
      geometry: {
        surfaceType: face.surfaceType,
        area: 0,
        center: { x: 0, y: 0, z: 0 },
        ...(face.normal ? { normal: face.normal } : {}),
        ...(face.centroid ? { centroid: face.centroid } : {})
      }
    });
    start += triangles.length;
  }
  const regrouped = new THREE.BufferGeometry();
  regrouped.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3)
  );
  regrouped.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(normals, 3)
  );
  const mesh = new THREE.Mesh(regrouped, BODY);
  mesh.userData.topology = { faces };
  return mesh;
}

const WIDTH = 27;
const DEPTH = 38;
const HEIGHT = 29.5;
const FILLET = 8.8;
const HOLE = { x: 9, y: 19, r: 3 };

/** Classifies an extruded profile's facets: planes by where all corners lie. */
function prismFaces(
  planes: { id: string; axis: 'x' | 'y' | 'z'; at: number; sign: 1 | -1 }[],
  curved: (corners: THREE.Vector3[]) => FaceClass
) {
  return (corners: THREE.Vector3[]): FaceClass => {
    for (const plane of planes) {
      if (
        corners.every(
          (corner) => Math.abs(corner[plane.axis] - plane.at) < 1e-5
        )
      ) {
        return {
          id: plane.id,
          surfaceType: 'plane',
          normal: {
            x: plane.axis === 'x' ? plane.sign : 0,
            y: plane.axis === 'y' ? plane.sign : 0,
            z: plane.axis === 'z' ? plane.sign : 0
          }
        };
      }
    }
    return curved(corners);
  };
}

/**
 * The recorded part's shape: a 27 × 38 × 29.5 mm box with r8.8 vertical
 * corner fillets and a Ø6 through hole. The hole's wall is a cylinder, so is
 * every fillet; `holeSides` lets a coarse hole present a facet that faces
 * exactly back at a pick, which only its surface class can rule out.
 */
function filletedBoxWithHole(
  options: { holeSides?: number; topology?: boolean } = {}
): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(FILLET, 0);
  shape.lineTo(WIDTH - FILLET, 0);
  shape.absarc(WIDTH - FILLET, FILLET, FILLET, -Math.PI / 2, 0, false);
  shape.lineTo(WIDTH, DEPTH - FILLET);
  shape.absarc(WIDTH - FILLET, DEPTH - FILLET, FILLET, 0, Math.PI / 2, false);
  shape.lineTo(FILLET, DEPTH);
  shape.absarc(FILLET, DEPTH - FILLET, FILLET, Math.PI / 2, Math.PI, false);
  shape.lineTo(0, FILLET);
  shape.absarc(FILLET, FILLET, FILLET, Math.PI, Math.PI * 1.5, false);
  const hole = new THREE.Path();
  if (options.holeSides) {
    // A polygon whose +X side stands square to the X axis.
    for (let side = 0; side <= options.holeSides; side += 1) {
      const angle =
        Math.PI / options.holeSides + (side * 2 * Math.PI) / options.holeSides;
      const x = HOLE.x + HOLE.r * Math.cos(-angle);
      const y = HOLE.y + HOLE.r * Math.sin(-angle);
      if (side === 0) hole.moveTo(x, y);
      else hole.lineTo(x, y);
    }
  } else {
    hole.absarc(HOLE.x, HOLE.y, HOLE.r, 0, Math.PI * 2, true);
  }
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: HEIGHT,
    bevelEnabled: false,
    curveSegments: 256
  });
  if (options.topology === false) return new THREE.Mesh(geometry, BODY);
  return withTopology(
    geometry,
    prismFaces(
      [
        { id: 'left', axis: 'x', at: 0, sign: -1 },
        { id: 'right', axis: 'x', at: WIDTH, sign: 1 },
        { id: 'front', axis: 'y', at: 0, sign: -1 },
        { id: 'back', axis: 'y', at: DEPTH, sign: 1 },
        { id: 'bottom', axis: 'z', at: 0, sign: -1 },
        { id: 'top', axis: 'z', at: HEIGHT, sign: 1 }
      ],
      (corners) => {
        const nearHole = corners.every(
          (corner) =>
            Math.hypot(corner.x - HOLE.x, corner.y - HOLE.y) < HOLE.r + 1e-3
        );
        return nearHole
          ? { id: 'hole', surfaceType: 'cylinder' }
          : {
              id: `fillet:${Math.sign(corners[0]!.x - WIDTH / 2)}:${Math.sign(corners[0]!.y - DEPTH / 2)}`,
              surfaceType: 'cylinder'
            };
      }
    )
  );
}

/** On the right face, at a height where the line crosses the hole's wall. */
const HOLE_ALIGNED = new THREE.Vector3(
  WIDTH,
  HOLE.y + Math.sqrt(HOLE.r ** 2 - 1.98 ** 2),
  8
);
/** On the right face, clear of the hole. */
const HOLE_CLEAR = new THREE.Vector3(WIDTH, 25, 8);

describe('opposingPlaneSpan', () => {
  it('reads the 27 mm width through and beside the hole', () => {
    const body = filletedBoxWithHole();
    // The recorded defect: the material-depth line stops at the hole wall.
    expect(faceDepthBehind(body, HOLE_ALIGNED, RIGHT)).toBeCloseTo(16.02, 2);
    expect(opposingPlaneSpan(body, HOLE_ALIGNED, RIGHT)).toBeCloseTo(WIDTH, 9);
    expect(opposingPlaneSpan(body, HOLE_CLEAR, RIGHT)).toBeCloseTo(WIDTH, 9);
    // Straight through the hole's axis, too.
    expect(
      opposingPlaneSpan(body, new THREE.Vector3(WIDTH, HOLE.y, 8), RIGHT)
    ).toBeCloseTo(WIDTH, 9);
    // And across the other way, from the left face.
    expect(
      opposingPlaneSpan(
        body,
        new THREE.Vector3(0, HOLE.y, 20),
        new THREE.Vector3(-1, 0, 0)
      )
    ).toBeCloseTo(WIDTH, 9);
  });

  it('reads the chip text the user sees as the box width', () => {
    const span = opposingPlaneSpan(filletedBoxWithHole(), HOLE_ALIGNED, RIGHT);
    const state = faceOffsetChipState(undefined, span);
    expect(state.mode).toBe('total');
    expect(
      offsetChipText({
        rawValue: 0,
        mode: state.mode,
        span: state.extent,
        sense: 1,
        units: 'mm'
      })
    ).toBe('27 mm');
  });

  it('never stops on a curved face, even one tessellated square to the line', () => {
    // A hexagonal hole: its +X facet faces exactly back along the line, so
    // only the face's cylinder surface class rules it out as the reference.
    const body = filletedBoxWithHole({ holeSides: 6 });
    expect(
      opposingPlaneSpan(body, new THREE.Vector3(WIDTH, HOLE.y, 8), RIGHT)
    ).toBeCloseTo(WIDTH, 9);
    // Without topology a flat facet is all there is to go on.
    const bare = filletedBoxWithHole({ holeSides: 6, topology: false });
    expect(
      opposingPlaneSpan(bare, new THREE.Vector3(WIDTH, HOLE.y, 8), RIGHT)
    ).toBeCloseTo(WIDTH - HOLE.x - HOLE.r * Math.cos(Math.PI / 6), 5);
  });

  it('reads the finely tessellated round hole through even without topology', () => {
    // No facet of a 256-segment circle is within tolerance of square.
    const bare = filletedBoxWithHole({ topology: false });
    expect(opposingPlaneSpan(bare, HOLE_ALIGNED, RIGHT)).toBeCloseTo(WIDTH, 5);
  });

  it('offers no Total when the line leaves only by curved or leaning faces', () => {
    // A D-shaped bar: a flat face at x = 0 in front of a half-round back.
    const shape = new THREE.Shape();
    shape.moveTo(0, -10);
    shape.lineTo(0, 10);
    shape.absarc(0, 0, 10, Math.PI / 2, -Math.PI / 2, false);
    const dee = withTopology(
      new THREE.ExtrudeGeometry(shape, {
        depth: 5,
        bevelEnabled: false,
        curveSegments: 64
      }),
      prismFaces(
        [
          { id: 'flat', axis: 'x', at: 0, sign: 1 },
          { id: 'bottom', axis: 'z', at: 0, sign: -1 },
          { id: 'top', axis: 'z', at: 5, sign: 1 }
        ],
        () => ({ id: 'round', surfaceType: 'cylinder' })
      )
    );
    const flat = RIGHT;
    expect(opposingPlaneSpan(dee, new THREE.Vector3(0, 0, 2), flat)).toBeNull();
    // The flat face's centroid line leaves by the same round: still none.
    expect(
      faceTotalSpan(dee, 'flat', new THREE.Vector3(0, 0, 2), flat)
    ).toBeNull();
    expect(faceOffsetChipState(undefined, null).mode).toBe('offset');

    // A wedge: the face behind the pick leans 45° away from square.
    const wedgeShape = new THREE.Shape();
    wedgeShape.moveTo(0, 0);
    wedgeShape.lineTo(20, 0);
    wedgeShape.lineTo(20, 10);
    wedgeShape.lineTo(10, 10);
    wedgeShape.lineTo(0, 0);
    const wedge = withTopology(
      new THREE.ExtrudeGeometry(wedgeShape, { depth: 5, bevelEnabled: false }),
      prismFaces(
        [
          { id: 'right', axis: 'x', at: 20, sign: 1 },
          { id: 'top', axis: 'y', at: 10, sign: 1 },
          { id: 'bottom', axis: 'y', at: 0, sign: -1 },
          { id: 'back', axis: 'z', at: 0, sign: -1 },
          { id: 'front', axis: 'z', at: 5, sign: 1 }
        ],
        () => ({
          id: 'chamfer',
          surfaceType: 'plane',
          normal: { x: -Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }
        })
      )
    );
    expect(
      opposingPlaneSpan(wedge, new THREE.Vector3(20, 5, 2), RIGHT)
    ).toBeNull();
  });

  it('does not stop on a chamfer the line leaves by', () => {
    // A block with its back-top edge chamfered: from the right the line at
    // y = 9 leaves by the chamfer, and nothing flat lies beyond it.
    const near = new THREE.Shape();
    near.moveTo(10, 0);
    near.lineTo(30, 0);
    near.lineTo(30, 10);
    near.lineTo(12, 10);
    near.lineTo(10, 8);
    near.lineTo(10, 0);
    const chamfered = withTopology(
      new THREE.ExtrudeGeometry(near, { depth: 5, bevelEnabled: false }),
      prismFaces(
        [
          { id: 'right', axis: 'x', at: 30, sign: 1 },
          { id: 'left', axis: 'x', at: 10, sign: -1 },
          { id: 'top', axis: 'y', at: 10, sign: 1 },
          { id: 'bottom', axis: 'y', at: 0, sign: -1 },
          { id: 'back', axis: 'z', at: 0, sign: -1 },
          { id: 'front', axis: 'z', at: 5, sign: 1 }
        ],
        () => ({
          id: 'chamfer',
          surfaceType: 'plane',
          normal: { x: -Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }
        })
      )
    );
    expect(
      opposingPlaneSpan(chamfered, new THREE.Vector3(30, 9, 2), RIGHT)
    ).toBeNull();
    // Below the chamfer the line meets the square back face.
    expect(
      opposingPlaneSpan(chamfered, new THREE.Vector3(30, 4, 2), RIGHT)
    ).toBeCloseTo(20, 9);
  });

  it('falls back to the face footprint when the pick only reaches a fillet', () => {
    // A 20 × 10 slab whose back-top vertical edge is rounded r4: a pick on
    // the right face at y = 8 leaves by the round, its centroid does not.
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(20, 0);
    shape.lineTo(20, 10);
    shape.lineTo(4, 10);
    shape.absarc(4, 6, 4, Math.PI / 2, Math.PI, false);
    shape.lineTo(0, 0);
    const slab = withTopology(
      new THREE.ExtrudeGeometry(shape, {
        depth: 6,
        bevelEnabled: false,
        curveSegments: 64
      }),
      prismFaces(
        [
          { id: 'right', axis: 'x', at: 20, sign: 1 },
          { id: 'left', axis: 'x', at: 0, sign: -1 },
          { id: 'top', axis: 'y', at: 10, sign: 1 },
          { id: 'bottom', axis: 'y', at: 0, sign: -1 },
          { id: 'back', axis: 'z', at: 0, sign: -1 },
          { id: 'front', axis: 'z', at: 6, sign: 1 }
        ],
        () => ({ id: 'round', surfaceType: 'cylinder' })
      )
    );
    const right = (
      slab.userData.topology as { faces: FaceTopology[] }
    ).faces.find((face) => face.topologyId === 'right')!;
    right.geometry!.centroid = { x: 20, y: 5, z: 3 };
    const pick = new THREE.Vector3(20, 8, 1);
    expect(opposingPlaneSpan(slab, pick, RIGHT)).toBeNull();
    expect(faceTotalSpan(slab, 'right', pick, RIGHT)).toBeCloseTo(20, 9);
    // Where the pick reaches the plane itself, the fallback is not used.
    expect(
      faceTotalSpan(slab, 'right', new THREE.Vector3(20, 2, 1), RIGHT)
    ).toBeCloseTo(20, 9);
  });

  it('reads a ring face whose pick and centroid both sit in its hole', () => {
    // An 80 × 40 × 6 plate with a Ø10 hole through its middle: the top
    // face's handle and its area centroid are both over the hole.
    const outline = new THREE.Shape();
    outline.moveTo(0, 0);
    outline.lineTo(80, 0);
    outline.lineTo(80, 40);
    outline.lineTo(0, 40);
    outline.lineTo(0, 0);
    const hole = new THREE.Path();
    hole.absarc(40, 20, 5, 0, Math.PI * 2, true);
    outline.holes.push(hole);
    const plate = withTopology(
      new THREE.ExtrudeGeometry(outline, {
        depth: 6,
        bevelEnabled: false,
        curveSegments: 64
      }),
      prismFaces(
        [
          { id: 'top', axis: 'z', at: 6, sign: 1 },
          { id: 'bottom', axis: 'z', at: 0, sign: -1 },
          { id: 'left', axis: 'x', at: 0, sign: -1 },
          { id: 'right', axis: 'x', at: 80, sign: 1 },
          { id: 'front', axis: 'y', at: 0, sign: -1 },
          { id: 'back', axis: 'y', at: 40, sign: 1 }
        ],
        () => ({ id: 'hole', surfaceType: 'cylinder' })
      )
    );
    const faces = (plate.userData.topology as { faces: FaceTopology[] })
      .faces;
    faces.find((face) => face.topologyId === 'top')!.geometry!.centroid = {
      x: 40,
      y: 20,
      z: 6
    };
    faces.find((face) => face.topologyId === 'bottom')!.geometry!.centroid = {
      x: 40,
      y: 20,
      z: 0
    };
    const up = new THREE.Vector3(0, 0, 1);
    const overHole = new THREE.Vector3(40, 20, 6);
    expect(opposingPlaneSpan(plate, overHole, up)).toBeNull();
    expect(faceTotalSpan(plate, 'top', overHole, up)).toBeCloseTo(6, 9);
    expect(
      faceTotalSpan(
        plate,
        'bottom',
        new THREE.Vector3(40, 20, 0),
        new THREE.Vector3(0, 0, -1)
      )
    ).toBeCloseTo(6, 9);
  });

  it('keeps the stepped tab and separated lobe readings local to the pick', () => {
    const block = (
      size: [number, number, number],
      center: [number, number, number]
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), BODY);
      mesh.position.set(...center);
      return mesh;
    };
    // Two 40 mm blocks 100 mm apart on a thin plate.
    const lobes = new THREE.Group();
    lobes.add(block([40, 40, 60], [20, 20, 30]));
    lobes.add(block([40, 40, 60], [160, 20, 30]));
    lobes.add(block([100, 40, 5], [90, 20, 2.5]));
    lobes.position.set(5, 0, 0);
    expect(
      opposingPlaneSpan(lobes, new THREE.Vector3(185, 20, 40), RIGHT)
    ).toBeCloseTo(40, 6);
    // A 10 mm tab over a 140 mm deep base, one flat face across both.
    const tab = new THREE.Group();
    tab.add(block([30, 140, 40], [15, 70, 20]));
    tab.add(block([30, 10, 30], [15, 5, 55]));
    expect(
      opposingPlaneSpan(tab, new THREE.Vector3(15, 0, 60), FRONT)
    ).toBeCloseTo(10, 6);
    expect(
      opposingPlaneSpan(tab, new THREE.Vector3(15, 0, 20), FRONT)
    ).toBeCloseTo(140, 6);
    // Nothing behind the pick: no material to span.
    expect(
      opposingPlaneSpan(
        lobes,
        new THREE.Vector3(95, 20, 60),
        new THREE.Vector3(0, 0, 1)
      )
    ).toBeNull();
  });

  it('counts from the plane the gesture started on', () => {
    const origin = new THREE.Vector3(5, 0, 0);
    const out = new THREE.Mesh(new THREE.BoxGeometry(12, 10, 10), BODY);
    out.position.set(1, 0, 0);
    expect(opposingPlaneSpan(out, origin, RIGHT, 2)).toBeCloseTo(10, 6);
  });

  it('measures plane to plane, within its angular tolerance only', () => {
    // A back face leaning just inside the tolerance still counts, read
    // perpendicular to it; one leaning just past it does not.
    const leaning = (angle: number) => {
      const shape = new THREE.Shape();
      const back = 10 * Math.tan(angle);
      shape.moveTo(0, 0);
      shape.lineTo(20, 0);
      shape.lineTo(20, 10);
      shape.lineTo(back, 10);
      shape.lineTo(0, 0);
      return withTopology(
        new THREE.ExtrudeGeometry(shape, { depth: 5, bevelEnabled: false }),
        prismFaces(
          [
            { id: 'right', axis: 'x', at: 20, sign: 1 },
            { id: 'top', axis: 'y', at: 10, sign: 1 },
            { id: 'bottom', axis: 'y', at: 0, sign: -1 },
            { id: 'back', axis: 'z', at: 0, sign: -1 },
            { id: 'front', axis: 'z', at: 5, sign: 1 }
          ],
          () => ({
            id: 'left',
            surfaceType: 'plane',
            normal: { x: -Math.cos(angle), y: Math.sin(angle), z: 0 }
          })
        )
      );
    };
    const within = OPPOSING_PLANE_ANGLE_TOLERANCE / 2;
    const span = opposingPlaneSpan(
      leaning(within),
      new THREE.Vector3(20, 5, 2),
      RIGHT
    )!;
    // The pick's perpendicular distance to the plane through the origin
    // with normal (-cos, sin), not the length of the line to it.
    expect(span).toBeCloseTo(20 * Math.cos(within) - 5 * Math.sin(within), 4);
    expect(
      opposingPlaneSpan(
        leaning(OPPOSING_PLANE_ANGLE_TOLERANCE * 2),
        new THREE.Vector3(20, 5, 2),
        RIGHT
      )
    ).toBeNull();
  });
});

describe('typed Total on the filleted, drilled box', () => {
  it('turns Total 20 into a −7 offset and stores −7', () => {
    const span = opposingPlaneSpan(filletedBoxWithHole(), HOLE_ALIGNED, RIGHT)!;
    const onCommit = vi.fn();
    render(
      <NumericKeypad
        request={{
          kind: 'offset',
          label: 'Total',
          initial: '27',
          unitKind: 'length',
          totalBaseline: span,
          totalSense: 1,
          initialOffset: 0
        }}
        units="mm"
        scope={{}}
        anchorRef={{ current: null }}
        onPreview={vi.fn()}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Total' }), {
      target: { value: '20' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply total' }));
    expect(onCommit).toHaveBeenCalledOnce();
    const offset = onCommit.mock.calls[0]![0] as number;
    expect(offset).toBeCloseTo(-7, 9);

    const document = addPrimitiveFeature(
      createProjectDocument('Total width', toUserId('user_total_width')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: WIDTH, height: DEPTH, depth: HEIGHT }
      }
    );
    const face: FaceTopology = {
      topologyId: 'face:right',
      hash: 123,
      triangleStart: 0,
      triangleCount: 2,
      geometry: {
        surfaceType: 'plane',
        area: 314,
        center: { x: WIDTH, y: 19, z: 8 },
        normal: { x: 1, y: 0, z: 0 }
      }
    };
    const plan = planFaceOffset({
      document,
      bodyId: document.bodyOrder[0]!,
      face,
      faceHash: face.hash,
      offset
    });
    expect(plan?.kind).toBe('direct-edit');
    const feature = listFeaturesInOrder(plan!.command.apply(document)).at(-1)!;
    if (
      feature.data.featureKind !== 'direct-edit' ||
      feature.data.operation.kind !== 'offset-face'
    ) {
      throw new Error('expected an offset-face direct edit');
    }
    expect(feature.data.operation.offset).toBe(-7);
  });
});
