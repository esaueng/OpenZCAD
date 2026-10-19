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
  projectView,
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
    expect(runs(covered)).toEqual([
      run('front', [100, 10, 10], [100.2, 10, 10])
    ]);
    expect(
      onLine(
        result.visible,
        (u, v) => Math.abs(v - 10) < 1e-6 && u > 100.01 && u < 100.19
      )
    ).toEqual([]);
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
