import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * exact kernel builds it. Every persisted reference — region fingerprints,
 * edge and face hashes — and every export path has to either resolve to the
 * same geometry on both kernels or fail closed. These tests are deliberately
 * adversarial: they assert *positions*, not just success, because a positional
 * (ordinal) resolution scheme passes success-only tests while silently editing
 * the wrong geometry.
 *
 * There is one exact kernel now, so "the seam" is no longer a seam between
 * two kernels. Z3 made BrepKit build every document, imported STEP included,
 * and Z5 deleted OpenCascade from the adapter; the cross-kernel leg of each
 * case went with it. What these tests still hold is the seam that remains and
 * that regressions actually crossed:
 *
 *   - a persisted reference must resolve to the same GEOMETRY, asserted by
 *     position, or fail closed by name — never land silently elsewhere;
 *   - `withImport` — the same document with an imported body ALONGSIDE the
 *     modelled one. Before Z3 this was indistinguishable from the OCCT leg;
 *     it is now the mixed-document case in its own right, and an import must
 *     not disturb what its neighbours resolve to.
 *
 * Bulk cross-kernel comparison lives on in the parity corpus
 * (`test/parity/`), which still measures BrepKit against OpenCascade file by
 * file. This suite no longer does.
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

// Real-kernel suite: the kernel starts up here, well past the 5 s default
// when the whole test pool is contending for CPU.
describe('kernel seam correctness', { timeout: 30_000 }, () => {
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

  it('keeps a region-extrude hole beside a STEP import', async () => {
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

    // The hole must not silently disappear when an imported body joins the
    // document (the historic failure sweeps the rectangle's whole profile:
    // volume 12000 instead of ~9989).
    const withStep = addStepImport(document, referenceStep);
    {
      const derived = await adapter.syncDocument(withStep);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId];
      expect(
        Math.abs((body?.volume ?? 0) - exactVolume) / exactVolume
      ).toBeLessThan(0.005);
      expect(
        body?.topology?.faces.some(
          (face) => face.geometry?.surfaceType === 'cylinder'
        )
      ).toBe(true);
    }

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

  it('fails closed naming the feature when a region cannot be resolved', async () => {
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
    for (const derived of [
      await adapter.syncDocument(document),
      await adapter.syncDocument(addStepImport(document, referenceStep))
    ]) {
      expect(
        derived.warnings.some(
          (warning) =>
            warning.includes('Ghost extrude') &&
            warning.includes('Broken profile reference')
        )
      ).toBe(true);
      // Never the fallback shape: the body must be absent, not the whole disk.
      expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
    }
  });

  it('keeps a fillet on the same geometric edge across upstream edits', async () => {
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

    // Adversarial upstream edit: widening the cutter shifts edge enumeration
    // but leaves the filleted edge's geometry identical. Under a positional
    // scheme the fillet silently lands elsewhere; under the geometric scheme
    // it must stay at (30, 18).
    const cutterFeature = listFeaturesInOrder(filleted).find(
      (feature) => feature.name === 'Cutter'
    )!;
    const edited = updateFeature(filleted, {
      featureId: cutterFeature.featureId,
      data: { dimensions: { width: 9 } }
    });
    for (const derived of [
      await adapter.syncDocument(edited),
      await adapter.syncDocument(addStepImport(edited, referenceStep))
    ]) {
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[filletBodyId];
      expect(hasEdgePointNearLine(body, 30, 18, 0.3)).toBe(false);
      expect(edgeOnVerticalLine(body, 30, 0)).toBeTruthy();
      // The cutter edit landed: the notch is wider than before.
      expect(body!.volume).toBeLessThan(brepkitBody!.volume - 300);
    }
  });

  it('fails closed on an edge pick an imported body no longer publishes', async () => {
    // The Z3 migration case, and the one that decides whether the flip is
    // safe for documents that already exist. Until Z3, a document with a STEP
    // import was built by OpenCascade, so any edge or face the user picked
    // was stored against that kernel's topology. BrepKit builds those
    // documents now.
    //
    // On analytic planar imports the two kernels published the SAME hashes
    // and nothing changed. They diverged on periodic surfaces: for this cone
    // OpenCascade published three edges to BrepKit's two (the seam-edge pin
    // in corpus-pins.ts, owner K0.6), and BrepKit's two were a subset — so a
    // pick on that extra seam edge has no counterpart after the flip. Z5
    // deleted the kernel that could still produce the orphan hash, so the
    // absent pick is now stated directly; the corpus keeps the seam-count
    // divergence itself under measurement.
    //
    // The requirement is not that it resolves. It is that it REFUSES: names
    // the feature, drops the result body, and leaves the imported body intact
    // at its correct size. A stale pick silently landing on a neighbouring
    // edge is the failure this whole identity scheme exists to prevent.
    const source = addPrimitiveFeature(
      createProjectDocument('Cone source', user),
      {
        name: 'Cone',
        primitiveKind: 'cone',
        dimensions: { bottomRadius: 10, topRadius: 0, height: 10 }
      }
    );
    const coneStep = await adapter.exportStep(source, [source.bodyOrder[0]!]);
    const { document, bodyId } = importStepBody(
      createProjectDocument('Imported cone', user),
      {
        name: 'Imported cone',
        artifactId: 'artifact_seam_cone',
        sourceName: 'cone.step',
        stepText: coneStep
      }
    );

    const onBrepKit = await adapter.syncDocument(document);
    const edges = onBrepKit.bodyRepresentations[bodyId]!.topology!.edges;
    // Pinned: BrepKit publishes two edges for this cone and no seam edge.
    expect(edges).toHaveLength(2);
    const published = new Set(edges.map((edge) => edge.hash));
    const orphan = 2_863_311_530;
    expect(published.has(orphan)).toBe(false);

    const stale = filletEdges(document, {
      name: 'Pre-flip fillet',
      targetBodyId: bodyId,
      edgeHashes: [orphan],
      size: 0.5
    }).document;
    const derived = await adapter.syncDocument(stale);
    expect(derived.warnings).toEqual([
      'Feature "Pre-flip fillet": A selected edge no longer exists. Re-select the edges and re-create this feature.'
    ]);
    expect(
      derived.bodyRepresentations[stale.bodyOrder.at(-1)!]
    ).toBeUndefined();
    // The import itself is untouched: pi * 10^2 * 10 / 3.
    expect(derived.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      (Math.PI * 1000) / 3,
      6
    );
  });

  it('publishes a stable topology count for an imported tessellated body', async () => {
    // The counts are the pin. Until Z5 this test also measured how many of
    // those hashes an OpenCascade-built version of the same import shared
    // (739 of 821 faces, 1,646 of 1,722 edges) — the migration cost of the Z3
    // flip, which has now been paid and cannot be re-measured without the
    // second kernel. What survives is the claim that matters going forward:
    // this body's topology must not silently change size, because every
    // stored pick on it is resolved against exactly these sets.
    const { document, bodyId } = importStepBody(
      createProjectDocument('Bracket', user),
      {
        name: 'Bracket',
        artifactId: 'artifact_seam_bracket',
        sourceName: 'parametric-bracket.step',
        stepText: readFileSync(
          resolve('samples/parametric-bracket.step'),
          'utf8'
        )
      }
    );
    const onBrepKit = await adapter.syncDocument(document);
    const body = onBrepKit.bodyRepresentations[bodyId]!;

    expect(body.topology!.faces).toHaveLength(821);
    expect(body.topology!.edges).toHaveLength(1722);
    // Every published hash is distinct: a collision would make two different
    // picks resolve to the same geometry.
    expect(new Set(body.topology!.faces.map((face) => face.hash)).size).toBe(
      821
    );
    expect(new Set(body.topology!.edges.map((edge) => edge.hash)).size).toBe(
      1722
    );
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

    for (const derived of [
      await adapter.syncDocument(bogus),
      await adapter.syncDocument(addStepImport(bogus, referenceStep))
    ]) {
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

  it('rejects legacy positional references from older documents', async () => {
    const { document, resultBodyId } = notchedBlockDocument(6);
    // Documents saved by the old OpenCascade scheme persisted 1-based
    // traversal ordinals. Interpreting 3 as "the third edge" would silently
    // fillet an arbitrary edge; it must instead fail closed with a clear
    // message.
    const legacy = filletEdges(document, {
      name: 'Legacy fillet',
      targetBodyId: resultBodyId,
      edgeHashes: [3],
      size: 2
    }).document;

    for (const derived of [
      await adapter.syncDocument(legacy),
      await adapter.syncDocument(addStepImport(legacy, referenceStep))
    ]) {
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

  it('scales imported-mesh STL exports to millimetres for inch documents', async () => {
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
