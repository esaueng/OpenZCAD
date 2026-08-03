import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  transformBody
} from '@openzcad/document-core';
import {
  buildTextProfileSet,
  computeSketchRegions,
  setTextFontProvider
} from '@openzcad/geometry';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ParamValue,
  type ProjectDocument
} from '@openzcad/shared';

import { FontLibrary } from '../../../packages/geometry/src/text/loader';
import { nodeFontDataSource } from '../../../packages/geometry/src/text/nodeFontSource';
import { inspectTriangleMeshClosure } from '../../../packages/kernel-adapter/src/boolean-result-validation';
import { OcctStepKernelAdapter } from './occt-step';

/**
 * The two kernels are separate types — `kind: 'brepkit'` against
 * `kind: 'occt'` — so a comparison holds them by the operation it uses rather
 * than by a shared adapter type. That is the whole surface these tests need.
 */
interface ComparableKernel {
  syncDocument(document: ProjectDocument): Promise<DerivedState>;
}

const user = toUserId('user_fingerprint_parity');

function resolveParam(value: ParamValue): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Rectangle with a circular hole, extruded as a persisted region profile. */
function plateWithHoleDocument(): {
  document: ProjectDocument;
  bodyId: BodyId;
} {
  const { document: withSketch, sketchId } = addSketchFeature(
    createProjectDocument('Plate', user),
    {
      name: 'Plate profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 40,
          height: 30,
          centerX: 0,
          centerY: 0
        },
        { objectKind: 'circle', radius: 8, centerX: 0, centerY: 0 }
      ]
    }
  );
  const sketch = findSketch(withSketch, sketchId)!;
  const objects = sketch.objectIds.flatMap((id) => {
    const node = withSketch.nodes[id];
    return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
  });
  const regions = computeSketchRegions(objects, resolveParam);
  const plate = regions.find((region) => region.holes.length === 1);
  expect(plate).toBeTruthy();
  const { document, bodyId } = extrudeSketch(withSketch, {
    name: 'Plate extrude',
    sketchId,
    distance: 10,
    profile: {
      regionFingerprint: plate!.regionFingerprint,
      samplePoint: plate!.samplePoint,
      sourceArea: plate!.area
    }
  });
  return { document, bodyId };
}

/**
 * Face and edge hashes are the identity substrate a saved selection resolves
 * against, and ADR-011 makes them cross-kernel stable for analytic topology.
 * If the two kernels name the same body's topology differently, a stored edge
 * pick lands on different geometry depending on which kernel built the
 * document — silently, because both bodies are valid and measure the same.
 *
 * This lives in the parity reference area rather than beside the seam suite
 * because that is what it is: a claim about the OCCT reference agreeing with
 * the production kernel. Z5 removed OpenCascade from the production adapter
 * and moved it here, and the assertion moved with it.
 *
 * `corpus.spec.ts` makes the same comparison in BULK, over the STEP corpus,
 * via the `faceHashDigest` / `edgeHashDigest` metrics. What it does not carry
 * is a MODELLED history: a primitive, a boolean, and a region-profile extrude
 * built from feature operations rather than parsed from a file. Those three
 * are the shapes a stored selection is actually taken on, so they are pinned
 * here directly and by hash SET rather than by digest, so a divergence names
 * the hashes that moved instead of reporting two unequal 32-bit numbers.
 */
describe('cross-kernel agreement on modelled documents', () => {
  let adapter: ComparableKernel;
  let occt: OcctStepKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    occt = await OcctStepKernelAdapter.create();
  });

  afterAll(() => {
    occt.dispose();
  });

  it('persists identical edge fingerprints on both kernels for the same history', async () => {
    const documents: Array<{ document: ProjectDocument; bodyId: BodyId }> = [];

    const box = addPrimitiveFeature(createProjectDocument('Box', user), {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });
    documents.push({ document: box, bodyId: box.bodyOrder[0]! });

    const withBlock = addPrimitiveFeature(
      createProjectDocument('Bored block', user),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      }
    );
    const blockId = withBlock.bodyOrder.at(-1)!;
    const withDrill = addPrimitiveFeature(withBlock, {
      name: 'Drill',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 10 }
    });
    const drillId = withDrill.bodyOrder.at(-1)!;
    const positioned = transformBody(withDrill, {
      name: 'Center drill',
      targetBodyId: drillId,
      translation: { x: 20, y: 20, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const bored = booleanBodies(positioned, {
      name: 'Bore',
      operation: 'subtract',
      targetBodyIds: [blockId, drillId]
    }).document;
    documents.push({ document: bored, bodyId: bored.bodyOrder.at(-1)! });

    const plate = plateWithHoleDocument();
    documents.push({ document: plate.document, bodyId: plate.bodyId });

    for (const { document, bodyId } of documents) {
      const onBrepKit = await adapter.syncDocument(document);
      const onOcct = await occt.syncDocument(document);
      expect(onBrepKit.warnings).toEqual([]);
      expect(onOcct.warnings).toEqual([]);
      const brepkitEdges = onBrepKit.bodyRepresentations[
        bodyId
      ]!.topology!.edges.map((edge) => edge.hash).sort((a, b) => a - b);
      const occtEdges = onOcct.bodyRepresentations[bodyId]!.topology!.edges.map(
        (edge) => edge.hash
      ).sort((a, b) => a - b);
      expect(occtEdges).toEqual(brepkitEdges);

      const brepkitFaces = onBrepKit.bodyRepresentations[
        bodyId
      ]!.topology!.faces.map((face) => face.hash).sort((a, b) => a - b);
      const occtFaces = onOcct.bodyRepresentations[bodyId]!.topology!.faces.map(
        (face) => face.hash
      ).sort((a, b) => a - b);
      expect(occtFaces).toEqual(brepkitFaces);
      // Non-vacuous: a body with no published topology would satisfy every
      // equality above. Each of these three has both faces and edges.
      expect(brepkitFaces.length).toBeGreaterThan(0);
      expect(brepkitEdges.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it('builds the same text solid from exact beziers on both kernels', async () => {
    // The `'bezier'` region-curve kind reaches BrepKit through
    // `liftCurve2dToPlane` and OpenCascade through `makeBezierEdge` — two
    // different constructions of the same curve, and the OCCT one had no
    // coverage at all. Same document, same volume, both watertight.
    const library = new FontLibrary(nodeFontDataSource());
    await library.load('open-sans', 'regular');
    setTextFontProvider((family, style) => library.peek(family, style));
    try {
      const created = addSketchFeature(
        createProjectDocument('Text seam', user),
        {
          name: 'Label',
          planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
          objects: [
            {
              objectKind: 'text',
              text: 'Bo',
              fontFamily: 'open-sans',
              fontStyle: 'regular',
              size: 20,
              x: 0,
              y: 0
            }
          ]
        }
      );
      const sketch = findSketch(created.document, created.sketchId)!;
      const { document, bodyId } = extrudeSketch(created.document, {
        name: 'Raised label',
        sketchId: created.sketchId,
        distance: 5,
        profiles: [{ all: true, sourceEntityIds: [sketch.objectIds[0]!] }]
      });

      // The area comes from the glyph pipeline, so neither kernel is grading
      // its own homework: 'Bo' has three counters, and dropping one is a
      // percent-scale volume error.
      const exactVolume =
        buildTextProfileSet(library.peek('open-sans', 'regular')!, {
          text: 'Bo',
          size: 20
        }).regions.reduce((total, region) => total + region.area, 0) * 5;

      for (const kernel of [adapter, occt] satisfies ComparableKernel[]) {
        const derived = await kernel.syncDocument(document);
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[bodyId]!;
        expect(Math.abs(body.volume - exactVolume) / exactVolume).toBeLessThan(
          0.001
        );
        const closure = inspectTriangleMeshClosure(
          body.mesh.vertices,
          body.mesh.indices
        );
        expect(closure.boundaryEdges).toBe(0);
        expect(closure.nonManifoldEdges).toBe(0);
      }
    } finally {
      setTextFontProvider(null);
    }
  }, 120_000);
});
