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
    it('locates the first strict orientation failure at the opening, despite closed meshes', () => {
      const stages = createNativeHolderStages();
      const expected = {
        plate: { faces: 6, volume: 74 * 53 * 8, height: 8, badEdges: 0 },
        opening: {
          faces: 10,
          volume: (74 * 53 - 46 * 33) * 8,
          height: 8,
          badEdges: 8
        },
        firstArm: {
          faces: 21,
          volume: 35775.471735205,
          height: 58,
          badEdges: 10
        },
        secondArm: {
          faces: 34,
          volume: 52318.94347041,
          height: 58,
          badEdges: 12
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

    it('isolates opening sweep direction without pretending it repairs the later Add', () => {
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
      expect(inspect(positiveStages.firstArm).report.issues).toEqual([
        {
          severity: 'error',
          description: '6 shared edges have inconsistent face orientations'
        }
      ]);
    });

    it('refuses Mirror at the invalid input boundary and preserves the source', async () => {
      const stage = createNativeHolderStages().firstArm;
      const mirrored = mirrorBody(stage.document, {
        name: 'Mirror',
        targetBodyId: stage.bodyId,
        plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
      });
      const result = await adapter.syncDocument(mirrored.document);
      expect(result.warnings).toContain(
        'Feature "Mirror": Target solid is not a valid closed solid.'
      );
      expect(result.bodyRepresentations[mirrored.bodyId]).toBeUndefined();
      expect(bodyOf(result, stage).consumed).toBe(false);
      expect(result.exportableBodyIds).toContain(stage.bodyId);
    });

    it('retains the working plate fillet while preserving input after refused arm fillets and holes', async () => {
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
      const plateEdge = edgeAt(body, 30, 37, 8);
      const fillet = filletEdges(stage.document, {
        name: 'Plate fillet',
        targetBodyId: stage.bodyId,
        edgeHashes: [plateEdge.hash],
        size: 3
      });
      const filleted = await adapter.syncDocument(fillet.document);
      expect(filleted.warnings).toEqual([]);
      expect(bodyOf(filleted, fillet).faceCount).toBe(36);
      expect(bodyOf(filleted, stage).consumed).toBe(true);

      // The observed Hole attempt followed the successful plate-edge fillet.
      const top = bodyOf(filleted, fillet).topology?.faces.find(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          Math.abs(face.geometry.center.z - 8) < 1e-6 &&
          Math.abs(face.geometry.area - 420) < 1e-6
      );
      expect(top).toBeDefined();
      for (const style of ['simple', 'countersink'] as const) {
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
        expect(result.warnings).toContain(
          'Feature "Hole": The hole cut did not produce a valid solid.'
        );
        expect(result.bodyRepresentations[hole.bodyId]).toBeUndefined();
        expect(bodyOf(result, fillet).consumed).toBe(false);
      }
    });
  }
);

describe(
  'native holder bore inference measurement baseline',
  { timeout: 120_000 },
  () => {
    it('exposes the union-volume increase that turns enclosed bore tools into Add', async () => {
      const stage = createNativeHolderStages().secondArm;
      const body = bodyOf(await adapter.syncDocument(stage.document), stage);
      const plate = filletEdges(stage.document, {
        name: 'Plate fillet',
        targetBodyId: stage.bodyId,
        edgeHashes: [edgeAt(body, 30, 37, 8).hash],
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
        'add'
      ]);
      expect(
        measurements.every((measurement) => measurement.warnings.length === 0)
      ).toBe(true);
      const toolVolume = measurements[0]!.volume;
      const unionVolume = measurements[1]!.volume;
      const targetVolume = bodyOf(base.derived, plate).volume;
      expect(toolVolume).toBeCloseTo(2 * Math.PI * 2.5 ** 2 * 8, 6);
      expect(targetVolume).toBeCloseTo(52260.790324680485, 4);
      // Both cylinders lie inside the untouched bridge. Their union should not
      // add volume; record the measured discrepancy without calling it exact.
      expect(unionVolume - targetVolume).toBeCloseTo(1.275608840745, 4);
      expect(unionVolume - targetVolume).toBeGreaterThan(
        resolved.inference.tolerance
      );
      expect(resolved.inference).toMatchObject({
        operation: 'add',
        reason: 'partial-overlap',
        targetBodyId: plate.bodyId
      });
      expect(resolved.inference.sharedVolume).toBeCloseTo(
        targetVolume + toolVolume - unionVolume,
        6
      );
    });
  }
);
