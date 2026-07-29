import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  filletEdges,
  findSketch,
  importMeshBody,
  importStepBody,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import { createKernelAdapter } from '@openzcad/kernel-adapter';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ParamValue,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Kernel-seam correctness: a document must mean the same geometry whichever
 * exact kernel builds it. Adding or removing a STEP import reroutes the whole
 * document between BrepKit and OpenCascade, so every persisted reference —
 * region fingerprints, edge and face hashes — and every export path has to
 * either resolve to the same geometry or fail closed. These tests are
 * deliberately adversarial: they assert *positions*, not just success, because
 * a positional (ordinal) resolution scheme passes success-only tests while
 * silently editing the wrong geometry.
 */

const user = toUserId('user_seam');

function resolveParam(value: ParamValue): number {
  return typeof value === 'number' ? value : Number(value);
}

/** Rectangle with a circular hole, extruded as a persisted region profile. */
function plateWithHoleDocument(): {
  document: ProjectDocument;
  bodyId: BodyId;
  exactVolume: number;
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
  return {
    document,
    bodyId,
    exactVolume: (40 * 30 - Math.PI * 8 ** 2) * 10
  };
}

/**
 * Notched block: base box minus a corner cutter. The far vertical corner edge
 * at (x=30, y=18) is untouched by the cutter, so a fillet on it must survive
 * any cutter edit — cutter changes shift edge enumeration without moving the
 * filleted edge's geometry.
 */
function notchedBlockDocument(cutterWidth: number): {
  document: ProjectDocument;
  resultBodyId: BodyId;
} {
  const withBase = addPrimitiveFeature(
    createProjectDocument('Notched block', user),
    {
      name: 'Base',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 18, depth: 24 }
    }
  );
  const baseId = withBase.bodyOrder.at(-1)!;
  const withCutter = addPrimitiveFeature(withBase, {
    name: 'Cutter',
    primitiveKind: 'box',
    dimensions: { width: cutterWidth, height: 6, depth: 30 }
  });
  const cutterId = withCutter.bodyOrder.at(-1)!;
  const { document } = booleanBodies(withCutter, {
    name: 'Notch',
    operation: 'subtract',
    targetBodyIds: [baseId, cutterId]
  });
  return { document, resultBodyId: document.bodyOrder.at(-1)! };
}

function addStepImport(
  document: ProjectDocument,
  stepText: string
): ProjectDocument {
  return importStepBody(document, {
    name: 'Imported reference',
    artifactId: 'artifact_seam_ref',
    sourceName: 'reference.step',
    stepText
  }).document;
}

function removeStepImport(document: ProjectDocument): ProjectDocument {
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.data.featureKind === 'imported-step'
  );
  expect(feature).toBeTruthy();
  return deleteFeature(document, { featureId: feature!.featureId });
}

/** Points of an edge all lying on the vertical line x=X, y=Y (within tol). */
function edgeOnVerticalLine(
  body: BodyRepresentation | undefined,
  x: number,
  y: number,
  tolerance = 1e-4
): { hash: number } | undefined {
  return body?.topology?.edges.find((edge) => {
    if (edge.points.length < 6) {
      return false;
    }
    let spanZ = 0;
    for (let index = 0; index + 2 < edge.points.length; index += 3) {
      if (
        Math.abs(edge.points[index]! - x) > tolerance ||
        Math.abs(edge.points[index + 1]! - y) > tolerance
      ) {
        return false;
      }
      spanZ = Math.max(spanZ, Math.abs(edge.points[index + 2]!));
    }
    return spanZ > 1;
  });
}

/** True when any edge point comes within `radius` of the line x=X, y=Y. */
function hasEdgePointNearLine(
  body: BodyRepresentation | undefined,
  x: number,
  y: number,
  radius: number
): boolean {
  return (body?.topology?.edges ?? []).some((edge) => {
    for (let index = 0; index + 2 < edge.points.length; index += 3) {
      if (
        Math.hypot(edge.points[index]! - x, edge.points[index + 1]! - y) <
        radius
      ) {
        return true;
      }
    }
    return false;
  });
}

function asciiStlVertices(text: string): number[][] {
  return [...text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
    Number(match[3])
  ]);
}

/** FNV-1a over a signature string — mirrors the persisted-hash contract. */
function fnv(signature: string): number {
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return unsigned === 0 ? 1 : unsigned;
}

describe('kernel seam correctness', () => {
  let adapter: ExactKernelAdapter;
  let referenceStep: string;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    const source = addPrimitiveFeature(
      createProjectDocument('Reference', user),
      {
        name: 'Reference box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      }
    );
    referenceStep = await adapter.exportStep(source, [source.bodyOrder[0]!]);
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('keeps a region-extrude hole through a STEP-import reroute and back', async () => {
    const { document, bodyId, exactVolume } = plateWithHoleDocument();

    const onBrepKit = await adapter.syncDocument(document);
    expect(onBrepKit.warnings).toEqual([]);
    const brepkitBody = onBrepKit.bodyRepresentations[bodyId];
    expect(
      Math.abs((brepkitBody?.volume ?? 0) - exactVolume) / exactVolume
    ).toBeLessThan(0.005);
    expect(
      brepkitBody?.topology?.faces.some(
        (face) => face.geometry?.surfaceType === 'cylinder'
      )
    ).toBe(true);

    // A STEP import reroutes the whole document to OpenCascade. The hole must
    // not silently disappear (the historic failure sweeps the rectangle's
    // whole profile: volume 12000 instead of ~9989).
    const withStep = addStepImport(document, referenceStep);
    const onOcct = await adapter.syncDocument(withStep);
    expect(onOcct.warnings).toEqual([]);
    const occtBody = onOcct.bodyRepresentations[bodyId];
    expect(
      Math.abs((occtBody?.volume ?? 0) - exactVolume) / exactVolume
    ).toBeLessThan(0.005);
    expect(
      occtBody?.topology?.faces.some(
        (face) => face.geometry?.surfaceType === 'cylinder'
      )
    ).toBe(true);

    // Removing the STEP source must return to identical BrepKit geometry.
    const backToBrepKit = await adapter.syncDocument(
      removeStepImport(withStep)
    );
    expect(backToBrepKit.warnings).toEqual([]);
    expect(backToBrepKit.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      brepkitBody!.volume,
      6
    );
  });

  it('fails closed naming the feature when OCCT cannot resolve the region', async () => {
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Ghost region', user),
      {
        name: 'Disk profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }]
      }
    );
    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Ghost extrude',
      sketchId,
      distance: 5,
      profile: {
        regionFingerprint: 123456789,
        samplePoint: { x: 500, y: 500 },
        sourceArea: 42
      }
    });
    const derived = await adapter.syncDocument(
      addStepImport(document, referenceStep)
    );
    expect(
      derived.warnings.some(
        (warning) =>
          warning.includes('Ghost extrude') &&
          warning.includes('Broken profile reference')
      )
    ).toBe(true);
    // Never the fallback shape: the body must be absent, not the whole disk.
    expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
  });

  it('keeps a fillet on the same geometric edge across reroutes and upstream edits', async () => {
    const { document, resultBodyId } = notchedBlockDocument(6);
    const base = await adapter.syncDocument(document);
    expect(base.warnings).toEqual([]);
    const target = edgeOnVerticalLine(
      base.bodyRepresentations[resultBodyId],
      30,
      18
    );
    expect(target).toBeTruthy();

    const filleted = filletEdges(document, {
      name: 'Corner fillet',
      targetBodyId: resultBodyId,
      edgeHashes: [target!.hash],
      size: 2
    }).document;
    const filletBodyId = filleted.bodyOrder.at(-1)!;

    const onBrepKit = await adapter.syncDocument(filleted);
    expect(onBrepKit.warnings).toEqual([]);
    const brepkitBody = onBrepKit.bodyRepresentations[filletBodyId];
    // The sharp corner line is gone; the nearest blend geometry stays ~0.59
    // from the old corner line, so nothing may remain within 0.3 of it.
    expect(hasEdgePointNearLine(brepkitBody, 30, 18, 0.3)).toBe(false);
    // The other intact corner survives untouched.
    expect(edgeOnVerticalLine(brepkitBody, 30, 0)).toBeTruthy();

    // Reroute to OpenCascade: the same persisted hash must land on the same
    // geometric edge — asserted by position, not by success.
    const onOcct = await adapter.syncDocument(
      addStepImport(filleted, referenceStep)
    );
    expect(onOcct.warnings).toEqual([]);
    const occtBody = onOcct.bodyRepresentations[filletBodyId];
    expect(hasEdgePointNearLine(occtBody, 30, 18, 0.3)).toBe(false);
    expect(edgeOnVerticalLine(occtBody, 30, 0)).toBeTruthy();
    expect(
      Math.abs(occtBody!.volume - brepkitBody!.volume) / brepkitBody!.volume
    ).toBeLessThan(0.005);

    // Adversarial upstream edit: widening the cutter shifts edge enumeration
    // but leaves the filleted edge's geometry identical. Under a positional
    // scheme the fillet silently lands elsewhere; under the geometric scheme
    // it must stay at (30, 18) — on both kernels.
    const cutterFeature = listFeaturesInOrder(filleted).find(
      (feature) => feature.name === 'Cutter'
    )!;
    const edited = updateFeature(filleted, {
      featureId: cutterFeature.featureId,
      data: { dimensions: { width: 9 } }
    });
    for (const candidate of [edited, addStepImport(edited, referenceStep)]) {
      const derived = await adapter.syncDocument(candidate);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[filletBodyId];
      expect(hasEdgePointNearLine(body, 30, 18, 0.3)).toBe(false);
      expect(edgeOnVerticalLine(body, 30, 0)).toBeTruthy();
      // The cutter edit landed: the notch is wider than before.
      expect(body!.volume).toBeLessThan(brepkitBody!.volume - 300);
    }
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
      const onOcct = await adapter.syncDocument(
        addStepImport(document, referenceStep)
      );
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
    }
  });

  it('fails closed on an unresolvable fillet hash instead of changing shape', async () => {
    const { document, resultBodyId } = notchedBlockDocument(6);
    const unfilleted = await adapter.syncDocument(document);
    const originalVolume = unfilleted.bodyRepresentations[resultBodyId]!.volume;

    const bogus = filletEdges(document, {
      name: 'Ghost fillet',
      targetBodyId: resultBodyId,
      edgeHashes: [4022250974],
      size: 2
    }).document;

    for (const candidate of [bogus, addStepImport(bogus, referenceStep)]) {
      const derived = await adapter.syncDocument(candidate);
      expect(
        derived.warnings.some(
          (warning) =>
            warning.includes('Ghost fillet') &&
            warning.includes('no longer exists')
        )
      ).toBe(true);
      // The target body still builds, geometrically unchanged — every sharp
      // corner is still present, and no blend was applied anywhere.
      const body = derived.bodyRepresentations[resultBodyId];
      expect(body?.volume).toBeCloseTo(originalVolume, 3);
      expect(edgeOnVerticalLine(body, 30, 18)).toBeTruthy();
      expect(derived.bodyRepresentations[bogus.bodyOrder.at(-1)!]).toBe(
        undefined
      );
    }
  });

  it('rejects legacy positional references from older OCCT documents', async () => {
    const { document, resultBodyId } = notchedBlockDocument(6);
    // Documents saved by the old OCCT scheme persisted 1-based traversal
    // ordinals. Interpreting 3 as "the third edge" would silently fillet an
    // arbitrary edge; it must instead fail closed with a clear message.
    const legacy = filletEdges(document, {
      name: 'Legacy fillet',
      targetBodyId: resultBodyId,
      edgeHashes: [3],
      size: 2
    }).document;

    for (const candidate of [legacy, addStepImport(legacy, referenceStep)]) {
      const derived = await adapter.syncDocument(candidate);
      expect(
        derived.warnings.some(
          (warning) =>
            warning.includes('Legacy fillet') && /older version/i.test(warning)
        )
      ).toBe(true);
      // No edge anywhere was filleted: all original corners remain sharp.
      const body = derived.bodyRepresentations[resultBodyId];
      expect(edgeOnVerticalLine(body, 30, 18)).toBeTruthy();
      expect(edgeOnVerticalLine(body, 30, 0)).toBeTruthy();
      expect(edgeOnVerticalLine(body, 0, 18)).toBeTruthy();
    }
  });

  it('still resolves closed-edge hashes persisted by the previous BrepKit scheme', async () => {
    // Pre-unification BrepKit fingerprinted a full circle from its seam
    // vertex and mid-parameter point. For BrepKit's circle convention (seam
    // at +X of the frame, curve phase +90°) the rim of makeCylinder(5, 12)
    // at z=0 hashed exactly this signature. Documents persisted such hashes;
    // they must keep resolving. If BrepKit ever changes its parameterization
    // this pin breaks loudly — that is the point.
    const quantum = (value: number): number => Math.round(value / 1e-6);
    const legacyHash = fnv(
      [
        'CIRCLE',
        quantum(2 * Math.PI * 5),
        quantum(5),
        quantum(0),
        quantum(0),
        quantum(5),
        quantum(0),
        quantum(0),
        quantum(0),
        quantum(-5),
        quantum(0)
      ].join(':')
    );

    const document = addPrimitiveFeature(
      createProjectDocument('Legacy rim', user),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 12 }
      }
    );
    const filleted = filletEdges(document, {
      name: 'Rim fillet',
      targetBodyId: document.bodyOrder[0]!,
      edgeHashes: [legacyHash],
      size: 1
    }).document;
    const derived = await adapter.syncDocument(filleted);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[filleted.bodyOrder.at(-1)!];
    expect(body?.volume).toBeGreaterThan(900);
    expect(body?.volume).toBeLessThan(941);
  });

  it('exports multi-body STEP as distinct solids without fusing', async () => {
    const withFirst = addPrimitiveFeature(
      createProjectDocument('Two bodies', user),
      {
        name: 'First',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const firstId = withFirst.bodyOrder.at(-1)!;
    const withSecond = addPrimitiveFeature(withFirst, {
      name: 'Second',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const secondId = withSecond.bodyOrder.at(-1)!;
    const document = transformBody(withSecond, {
      name: 'Overlap second',
      targetBodyId: secondId,
      translation: { x: 5, y: 5, z: 5 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;

    const step = await adapter.exportStep(document, [firstId, secondId]);
    expect(step.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(2);
    // Two overlapping 1000 mm³ boxes: distinct solids measure 2000; a fused
    // export would measure the union, 1875.
    const inspection = await adapter.inspectStep(step);
    expect(inspection.solid).toBe(true);
    expect(inspection.volume).toBeCloseTo(2000, 3);
  });

  it('scales exact-path STL exports to millimetres for inch documents', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Inch part', user, 'inch'),
      {
        name: 'Inch box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 2, depth: 3 }
      }
    );
    const stl = await adapter.exportStl(document, [document.bodyOrder[0]!]);
    const vertices = asciiStlVertices(stl);
    expect(vertices.length).toBeGreaterThan(0);
    expect(Math.max(...vertices.map((vertex) => vertex[0]!))).toBeCloseTo(
      25.4,
      6
    );
    expect(Math.max(...vertices.map((vertex) => vertex[1]!))).toBeCloseTo(
      50.8,
      6
    );
    expect(Math.max(...vertices.map((vertex) => vertex[2]!))).toBeCloseTo(
      76.2,
      6
    );
  });

  it('scales compatibility-path STL exports to millimetres for inch documents', () => {
    const compat = createKernelAdapter();
    const document = addPrimitiveFeature(
      createProjectDocument('Inch mesh part', user, 'inch'),
      {
        name: 'Inch box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 2, depth: 3 }
      }
    );
    const stl = compat.exportStl(document, [document.bodyOrder[0]!]);
    const vertices = asciiStlVertices(stl);
    expect(vertices.length).toBeGreaterThan(0);
    expect(Math.max(...vertices.map((vertex) => vertex[2]!))).toBeCloseTo(
      76.2,
      6
    );
  });

  it('routes imported-mesh documents through a millimetre-scaled STL export', async () => {
    const tetrahedron = {
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]
    };
    const { document } = importMeshBody(
      createProjectDocument('Inch mesh', user, 'inch'),
      {
        name: 'Tetra',
        artifactId: 'artifact_tetra',
        sourceName: 'tetra.stl',
        triangleCount: 4,
        ...tetrahedron
      }
    );
    const stl = await adapter.exportStl(document, [document.bodyOrder[0]!]);
    const vertices = asciiStlVertices(stl);
    expect(vertices.length).toBeGreaterThan(0);
    expect(Math.max(...vertices.map((vertex) => vertex[0]!))).toBeCloseTo(
      25.4,
      6
    );
  });

  it('emits one ASCII STL solid block for multi-body exports', async () => {
    const withFirst = addPrimitiveFeature(
      createProjectDocument('STL pair', user),
      {
        name: 'First',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const firstId = withFirst.bodyOrder.at(-1)!;
    const withSecond = addPrimitiveFeature(withFirst, {
      name: 'Second',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const secondId = withSecond.bodyOrder.at(-1)!;
    const document = transformBody(withSecond, {
      name: 'Separate second',
      targetBodyId: secondId,
      translation: { x: 30, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;

    const stl = await adapter.exportStl(document, [firstId, secondId]);
    // Consumers that read only the first `solid` block must still see every
    // body, so multi-body exports concatenate facets into a single block.
    expect(stl.match(/^solid /gm)).toHaveLength(1);
    expect(stl.match(/^endsolid /gm)).toHaveLength(1);
    expect(stl.match(/facet normal/g)).toHaveLength(24);
    const vertices = asciiStlVertices(stl);
    expect(Math.max(...vertices.map((vertex) => vertex[0]!))).toBeCloseTo(
      40,
      6
    );
  });
});
