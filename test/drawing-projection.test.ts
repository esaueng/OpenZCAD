import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  DRAWING_VIEW_FRAMES,
  toUserId,
  type BodyId,
  type DrawingViewOrientation,
  type ProjectDocument
} from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  OcclusionGrid,
  OcclusionIndex,
  SegmentGrid,
  dropCoincidentHidden,
  gridCellsAlong,
  projectView,
  triangleSag,
  type Triangle,
  type ViewProjection
} from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

function box(
  document: ProjectDocument,
  name: string,
  size: [number, number, number],
  at: [number, number, number] = [0, 0, 0]
): { document: ProjectDocument; bodyId: BodyId } {
  let next = addPrimitiveFeature(document, {
    name,
    primitiveKind: 'box',
    dimensions: { width: size[0], height: size[1], depth: size[2] }
  });
  const bodyId = next.bodyOrder.at(-1)!;
  if (at.some((value) => value !== 0))
    next = transformBody(next, {
      name: `${name} position`,
      targetBodyId: bodyId,
      translation: { x: at[0], y: at[1], z: at[2] }
    }).document;
  return { document: next, bodyId };
}

async function project(
  document: ProjectDocument,
  bodyIds: BodyId[],
  orientation: DrawingViewOrientation,
  hiddenLines = true
): Promise<ViewProjection> {
  const derived = await adapter.syncDocument(document);
  expect(derived.warnings).toEqual([]);
  return projectView({
    orientation,
    hiddenLines,
    bodies: bodyIds.map((id) =>
      projectionBodyInput(derived.bodyRepresentations[id]!)!
    )
  });
}

/** Every run's endpoints, rounded, so a run can be matched in either order. */
function runs(lines: Float64Array[]): string[] {
  const key = (u: number, v: number) => `${u.toFixed(4)},${v.toFixed(4)}`;
  return lines.map((line) => {
    const a = key(line[0]!, line[1]!);
    const b = key(line.at(-2)!, line.at(-1)!);
    return a < b ? `${a}>${b}` : `${b}>${a}`;
  });
}

function projected(orientation: DrawingViewOrientation, [x, y, z]: number[]) {
  const frame = DRAWING_VIEW_FRAMES[orientation];
  return [
    frame.x.x * x! + frame.x.y * y! + frame.x.z * z!,
    frame.up.x * x! + frame.up.y * y! + frame.up.z * z!
  ] as const;
}

function run(
  orientation: DrawingViewOrientation,
  from: number[],
  to: number[]
): string {
  const [ua, va] = projected(orientation, from);
  const [ub, vb] = projected(orientation, to);
  const a = `${ua.toFixed(4)},${va.toFixed(4)}`;
  const b = `${ub.toFixed(4)},${vb.toFixed(4)}`;
  return a < b ? `${a}>${b}` : `${b}>${a}`;
}

function onLine(
  lines: Float64Array[],
  test: (u: number, v: number) => boolean
): Float64Array[] {
  return lines.filter((line) => {
    for (let i = 0; i < line.length; i += 2)
      if (!test(line[i]!, line[i + 1]!)) return false;
    return true;
  });
}

function vSpan(lines: Float64Array[]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const line of lines)
    for (let i = 1; i < line.length; i += 2) {
      min = Math.min(min, line[i]!);
      max = Math.max(max, line[i]!);
    }
  return max - min;
}

describe('D01 view projection', () => {
  it('projects a 20×10×6 box onto exact principal-view bounds with no hidden lines', async () => {
    const start = createProjectDocument('Box', toUserId('test'));
    const { document, bodyId } = box(start, 'Box', [20, 10, 6]);
    const expectations: [
      DrawingViewOrientation,
      [number, number, number, number]
    ][] = [
      ['front', [0, 0, 20, 6]],
      ['top', [0, 0, 20, 10]],
      ['right', [0, 0, 10, 6]],
      ['left', [-10, 0, 0, 6]],
      ['bottom', [0, -10, 20, 0]],
      ['back', [-20, 0, 0, 6]]
    ];
    for (const [orientation, [minU, minV, maxU, maxV]] of expectations) {
      const result = await project(document, [bodyId], orientation);
      expect(result.bounds!.minU, orientation).toBeCloseTo(minU, 6);
      expect(result.bounds!.minV, orientation).toBeCloseTo(minV, 6);
      expect(result.bounds!.maxU, orientation).toBeCloseTo(maxU, 6);
      expect(result.bounds!.maxV, orientation).toBeCloseTo(maxV, 6);
      expect(result.visible.length, orientation).toBeGreaterThan(0);
      expect(result.hidden, orientation).toEqual([]);
    }
  });

  it('hides exactly the three edges at the far corner of a box in the isometric', async () => {
    // 30 × 20 × 10 is the regression: a sample landing exactly on a face's
    // triangle diagonal once split a hidden edge around a visible blip.
    for (const [w, d, h] of [
      [20, 10, 6],
      [30, 20, 10]
    ] as const) {
      const start = createProjectDocument('Box', toUserId('test'));
      const { document, bodyId } = box(start, 'Box', [w, d, h]);
      const result = await project(document, [bodyId], 'iso');
      // Seen from (1, −1, 1), the far corner is (0, d, 0).
      expect(runs(result.hidden).sort(), `${w}×${d}×${h}`).toEqual(
        [
          run('iso', [0, d, 0], [w, d, 0]),
          run('iso', [0, d, 0], [0, 0, 0]),
          run('iso', [0, d, 0], [0, d, h])
        ].sort()
      );
      expect(runs(result.visible)).toContain(run('iso', [0, 0, 0], [w, 0, 0]));
      expect(runs(result.visible)).toContain(run('iso', [w, d, h], [0, d, h]));
      expect(result.visible).toHaveLength(9);
      // Straight edges come out as their two ends, not their samples.
      for (const line of [...result.visible, ...result.hidden])
        expect(line).toHaveLength(4);
    }
    // Page-up is +Z: the top face's far corner sits above the bottom's.
    expect(projected('iso', [0, 0, 6])[1]).toBeGreaterThan(
      projected('iso', [0, 0, 0])[1]
    );
  });

  it('drops the hidden set when hidden lines are off', async () => {
    const start = createProjectDocument('Box', toUserId('test'));
    const { document, bodyId } = box(start, 'Box', [20, 10, 6]);
    const result = await project(document, [bodyId], 'iso', false);
    expect(result.hidden).toEqual([]);
    expect(result.visible).toHaveLength(9);
  });

  it('draws the silhouette sides of a cylinder seen from the side', async () => {
    let document = createProjectDocument('Shaft', toUserId('test'));
    document = addPrimitiveFeature(document, {
      name: 'Shaft',
      primitiveKind: 'cylinder',
      dimensions: { radius: 5, height: 20 }
    });
    const bodyId = document.bodyOrder[0]!;
    const derived = await adapter.syncDocument(document);
    const bbox = derived.bodyRepresentations[bodyId]!.bbox;
    const result = await project(document, [bodyId], 'front');
    const cx = (bbox.min.x + bbox.max.x) / 2;
    const tolerance = 0.05;
    for (const side of [cx - 5, cx + 5]) {
      const lines = onLine(
        result.visible,
        (u) => Math.abs(u - side) < tolerance
      );
      expect(lines.length, `silhouette at u=${side}`).toBeGreaterThan(0);
      expect(vSpan(lines)).toBeCloseTo(bbox.max.z - bbox.min.z, 1);
    }
    // The back halves of both rims coincide with the front halves in a
    // side view, and the side view shows no hidden geometry behind a solid
    // cylinder.
    expect(result.hidden).toEqual([]);
  });

  it('hides a far post behind the near one in a U part (non-local occlusion)', async () => {
    let document = createProjectDocument('U', toUserId('test'));
    const base = box(document, 'Base', [30, 10, 5]);
    // The far post is narrower so its edges fall strictly inside the near
    // post's outline in the right view.
    const far = box(base.document, 'Far post', [5, 6, 20], [0, 2, 0]);
    const near = box(far.document, 'Near post', [5, 10, 20], [25, 0, 0]);
    document = booleanBodies(near.document, {
      name: 'U',
      operation: 'union',
      targetBodyIds: [base.bodyId, far.bodyId, near.bodyId]
    }).document;
    const u = document.bodyOrder.at(-1)!;
    const result = await project(document, [u], 'right');
    // The far post's two vertical edges at y = 2 and y = 8, above the base.
    for (const y of [2, 8]) {
      const hidden = onLine(result.hidden, (uu) => Math.abs(uu - y) < 1e-6);
      expect(vSpan(hidden), `hidden edge at y=${y}`).toBeCloseTo(15, 3);
      expect(onLine(result.visible, (uu) => Math.abs(uu - y) < 1e-6)).toEqual(
        []
      );
    }
  });

  it('finds an occluder far narrower than any sampling step would', async () => {
    // A 0.2 mm fin in front of a 400 mm bar: the fin covers 0.05% of the
    // bar's top edge, which a fixed step of diagonal/400 (~1 mm) skipped.
    let document = createProjectDocument('Fin', toUserId('test'));
    const fin = box(document, 'Fin', [0.2, 2, 20], [100, 0, 0]);
    const bar = box(fin.document, 'Bar', [400, 2, 10], [0, 10, 0]);
    document = bar.document;
    const result = await project(document, [fin.bodyId, bar.bodyId], 'front');
    const covered = onLine(
      result.hidden,
      (u, v) => Math.abs(v - 10) < 1e-6 && u >= 100 - 1e-6 && u <= 100.2 + 1e-6
    );
    // The bar's front-top and back-top edges coincide in this view; both
    // are behind the fin there, so the span is drawn hidden (once per edge).
    expect([...new Set(runs(covered))]).toEqual([
      run('front', [100, 10, 10], [100.2, 10, 10])
    ]);
    expect(
      onLine(
        result.visible,
        (u, v) => Math.abs(v - 10) < 1e-6 && u > 100.01 && u < 100.19
      )
    ).toEqual([]);
  });

  it("splits an edge where it passes through another body's face", async () => {
    // A bar pierces a plate. Seen from (1, −1, 1), the bar's near top edge
    // is visible in front of the plate (y < 0) and hidden from where it
    // enters the plate's front face at y = 0, inside that face's footprint.
    let document = createProjectDocument('Pierce', toUserId('test'));
    const plate = box(document, 'Plate', [20, 2, 20]);
    const bar = box(plate.document, 'Bar', [2, 10, 2], [9, -4, 9]);
    document = bar.document;
    const result = await project(document, [plate.bodyId, bar.bodyId], 'iso');
    const [eu, ev] = projected('iso', [11, 0, 11]);
    const [su, sv] = projected('iso', [11, -4, 11]);
    const near = (line: Float64Array, u: number, v: number) => {
      for (let i = 0; i + 1 < line.length; i += 2)
        if (Math.hypot(line[i]! - u, line[i + 1]! - v) < 0.05) return true;
      return false;
    };
    // One visible run from the bar's front corner to where it enters the
    // plate (other edges share the corner, so match both ends).
    expect(
      result.visible.some((line) => near(line, su, sv) && near(line, eu, ev)),
      'visible run from the bar end to the plate face'
    ).toBe(true);
    expect(
      result.hidden.some((line) => near(line, eu, ev)),
      'hidden run starts at the plate face'
    ).toBe(true);
  });

  it('hides a body a tenth of a millimetre behind a face on a metre-scale sheet', async () => {
    // A 1 m panel 0.05 mm thick, and a small block 0.1 mm behind its front
    // face: a tolerance scaled to the whole view (0.5 mm here) let every
    // edge of the block through as visible.
    let document = createProjectDocument('Panel', toUserId('test'));
    const panel = box(document, 'Panel', [1000, 0.05, 1000]);
    const block = box(panel.document, 'Block', [10, 2, 10], [495, 0.1, 495]);
    document = block.document;
    const result = await project(
      document,
      [panel.bodyId, block.bodyId],
      'front'
    );
    const inside = (u: number, v: number) =>
      u >= 495 - 1e-6 && u <= 505 + 1e-6 && v >= 495 - 1e-6 && v <= 505 + 1e-6;
    expect(onLine(result.visible, inside)).toEqual([]);
    expect(onLine(result.hidden, inside).length).toBeGreaterThan(0);
  });

  it('lets one body hide another', async () => {
    let document = createProjectDocument('Two', toUserId('test'));
    const front = box(document, 'Front', [20, 2, 20]);
    const back = box(front.document, 'Back', [10, 2, 10], [5, 10, 5]);
    document = back.document;
    const result = await project(
      document,
      [front.bodyId, back.bodyId],
      'front'
    );
    // Every edge of the smaller body behind is hidden.
    const behind = onLine(
      result.hidden,
      (u, v) =>
        u >= 5 - 1e-6 && u <= 15 + 1e-6 && v >= 5 - 1e-6 && v <= 15 + 1e-6
    );
    expect(runs(behind)).toEqual(
      expect.arrayContaining([
        run('front', [5, 10, 5], [15, 10, 5]),
        run('front', [5, 10, 15], [15, 10, 15]),
        run('front', [5, 10, 5], [5, 10, 15]),
        run('front', [15, 10, 5], [15, 10, 15])
      ])
    );
    expect(
      onLine(
        result.visible,
        (u, v) => u > 5.5 && u < 14.5 && v > 5.5 && v < 14.5
      )
    ).toEqual([]);
  });

  it('draws a through hole as hidden silhouettes in the side view of a drilled plate', async () => {
    let document = createProjectDocument('Plate', toUserId('test'));
    const plate = box(document, 'Plate', [20, 10, 6]);
    document = addPrimitiveFeature(plate.document, {
      name: 'Drill',
      primitiveKind: 'cylinder',
      dimensions: { radius: 2, height: 10 }
    });
    const drill = document.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(document);
    const drillBox = derived.bodyRepresentations[drill]!.bbox;
    document = transformBody(document, {
      name: 'Drill position',
      targetBodyId: drill,
      translation: {
        x: 10 - (drillBox.min.x + drillBox.max.x) / 2,
        y: 5 - (drillBox.min.y + drillBox.max.y) / 2,
        z: -2 - drillBox.min.z
      }
    }).document;
    document = booleanBodies(document, {
      name: 'Drilled',
      operation: 'subtract',
      targetBodyIds: [plate.bodyId, drill]
    }).document;
    const drilled = document.bodyOrder.at(-1)!;
    const result = await project(document, [drilled], 'front');
    expect(result.bounds!.minU).toBeCloseTo(0, 6);
    expect(result.bounds!.maxU).toBeCloseTo(20, 6);
    for (const side of [8, 12]) {
      const hidden = onLine(result.hidden, (u) => Math.abs(u - side) < 0.05);
      expect(vSpan(hidden), `bore silhouette at u=${side}`).toBeCloseTo(6, 1);
    }
    const top = await project(document, [drilled], 'top');
    // From above, the bore's upper rim is visible and the lower one coincides.
    expect(top.visible.length).toBeGreaterThan(4);
  });

  it('records the pinned kernel projectEdges gaps this projection exists to close', async () => {
    // Diagnostic evidence for the design choice in projectView.ts. If this
    // starts failing after a Remus bump, the kernel has gained global
    // occlusion and silhouettes: re-evaluate projecting with projectEdges.
    const kernel = new RemusKernel();
    try {
      const move = (solid: number, x: number, y: number) => {
        kernel.transformSolid(
          solid,
          new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, 0, 0, 0, 0, 1])
        );
        return solid;
      };
      const u = kernel.fuse(
        kernel.fuse(
          kernel.makeBox(30, 10, 5),
          move(kernel.makeBox(5, 6, 20), 0, 2)
        ),
        move(kernel.makeBox(5, 10, 20), 25, 0)
      );
      const parse = (value: unknown) =>
        (typeof value === 'string' ? JSON.parse(value) : value) as {
          visible: number[][];
          hidden: number[][];
        };
      const side = parse(
        kernel.projectEdges(u, 0, 0, 0, -1, 0, 0, 0, 1, 0, true, 0.1)
      );
      const farEdgeVisible = side.visible.some((line) =>
        line.every(
          (value, index) => index % 2 === 1 || Math.abs(value - 2) < 1e-6
        )
      );
      expect(farEdgeVisible).toBe(true);
      const cylinder = kernel.makeCylinder(5, 20);
      const view = parse(
        kernel.projectEdges(cylinder, 0, 0, 0, 0, 1, 0, 1, 0, 0, true, 0.1)
      );
      const sideLines = view.visible.filter((line) =>
        line.every(
          (value, index) =>
            index % 2 === 1 || Math.abs(Math.abs(value) - 5) < 0.05
        )
      );
      expect(sideLines).toEqual([]);
    } finally {
      kernel.free();
    }
  });
});

describe('D01 occlusion grid walk', () => {
  /** Whether segment p→q meets the closed unit cell at (i, j). */
  function meetsCell(
    [px, py]: [number, number],
    [qx, qy]: [number, number],
    i: number,
    j: number
  ): boolean {
    // Liang–Barsky clip against [i, i+1] × [j, j+1].
    let t0 = 0;
    let t1 = 1;
    const dx = qx - px;
    const dy = qy - py;
    for (const [p, q] of [
      [-dx, px - i],
      [dx, i + 1 - px],
      [-dy, py - j],
      [dy, j + 1 - py]
    ] as const) {
      if (p === 0) {
        if (q < 0) return false;
        continue;
      }
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
    return true;
  }

  it('visits every cell a segment touches, including clipped corners and exact diagonals', () => {
    const size = 16;
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648) * size * 0.999;
    };
    const cases: [[number, number], [number, number]][] = [
      // Clips the corner of cell (1, 1) by far less than a quarter cell.
      [
        [0.5, 1.999],
        [1.001, 2.5]
      ],
      // Passes exactly through grid corners.
      [
        [0.5, 0.5],
        [5.5, 5.5]
      ],
      [
        [0, 4],
        [4, 0]
      ],
      // Axis-aligned along a grid line.
      [
        [2, 3],
        [9, 3]
      ]
    ];
    for (let k = 0; k < 400; k += 1)
      cases.push([
        [random(), random()],
        [random(), random()]
      ]);
    for (const [p, q] of cases) {
      const walked = new Set(gridCellsAlong(p[0], p[1], q[0], q[1], size));
      for (let j = 0; j < size; j += 1)
        for (let i = 0; i < size; i += 1) {
          // Cells the segment only grazes at a single boundary point may
          // be skipped; anything it passes through with length must not.
          if (!meetsCell(p, q, i, j)) continue;
          const shrunk = meetsCellInterior(p, q, i, j);
          if (shrunk)
            expect(
              walked.has(j * size + i),
              `${JSON.stringify([p, q])} cell ${i},${j}`
            ).toBe(true);
        }
    }

    function meetsCellInterior(
      a: [number, number],
      b: [number, number],
      i: number,
      j: number
    ): boolean {
      const eps = 1e-9;
      return meetsCell(
        [a[0] - i, a[1] - j].map((v) => (v - eps) / (1 - 2 * eps)) as [
          number,
          number
        ],
        [b[0] - i, b[1] - j].map((v) => (v - eps) / (1 - 2 * eps)) as [
          number,
          number
        ],
        0,
        0
      );
    }
  });
});

describe('D01 occlusion tolerance', () => {
  /** Two 10 mm-wide flat strips meeting along x at `degrees` of fold. */
  function fold(degrees: number, faces?: 'one' | 'two') {
    const a = (degrees * Math.PI) / 180;
    const vertices = Float32Array.from([
      0,
      0,
      0,
      10,
      0,
      0,
      10,
      10,
      0,
      0,
      10,
      0,
      0,
      -10 * Math.cos(a),
      10 * Math.sin(a),
      10,
      -10 * Math.cos(a),
      10 * Math.sin(a)
    ]);
    // Strip one: 0,1,2,3 (in z = 0); strip two: 0,1 and 4,5 (folded up).
    const indices = Uint32Array.from([0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1]);
    return triangleSag({
      vertices,
      indices,
      edges: [],
      ...(faces === 'one'
        ? { faces: [{ triangleStart: 0, triangleCount: 4 }] }
        : faces === 'two'
          ? {
              faces: [
                { triangleStart: 0, triangleCount: 2 },
                { triangleStart: 2, triangleCount: 2 }
              ]
            }
          : {})
    });
  }

  it('cuts an edge exactly where the occlusion test flips', () => {
    // One curved face (two strips folded 10°) lying in z = 0 over x, y in
    // [0, 10] × [−10, 10], and a lone edge descending through it, seen from
    // above. The face's chordal sag widens its tolerance, so the edge turns
    // hidden where it is that far below the face, not where it crosses it.
    const a = (10 * Math.PI) / 180;
    const sheet = {
      vertices: Float32Array.from([
        0,
        0,
        0,
        10,
        0,
        0,
        10,
        10,
        0,
        0,
        10,
        0,
        0,
        -10 * Math.cos(a),
        10 * Math.sin(a),
        10,
        -10 * Math.cos(a),
        10 * Math.sin(a)
      ]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1]),
      faces: [{ triangleStart: 0, triangleCount: 4 }],
      edges: []
    };
    const rod = {
      vertices: new Float32Array(),
      indices: new Uint32Array(),
      edges: [[2, 5, 1, 8, 5, -1]]
    };
    const sag = Math.max(...triangleSag(sheet));
    expect(sag).toBeGreaterThan(0.1);
    const result = projectView({
      orientation: 'top',
      hiddenLines: true,
      bodies: [sheet, rod]
    });
    // The tolerance is the float32 floor — none here: the covering
    // triangles lie flat in z = 0, square to the view — plus the sag;
    // z = 1 − (x − 2) / 3 along the edge, so it turns hidden at z = −tol.
    const visibleRun = result.visible.find(
      (line) =>
        Math.abs(line[0]! - 2) < 1e-9 || Math.abs(line.at(-2)! - 2) < 1e-9
    )!;
    const end = Math.max(visibleRun[0]!, visibleRun.at(-2)!);
    const tol = 1e-12 + sag;
    expect(end).toBeCloseTo(5 + 3 * tol, 4);
    expect(
      result.hidden.some(
        (line) => Math.abs(Math.min(line[0]!, line.at(-2)!) - end) < 1e-9
      )
    ).toBe(true);
  });

  it('hides an edge a hair behind a large plate', () => {
    // A 10 000 mm square plate at z = 1 and a 1 mm edge 0.005 mm under it,
    // seen from above. A floor scaled by the plate (10^-6 of its diagonal is
    // 0.014 mm) called the edge visible; only float noise is absorbed now.
    const plate = {
      vertices: Float32Array.from([
        0, 0, 1, 10000, 0, 1, 10000, 10000, 1, 0, 10000, 1
      ]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      faces: [{ triangleStart: 0, triangleCount: 2 }],
      edges: []
    };
    const edge = {
      vertices: new Float32Array(),
      indices: new Uint32Array(),
      edges: [[5000, 5000, 0.995, 5001, 5000, 0.995]]
    };
    const result = projectView({
      orientation: 'top',
      hiddenLines: true,
      bodies: [plate, edge]
    });
    const under = (u: number, v: number) =>
      u >= 5000 && u <= 5001 && Math.abs(v - 5000) < 1e-6;
    expect(onLine(result.visible, under)).toEqual([]);
    expect(onLine(result.hidden, under)).toHaveLength(1);
  });

  it('does not widen the depth tolerance for a body far along the page', () => {
    // A face square to the front view at x = 10^6, and an edge 0.1 mm
    // behind it. The x coordinate says nothing about depth, which runs
    // along y; a floor from the largest coordinate (0.48 mm) called the
    // edge visible.
    const plate = {
      vertices: Float64Array.from([
        1e6,
        0,
        0,
        1e6 + 10,
        0,
        0,
        1e6 + 10,
        0,
        10,
        1e6,
        0,
        10
      ]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      faces: [{ triangleStart: 0, triangleCount: 2 }],
      edges: []
    };
    const edge = {
      vertices: new Float64Array(),
      indices: new Uint32Array(),
      edges: [[1e6 + 2, 0.1, 5, 1e6 + 8, 0.1, 5]]
    };
    const result = projectView({
      orientation: 'front',
      hiddenLines: true,
      bodies: [plate, edge]
    });
    const behind = (u: number, v: number) =>
      Math.abs(Math.abs(u) - 1e6 - 5) <= 3.001 && Math.abs(v - 5) < 1e-6;
    expect(onLine(result.visible, behind)).toEqual([]);
    expect(onLine(result.hidden, behind)).toHaveLength(1);
  });

  it('breaks a hidden polyline where visible coverage cuts its corner', () => {
    // A hidden L whose corner is covered by a visible one: the two
    // uncovered legs meet no vertex, so they stay two lines — not one with
    // a dashed shortcut across the covered corner, which a wide tolerance
    // (another body far across the sheet) once joined.
    const hidden = [Float64Array.from([0, 0, 10, 0, 10, 10])];
    const visible = [Float64Array.from([9, 0, 10, 0, 10, 1])];
    const out = dropCoincidentHidden(hidden, visible, 5);
    expect(out.map((line) => Array.from(line))).toEqual([
      [0, 0, 9, 0],
      [10, 1, 10, 10]
    ]);
  });

  it('does not widen the depth tolerance of a steep face far along the view', () => {
    // A face receding 100 mm per mm across the front view, 10^4 mm deep, and
    // an edge 0.1 mm behind it. Page-coordinate noise times that slope is
    // the face's depth uncertainty; the depth coordinate is not page noise,
    // and counting it there (0.48 mm) called the edge visible.
    const y = 1e4;
    const face = {
      vertices: Float64Array.from([
        0,
        y,
        0,
        1,
        y + 100,
        0,
        1,
        y + 100,
        10,
        0,
        y,
        10
      ]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      faces: [{ triangleStart: 0, triangleCount: 2 }],
      edges: []
    };
    const edge = {
      vertices: new Float64Array(),
      indices: new Uint32Array(),
      edges: [[0.5, y + 50.1, 2, 0.5, y + 50.1, 8]]
    };
    const result = projectView({
      orientation: 'front',
      hiddenLines: true,
      bodies: [face, edge]
    });
    const behind = (u: number, v: number) =>
      Math.abs(Math.abs(u) - 0.5) < 1e-9 && v >= 2 - 1e-9 && v <= 8 + 1e-9;
    expect(onLine(result.visible, behind)).toEqual([]);
    expect(onLine(result.hidden, behind)).toHaveLength(1);
  });

  it('keeps a small opening in the outline over a very long hidden edge', () => {
    // A 10^7 mm hidden line, covered by 1000 mm visible segments either side
    // of a 1 mm opening: the opening is real at the covering segments'
    // scale, though a millionth of the hidden line would swallow it.
    const out = dropCoincidentHidden(
      [Float64Array.from([0, 0, 1e7, 0])],
      [
        Float64Array.from([5e6 - 1000, 0, 5e6, 0]),
        Float64Array.from([5e6 + 1, 0, 5e6 + 1001, 0])
      ],
      100
    );
    const expected = [
      [0, 0, 5e6 - 1000, 0],
      [5e6, 0, 5e6 + 1, 0],
      [5e6 + 1001, 0, 1e7, 0]
    ];
    expect(out).toHaveLength(expected.length);
    out.forEach((line, index) =>
      Array.from(line).forEach((value, k) =>
        expect(value).toBeCloseTo(expected[index]![k]!, 6)
      )
    );
  });

  it('keeps a hidden line wherever a visible outline over it has a gap', () => {
    // A hidden line under a visible one broken by a 0.3 mm gap that falls
    // between the hidden run's ends and quarter points.
    const hidden = [Float64Array.from([0, 0, 100, 0])];
    const visible = [
      Float64Array.from([0, 0, 30.1, 0]),
      Float64Array.from([30.4, 0, 100, 0])
    ];
    const kept = dropCoincidentHidden(hidden, visible, 1e-6);
    expect(kept).toHaveLength(1);
    expect([...kept[0]!].map((value) => +value.toFixed(6))).toEqual([
      30.1, 0, 30.4, 0
    ]);
    // A hidden segment shorter than the tolerance is kept unless something
    // actually covers it: another body's line elsewhere is no cover.
    const tiny = [Float64Array.from([5, 5, 5 + 5e-7, 5])];
    expect(
      dropCoincidentHidden(tiny, [Float64Array.from([0, 0, 100, 0])], 1e-6)
    ).toHaveLength(1);
    expect(
      dropCoincidentHidden(tiny, [Float64Array.from([0, 5, 100, 5])], 1e-6)
    ).toEqual([]);
    // Parallel edges 1e-4 apart on a unit-sized body stay distinct even
    // when the view-wide tolerance (another body far across the sheet)
    // would be 10 units.
    expect(
      dropCoincidentHidden(
        [Float64Array.from([0, 0, 1, 0])],
        [Float64Array.from([0, 1e-4, 1, 1e-4])],
        10
      )
    ).toHaveLength(1);
    // A unit hidden edge 0.1 from a very long visible line stays: the
    // shorter line sets how close counts as the same.
    expect(
      dropCoincidentHidden(
        [Float64Array.from([0, 0, 1, 0])],
        [Float64Array.from([-5e6, 0.1, 5e6, 0.1])],
        10
      )
    ).toHaveLength(1);
    // A hidden line wholly under a visible one is dropped.
    expect(
      dropCoincidentHidden(hidden, [Float64Array.from([0, 0, 100, 0])], 1e-6)
    ).toEqual([]);
  });

  /** An axis-aligned box as a projection body: 12 outward triangles, 12 edges. */
  const cuboid = (o: number[], s: number) => {
    const c = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [
      o[0]! + (k & 1 ? s : 0),
      o[1]! + (k & 2 ? s : 0),
      o[2]! + (k & 4 ? s : 0)
    ]);
    const quads = [
      [0, 2, 3, 1],
      [4, 5, 7, 6],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [1, 3, 7, 5],
      [0, 4, 6, 2]
    ];
    const pairs = [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
      [0, 2],
      [1, 3],
      [4, 6],
      [5, 7],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7]
    ];
    return {
      vertices: Float64Array.from(c.flat()),
      indices: Uint32Array.from(
        quads.flatMap(([a, b, cc, d]) => [a!, b!, cc!, a!, cc!, d!])
      ),
      faces: quads.map((_, k) => ({
        triangleStart: k * 2,
        triangleCount: 2
      })),
      edges: pairs.map(([a, b]) => [...c[a!]!, ...c[b!]!])
    };
  };
  it('keeps small bodies far apart along the view occluding each other', () => {
    // A 2 mm cube at the origin, and a 1 mm cube 10^7 mm behind it.
    const near = cuboid([0, 0, 0], 2);
    const far = cuboid([0.5, 1e7, 0.5], 1);
    const result = projectView({
      orientation: 'front',
      hiddenLines: true,
      bodies: [near, far]
    });
    const insideFar = (u: number, v: number) =>
      u > 0.49 && u < 1.51 && v > 0.49 && v < 1.51;
    expect(onLine(result.visible, insideFar)).toEqual([]);
    expect(onLine(result.hidden, insideFar).length).toBeGreaterThanOrEqual(4);
  });

  it('keeps the short edges of a small body far across the view', () => {
    // A 0.005 mm cube at the origin and a 1 mm cube 10^7 mm along the page:
    // a view-wide cutoff (10^-9 of the span is 0.01 mm) would drop every
    // edge of the small one.
    const small = cuboid([0, 0, 0], 0.005);
    const big = cuboid([1e7, 0, 0], 1);
    const result = projectView({
      orientation: 'front',
      hiddenLines: true,
      bodies: [small, big]
    });
    const insideSmall = (u: number, v: number) =>
      u > -1e-4 && u < 0.0051 && v > -1e-4 && v < 0.0051;
    expect(onLine(result.visible, insideSmall)).toHaveLength(4);
  });

  it('keeps a short visible gap beside an interior sample of a curved edge', () => {
    // A 1000 mm polyline edge with an interior sample at x = 500, seen from
    // above. A flat strip hides x in [400, 500]; a sloped one over
    // [500, 600] rises above the edge only past x = 500.03. The 0.03 mm in
    // between is visible: bounded by an interior sample and a depth cut, it
    // is not a corner artifact (only the edge's own ends make those).
    const quad = (corners: number[][]) => ({
      vertices: Float64Array.from(corners.flat()),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      faces: [{ triangleStart: 0, triangleCount: 2 }],
      edges: []
    });
    const flat = quad([
      [400, -1, 1],
      [500, -1, 1],
      [500, 1, 1],
      [400, 1, 1]
    ]);
    // z = (x − 500.03) / 10: below the edge before 500.03, above after.
    const z = (x: number) => (x - 500.03) / 10;
    const sloped = quad([
      [500, -1, z(500)],
      [600, -1, z(600)],
      [600, 1, z(600)],
      [500, 1, z(500)]
    ]);
    const rod = {
      vertices: Float64Array.from([0, -0.5, -5, 1000, -0.5, -5, 1000, 0.5, -5]),
      indices: Uint32Array.from([0, 1, 2]),
      edges: [[0, 0, 0, 500, 0, 0, 1000, 0, 0]]
    };
    const result = projectView({
      orientation: 'top',
      hiddenLines: true,
      bodies: [flat, sloped, rod]
    });
    const onRod = (line: Float64Array) =>
      Math.abs(line[1]!) < 1e-9 && Math.abs(line.at(-1)!) < 1e-9;
    const gap = result.visible.filter(
      (line) =>
        onRod(line) &&
        Math.abs(Math.min(line[0]!, line.at(-2)!) - 500) < 1e-6 &&
        // 500.03 plus the depth floor's sliver of slope.
        Math.abs(Math.max(line[0]!, line.at(-2)!) - 500.03) < 5e-3
    );
    expect(gap).toHaveLength(1);
  });

  it("keeps a short prefix bounded by an unrelated face, not the edge's own", () => {
    // Seen from above, an edge starts 0.003 mm above a plate it does not
    // belong to and dips under it 0.03 mm later: a real visible prefix,
    // shorter than the corner-sliver threshold of this 1000 mm view.
    const plate = {
      vertices: Float64Array.from([
        -10, -1, 0, 100, -1, 0, 100, 1, 0, -10, 1, 0
      ]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      faces: [{ triangleStart: 0, triangleCount: 2 }],
      edges: []
    };
    const z = (x: number) => 0.003 - 0.1 * x;
    const rod = {
      vertices: Float64Array.from([
        0, -0.5, -500, 1000, -0.5, -500, 1000, 0.5, -500
      ]),
      indices: Uint32Array.from([0, 1, 2]),
      edges: [[0, 0, z(0), 1000, 0, z(1000)]]
    };
    const result = projectView({
      orientation: 'top',
      hiddenLines: true,
      bodies: [plate, rod]
    });
    const prefix = result.visible.filter(
      (line) =>
        Math.abs(line[1]!) < 1e-9 &&
        Math.min(line[0]!, line.at(-2)!) < 1e-9 &&
        Math.max(line[0]!, line.at(-2)!) < 0.05
    );
    expect(prefix).toHaveLength(1);
  });

  it('keeps a short prefix that ends near, not on, an unrelated face', () => {
    // An edge starts half a tolerance above a plate it does not belong to,
    // well inside one of the plate's triangles, and sinks under it: its
    // short visible prefix is real. Plane distance alone once called the
    // start a corner of the plate and merged the prefix away.
    const plate = {
      vertices: Float64Array.from([
        -10, -1, 100, 100, -1, 100, 100, 1, 100, -10, 1, 100
      ]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      faces: [{ triangleStart: 0, triangleCount: 2 }],
      edges: []
    };
    // The plate's float32 floor: four units in the last place of z = 100.
    const tol = 100 * 2 ** -21;
    const edge = {
      vertices: new Float64Array(),
      indices: new Uint32Array(),
      edges: [[0, 0, 100 + tol / 2, 1000, 0, 99 + tol / 2]]
    };
    const result = projectView({
      orientation: 'top',
      hiddenLines: true,
      bodies: [plate, edge]
    });
    const prefix = result.visible.filter(
      (line) =>
        Math.abs(line[1]!) < 1e-9 &&
        Math.min(line[0]!, line.at(-2)!) < 1e-9 &&
        Math.max(line[0]!, line.at(-2)!) < 0.1
    );
    expect(prefix).toHaveLength(1);
  });

  it('keeps the silhouettes of a long, thin cylinder', () => {
    // 10^6 mm long and 0.1 mm across: a ten-millionth of its diagonal is the
    // whole diameter, which welded each rim to a point and left the side
    // with no normals, so no silhouette.
    const n = 24;
    const r = 0.05;
    const length = 1e6;
    const vertices: number[] = [];
    for (const x of [0, length])
      for (let k = 0; k < n; k += 1) {
        const a = (2 * Math.PI * k) / n;
        vertices.push(x, r * Math.cos(a), r * Math.sin(a));
      }
    vertices.push(0, 0, 0, length, 0, 0);
    const indices: number[] = [];
    for (let k = 0; k < n; k += 1) {
      const j = (k + 1) % n;
      indices.push(k, j, n + j, k, n + j, n + k);
    }
    for (let k = 0; k < n; k += 1) {
      const j = (k + 1) % n;
      indices.push(2 * n, j, k);
      indices.push(2 * n + 1, n + k, n + j);
    }
    const rim = (x: number) =>
      Array.from({ length: n + 1 }, (_, k) => {
        const a = (2 * Math.PI * k) / n;
        return [x, r * Math.cos(a), r * Math.sin(a)];
      }).flat();
    const rod = {
      vertices: Float64Array.from(vertices),
      indices: Uint32Array.from(indices),
      faces: [
        { triangleStart: 0, triangleCount: 2 * n },
        { triangleStart: 2 * n, triangleCount: 2 * n }
      ],
      edges: [rim(0), rim(length)]
    };
    const result = projectView({
      orientation: 'top',
      hiddenLines: true,
      bodies: [rod]
    });
    const long = result.visible.filter((line) => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < line.length; i += 2) {
        min = Math.min(min, line[i]!);
        max = Math.max(max, line[i]!);
      }
      return Math.abs(max - min) > length / 2;
    });
    expect(long).toHaveLength(2);
  });

  it('keeps an occluded interval shorter than the sliver threshold', () => {
    // A 1000 mm edge under a 0.05 mm strip: 5e-5 of the view, below the
    // corner-sliver threshold, but bounded by the strip's own footprint.
    const strip = {
      vertices: Float32Array.from([
        500, -1, 1, 500.05, -1, 1, 500.05, 1, 1, 500, 1, 1
      ]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      faces: [{ triangleStart: 0, triangleCount: 2 }],
      edges: []
    };
    // The rod's edge, with a strip of mesh well below it so the view spans
    // the full 1000 mm (the threshold scales with it) without hiding it.
    const rod = {
      vertices: Float32Array.from([0, -0.5, -5, 1000, -0.5, -5, 1000, 0.5, -5]),
      indices: Uint32Array.from([0, 1, 2]),
      edges: [[0, 0, 0, 1000, 0, 0]]
    };
    const result = projectView({
      orientation: 'top',
      hiddenLines: true,
      bodies: [strip, rod]
    });
    const covered = result.hidden.filter(
      (line) => Math.abs(line[1]!) < 1e-9 && Math.abs(line.at(-1)!) < 1e-9
    );
    expect(covered).toHaveLength(1);
    // Float32 vertices: 500.05 is stored as 500.0499878.
    expect(Math.min(covered[0]![0]!, covered[0]!.at(-2)!)).toBeCloseTo(500, 4);
    expect(Math.max(covered[0]![0]!, covered[0]!.at(-2)!)).toBeCloseTo(
      500.05,
      4
    );
  });

  it('gives a crease between two planar faces no sag, however shallow', () => {
    // A 45° chamfer meeting its neighbour: both exact planes.
    expect([...fold(45, 'two')]).toEqual([0, 0, 0, 0]);
    expect([...fold(10, 'two')]).toEqual([0, 0, 0, 0]);
    // Without B-rep faces only a slight turn reads as one curved surface.
    expect([...fold(45)]).toEqual([0, 0, 0, 0]);
    expect(Math.max(...fold(10))).toBeGreaterThan(0);
    // Facets of one curved face carry their chordal sag.
    expect(Math.max(...fold(45, 'one'))).toBeGreaterThan(0);
  });
});

describe('D01 coincident-line index budget', () => {
  it('bounds the entries it keeps, refining only within what is left', () => {
    // 2000 long diagonals across a square, each crossing about a hundred
    // cells: a budget that cannot hold the top level refuses the view, and
    // one that holds only the top level keeps no refinements.
    const segments: number[] = [];
    for (let k = 0; k < 2000; k += 1)
      segments.push(0, k / 20, 100, 100 - k / 20);
    const members = segments.flatMap((_, index) =>
      index % 4 === 0 ? [index] : []
    );
    const box = { minU: 0, minV: 0, maxU: 100, maxV: 100 };
    const full = new SegmentGrid(segments, members, box, 1e-6);
    const top = full.retainedEntries;
    expect(() => new SegmentGrid(segments, members, box, 1e-6, 10)).toThrow(
      /projection memory budget/
    );
    const tight = new SegmentGrid(segments, members, box, 1e-6, top);
    expect(tight.retainedEntries).toBeLessThanOrEqual(top);
  });
});

describe('D01 occlusion footprint', () => {
  it('does not cover a point a visible distance outside a very tall triangle', () => {
    // A triangle 10^9 mm tall on a 2 mm base: 0.1 mm below the base is a
    // weight of only −10^-10 for the apex, inside a fixed 10^-9 weight
    // slack, so the point counted as covered.
    const tall: Triangle = {
      u0: -1,
      v0: 0,
      d0: 0,
      u1: 1,
      v1: 0,
      d1: 0,
      u2: 0,
      v2: 1e9,
      d2: 0,
      area: 2e9,
      tol: 0
    };
    const box = { minU: -1, minV: -1, maxU: 1, maxV: 1e9 };
    const grid = new OcclusionGrid([tall], box, 1e-12);
    expect(grid.occluded(0, -0.1, 1)).toBe(false);
    expect(grid.occluded(0, 0.1, 1)).toBe(true);
    // A point on its base, as on a diagonal two triangles share, still is.
    expect(grid.occluded(0.5, 0, 1)).toBe(true);
    const index = new OcclusionIndex([[tall]], 1e-12);
    expect(index.occluded(0, -0.1, 1)).toBe(false);
    // Through the projection: an edge 0.1 mm below that face, behind it,
    // is in the clear.
    const result = projectView({
      orientation: 'front',
      hiddenLines: true,
      bodies: [
        {
          vertices: Float64Array.from([-1, 0, 0, 1, 0, 0, 0, 0, 1e9]),
          indices: Uint32Array.from([0, 1, 2]),
          faces: [{ triangleStart: 0, triangleCount: 1 }],
          edges: []
        },
        {
          vertices: new Float64Array(),
          indices: new Uint32Array(),
          edges: [[-0.5, 5, -0.1, 0.5, 5, -0.1]]
        }
      ]
    });
    const below = (u: number, v: number) =>
      Math.abs(Math.abs(u) - 0.5) < 1e-9 && Math.abs(v + 0.1) < 1e-9;
    expect(onLine(result.visible, below)).toHaveLength(1);
    expect(onLine(result.hidden, below)).toEqual([]);
  });
});

describe('D01 coincident-line index', () => {
  it('keeps cells small for dense outlines far apart, and still finds coincidences', () => {
    // Two 100 × 100 mesh outlines of 20 000 unit segments each, 10^6 mm
    // apart on both page axes. Cells sized by the whole extent put each
    // outline in one cell, so every hidden segment met every visible one.
    const lines: Float64Array[] = [];
    for (const offset of [0, 1e6])
      for (let k = 0; k < 100; k += 1)
        for (let m = 0; m < 100; m += 1) {
          lines.push(
            Float64Array.from([
              offset + m,
              offset + k,
              offset + m + 1,
              offset + k
            ])
          );
          lines.push(
            Float64Array.from([
              offset + k,
              offset + m,
              offset + k,
              offset + m + 1
            ])
          );
        }
    const segments = lines.flatMap((line) => Array.from(line));
    const members = segments.flatMap((_, index) =>
      index % 4 === 0 ? [index] : []
    );
    const grid = new SegmentGrid(
      segments,
      members,
      { minU: 0, minV: 0, maxU: 1e6 + 100, maxV: 1e6 + 100 },
      1e-3
    );
    expect(grid.maxCellLoad).toBeLessThan(50);
    // A hidden line along a row of the far outline vanishes under it; one
    // just off it, between rows, stays.
    const onRow = Float64Array.from([1e6 + 10, 1e6 + 40, 1e6 + 20, 1e6 + 40]);
    const between = Float64Array.from([
      1e6 + 10.25,
      1e6 + 40.5,
      1e6 + 10.75,
      1e6 + 40.5
    ]);
    expect(dropCoincidentHidden([onRow], lines, 1e-3)).toEqual([]);
    expect(dropCoincidentHidden([between], lines, 1e-3)).toHaveLength(1);
    // A view-wide tolerance wider than either outline (10^-6 of a 1.4·10^7
    // view is 14 mm) must not set the cells: unit segments only ever reach
    // a millionth of their own length.
    const wide = new SegmentGrid(
      segments,
      members,
      { minU: 0, minV: 0, maxU: 1e6 + 100, maxV: 1e6 + 100 },
      14
    );
    expect(wide.maxCellLoad).toBeLessThan(50);
    expect(dropCoincidentHidden([onRow], lines, 14)).toEqual([]);
    expect(dropCoincidentHidden([between], lines, 14)).toHaveLength(1);
  });
});

describe('D01 occlusion grid', () => {
  it('counts parent and refined cells in the shared view entry budget', () => {
    // Two small tessellated patches in one group exercise refinement of a
    // concatenated mesh; a second group exercises the view-wide allowance.
    const triangles: Triangle[] = [];
    for (const offset of [0, 1000])
      for (let u = 0; u < 10; u += 1)
        for (let v = 0; v < 10; v += 1)
          for (const [a, b, c] of [
            [
              [u, v],
              [u + 1, v],
              [u + 1, v + 1]
            ],
            [
              [u, v],
              [u + 1, v + 1],
              [u, v + 1]
            ]
          ] as const)
            triangles.push({
              u0: offset + a[0],
              v0: offset + a[1],
              d0: 0,
              u1: offset + b[0],
              v1: offset + b[1],
              d1: 0,
              u2: offset + c[0],
              v2: offset + c[1],
              d2: 0,
              area: 1,
              tol: 0
            });
    const bounds = { minU: 0, minV: 0, maxU: 1010, maxV: 1010 };
    const ordinary = new OcclusionGrid(triangles, bounds, 1e-9);
    expect(ordinary.maxCellLoad).toBeLessThan(50);
    expect(
      () => new OcclusionGrid(triangles, bounds, 1e-9, triangles.length)
    ).toThrow(/drawing view.*memory budget/i);
    const exact = new OcclusionGrid(
      triangles,
      bounds,
      1e-9,
      ordinary.entryCount
    );
    expect(exact.entryCount).toBe(ordinary.entryCount);
    expect(exact.occluded(5.5, 5.2, 1)).toBe(true);
    expect(exact.occluded(1005.5, 1005.2, 1)).toBe(true);
    expect(
      () => new OcclusionGrid(triangles, bounds, 1e-9, ordinary.entryCount - 1)
    ).toThrow(/drawing view.*memory budget/i);
    expect(
      () =>
        new OcclusionIndex(
          [triangles, triangles],
          1e-9,
          ordinary.entryCount * 2
        )
    ).not.toThrow();
    expect(
      () =>
        new OcclusionIndex(
          [triangles, triangles],
          1e-9,
          ordinary.entryCount * 2 - 1
        )
    ).toThrow(/drawing view.*memory budget/i);
  });

  it('shares the view entry budget across its body grids', () => {
    const near: Triangle = {
      u0: 0,
      v0: 0,
      d0: 0,
      u1: 1,
      v1: 0,
      d1: 0,
      u2: 0,
      v2: 1,
      d2: 0,
      area: 1,
      tol: 0
    };
    const far = { ...near, u0: 2, u1: 3, u2: 2 };
    const bounds = { minU: 0, minV: 0, maxU: 1, maxV: 1 };
    const perBody = new OcclusionGrid([near], bounds, 1e-9).entryCount;
    const index = new OcclusionIndex([[near], [far]], 1e-9, perBody * 2);
    expect(index.occluded(0.25, 0.25, 1)).toBe(true);
    expect(index.occluded(2.25, 0.25, 1)).toBe(true);
    expect(
      () => new OcclusionIndex([[near], [far]], 1e-9, perBody * 2 - 1)
    ).toThrow(/drawing view.*memory budget/i);
  });

  it('refuses a grid before its entry budget is exceeded', () => {
    const triangles = [
      {
        u0: 0,
        v0: 0,
        d0: 0,
        u1: 1,
        v1: 0,
        d1: 0,
        u2: 0,
        v2: 1,
        d2: 0,
        area: 1,
        tol: 0
      }
    ];
    const bounds = { minU: 0, minV: 0, maxU: 1, maxV: 1 };
    const ordinary = new OcclusionGrid(triangles, bounds, 1e-9);
    const exact = new OcclusionGrid(
      triangles,
      bounds,
      1e-9,
      ordinary.entryCount
    );
    expect(exact.entryCount).toBe(ordinary.entryCount);
    expect(exact.occluded(0.25, 0.25, 1)).toBe(true);
    expect(
      () => new OcclusionGrid(triangles, bounds, 1e-9, ordinary.entryCount - 1)
    ).toThrow(/drawing view.*memory budget/i);
  });

  it('files a thin triangle under the cells it covers, not its whole bounding box', () => {
    // A fan of 2000 slivers around a shared centre: every sliver's bounding
    // box spans a quadrant of the grid, its footprint only a thin wedge.
    const count = 2000;
    const triangles = Array.from({ length: count }, (_, k) => {
      const a0 = (2 * Math.PI * k) / count;
      const a1 = (2 * Math.PI * (k + 1)) / count;
      const u1 = 100 * Math.cos(a0);
      const v1 = 100 * Math.sin(a0);
      const u2 = 100 * Math.cos(a1);
      const v2 = 100 * Math.sin(a1);
      return {
        u0: 0,
        v0: 0,
        d0: 0,
        u1,
        v1,
        d1: 0,
        u2,
        v2,
        d2: 0,
        area: u1 * v2 - u2 * v1,
        tol: 0
      };
    });
    const grid = new OcclusionGrid(
      triangles,
      { minU: -100, minV: -100, maxU: 100, maxV: 100 },
      1e-9
    );
    // 32 × 32 cells: a wedge crosses about one cell per row it spans, so
    // the total stays near count × (rows / 2), far below the bounding-box
    // filing (about a quarter of the grid per sliver).
    expect(grid.entryCount).toBeLessThan(count * 40);
    // And it still answers: the centre is covered, a point outside is not.
    expect(grid.occluded(10, 10, 1)).toBe(true);
    expect(grid.occluded(90, 90, 1)).toBe(false);
  });

  it('keeps cells small for dense bodies far apart on the page', () => {
    // Two 100 × 100 meshes of 20 000 triangles each, 10^6 mm apart on both
    // page axes: two bodies, or two solids of one patterned body (the exact
    // adapter concatenates a pattern's solids into one body). Cells sized by
    // the view put each in a single cell, so every segment tested every
    // triangle; a dense cell now gets a finer grid over what it holds.
    const patch = (offset: number) => {
      const triangles: Triangle[] = [];
      for (let i = 0; i < 100; i += 1)
        for (let j = 0; j < 100; j += 1) {
          const u = offset + i;
          const v = offset + j;
          for (const [a, b, c] of [
            [
              [u, v],
              [u + 1, v],
              [u + 1, v + 1]
            ],
            [
              [u, v],
              [u + 1, v + 1],
              [u, v + 1]
            ]
          ] as const)
            triangles.push({
              u0: a[0],
              v0: a[1],
              d0: 0,
              u1: b[0],
              v1: b[1],
              d1: 0,
              u2: c[0],
              v2: c[1],
              d2: 0,
              area:
                (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]),
              tol: 0
            });
        }
      return triangles;
    };
    const near = patch(0);
    const far = patch(1e6);
    const single = new OcclusionGrid(
      [...near, ...far],
      { minU: 0, minV: 0, maxU: 1e6 + 100, maxV: 1e6 + 100 },
      1e-9
    );
    expect(single.maxCellLoad).toBeLessThan(50);
    const index = new OcclusionIndex([near, far], 1e-9);
    expect(index.maxCellLoad).toBeLessThan(50);
    const patterned = new OcclusionIndex([[...near, ...far]], 1e-9);
    expect(patterned.maxCellLoad).toBeLessThan(50);
    const span = 1e6 + 120;
    for (const query of [single, index, patterned]) {
      // Each still answers across both solids, and finds their outlines.
      expect(query.occluded(50.5, 50.2, 1)).toBe(true);
      expect(query.occluded(1e6 + 50.5, 1e6 + 50.2, 1)).toBe(true);
      expect(query.occluded(5e5, 5e5, 1)).toBe(false);
      // A diagonal from before the first solid to past the second: its
      // footprint crossings start at the first's corner and end at the
      // second's far corner.
      const cuts = query.crossings(-10, -10, 1, 1e6 + 110, 1e6 + 110, 1);
      const footprint = cuts.filter((cut) => !cut.depth).map((cut) => cut.t);
      expect(footprint.at(0)! * span - 10).toBeCloseTo(0, 4);
      expect(footprint.at(-1)! * span - 10).toBeCloseTo(1e6 + 100, 4);
    }
  });
});
