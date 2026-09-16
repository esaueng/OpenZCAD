/** Opt-in private-fixture export validation. No project payload in Git.
 *
 * Replays the complete feature history of a saved `.openzcad` project that
 * mixes STEP imports, rigid transforms, and booleans, then validates the
 * production STEP, STL and 3MF exports headlessly:
 * - STEP: reimports through the production translators to valid solids with
 *   finite positive volumes and non-degenerate bounding boxes.
 * - STL: parses the ASCII facets, asserts watertight topology (no open
 *   edges), finite coordinates, and facet-volume agreement with the kernel
 *   volumes.
 *
 * The copy under test must be a disposable duplicate: the test only reads
 * it, and it refuses the known original path. Provide it via
 * `OPENZCAD_EXPORT_PROJECT_COPY`. Without it the test skips — this keeps
 * private project data out of CI while letting anyone with the file verify.
 *
 * Regression: a 90° Move once stranded a circle edge 8.13e-16 above its own
 * tolerance (STEP-measured stamp vs re-rounded rotated frame), failing both
 * exports at the strict arena gate. Fixed in Remus by carrying endpoint
 * certificates through rigid transforms; this test pins the end-to-end
 * behavior at the pinned Remus revision.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import type { ProjectDocument } from '@openzcad/shared';
import { measureThreeMfExport } from './support/three-mf-export';

const copyPath = process.env.OPENZCAD_EXPORT_PROJECT_COPY;
const hasFixture =
  !!copyPath &&
  copyPath !== '/Users/dev/Downloads/Tiny-Fox(1).openzcad';

type FixturePoint = [number, number, number];
interface CylinderArena {
  vertices: { point: FixturePoint }[];
  edges: {
    start: number;
    trim: [number, number];
    tolerance: number | null;
    curve: {
      Circle: {
        center: FixturePoint;
        u_axis: FixturePoint;
        v_axis: FixturePoint;
        radius: number;
      };
    };
  }[];
}

// A public, synthetic cylinder isolates the same numerical boundary without
// including a user's model. A STEP reader can stamp an edge's tolerance at
// its measured endpoint residual; rotating it must preserve that certificate.
function cylinderAtEndpointTolerance(kernel: RemusKernel): number {
  const original = kernel.makeCylinder(3, 10);
  const arena = JSON.parse(
    new TextDecoder().decode(
      kernel.serializeSolids(new Uint32Array([original]))
    )
  ) as CylinderArena;
  const edge = arena.edges[0]!;
  const circle = edge.curve.Circle;
  const point = arena.vertices[edge.start]!.point;
  point[1] = 0.00004;
  const residual = Math.max(
    ...edge.trim.map((t: number) =>
      Math.hypot(
        ...point.map(
          (value, i) =>
            circle.center[i]! +
            circle.radius *
              (circle.u_axis[i]! * Math.cos(t) +
                circle.v_axis[i]! * Math.sin(t)) -
            value
        )
      )
    )
  );
  // One representable step covers evaluation rounding when loading the
  // fixture; the old rotation drifts farther and still fails the strict gate.
  const stamp = new Float64Array([residual]);
  new BigUint64Array(stamp.buffer)[0]! += 1n;
  edge.tolerance = stamp[0]!;
  return kernel.deserializeSolids(
    new TextEncoder().encode(JSON.stringify(arena))
  )[0]!;
}

describe('rigid transform mesh exports', () => {
  it('exports STL and 3MF at a measured endpoint tolerance after rotation', async () => {
    const kernel = new RemusKernel();
    try {
      const io = await loadRemusTranslators();
      const source = cylinderAtEndpointTolerance(kernel);
      const angle = Math.PI / 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const moved = kernel.copyAndTransformSolid(
        source,
        new Float64Array([1, 0, 0, 0, 0, c, -s, 66.5, 0, s, c, 0.5, 0, 0, 0, 1])
      );
      const arena = kernel.serializeSolids(new Uint32Array([moved]));
      expect(kernel.deserializeSolids(arena)).toHaveLength(1);
      const stl = io.exportStl(arena, 0.1);
      expect(stl.length).toBeGreaterThan(84);
      const triangles = new DataView(
        stl.buffer,
        stl.byteOffset,
        stl.byteLength
      ).getUint32(80, true);
      expect(triangles).toBeGreaterThan(0);
      expect(stl.length).toBe(84 + triangles * 50);
      const threeMf = io.export3mf(arena, 0.01);
      expect(kernel.deserializeSolids(io.import3mf(threeMf))).toHaveLength(1);
      const meshes = measureThreeMfExport(threeMf);
      expect(meshes).toHaveLength(1);
      expect(meshes[0]!.invalidEdges).toBe(0);
      expect(
        Math.abs(meshes[0]!.volume - Math.PI * 3 ** 2 * 10) /
          (Math.PI * 3 ** 2 * 10)
      ).toBeLessThan(0.02);

      // Real geometric gaps must still be refused by both file writers.
      const invalid = JSON.parse(
        new TextDecoder().decode(arena)
      ) as CylinderArena;
      invalid.vertices[0]!.point[0] += 0.01;
      const invalidBytes = new TextEncoder().encode(JSON.stringify(invalid));
      expect(() => io.exportStl(invalidBytes, 0.1)).toThrow(
        'exceeds effective tolerance'
      );
      expect(() => io.export3mf(invalidBytes, 0.1)).toThrow(
        'exceeds effective tolerance'
      );
    } finally {
      kernel.free();
    }
  }, 120_000);
});

function parseAsciiStlFacets(stl: string): {
  triangles: number;
  openEdges: number;
  volume: number;
  nonFinite: number;
} {
  const vertices: [number, number, number][] = [];
  const pattern = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let match: RegExpExecArray | null;
  let nonFinite = 0;
  while ((match = pattern.exec(stl)) !== null) {
    const v: [number, number, number] = [
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    ];
    if (!v.every(Number.isFinite)) nonFinite++;
    vertices.push(v);
  }
  const ids = new Map<string, number>();
  const canon = vertices.map((v) => {
    const key = v.map((c) => Math.round(c * 1e6)).join(',');
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key)!;
  });
  const use = new Map<string, number>();
  let volume = 0;
  for (let i = 0; i + 2 < canon.length; i += 3) {
    const tri = [canon[i]!, canon[i + 1]!, canon[i + 2]!];
    for (let k = 0; k < 3; k++) {
      const a = tri[k]!;
      const b = tri[(k + 1) % 3]!;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
    const [p, q, r] = [vertices[i]!, vertices[i + 1]!, vertices[i + 2]!];
    volume +=
      (p[0] * (q[1] * r[2] - q[2] * r[1]) -
        p[1] * (q[0] * r[2] - q[2] * r[0]) +
        p[2] * (q[0] * r[1] - q[1] * r[0])) /
      6;
  }
  return {
    triangles: Math.floor(vertices.length / 3),
    openEdges: [...use.values()].filter((n) => n === 1).length,
    volume: Math.abs(volume),
    nonFinite
  };
}

describe.skipIf(!hasFixture)('saved-project export validation', () => {
  it('exports valid STEP, STL and 3MF from the complete saved history', async () => {
    const raw = readFileSync(copyPath!, 'utf8');
    const backup = JSON.parse(raw) as {
      document: ProjectDocument;
      sources?: { sha256: string; base64: string }[];
    };
    const sources = new Map<string, Uint8Array>();
    for (const s of backup.sources ?? [])
      sources.set(s.sha256, Buffer.from(s.base64, 'base64'));
    const adapter = await createExactKernelAdapter({
      resolveSourceBytes: async (ref) => {
        const bytes = sources.get(ref.checksumSha256);
        if (!bytes) throw new Error(`missing source ${ref.checksumSha256}`);
        return bytes;
      }
    });
    try {
      const document = backup.document;
      const derived = await adapter.syncDocument(document);
      const liveBodies = [...document.bodyOrder].filter(
        (id) => derived.bodyRepresentations[id]
      );
      expect(liveBodies.length).toBeGreaterThan(0);

      const step = await adapter.exportStep(document, liveBodies);
      expect(step).toMatch(/ISO-10303-21/);
      expect(
        (step.match(/MANIFOLD_SOLID_BREP/g) ?? []).length
      ).toBeGreaterThanOrEqual(1);

      // STEP reimport through the production translators.
      const io = await loadRemusTranslators();
      const kernel = new RemusKernel();
      let kernelTotal = 0;
      try {
        const reimported = kernel.deserializeSolids(
          io.importStep(new TextEncoder().encode(step))
        );
        expect(reimported.length).toBeGreaterThanOrEqual(1);
        for (const solid of reimported) {
          expect(kernel.validateSolid(solid)).toBe(0);
          const volume = kernel.volume(solid, 0.01);
          expect(Number.isFinite(volume)).toBe(true);
          expect(volume).toBeGreaterThan(0);
          const bbox = Array.from(kernel.boundingBox(solid));
          expect(bbox.every(Number.isFinite)).toBe(true);
          expect(bbox[3]! - bbox[0]!).toBeGreaterThan(0);
          expect(bbox[4]! - bbox[1]!).toBeGreaterThan(0);
          expect(bbox[5]! - bbox[2]!).toBeGreaterThan(0);
          kernelTotal += volume;
        }
      } finally {
        kernel.free();
      }
      expect(kernelTotal).toBeGreaterThan(0);

      const stl = await adapter.exportStl(document, liveBodies);
      expect(stl.startsWith('solid')).toBe(true);
      const facets = parseAsciiStlFacets(stl);
      expect(facets.nonFinite).toBe(0);
      expect(facets.triangles).toBeGreaterThan(0);
      expect(facets.openEdges).toBe(0);
      expect(Math.abs(facets.volume - kernelTotal) / kernelTotal).toBeLessThan(
        0.02
      );

      const binaryStl = await adapter.exportMesh(document, liveBodies, {
        format: 'stl-binary',
        deflection: 0.1
      });
      const triangles = new DataView(
        binaryStl.buffer,
        binaryStl.byteOffset,
        binaryStl.byteLength
      ).getUint32(80, true);
      expect(triangles).toBeGreaterThan(0);
      expect(binaryStl.length).toBe(84 + triangles * 50);
      const threeMf = await adapter.exportMesh(document, liveBodies, {
        format: '3mf',
        deflection: 0.1
      });
      // Inspect the exported indexed mesh directly: importing it first can
      // weld close vertices and change the topology we are trying to test.
      const meshes = measureThreeMfExport(threeMf);
      expect(meshes.length).toBe(
        (step.match(/MANIFOLD_SOLID_BREP/g) ?? []).length
      );
      for (const mesh of meshes) {
        expect(mesh.triangles).toBeGreaterThan(0);
        expect(mesh.invalidEdges).toBe(0);
        expect(mesh.volume).toBeGreaterThan(0);
      }
      const meshVolume = meshes.reduce((total, mesh) => total + mesh.volume, 0);
      expect(Math.abs(meshVolume - kernelTotal) / kernelTotal).toBeLessThan(
        0.02
      );

      const out = process.env.OPENZCAD_EXPORT_PROJECT_OUT;
      if (out) {
        writeFileSync(`${out}.step`, step);
        writeFileSync(`${out}.stl`, stl);
        writeFileSync(`${out}.3mf`, threeMf);
      }
    } finally {
      adapter.dispose();
    }
  }, 600_000);
});
