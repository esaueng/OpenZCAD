/** Opt-in private-fixture construction and export. No STEP payload in Git. */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  createProjectDocument,
  importStepBody,
  setParameter,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  CommandManager,
  growingHolderCommand,
  growingHolderHistories,
  growingHolderHoleCommand,
  matchGrowingHolderHoles,
  recipeFromRecognizedOpening
} from '@openzcad/command-system';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { hammerRecipe } from '../packages/command-system/src/growing-holder.test';
import { sanitizeStepHeaderPrivacy } from '@openzcad/io-step';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { recognizeOpening } from '../packages/kernel-adapter/src/opening-recognition';
import { buildDocumentHistory } from '../packages/kernel-adapter/src/exact-build-loop';
import { inspectTriangleMeshClosure } from '../packages/kernel-adapter/src/boolean-result-validation';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';

const sourcePath = process.env.OPENZCAD_HAMMER_STEP;
const move = (x: number, y = 0, z = 0) =>
  Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);

it.skipIf(!sourcePath)(
  'grows the holder and moves intact mounting holes with the arms',
  async () => {
    const io = await loadRemusTranslators();
    const kernel = new RemusKernel();
    try {
      const [source] = kernel.deserializeSolids(
        io.importStep(readFileSync(sourcePath!))
      );
      // Prove the replaced source section analytically. Whole-holder volume
      // uses tessellation for its NURBS lettering/blends and changes slightly
      // when the same boundary is partitioned, so it is not an exact identity
      // oracle. This core is entirely planar/cylindrical and integrates exactly.
      const coreMask = kernel.copyAndTransformSolid(
        kernel.makeBox(30, 200, 200),
        move(-4, -100, -100)
      );
      const core = kernel.intersect(source!, coreMask);
      expect(kernel.validateSolid(core)).toBe(0);
      expect(Array.from(kernel.boundingBox(core))).toEqual([
        -4, 39.5, 4.5, 26, 59.5, 12.5
      ]);
      const coreSurfaces = Array.from(kernel.getSolidFaces(core)).map(
        (f) =>
          JSON.parse(kernel.getAnalyticSurfaceParams(f)) as {
            type: string;
            radius?: number;
            axis?: number[];
          }
      );
      expect(coreSurfaces.filter((s) => s.type === 'plane')).toHaveLength(6);
      const corners = coreSurfaces.filter((s) => s.type === 'cylinder');
      expect(corners).toHaveLength(2);
      for (const corner of corners) {
        expect(corner.radius).toBe(3);
        expect(Math.abs(corner.axis![0]!)).toBe(1);
      }
      expect(kernel.volume(core, 0.01)).toBeCloseTo(
        30 * (160 - 18 + 4.5 * Math.PI),
        8
      );
      const width = Number(process.env.OPENZCAD_HAMMER_WIDTH ?? 48);
      // One sanitized import; the production recipe compiler carves the ends
      // from it at rebuild time instead of embedding two STEP payloads.
      const imported = importStepBody(
        createProjectDocument(
          'Hammer growing opening',
          toUserId('local_hammer')
        ),
        {
          name: 'Hammer holder',
          artifactId: 'hammer',
          sourceName: 'holder.step',
          stepText: sanitizeStepHeaderPrivacy(
            new TextDecoder().decode(readFileSync(sourcePath!)),
            'holder.step'
          )
        }
      );
      // Recognition measures the same recipe the hand-authored fixture
      // carries: every value below comes from the exact solid, none from
      // this file.
      const recognized = recognizeOpening(kernel, source!);
      expect(recognized.status).toBe('recognized');
      if (recognized.status !== 'recognized') throw new Error('unreachable');
      const {
        section: measuredSection,
        height: measuredHeight,
        ...measured
      } = recognized.opening;
      const { section: expectedSection, ...expected } = hammerRecipe(
        imported.bodyId
      );
      // The arm height: the widest gap between two letters on the lettered
      // arm, shared with the plain arm, with the eight-edge arm profile.
      expect(measuredHeight).toMatchObject({ axis: 'z', sourceHeight: 58 });
      const runs = measuredHeight!.straightRuns;
      expect(runs.negative[0]).toBeCloseTo(24.7, 2);
      expect(runs.negative[1]).toBeCloseTo(26.09, 2);
      expect(runs.positive[0]).toBeCloseTo(20.5, 2);
      expect(runs.positive[1]).toBeCloseTo(47.26, 2);
      expect(measuredHeight!.cuts[0]).toBeCloseTo(runs.negative[0] + 0.1, 6);
      expect(measuredHeight!.cuts[1]).toBeCloseTo(runs.negative[1] - 0.1, 6);
      expect(measuredHeight!.minimumHeight).toBeCloseTo(
        58 - (measuredHeight!.cuts[1] - measuredHeight!.cuts[0]) + 0.1,
        6
      );
      expect(measuredHeight!.sections.negative).toHaveLength(8);
      expect(measuredHeight!.sections.positive).toHaveLength(8);
      expect(measured).toEqual({
        axis: expected.axis,
        envelope: expected.envelope,
        cuts: expected.cuts,
        center: expected.center,
        sourceOpening: expected.sourceOpening,
        minimumOpening: expected.minimumOpening
      });
      // Lines compare regardless of direction; arcs must match exactly.
      const profileKeys = (section: typeof measuredSection) =>
        section
          .map((o) =>
            o.objectKind === 'line'
              ? [
                  [o.x1, o.y1],
                  [o.x2, o.y2]
                ]
                  .map((p) => p.join(','))
                  .sort()
                  .join(' ')
              : JSON.stringify(o)
          )
          .sort();
      expect(profileKeys(measuredSection)).toEqual(profileKeys(expectedSection));
      expect(recognized.evidence).toMatchObject({
        candidate: { innerFaces: [-12, 34], opening: 46 },
        straightRun: [-4.5, 26.5],
        sectionEdges: 6
      });
      const manager = new CommandManager(imported.document);
      const recipe = recipeFromRecognizedOpening(recognized.opening, {
        name: 'Hammer opening',
        targetBodyId: imported.bodyId,
        parameter: 'opening_width'
      });
      const compiled = growingHolderCommand(manager.document, recipe);
      manager.execute(compiled.command);
      expect(growingHolderHistories(manager.document)).toHaveLength(1);
      // The mounting bores: both Ø5 through the base, countersunk to Ø9,
      // measured on the carved ends and driven by one parameter. Widening
      // runs the cutter through the countersink, which keeps its diameter.
      const adapter = await createExactKernelAdapter();
      let grown: typeof manager.document;
      try {
        grown = {
          ...manager.document,
          derived: await adapter.syncDocument(manager.document)
        };
      } finally {
        adapter.dispose();
      }
      expect(grown.derived.warnings).toEqual([]);
      const history = growingHolderHistories(grown)[0]!;
      const match = matchGrowingHolderHoles(grown, history);
      expect(match.status).toBe('matched');
      if (match.status !== 'matched') throw new Error('unreachable');
      expect(match.pair.diameter).toBe(5);
      manager.execute(growingHolderHoleCommand(grown, match.pair).command);
      // Shrinking is refused on this part: the kernel returns the untouched
      // body for a ring fused onto a coaxial bore and degrades the fill to a
      // mesh, and the feature reports it instead of pretending.
      const shrunk = buildDocumentHistory(
        kernel,
        setParameter(manager.document, {
          name: 'hole_diameter',
          expression: '4'
        })
      );
      expect(
        shrunk.warnings.map((w) => JSON.stringify(w))
      ).toHaveLength(2);
      expect(JSON.stringify(shrunk.warnings)).toMatch(
        /kept its original diameter instead of resizing to Ø4/
      );
      const holeDiameter = 6;
      const holderHeight = Number(process.env.OPENZCAD_HAMMER_HEIGHT ?? 64);
      const document = setParameter(
        setParameter(
          setParameter(manager.document, {
            name: 'hole_diameter',
            expression: String(holeDiameter)
          }),
          { name: 'holder_height', expression: String(holderHeight) }
        ),
        { name: 'opening_width', expression: String(width) }
      );
      const joined = { bodyId: compiled.bodyId };
      const built = buildDocumentHistory(kernel, document);
      expect(built.warnings).toEqual([]);
      const solids = built.shapes.get(joined.bodyId)!.solids;
      expect(solids).toHaveLength(1);
      const solid = solids[0]!;
      expect(kernel.validateSolid(solid)).toBe(0);
      for (const x of [11 - width / 2, 11 + width / 2]) {
        expect(
          Array.from(kernel.getSolidFaces(solid)).some((face) => {
            const surface = JSON.parse(
              kernel.getAnalyticSurfaceParams(face)
            ) as { type: string };
            const vertices = Array.from(kernel.getFaceVertices(face));
            return (
              surface.type === 'plane' &&
              vertices.length >= 4 &&
              vertices.every(
                (vertex) =>
                  Math.abs(kernel.getVertexPosition(vertex)[0]! - x) < 1e-7
              )
            );
          }),
          `opening wall at x=${x}`
        ).toBe(true);
      }
      Array.from(kernel.boundingBox(solid)).forEach((v, i) =>
        expect(v).toBeCloseTo(
          [
            11 - (width + 28) / 2,
            6.5,
            4.5,
            11 + (width + 28) / 2,
            59.5,
            62.5 + (holderHeight - 58)
          ][i]!,
          6
        )
      );
      const mesh = kernel.tessellateSolid(solid, 0.05);
      try {
        expect(
          inspectTriangleMeshClosure(mesh.positions, mesh.indices)
        ).toMatchObject({
          boundaryEdges: 0,
          nonManifoldEdges: 0,
          inconsistentWindingEdges: 0
        });
      } finally {
        mesh.free();
      }
      const surfaces = Array.from(kernel.getSolidFaces(solid)).map(
        (f) =>
          JSON.parse(kernel.getAnalyticSurfaceParams(f)) as {
            type: string;
            radius?: number;
            origin?: number[];
            axis?: number[];
          }
      );
      // The bores run along z at y = 49.5; the part's R3 blends do not.
      const holes = surfaces
        .filter(
          (s) =>
            s.type === 'cylinder' &&
            Math.abs((s.radius ?? 0) - holeDiameter / 2) < 1e-7 &&
            Math.abs(Math.abs(s.axis?.[2] ?? 0) - 1) < 1e-7 &&
            Math.abs((s.origin?.[1] ?? 0) - 49.5) < 1e-6
        )
        .sort((a, b) => a.origin![0]! - b.origin![0]!);
      // The Ø9 countersinks survive as cones whatever the bore does.
      expect(surfaces.filter((s) => s.type === 'cone').length).toBeGreaterThanOrEqual(2);
      expect(holes).toHaveLength(2);
      expect(holes[0]!.origin![0]).toBeCloseTo(11 - (width - 6) / 2, 6);
      expect(holes[1]!.origin![0]).toBeCloseTo(11 + (width - 6) / 2, 6);
      for (const hole of holes) expect(hole.origin![1]).toBeCloseTo(49.5, 6);
      const text = JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: withoutDerivedProjection(document),
        files: [],
        sources: [],
        saveStates: []
      });
      expect((await parseProjectBackup(text)).document.featureOrder).toEqual(
        document.featureOrder
      );
      if (process.env.OPENZCAD_HAMMER_OUTPUT)
        writeFileSync(process.env.OPENZCAD_HAMMER_OUTPUT, text);
      if (process.env.OPENZCAD_HAMMER_ARENA)
        writeFileSync(
          process.env.OPENZCAD_HAMMER_ARENA,
          kernel.serializeSolids(Uint32Array.of(solid))
        );
      const restored = kernel.deserializeSolids(
        io.importStep(
          io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)))
        )
      );
      expect(restored).toHaveLength(1);
      expect(kernel.validateSolid(restored[0]!)).toBe(0);
      const volume = kernel.volume(solid, 0.01);
      expect(volume).toBeGreaterThan(0);
      // Tessellated volume of a NURBS-faced body shifts by a few 1e-6
      // relative when the round trip repartitions its faces (more once the
      // widened bores cut into the countersinks); this is not an exact
      // identity oracle (see docs/imported-hammer-growing.md).
      expect(
        Math.abs(kernel.volume(restored[0]!, 0.01) - volume) / volume
      ).toBeLessThan(1e-5);
    } finally {
      kernel.free();
    }
  },
  600_000
);
