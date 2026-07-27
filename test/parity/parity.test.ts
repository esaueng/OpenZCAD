/**
 * Kernel parity harness: the acceptance benchmark for the BrepKit kernel.
 *
 * Replays real modeling scenarios (the workspace demos plus stress cases)
 * headless through the exact kernel adapter and holds each body to the
 * acceptance bar:
 *
 *  1. zero sync warnings — the adapter swallows per-feature kernel failures
 *     into `derived.warnings`, so an empty list is the "every feature
 *     actually built" gate;
 *  2. watertight, manifold meshes — position-welded edge-use census on every
 *     body mesh and on the exported STL (an edge used once is a hole, three+
 *     times is branching). A scenario may pin a known-defective count via
 *     `expectedMeshDefects`; that count is then asserted exactly, so the pin
 *     fails on a repair as well as on a regression;
 *  3. baseline-pinned volume and exact face count — the face count is the
 *     mesh-fallback tell: a kernel regression to a tessellated boolean
 *     multiplies it into the hundreds even while volume and validity still
 *     pass;
 *  4. deterministic replay — rebuilding from the serialized command log
 *     reproduces the same volumes.
 *
 * Regenerate baselines after an intentional geometry change with:
 *   OPENZCAD_WRITE_PARITY_BASELINES=1 pnpm vitest run test/parity
 *
 * Run against a local kernel build (without touching the lockfile) with:
 *   BREPKIT_WASM_PKG=/abs/path/to/brepkit/crates/wasm/pkg pnpm vitest run test/parity
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { replayCommands } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type DerivedState, type ProjectDocument } from '@openzcad/shared';

import { meshEdgeUse, parseAsciiStl } from './mesh-probe';
import { PARITY_SCENARIOS, type MeshDefectPin } from './scenarios';

/** What every mesh must be unless the scenario pins a known defect. */
const WATERTIGHT: MeshDefectPin = { boundaryEdges: 0, nonManifoldEdges: 0 };

/**
 * A pinned count is asserted in both directions, so its failure message has
 * to serve two readers: someone who broke a mesh further, and someone who
 * fixed one and now has to retire the pin.
 */
function meshDefectLabel(
  scenarioKey: string,
  label: string,
  pinned: boolean
): string {
  return pinned
    ? `${label} — pinned known defect for '${scenarioKey}'. Reading 0 means ` +
        `the kernel defect is FIXED: drop the entry from ` +
        `EXPECTED_MESH_DEFECTS in test/parity/scenarios.ts. Any other value ` +
        `is a regression.`
    : label;
}

interface BodyBaseline {
  name: string;
  volume: number;
  /**
   * Exact B-rep face count — the mesh-fallback tell. Analytic results sit in
   * the tens of faces; a kernel regression to a tessellated boolean multiplies
   * this into the hundreds, even while volume and validity still pass.
   * (The stronger surface-type-mix probe needs FaceGeometry.surfaceType,
   * which the BrepKit adapter does not populate yet.)
   */
  faceCount: number;
}

type Baselines = Record<string, BodyBaseline[]>;

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'baselines.json'
);
const WRITE_BASELINES = process.env.OPENZCAD_WRITE_PARITY_BASELINES === '1';
/** Relative volume tolerance vs baseline. Loose enough for legitimate
 * tessellation-density changes, far tighter than any real regression. */
const VOLUME_RTOL = 5e-4;

function loadBaselines(): Baselines {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baselines;
  } catch {
    return {};
  }
}

function exportableBodies(derived: DerivedState) {
  return derived.exportableBodyIds.map((bodyId) => {
    const representation = derived.bodyRepresentations[bodyId];
    if (!representation) {
      throw new Error(`exportable body ${bodyId} has no representation`);
    }
    return { bodyId, representation };
  });
}

describe('kernel parity harness', () => {
  let adapter: ExactKernelAdapter;
  const measured: Baselines = {};
  const timings: Record<string, number> = {};
  const documents = new Map<string, { document: ProjectDocument; derived: DerivedState }>();

  const buildFailures = new Map<string, unknown>();

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    for (const scenario of PARITY_SCENARIOS) {
      const start = performance.now();
      let document: ProjectDocument;
      try {
        document = await scenario.build((doc) => adapter.syncDocument(doc));
      } catch (error) {
        buildFailures.set(scenario.key, error);
        continue;
      }
      const derived = await adapter.syncDocument(document);
      timings[scenario.key] = performance.now() - start;
      documents.set(scenario.key, { document, derived });
      measured[scenario.key] = exportableBodies(derived).map(
        ({ representation }) => ({
          name: representation.name,
          volume: representation.volume,
          faceCount: representation.faceCount
        })
      );
    }
  }, 240_000);

  afterAll(() => {
    if (WRITE_BASELINES) {
      mkdirSync(dirname(BASELINE_PATH), { recursive: true });
      writeFileSync(BASELINE_PATH, `${JSON.stringify(measured, null, 2)}\n`);
    }
    // Vitest's forks pool swallows console output; persist timings to a file.
    writeFileSync(
      join(dirname(BASELINE_PATH), 'last-run-timings.json'),
      `${JSON.stringify(timings, null, 2)}\n`
    );
  });

  for (const scenario of PARITY_SCENARIOS) {
    if (scenario.expectedBuildFailure) {
      describe(scenario.key, () => {
        it('still hits the pinned known kernel defect', () => {
          const failure = buildFailures.get(scenario.key);
          expect(
            failure,
            `'${scenario.key}' built successfully — the pinned kernel defect ` +
              `appears FIXED. Remove its expectedBuildFailure entry and ` +
              `record a baseline with OPENZCAD_WRITE_PARITY_BASELINES=1.`
          ).toBeDefined();
          expect(String(failure)).toMatch(scenario.expectedBuildFailure!);
        });
      });
      continue;
    }
    describe(scenario.key, () => {
      it('builds without errors', () => {
        const failure = buildFailures.get(scenario.key);
        expect(failure, String(failure)).toBeUndefined();
      });

      it('rebuilds every feature without unexpected warnings', () => {
        const { derived } = documents.get(scenario.key)!;
        const expected = scenario.expectedWarnings ?? [];
        expect(
          derived.warnings.length,
          expected.length > 0
            ? `pinned warnings changed — if the kernel defect is fixed, ` +
              `remove '${scenario.key}' from EXPECTED_WARNINGS and rerecord ` +
              `baselines. warnings: ${JSON.stringify(derived.warnings)}`
            : `warnings: ${JSON.stringify(derived.warnings)}`
        ).toBe(expected.length);
        for (const [index, pattern] of expected.entries()) {
          expect(derived.warnings[index]).toMatch(pattern);
        }
        expect(derived.exportableBodyIds.length).toBeGreaterThan(0);
      });

      it('produces watertight, manifold body meshes', () => {
        const { derived } = documents.get(scenario.key)!;
        for (const { representation } of exportableBodies(derived)) {
          const report = meshEdgeUse(
            representation.mesh.vertices,
            representation.mesh.indices
          );
          const pin =
            scenario.expectedMeshDefects?.bodies?.[representation.name];
          const expected = pin ?? WATERTIGHT;
          expect.soft(report.triangles).toBeGreaterThan(0);
          expect
            .soft(
              report.boundaryEdges,
              meshDefectLabel(
                scenario.key,
                `${representation.name} boundary edges`,
                pin !== undefined
              )
            )
            .toBe(expected.boundaryEdges);
          expect
            .soft(
              report.nonManifoldEdges,
              meshDefectLabel(
                scenario.key,
                `${representation.name} non-manifold edges`,
                pin !== undefined
              )
            )
            .toBe(expected.nonManifoldEdges);
        }
      });

      it('exports a watertight STL', async () => {
        const { document, derived } = documents.get(scenario.key)!;
        const stl = await adapter.exportStl(document, derived.exportableBodyIds);
        const parsed = parseAsciiStl(stl);
        const report = meshEdgeUse(parsed.vertices, parsed.indices);
        const pin = scenario.expectedMeshDefects?.stl;
        const expected = pin ?? WATERTIGHT;
        expect(report.triangles).toBeGreaterThan(0);
        expect(
          report.boundaryEdges,
          meshDefectLabel(scenario.key, 'STL boundary edges', pin !== undefined)
        ).toBe(expected.boundaryEdges);
        expect(
          report.nonManifoldEdges,
          meshDefectLabel(
            scenario.key,
            'STL non-manifold edges',
            pin !== undefined
          )
        ).toBe(expected.nonManifoldEdges);
      });

      it('matches the recorded volume and face count', () => {
        if (WRITE_BASELINES) {
          return; // regeneration run — baselines are being (re)written
        }
        const baselines = loadBaselines()[scenario.key];
        expect(
          baselines,
          `no baseline for '${scenario.key}' — regenerate with OPENZCAD_WRITE_PARITY_BASELINES=1`
        ).toBeDefined();
        const bodies = measured[scenario.key]!;
        expect(bodies.length).toBe(baselines!.length);
        for (const [index, body] of bodies.entries()) {
          const expected = baselines![index]!;
          expect.soft(body.name).toBe(expected.name);
          expect
            .soft(
              Math.abs(body.volume - expected.volume) /
                Math.max(Math.abs(expected.volume), 1e-12),
              `${body.name} volume ${body.volume} vs baseline ${expected.volume}`
            )
            .toBeLessThan(VOLUME_RTOL);
          expect
            .soft(body.faceCount, `${body.name} face count (mesh-fallback tell)`)
            .toBe(expected.faceCount);
        }
      });

      it('replays its command log to the same volumes', async () => {
        const { document, derived } = documents.get(scenario.key)!;
        const base = createProjectDocument(
          'Parity Replay',
          toUserId('user_parity_harness'),
          'mm'
        );
        const replayed = replayCommands(base, document.commandLog);
        const replayedDerived = await adapter.syncDocument(replayed);
        expect(replayedDerived.warnings).toEqual(
          documents.get(scenario.key)!.derived.warnings
        );

        const volumes = (d: DerivedState) =>
          exportableBodies(d)
            .map(({ representation }) => representation.volume)
            .sort((a, b) => a - b);
        const original = volumes(derived);
        const fromReplay = volumes(replayedDerived);
        expect(fromReplay.length).toBe(original.length);
        for (const [index, volume] of fromReplay.entries()) {
          expect
            .soft(
              Math.abs(volume - original[index]!) /
                Math.max(Math.abs(original[index]!), 1e-12)
            )
            .toBeLessThan(1e-9);
        }
      });
    });
  }
});
