import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  findSketch,
  listFeaturesInOrder,
  filletEdges,
  holeBody,
  mirrorBody,
  normalizeDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type {
  BodyRepresentation,
  DerivedState,
  ProjectDocument
} from '@openzcad/shared';
import { resolveExtrudeOperation } from '../apps/web/src/lib/extrudeInference';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { buildDocumentHistory } from '../packages/kernel-adapter/src/exact-build-loop';
import { inspectTriangleMeshClosure } from '../packages/kernel-adapter/src/boolean-result-validation';
import {
  createNativeHolderStages,
  createHolderOpeningTool,
  type HolderStage
} from './fixtures/hammer-holder/native-document';

interface ValidationReport {
  errorCount: number;
  warningCount: number;
  issues: { severity: string; description: string }[];
}

function inspect(stage: HolderStage) {
  const kernel = new RemusKernel();
  try {
    const build = buildDocumentHistory(kernel, stage.document);
    const solids = build.shapes.get(stage.bodyId)?.solids;
    expect(solids).toHaveLength(1);
    const solid = solids![0]!;
    const mesh = kernel.tessellateSolid(solid, 0.08);
    try {
      return {
        warnings: build.warnings,
        strict: kernel.validateSolid(solid),
        relaxed: kernel.validateSolidRelaxed(solid),
        report: JSON.parse(
          kernel.validateSolidDetailed(solid) as string
        ) as ValidationReport,
        bounds: Array.from(kernel.boundingBox(solid)),
        volume: kernel.volume(solid, 0.08),
        shells: kernel.getSolidShells(solid).length,
        faces: kernel.getSolidFaces(solid).length,
        mesh: inspectTriangleMeshClosure(mesh.positions, mesh.indices)
      };
    } finally {
      mesh.free();
    }
  } finally {
    kernel.free();
  }
}

function bodyOf(derived: DerivedState, stage: HolderStage): BodyRepresentation {
  const body = derived.bodyRepresentations[stage.bodyId];
  expect(body).toBeDefined();
  return body!;
}

function edgeAt(
  body: BodyRepresentation,
  length: number,
  x: number,
  z?: number
) {
  const edge = body.topology?.edges.find(
    (candidate) =>
      candidate.length !== undefined &&
      Math.abs(candidate.length - length) < 1e-6 &&
      Math.abs(candidate.points[0]! - x) < 1e-6 &&
      (z === undefined
        ? Math.abs(candidate.points[1]! + 43) < 1e-6
        : Math.abs(candidate.points[2]! - z) < 1e-6)
  );
  expect(edge, `edge length ${length} at x=${x}`).toBeDefined();
  return edge!;
}

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => {
  adapter.dispose();
});

// These characterize a known rejection boundary, not completed holder support.
// When the kernel changes, advance the baseline to valid construction rather
// than weakening downstream validation to keep these observations unchanged.
describe(
  'reconstructed native Hammer Holder diagnostic baseline',
  { timeout: 120_000 },
  () => {
    it('builds every stage strictly valid now that a negative sweep keeps its orientation', () => {
      const stages = createNativeHolderStages();
      const expected = {
        plate: { faces: 6, volume: 74 * 53 * 8, height: 8, badEdges: 0 },
        opening: {
          faces: 10,
          volume: (74 * 53 - 46 * 33) * 8,
          height: 8,
          badEdges: 0
        },
        firstArm: {
          faces: 17,
          volume: 35776.00421470196,
          height: 58,
          badEdges: 0
        },
        secondArm: {
          faces: 24,
          volume: 52320.008429403926,
          height: 58,
          badEdges: 0
        }
      };
      for (const name of Object.keys(stages) as (keyof typeof stages)[]) {
        // Exercise the persisted document shape, including region references.
        const document = normalizeDocument(
          JSON.parse(JSON.stringify(stages[name].document)) as ProjectDocument
        );
        const result = inspect({ ...stages[name], document });
        const reference = expected[name];
        expect(result.warnings).toEqual([]);
        expect(result.relaxed).toBe(0);
        expect(result.shells).toBe(1);
        expect(result.faces).toBe(reference.faces);
        result.bounds.forEach((value, i) =>
          expect(value).toBeCloseTo(
            [-37, -43, 0, 37, 10, reference.height][i]!,
            6
          )
        );
        // Curved-stage volumes are measured baseline witnesses, not exact oracles.
        expect(result.volume).toBeCloseTo(reference.volume, 4);
        expect(result.mesh).toMatchObject({
          boundaryEdges: 0,
          nonManifoldEdges: 0,
          inconsistentWindingEdges: 0
        });
        expect(result.strict).toBe(reference.badEdges === 0 ? 0 : 1);
        expect(result.report.errorCount).toBe(result.strict);
        expect(result.report.issues).toEqual(
          reference.badEdges === 0
            ? []
            : [
                {
                  severity: 'error',
                  description: `${reference.badEdges} shared edges have inconsistent face orientations`
                }
              ]
        );
      }
    });

    it('rebuilds the positive opening and first arm with strict orientation', () => {
      for (const direction of ['negative', 'positive'] as const) {
        const tool = inspect(createHolderOpeningTool(direction));
        expect(tool.report.issues, direction).toEqual([]);
        expect(tool.strict).toBe(0);
      }
      const negative = inspect(createNativeHolderStages().opening);
      const positiveStages = createNativeHolderStages({
        openingDirection: 'positive'
      });
      const positive = inspect(positiveStages.opening);
      expect(positive.strict).toBe(0);
      expect(positive.bounds).toEqual(negative.bounds);
      expect(positive.volume).toBeCloseTo(negative.volume, 6);
      expect(positive.faces).toBe(negative.faces);
      expect(inspect(positiveStages.firstArm).report.issues).toEqual([]);
      expect(inspect(positiveStages.firstArm).strict).toBe(0);
    });

    it('mirrors the first arm now that its input is a valid closed solid', async () => {
      // Before the negative-sweep fix this was a refusal boundary: the
      // opening cut left the arm inside-out and Mirror rejected its input.
      const stage = createNativeHolderStages().firstArm;
      const mirrored = mirrorBody(stage.document, {
        name: 'Mirror',
        targetBodyId: stage.bodyId,
        plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
      });
      const result = await adapter.syncDocument(mirrored.document);
      expect(result.warnings).toEqual([]);
      expect(result.bodyRepresentations[mirrored.bodyId]?.faceCount).toBe(17);
      expect(bodyOf(result, stage).consumed).toBe(false);
      expect(result.exportableBodyIds).toContain(stage.bodyId);
    });

    it('fillets the plate and drills it after refused arm fillets, preserving input at each refusal', async () => {
      const stage = createNativeHolderStages().secondArm;
      const body = bodyOf(await adapter.syncDocument(stage.document), stage);
      const armEdge = edgeAt(body, 35, 37);
      for (const size of [3, 1]) {
        const fillet = filletEdges(stage.document, {
          name: 'Arm fillet',
          targetBodyId: stage.bodyId,
          edgeHashes: [armEdge.hash],
          size
        });
        const result = await adapter.syncDocument(fillet.document);
        expect(result.warnings).toEqual([
          expect.stringContaining(
            `Fillet could not be created on 1 selected edge with radius ${size}.`
          )
        ]);
        expect(result.bodyRepresentations[fillet.bodyId]).toBeUndefined();
        expect(bodyOf(result, stage).consumed).toBe(false);
      }
      // On the valid body the top plate edge under the arm foot is the next
      // refusal boundary: the blend would end where the arm wall rises. (The
      // inside-out body used to accept it, as a fragment of the real edge.)
      const topPlateEdge = edgeAt(body, 30, 37, 8);
      const refusedTop = await adapter.syncDocument(
        filletEdges(stage.document, {
          name: 'Plate fillet',
          targetBodyId: stage.bodyId,
          edgeHashes: [topPlateEdge.hash],
          size: 3
        }).document
      );
      expect(refusedTop.warnings).toEqual([
        expect.stringContaining(
          'Fillet could not be created on 1 selected edge with radius 3.'
        )
      ]);
      expect(bodyOf(refusedTop, stage).consumed).toBe(false);
      const plateEdge = edgeAt(body, 30, 37, 0);
      const fillet = filletEdges(stage.document, {
        name: 'Plate fillet',
        targetBodyId: stage.bodyId,
        edgeHashes: [plateEdge.hash],
        size: 3
      });
      const filleted = await adapter.syncDocument(fillet.document);
      expect(filleted.warnings).toEqual([]);
      expect(bodyOf(filleted, fillet).faceCount).toBe(25);
      expect(bodyOf(filleted, stage).consumed).toBe(true);

      // The observed Hole attempts followed the plate-edge fillet. On the
      // inside-out body both refused ("The hole cut did not produce a valid
      // solid."); on the valid body the unified 1760 mm² top face drills.
      const top = bodyOf(filleted, fillet).topology?.faces.find(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          Math.abs(face.geometry.center.z - 8) < 1e-6 &&
          Math.abs(face.geometry.area - 1760) < 1e-6
      );
      expect(top).toBeDefined();
      for (const [style, faces] of [
        ['simple', 27],
        ['countersink', 28]
      ] as const) {
        const hole = holeBody(fillet.document, {
          name: 'Hole',
          targetBodyId: fillet.bodyId,
          faceHash: top!.hash,
          style,
          diameter: 5,
          depthMode: 'through',
          position: { u: 0, v: 0 },
          ...(style === 'countersink'
            ? { countersinkDiameter: 9, countersinkAngleDeg: 90 }
            : {})
        });
        const result = await adapter.syncDocument(hole.document);
        expect(result.warnings).toEqual([]);
        expect(bodyOf(result, hole).faceCount).toBe(faces);
        expect(bodyOf(result, fillet).consumed).toBe(true);
      }
    });
  }
);

describe(
  'native holder bore inference measurement baseline',
  { timeout: 120_000 },
  () => {
    it('infers Cut for a bore tool wholly inside the target, at an exact union', async () => {
      const stage = createNativeHolderStages().secondArm;
      const body = bodyOf(await adapter.syncDocument(stage.document), stage);
      const plate = filletEdges(stage.document, {
        name: 'Plate fillet',
        targetBodyId: stage.bodyId,
        edgeHashes: [edgeAt(body, 30, 37, 0).hash],
        size: 3
      });
      const sketch = addSketchFeature(plate.document, {
        name: 'Bore layout',
        planeRef: { type: 'canonical', plane: 'XY', offset: 8 },
        objects: [-20, 20].map((centerX) => ({
          objectKind: 'circle',
          centerX,
          centerY: 0,
          radius: 2.5
        }))
      });
      const base = {
        ...sketch.document,
        derived: await adapter.syncDocument(sketch.document)
      };
      const measurements: {
        operation: string | undefined;
        volume: number;
        warnings: string[];
      }[] = [];
      const resolved = await resolveExtrudeOperation({
        base,
        input: {
          name: 'Bore extrude',
          sketchId: sketch.sketchId,
          distance: -8,
          profiles: findSketch(base, sketch.sketchId)!.objectIds.map((id) => ({
            all: true,
            sourceEntityIds: [id]
          }))
        },
        derive: async (document) => {
          const derived = await adapter.syncDocument(document);
          const feature = listFeaturesInOrder(document).at(-1)!;
          expect(feature.data.featureKind).toBe('extrude');
          measurements.push({
            operation:
              feature.data.featureKind === 'extrude'
                ? feature.data.operation
                : undefined,
            volume:
              derived.bodyRepresentations[document.bodyOrder.at(-1)!]!.volume,
            warnings: derived.warnings
          });
          return derived;
        }
      });
      expect(measurements.map((measurement) => measurement.operation)).toEqual([
        'new-body',
        'add',
        'cut'
      ]);
      expect(
        measurements.every((measurement) => measurement.warnings.length === 0)
      ).toBe(true);
      const toolVolume = measurements[0]!.volume;
      const unionVolume = measurements[1]!.volume;
      const targetVolume = bodyOf(base.derived, plate).volume;
      expect(toolVolume).toBeCloseTo(2 * Math.PI * 2.5 ** 2 * 8, 6);
      expect(targetVolume).toBeCloseTo(52217.64335334451, 4);
      // Both cylinders lie inside the untouched bridge. The union measures the
      // target exactly — an enclosed tool adds nothing — so the classifier's
      // enclosure rule has the final say and the bores infer Cut. When the
      // measurement still carried tessellation error, the union read 1.2756
      // mm3 ABOVE the target and the same gesture inferred Add instead; that
      // misclassification is what an exact union measurement buys back.
      expect(unionVolume).toBeCloseTo(targetVolume, 6);
      expect(resolved.inference).toMatchObject({
        operation: 'cut',
        reason: 'enclosed',
        targetBodyId: plate.bodyId
      });
      expect(resolved.inference.sharedVolume).toBeCloseTo(
        targetVolume + toolVolume - unionVolume,
        6
      );
    });
  }
);
