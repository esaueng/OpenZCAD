import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

/**
 * What a mesh export's tolerances buy, measured rather than trusted
 * (ZC-200). An R10 cylinder is the closed-form case: every point the export
 * writes on the side wall must lie within the chord tolerance of radius 10,
 * a tighter tolerance must add triangles, and the measured deviation the
 * dialog reports must stay inside the tolerance it was asked for.
 */

const RADIUS = 10;

/** Binary STL facets: count, and the largest gap below radius 10. */
function readBinaryStl(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const facets = view.getUint32(80, true);
  expect(bytes.byteLength).toBe(84 + facets * 50);
  let maxGap = 0;
  for (let facet = 0; facet < facets; facet += 1) {
    const base = 84 + facet * 50 + 12;
    const corners = [0, 1, 2].map((k) => [
      view.getFloat32(base + k * 12, true),
      view.getFloat32(base + k * 12 + 4, true),
      view.getFloat32(base + k * 12 + 8, true)
    ]);
    // Side-wall facets only (the caps are planar and exact). A wall facet
    // spans the height: its corners sit on both rims, never all on one.
    const zs = corners.map(([, , z]) => z!);
    if (Math.max(...zs) - Math.min(...zs) > 1e-4) {
      for (const [a, b] of [
        [0, 1],
        [1, 2],
        [2, 0]
      ] as const) {
        const mx = (corners[a]![0]! + corners[b]![0]!) / 2;
        const my = (corners[a]![1]! + corners[b]![1]!) / 2;
        maxGap = Math.max(maxGap, RADIUS - Math.hypot(mx, my));
      }
    }
  }
  return { facets, maxGap };
}

describe('mesh export tolerance on an R10 cylinder', () => {
  let adapter: ExactKernelAdapter;
  let document: ProjectDocument;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    const base = addPrimitiveFeature(
      createProjectDocument('Cylinder', toUserId('user_tolerance')),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: RADIUS, height: 20 }
      }
    );
    document = { ...base, derived: await adapter.syncDocument(base) };
  });

  const bodyIds = () => [...document.derived.exportableBodyIds];

  it('measures a deviation within each chord tolerance, and more triangles at the finer one', async () => {
    const coarse = await adapter.meshQuality(document, bodyIds(), 0.1);
    const fine = await adapter.meshQuality(document, bodyIds(), 0.01);
    expect(coarse.watertight).toBe(true);
    expect(fine.watertight).toBe(true);
    expect(coarse.maxDeviation).toBeGreaterThan(0);
    expect(coarse.maxDeviation).toBeLessThanOrEqual(0.1);
    expect(fine.maxDeviation).toBeLessThanOrEqual(0.01);
    expect(fine.maxDeviation).toBeLessThan(coarse.maxDeviation);
    expect(fine.triangleCount).toBeGreaterThan(coarse.triangleCount);
    expect(coarse.sampled).toBe(false);
  });

  it('writes the file the check measured: same triangle count, side wall within tolerance', async () => {
    for (const deflection of [0.1, 0.01]) {
      const report = await adapter.meshQuality(document, bodyIds(), deflection);
      const stl = readBinaryStl(
        await adapter.exportMesh(document, bodyIds(), {
          format: 'stl-binary',
          deflection
        })
      );
      expect(stl.facets).toBe(report.triangleCount);
      // Float32 positions: allow their rounding on a 10 mm radius. Above
      // zero proves the wall was found around the axis being measured.
      expect(stl.maxGap).toBeGreaterThan(deflection / 10);
      expect(stl.maxGap).toBeLessThanOrEqual(deflection + 1e-5);
    }
  });

  it('adds facets for a tighter angle where the chord tolerance alone would not', async () => {
    const angle = (5 * Math.PI) / 180;
    const chordOnly = await adapter.meshQuality(document, bodyIds(), 0.1);
    const angled = await adapter.meshQuality(document, bodyIds(), 0.1, angle);
    expect(angled.triangleCount).toBeGreaterThan(chordOnly.triangleCount);
    expect(angled.maxDeviation).toBeLessThan(chordOnly.maxDeviation);
    // 5° per facet around a full turn is at least 72 wall segments.
    const stl = readBinaryStl(
      await adapter.exportMesh(document, bodyIds(), {
        format: 'stl-binary',
        deflection: 0.1,
        angularTolerance: angle
      })
    );
    expect(stl.facets).toBe(angled.triangleCount);
    expect(stl.facets).toBeGreaterThanOrEqual(72 * 2);
    // Each wall chord spans at most 5°: sagitta R(1 − cos 2.5°).
    expect(stl.maxGap).toBeGreaterThan(0);
    expect(stl.maxGap).toBeLessThanOrEqual(
      RADIUS * (1 - Math.cos(angle / 2)) + 1e-5
    );
  });

  it('keeps the default angle on the writers’ own path, byte for byte', async () => {
    const plain = await adapter.exportMesh(document, bodyIds(), {
      format: '3mf',
      deflection: 0.08
    });
    const explicitDefault = await adapter.exportMesh(document, bodyIds(), {
      format: '3mf',
      deflection: 0.08,
      angularTolerance: 0.35
    });
    expect(explicitDefault).toEqual(plain);
  });

  it('measures planar facets too: float32 corners of a tilted, distant plane miss it', async () => {
    let far = addPrimitiveFeature(
      createProjectDocument('Far plate', toUserId('user_tolerance')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 10, depth: 5 }
      }
    );
    far = transformBody(far, {
      name: 'Tilt and send far away',
      targetBodyId: far.bodyOrder.at(-1)!,
      rotationDeg: { x: 31, y: 17, z: 23 },
      translation: { x: 250_000, y: -180_000, z: 90_000 }
    }).document;
    far = { ...far, derived: await adapter.syncDocument(far) };
    const report = await adapter.meshQuality(
      far,
      [...far.derived.exportableBodyIds],
      0.08
    );
    // All planes, so no chord error: what remains is float32 rounding at a
    // quarter of a kilometre (an ulp there is 1/64 mm), and it is reported.
    expect(report.maxDeviation).toBeGreaterThan(0);
    expect(report.maxDeviation).toBeLessThan(0.05);
    expect(report.bodies[0]!.sampledTriangles).toBe(12);
  });

  it('refuses an angle that is not a usable tolerance', async () => {
    await expect(
      adapter.exportMesh(document, bodyIds(), {
        format: 'obj',
        deflection: 0.08,
        angularTolerance: 0
      })
    ).rejects.toThrow(/positive/);
    await expect(
      adapter.meshQuality(document, bodyIds(), 0.08, Math.PI)
    ).rejects.toThrow(/90°/);
  });
});
