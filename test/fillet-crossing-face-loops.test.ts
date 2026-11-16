import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  filletEdges,
  findSketch
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type EdgeTopology,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import {
  applyEdgeModifier,
  edgeModifierRefusal
} from '../packages/kernel-adapter/src/exact-edge-modifiers';
import {
  crossedFaceLoopsAdvisory,
  displayMeshGapsAdvisory
} from '../packages/kernel-adapter/src/exact-feature-warnings';
import {
  crossingFaceLoops,
  loopCrossingDepth,
  type Point2
} from '../packages/kernel-adapter/src/face-loop-crossing';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * A plate whose outline runs along a tangent S-curve of two R4 arcs past a
 * fused R7.75 hub, 0.137 outside the hub's base circle at its closest.
 * Coordinates are relative to the hub axis. The convex arc is centred at
 * (-1, 4.73); the concave arc's centre is the point 8 (two radii) away
 * toward (-7.765, 9), so the two arcs meet tangentially. The concave arc is
 * the one that passes closest to the hub.
 *
 * Filleting the S-curve at r moves the plate's top-face outline r inward, so
 * any r above 0.137 puts the spring line inside the hub's base circle.
 */
const HUB_RADIUS = 7.75;
const ARC_RADIUS = 4;
const PLATE_THICKNESS = 4;
const HUB_HEIGHT = 6;
const CONVEX = { x: -1, y: 4.73 };
const CONCAVE = (() => {
  const dx = -7.765 - CONVEX.x;
  const dy = 9 - CONVEX.y;
  const length = Math.hypot(dx, dy);
  return {
    x: CONVEX.x + (2 * ARC_RADIUS * dx) / length,
    y: CONVEX.y + (2 * ARC_RADIUS * dy) / length
  };
})();
/** Where the two arcs meet, as an angle about each centre. */
const TANGENT_DEG =
  (Math.atan2(CONCAVE.y - CONVEX.y, CONCAVE.x - CONVEX.x) * 180) / Math.PI;
const CLEARANCE = Math.hypot(CONCAVE.x, CONCAVE.y) - ARC_RADIUS - HUB_RADIUS;
/** The plate's straight edges leave the arcs where they run along x. */
const LOW_Y = CONCAVE.y - ARC_RADIUS;
const HIGH_Y = CONVEX.y + ARC_RADIUS;

const point = (u: number, v: number): Point2 => ({ u, v });

function circle(cx: number, cy: number, radius: number, count = 720) {
  return Array.from({ length: count }, (_, index) => {
    const angle = (2 * Math.PI * index) / count;
    return point(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  });
}

const square = (half: number) => [
  point(-half, -half),
  point(half, -half),
  point(half, half),
  point(-half, half)
];

describe('loop crossing depth', () => {
  const tolerance = 1e-4;

  it('accepts holes inside the outline, touching it or each other', () => {
    expect(loopCrossingDepth([square(10), circle(0, 0, 3)], tolerance)).toBe(0);
    // A hole internally tangent to the outline.
    expect(loopCrossingDepth([square(10), circle(7, 0, 3)], tolerance)).toBe(0);
    // Two holes externally tangent to each other.
    expect(
      loopCrossingDepth(
        [square(10), circle(-3, 0, 3), circle(3, 0, 3)],
        tolerance
      )
    ).toBe(0);
    // The outline is found by area, not by order.
    expect(loopCrossingDepth([circle(0, 0, 3), square(10)], tolerance)).toBe(0);
  });

  it('measures a hole that pokes out of the outline', () => {
    const depth = loopCrossingDepth([circle(7.2, 0, 3), square(10)], tolerance);
    expect(depth).toBeCloseTo(0.2, 3);
  });

  it('measures two holes that overlap', () => {
    const depth = loopCrossingDepth(
      [square(10), circle(-2.9, 0, 3), circle(2.9, 0, 3)],
      tolerance
    );
    expect(depth).toBeGreaterThan(0.1);
  });

  it('measures crossing slots whose corners all lie outside each other', () => {
    // Every vertex of each slot is outside the other; only the edges cross.
    const rectangle = (u0: number, v0: number, u1: number, v1: number) => [
      point(u0, v0),
      point(u1, v0),
      point(u1, v1),
      point(u0, v1)
    ];
    expect(
      loopCrossingDepth(
        [square(10), rectangle(-5, -1, 5, 1), rectangle(-1, -5, 1, 5)],
        tolerance
      )
    ).toBeCloseTo(1, 6);
    // A slot running out through the outline: its far corners lie 2 outside.
    expect(
      loopCrossingDepth([square(10), rectangle(8, -1, 12, 1)], tolerance)
    ).toBeCloseTo(2, 6);
    // Slots meeting edge to edge only touch.
    expect(
      loopCrossingDepth(
        [square(10), rectangle(-5, -1, 0, 1), rectangle(0, -1, 5, 1)],
        tolerance
      )
    ).toBe(0);
  });

  it('measures a hole lying wholly outside the outline', () => {
    expect(
      loopCrossingDepth([square(10), circle(20, 0, 3)], tolerance)
    ).toBeGreaterThan(5);
  });
});

describe('crossed face loops advisory', () => {
  it('does not call a body with crossed loops a valid solid', () => {
    const text = crossedFaceLoopsAdvisory();
    expect(text).not.toMatch(/valid solid/);
    expect(text).toMatch(/holes there, not only its display mesh/);
    expect(displayMeshGapsAdvisory(false)).toMatch(/valid solid/);
  });
});

/** The fixture built straight in the kernel. Returns the solid and S-curve. */
function kernelFixture(kernel: RemusKernel): {
  body: number;
  sCurve: number[];
} {
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    kernel.makeLineEdge(x1, y1, 0, x2, y2, 0);
  const tangent = {
    x: CONVEX.x + ARC_RADIUS * Math.cos((TANGENT_DEG * Math.PI) / 180),
    y: CONVEX.y + ARC_RADIUS * Math.sin((TANGENT_DEG * Math.PI) / 180)
  };
  const edges = [
    line(-20, -15, 20, -15),
    line(20, -15, 20, HIGH_Y),
    line(20, HIGH_Y, CONVEX.x, HIGH_Y),
    // Counter-clockwise about the convex centre, 90 degrees to the tangent.
    kernel.makeCircleArc3d(
      CONVEX.x,
      HIGH_Y,
      0,
      tangent.x,
      tangent.y,
      0,
      CONVEX.x,
      CONVEX.y,
      0,
      0,
      0,
      1
    ),
    // Clockwise about the concave centre, from the tangent down to 270.
    kernel.makeCircleArc3d(
      tangent.x,
      tangent.y,
      0,
      CONCAVE.x,
      LOW_Y,
      0,
      CONCAVE.x,
      CONCAVE.y,
      0,
      0,
      0,
      -1
    ),
    line(CONCAVE.x, LOW_Y, -20, LOW_Y),
    line(-20, LOW_Y, -20, -15)
  ];
  const face = kernel.makeFaceFromWire(
    kernel.makeWire(Uint32Array.from(edges), true)
  );
  const plate = kernel.extrude(face, 0, 0, 1, PLATE_THICKNESS);
  const hub = kernel.makeCylinder(HUB_RADIUS, HUB_HEIGHT);
  const bounds = kernel.boundingBox(hub);
  kernel.transformSolid(
    hub,
    new Float64Array([
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      PLATE_THICKNESS - bounds[2]!,
      0,
      0,
      0,
      1
    ])
  );
  const body = kernel.fuse(plate, hub);
  const sCurve = Array.from(kernel.getSolidEdges(body)).filter((edge) => {
    if (kernel.getEdgeCurveType(edge) !== 'CIRCLE') return false;
    const vertices = kernel.getEdgeVertices(edge);
    return (
      Math.abs(vertices[2]! - PLATE_THICKNESS) < 1e-9 &&
      Math.abs(vertices[5]! - PLATE_THICKNESS) < 1e-9 &&
      Math.abs(kernel.edgeLength(edge) - 2 * Math.PI * HUB_RADIUS) > 1
    );
  });
  return { body, sCurve };
}

function closedMesh(kernel: RemusKernel, solid: number): boolean {
  const mesh = kernel.tessellateSolid(solid, 0.01);
  try {
    return isClosedConsistentlyOrientedMesh(
      inspectTriangleMeshClosure(mesh.positions, mesh.indices)
    );
  } finally {
    mesh.free();
  }
}

describe('fillet whose spring line crosses a boss circle', () => {
  it('has the clearance the fixture claims', () => {
    expect(CLEARANCE).toBeCloseTo(0.137, 3);
  });

  it('refuses a blend that leaves crossed face loops and quotes one that builds', () => {
    const kernel = new RemusKernel();
    const { body, sCurve } = kernelFixture(kernel);
    expect(sCurve).toHaveLength(2);
    expect(crossingFaceLoops(kernel, [body])).toBeNull();

    // What the kernel returns at r0.5, unguarded. On the pinned kernel it is
    // an `ok` result its validator passes, with a plate face whose outline
    // runs 0.363 inside the hub circle and an open mesh. A kernel that trims
    // the face correctly returns no crossing, and the guard has nothing to do.
    const raw = kernel.filletDetailed(body, Uint32Array.from(sCurve), 0.5);
    const rawSolid = raw.status === 'ok' ? raw.value : null;
    const rawCrossing =
      rawSolid === null ? null : crossingFaceLoops(kernel, [rawSolid]);
    if (rawSolid !== null && rawCrossing) {
      expect(rawCrossing.depth).toBeCloseTo(0.5 - CLEARANCE, 2);
      expect(closedMesh(kernel, rawSolid)).toBe(false);
    }

    let reported = '';
    const guarded = applyEdgeModifier(
      kernel,
      body,
      sCurve,
      'fillet',
      0.5,
      (message) => {
        reported = message;
      }
    );
    if (rawCrossing) {
      expect(guarded).toBeNull();
      expect(reported).toMatch(/fillet left a face whose boundary loops cross/);
    }
    if (guarded !== null) {
      // Built: it must be sound.
      expect(crossingFaceLoops(kernel, [guarded])).toBeNull();
      expect(closedMesh(kernel, guarded)).toBe(true);
      return;
    }

    const refusal = edgeModifierRefusal(
      kernel,
      body,
      sCurve,
      'fillet',
      0.5,
      false,
      reported
    );
    expect(refusal.advice?.kind).toBe('smaller-size');
    const quoted =
      refusal.advice?.kind === 'smaller-size' ? refusal.advice.size : NaN;
    expect(refusal.message).toContain(`radius ${quoted} builds here`);
    // The largest radius that keeps the spring line outside the hub circle.
    expect(quoted).toBeGreaterThanOrEqual(0.1);
    expect(quoted).toBeLessThan(CLEARANCE);
    const rounded = applyEdgeModifier(kernel, body, sCurve, 'fillet', quoted);
    expect(rounded).not.toBeNull();
    expect(crossingFaceLoops(kernel, [rounded!])).toBeNull();
    expect(closedMesh(kernel, rounded!)).toBe(true);
  });

  it('builds r0.1 with a closed mesh', () => {
    const kernel = new RemusKernel();
    const { body, sCurve } = kernelFixture(kernel);
    const rounded = applyEdgeModifier(kernel, body, sCurve, 'fillet', 0.1);
    expect(rounded).not.toBeNull();
    expect(crossingFaceLoops(kernel, [rounded!])).toBeNull();
    expect(closedMesh(kernel, rounded!)).toBe(true);
  });
});

/** The same fixture as a document: sketch, extrude, hub extruded onto it. */
function plateDocument(): { document: ProjectDocument; bodyId: BodyId } {
  let document = createProjectDocument(
    'Crossed loops',
    toUserId('user_crossed_loops')
  );
  const outline: SketchObjectData[] = [
    { objectKind: 'line', x1: -20, y1: -15, x2: 20, y2: -15 },
    { objectKind: 'line', x1: 20, y1: -15, x2: 20, y2: HIGH_Y },
    { objectKind: 'line', x1: 20, y1: HIGH_Y, x2: CONVEX.x, y2: HIGH_Y },
    {
      objectKind: 'arc',
      centerX: CONVEX.x,
      centerY: CONVEX.y,
      radius: ARC_RADIUS,
      startAngleDeg: 90,
      endAngleDeg: TANGENT_DEG
    },
    {
      objectKind: 'arc',
      centerX: CONCAVE.x,
      centerY: CONCAVE.y,
      radius: ARC_RADIUS,
      startAngleDeg: 270,
      endAngleDeg: 360 + TANGENT_DEG - 180
    },
    { objectKind: 'line', x1: CONCAVE.x, y1: LOW_Y, x2: -20, y2: LOW_Y },
    { objectKind: 'line', x1: -20, y1: LOW_Y, x2: -20, y2: -15 }
  ];
  const plateSketch = addSketchFeature(document, {
    name: 'Plate sketch',
    plane: 'XY',
    offset: 0,
    objects: outline
  });
  const plate = extrudeSketch(plateSketch.document, {
    name: 'Plate',
    sketchId: plateSketch.sketchId,
    distance: PLATE_THICKNESS,
    profiles: [
      {
        all: true,
        sourceEntityIds: [
          ...findSketch(plateSketch.document, plateSketch.sketchId)!.objectIds
        ]
      }
    ]
  });
  const hubSketch = addSketchFeature(plate.document, {
    name: 'Hub sketch',
    plane: 'XY',
    offset: PLATE_THICKNESS,
    objects: [
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: HUB_RADIUS }
    ]
  });
  const hub = extrudeSketch(hubSketch.document, {
    name: 'Hub',
    sketchId: hubSketch.sketchId,
    distance: HUB_HEIGHT,
    operation: 'add',
    targetBodyId: plate.bodyId,
    profiles: [
      {
        all: true,
        sourceEntityIds: [
          ...findSketch(hubSketch.document, hubSketch.sketchId)!.objectIds
        ]
      }
    ]
  });
  document = hub.document;
  return { document, bodyId: hub.bodyId };
}

const onPlateTop = (edge: EdgeTopology) => {
  for (let index = 2; index < edge.points.length; index += 3) {
    if (Math.abs(edge.points[index]! - PLATE_THICKNESS) > 1e-6) return false;
  }
  return true;
};

describe('crossed-loop fillet through the build', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  async function filleted(size: number) {
    const { document, bodyId } = plateDocument();
    const base = await adapter.syncDocument(document);
    expect(base.warnings).toEqual([]);
    const sCurve = base.bodyRepresentations[bodyId]!.topology!.edges.filter(
      (edge) =>
        onPlateTop(edge) &&
        edge.curve?.type === 'CIRCLE' &&
        Math.abs((edge.curve.circle?.radius ?? 0) - ARC_RADIUS) < 1e-6
    );
    expect(sCurve).toHaveLength(2);
    const result = filletEdges(document, {
      name: `S-curve ${size}`,
      targetBodyId: bodyId,
      edgeHashes: sCurve.map((edge) => edge.hash),
      size
    });
    return {
      derived: await adapter.syncDocument(result.document),
      bodyId: result.bodyId
    };
  }

  const meshClosed = (
    derived: Awaited<ReturnType<ExactKernelAdapter['syncDocument']>>,
    bodyId: BodyId
  ) => {
    const mesh = derived.bodyRepresentations[bodyId]!.mesh;
    return isClosedConsistentlyOrientedMesh(
      inspectTriangleMeshClosure(mesh.vertices, mesh.indices)
    );
  };

  it('refuses r0.5 with a quoted radius, never as a valid solid', async () => {
    const { derived, bodyId } = await filleted(0.5);
    const text = derived.warnings.join('\n');
    expect(text).not.toMatch(/valid solid|display mesh has gaps/);
    const match =
      /Fillet could not be created on 2 selected edges with radius 0\.5\. Try a smaller radius: radius ([0-9.]+) builds here\./.exec(
        text
      );
    if (!match) {
      // A kernel that trims the face builds it soundly instead.
      expect(derived.warnings).toEqual([]);
      expect(meshClosed(derived, bodyId)).toBe(true);
      return;
    }
    const quoted = Number(match[1]);
    expect(quoted).toBeGreaterThanOrEqual(0.1);
    expect(quoted).toBeLessThan(CLEARANCE);
    // A typed refusal carrying the size the ladder built, and no advisory.
    expect(derived.featureWarnings).toHaveLength(1);
    const [refusal] = derived.featureWarnings!;
    expect(refusal!.kind).toBe('build-failed');
    expect(refusal!.kernelRefusal?.code).toBe('edge_modifier_refused');
    expect(refusal!.blendAdvice).toMatchObject({
      kind: 'smaller-size',
      size: quoted
    });

    const retried = await filleted(quoted);
    expect(retried.derived.warnings).toEqual([]);
    expect(meshClosed(retried.derived, retried.bodyId)).toBe(true);
  });

  it('builds r0.1 exactly with a closed mesh', async () => {
    const { derived, bodyId } = await filleted(0.1);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[bodyId]).toBeDefined();
    expect(meshClosed(derived, bodyId)).toBe(true);
  });
});
