import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  filletEdges,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  DerivedState,
  EdgeTopology,
  FaceTopology,
  FeatureId,
  ProjectDocument
} from '@openzcad/shared';
import {
  BOOLEAN_EVOLUTION_SKIPPED_NO_REFERENCE,
  booleanEvolutionProbeNeeded,
  deriveBooleanLineage,
  probeBooleanEntityEvolution,
  type BooleanEvolutionOperation
} from '../packages/kernel-adapter/src/exact-boolean-evolution';
import * as evolutionModule from '../packages/kernel-adapter/src/exact-boolean-evolution';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { topologyCandidatesForSolid } from '../packages/kernel-adapter/src/exact-lineage-builders';
import {
  unifyBooleanFaces,
  unifyUnionFaces
} from '../packages/kernel-adapter/src/exact-boolean-helpers';
import {
  createRemusSemanticLineage,
  deriveRemusBooleanCarrierLineage,
  type RemusBooleanOperand,
  type RemusTopologyCandidate
} from '../packages/kernel-adapter/src/remus-lineage';

// The viewport's idle broadcast: it carries a (here empty) lineage demand,
// which is what opts a sync into skipping the probe for unreferenced
// booleans. A sync with no demand always probes.
const IDLE_SYNC = { lineageDemand: [] as BodyId[] };

/**
 * K05 follow-up: the two-operand boolean entity-evolution probe runs only
 * when something downstream could consume face/edge identity from the
 * result. A terminal boolean skips it; a boolean feeding a fillet, a sketch
 * attachment or any other explicit lineage consumer runs it with byte-
 * identical lineage; and a cached carrier-only result is rebuilt with the
 * probe once a referencing feature is appended.
 */

const user = toUserId('user_boolean_lazy_probe');

/** Two overlapping boxes whose planar union the exact pipeline accepts. */
function fusedPlateDocument(): { document: ProjectDocument; bodyId: BodyId } {
  let document = addPrimitiveFeature(
    createProjectDocument('Lazy boolean probe', user),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 24, depth: 10 }
    }
  );
  const plateId = document.bodyOrder[0]!;
  document = addPrimitiveFeature(document, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 12, height: 24, depth: 30 }
  });
  const postId = document.bodyOrder[1]!;
  return {
    ...booleanBodies(document, {
      name: 'Fuse',
      operation: 'union',
      targetBodyIds: [plateId, postId]
    })
  };
}

function booleanFeatureOf(document: ProjectDocument) {
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.data.featureKind === 'boolean'
  )!;
  expect(feature, 'boolean feature').toBeDefined();
  return feature;
}

function edgesOf(derived: DerivedState, bodyId: BodyId): EdgeTopology[] {
  return derived.bodyRepresentations[bodyId]?.topology?.edges ?? [];
}

function facesOf(derived: DerivedState, bodyId: BodyId): FaceTopology[] {
  const body = derived.bodyRepresentations[bodyId];
  expect(body, 'result body').toBeDefined();
  return body!.topology!.faces;
}

/** A plate with a centred pocket, subtracted as a terminal boolean feature. */
function pocketDocument(): { document: ProjectDocument; bodyId: BodyId } {
  let document = addPrimitiveFeature(
    createProjectDocument('Pocket probe', user),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 24, depth: 10 }
    }
  );
  const plateId = document.bodyOrder[0]!;
  document = addPrimitiveFeature(document, {
    name: 'Pocket tool',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 6, depth: 8 }
  });
  const toolId = document.bodyOrder[1]!;
  document = transformBody(document, {
    name: 'Seat tool',
    targetBodyId: toolId,
    translation: { x: 15, y: 9, z: 6 }
  }).document;
  return {
    ...booleanBodies(document, {
      name: 'Pocket',
      operation: 'subtract',
      targetBodyIds: [plateId, toolId]
    })
  };
}

/** A fillet on one referenced edge of the boolean result. */
function filletOneEdge(
  document: ProjectDocument,
  derived: DerivedState,
  bodyId: BodyId
): { document: ProjectDocument; bodyId: BodyId } {
  const edges = edgesOf(derived, bodyId);
  expect(edges.length, 'boolean result edges').toBeGreaterThan(0);
  const target =
    edges.find((edge) => edge.reference?.kind === 'edge') ?? edges[0]!;
  return filletEdges(document, {
    name: 'Round',
    targetBodyId: bodyId,
    edgeHashes: [target.hash],
    ...(target.reference ? { edgeReferences: [target.reference] } : {}),
    size: 1
  });
}

describe('booleanEvolutionProbeNeeded', () => {
  it('is false for a terminal boolean', () => {
    const { document } = fusedPlateDocument();
    expect(
      booleanEvolutionProbeNeeded(document, booleanFeatureOf(document))
    ).toBe(false);
  });

  it('is true when a later fillet picks an edge of the result', () => {
    const { document, bodyId } = fusedPlateDocument();
    const filleted = filletEdges(document, {
      name: 'Round',
      targetBodyId: bodyId,
      edgeHashes: [1],
      size: 1
    });
    expect(
      booleanEvolutionProbeNeeded(filleted.document, booleanFeatureOf(document))
    ).toBe(true);
  });

  it('is false when the later fillet targets an unrelated body', () => {
    const { document } = fusedPlateDocument();
    let other = addPrimitiveFeature(document, {
      name: 'Other',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 5, depth: 5 }
    });
    const otherId = other.bodyOrder.at(-1)!;
    other = filletEdges(other, {
      name: 'Round other',
      targetBodyId: otherId,
      edgeHashes: [1],
      size: 1
    }).document;
    expect(booleanEvolutionProbeNeeded(other, booleanFeatureOf(document))).toBe(
      false
    );
  });

  it('is true when a later sketch attaches to the result face', () => {
    const { document, bodyId } = fusedPlateDocument();
    const { document: withSketch } = addSketchFeature(document, {
      name: 'On the fuse',
      planeRef: {
        type: 'face',
        bodyId,
        faceHash: 1,
        sourceArea: 1,
        sourceCenter: { x: 0, y: 0, z: 0 },
        sourceNormal: { x: 0, y: 0, z: 1 },
        frame: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          zAxis: { x: 0, y: 0, z: 1 }
        }
      },
      objects: [{ objectKind: 'circle', radius: 1, centerX: 0, centerY: 0 }]
    });
    expect(
      findSketch(withSketch, withSketch.sketchOrder.at(-1)!)
    ).toBeDefined();
    expect(
      booleanEvolutionProbeNeeded(withSketch, booleanFeatureOf(document))
    ).toBe(true);
  });

  it('is false when a later transform merely carries the result', () => {
    const { document, bodyId } = fusedPlateDocument();
    const moved = transformBody(document, {
      name: 'Move',
      targetBodyId: bodyId,
      translation: { x: 5, y: 0, z: 0 }
    });
    expect(
      booleanEvolutionProbeNeeded(moved.document, booleanFeatureOf(document))
    ).toBe(false);
  });

  it('is true through a carried chain that ends in a fillet', () => {
    const { document, bodyId } = fusedPlateDocument();
    const moved = transformBody(document, {
      name: 'Move',
      targetBodyId: bodyId,
      translation: { x: 5, y: 0, z: 0 }
    });
    const filleted = filletEdges(moved.document, {
      name: 'Round',
      targetBodyId: moved.bodyId,
      edgeHashes: [1],
      size: 1
    });
    expect(
      booleanEvolutionProbeNeeded(filleted.document, booleanFeatureOf(document))
    ).toBe(true);
  });

  it('fails closed on a forged unknown downstream feature kind', () => {
    const { document } = fusedPlateDocument();
    const feature = booleanFeatureOf(document);
    const forged = {
      ...document,
      nodes: {
        ...document.nodes,
        forged: {
          id: 'forged',
          kind: 'feature',
          name: 'Forged',
          parentId: null,
          revisionId: null,
          featureId: 'feature_forged',
          featureKind: 'lathe',
          data: { featureKind: 'lather' }
        }
      },
      featureOrder: [...document.featureOrder, 'feature_forged' as never]
    } as unknown as ProjectDocument;
    expect(booleanEvolutionProbeNeeded(forged, feature)).toBe(true);
  });

  it('is false for non-boolean features', () => {
    const { document } = fusedPlateDocument();
    const primitive = listFeaturesInOrder(document)[0]!;
    expect(booleanEvolutionProbeNeeded(document, primitive)).toBe(false);
  });
});

describe('lazy boolean evolution probe', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => {
    adapter.dispose();
  });

  it('skips the probe for a history ending in a boolean', async () => {
    const { document, bodyId } = fusedPlateDocument();
    const spy = vi.spyOn(evolutionModule, 'probeBooleanEntityEvolution');
    try {
      spy.mockClear();
      const derived = await adapter.syncDocument(document, undefined, undefined, undefined, IDLE_SYNC);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[bodyId]).toBeDefined();
      expect(spy).not.toHaveBeenCalled();
      const diagnostics =
        derived.bodyRepresentations[bodyId]?.topology?.lineageDiagnostics ?? [];
      expect(
        diagnostics.some((entry) =>
          entry.message.includes(BOOLEAN_EVOLUTION_SKIPPED_NO_REFERENCE)
        )
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('runs the probe for a boolean followed by a fillet, unchanged', async () => {
    const { document, bodyId } = fusedPlateDocument();
    const first = await adapter.syncDocument(document, undefined, undefined, undefined, IDLE_SYNC);
    expect(first.warnings).toEqual([]);
    const { document: filleted, bodyId: roundedId } = filletOneEdge(
      document,
      first,
      bodyId
    );
    const spy = vi.spyOn(evolutionModule, 'probeBooleanEntityEvolution');
    try {
      spy.mockClear();
      const derived = await adapter.syncDocument(filleted, undefined, undefined, undefined, IDLE_SYNC);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[roundedId]).toBeDefined();
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      const rounded = derived.bodyRepresentations[roundedId]!;
      for (const edge of rounded.topology?.edges ?? []) {
        if (edge.reference) {
          expect(edge.reference.currentHash).toBe(edge.hash);
        }
      }
      expect(
        (rounded.topology?.lineageDiagnostics ?? []).some((entry) =>
          entry.message.includes(BOOLEAN_EVOLUTION_SKIPPED_NO_REFERENCE)
        )
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('probes once a referencing feature is added after a cached skip', async () => {
    const caching = await createExactKernelAdapter();
    try {
      const { document, bodyId } = fusedPlateDocument();
      const spy = vi.spyOn(evolutionModule, 'probeBooleanEntityEvolution');
      try {
        spy.mockClear();
        const first = await caching.syncDocument(document, undefined, undefined, undefined, IDLE_SYNC);
        expect(first.warnings).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
        const { document: filleted, bodyId: roundedId } = filletOneEdge(
          document,
          first,
          bodyId
        );
        spy.mockClear();
        const second = await caching.syncDocument(filleted, undefined, undefined, undefined, IDLE_SYNC);
        expect(second.warnings).toEqual([]);
        expect(second.bodyRepresentations[roundedId]).toBeDefined();
        expect(spy.mock.calls.length).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    } finally {
      caching.dispose();
    }
  });

  it('recorded carrier-phase references resolve identically after enrichment', async () => {
    const { document, bodyId } = pocketDocument();
    const spy = vi.spyOn(evolutionModule, 'probeBooleanEntityEvolution');
    try {
      spy.mockClear();
      const carrierDerived = await adapter.syncDocument(document, undefined, undefined, undefined, IDLE_SYNC);
      expect(carrierDerived.warnings).toEqual([]);
      const carrierBody = carrierDerived.bodyRepresentations[bodyId]!;
      expect(carrierBody, 'pocket body').toBeDefined();
      expect(
        spy,
        'probe skipped while the pocket is terminal'
      ).not.toHaveBeenCalled();

      // Record exactly what the UI persists: the face v5 reference and the
      // edge fingerprint. Carrier publishes no boolean edge names, so a
      // hash-only pick is the UI path for the edge.
      const floor = facesOf(carrierDerived, bodyId).find(
        (face) =>
          face.reference?.kind === 'face' &&
          face.geometry?.surfaceType === 'plane' &&
          Math.abs((face.geometry.normal?.z ?? 0) - 1) < 1e-9 &&
          Math.abs(face.geometry.center.z - 6) < 1e-9
      );
      expect(floor?.reference, 'carrier-named pocket floor').toBeDefined();
      const recordedFace = structuredClone(floor!.reference!);
      const recordedCenter = { ...floor!.geometry!.center };
      const recordedArea = floor!.geometry!.area;
      expect(recordedArea).toBeCloseTo(10 * 6, 6);
      const outer = edgesOf(carrierDerived, bodyId)
        .filter((edge) => (edge.length ?? 0) > 39)
        .sort((a, b) => (b.length ?? 0) - (a.length ?? 0))[0];
      expect(outer, 'outer plate edge').toBeDefined();
      expect(
        outer!.reference,
        'carrier publishes no boolean edge names'
      ).toBeUndefined();
      const recordedEdgeHash = outer!.hash;

      // The hole consumes the recorded face reference, so this rebuild must
      // run the probe the terminal build skipped.
      const bored = holeBody(document, {
        name: 'Drain',
        targetBodyId: bodyId,
        faceHash: floor!.hash,
        faceReference: structuredClone(recordedFace),
        style: 'simple',
        diameter: 3,
        depthMode: 'through',
        position: { u: 0, v: 0 },
        positionAnchor: 'centroid'
      });
      spy.mockClear();
      const holed = await adapter.syncDocument(bored.document, undefined, undefined, undefined, IDLE_SYNC);
      expect(holed.warnings).toEqual([]);
      expect(
        spy.mock.calls.length,
        'probe runs once the hole references the result'
      ).toBeGreaterThan(0);
      const drain = holed.bodyRepresentations[bored.bodyId]!;
      expect(drain, 'hole body').toBeDefined();
      // The carrier-phase reference resolved to the recorded face: the bore
      // axis passes through the recorded centroid, and material is gone.
      expect((drain.bbox.min.x + drain.bbox.max.x) / 2).toBeCloseTo(
        recordedCenter.x,
        4
      );
      expect((drain.bbox.min.y + drain.bbox.max.y) / 2).toBeCloseTo(
        recordedCenter.y,
        4
      );
      expect(drain.volume).toBeLessThan(carrierBody.volume);

      // The recorded edge survives the hole elsewhere on the body, then the
      // fillet consumes exactly it.
      const preFillet = holed.bodyRepresentations[bored.bodyId]!;
      expect(
        preFillet.topology!.edges.some(
          (edge) => edge.hash === recordedEdgeHash
        ),
        'recorded edge still present after the hole'
      ).toBe(true);
      const rounded = filletEdges(bored.document, {
        name: 'Ease',
        targetBodyId: bored.bodyId,
        edgeHashes: [recordedEdgeHash],
        size: 1
      });
      const finished = await adapter.syncDocument(rounded.document, undefined, undefined, undefined, IDLE_SYNC);
      expect(finished.warnings).toEqual([]);
      const eased = finished.bodyRepresentations[rounded.bodyId]!;
      expect(eased, 'fillet body').toBeDefined();
      expect(
        eased.topology!.edges.some((edge) => edge.hash === recordedEdgeHash),
        'recorded edge consumed by the blend'
      ).toBe(false);
      expect(
        eased.topology!.faces.some(
          (face) => face.geometry?.surfaceType === 'cylinder'
        ),
        'blend face left behind'
      ).toBe(true);
      expect(eased.volume).toBeLessThan(drain.volume);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Reference stability under enrichment, at the kernel level on identical
 * handles: every face name the carrier rule publishes must survive the
 * reconciled lineage once the probe runs. A carrier name the enrichment
 * withdrew would silently break a reference the UI recorded while the
 * boolean was terminal — v5 resolution is lineage-identity only, with no
 * hash fallback — so this pins the stability the lazy probe depends on.
 */
describe('carrier names survive enrichment', () => {
  const STABILITY_ID = 'feature_enrich_stability' as FeatureId;

  function rowMajor(tx: number, ty: number, tz: number): Float64Array {
    return new Float64Array([
      1,
      0,
      0,
      tx,
      0,
      1,
      0,
      ty,
      0,
      0,
      1,
      tz,
      0,
      0,
      0,
      1
    ]);
  }

  /** Operand lineage exactly as buildBooleanFeature measures it: no roles. */
  function nameAllOperands(
    kernel: RemusKernel,
    solids: readonly number[],
    prefix: string
  ): RemusBooleanOperand[] {
    return solids.map((solid, index) => {
      const candidates = topologyCandidatesForSolid(kernel, solid);
      return {
        candidates,
        lineage: createRemusSemanticLineage(
          STABILITY_ID,
          'primitive',
          candidates.map(
            (candidate: RemusTopologyCandidate, ordinal: number) => ({
              ...candidate,
              lineageName: `${prefix}${index}.${candidate.kind}.${ordinal}`
            })
          )
        )
      };
    });
  }

  function checkCase(input: {
    readonly label: string;
    readonly operation: BooleanEvolutionOperation;
    readonly makeOperands: (kernel: RemusKernel) => readonly [number, number];
    readonly produce: (kernel: RemusKernel, a: number, b: number) => number;
    readonly unify: (kernel: RemusKernel, solid: number) => number;
  }): { accepted: boolean; dropped: string[]; disagreements: number } {
    const kernel = new RemusKernel();
    const [a, b] = input.makeOperands(kernel);
    const operands = nameAllOperands(kernel, [a, b], 'op');
    const shipped = input.unify(kernel, input.produce(kernel, a, b));
    const resultCandidates = topologyCandidatesForSolid(kernel, shipped);
    const carrier = deriveRemusBooleanCarrierLineage({
      producingFeatureId: STABILITY_ID,
      operands,
      resultCandidates
    });
    const evidence = probeBooleanEntityEvolution({
      kernel,
      operation: input.operation,
      a,
      b,
      shipped,
      unify: (candidate) => input.unify(kernel, candidate),
      operands
    });
    const full = deriveBooleanLineage({
      evidence,
      producingFeatureId: STABILITY_ID,
      operands,
      resultCandidates
    });
    // Carrier publishes faces only; evolution edge names are pure additions.
    expect(carrier.edgeReferences.size, `${input.label}: carrier edges`).toBe(
      0
    );
    const dropped: string[] = [];
    for (const [handle, reference] of carrier.faceReferences) {
      if (
        full.faceReferences.get(handle)?.lineageName !== reference.lineageName
      ) {
        dropped.push(
          `${input.label}: face ${handle} lost ${reference.lineageName}`
        );
      }
    }
    const disagreements = full.diagnostics.filter(
      (entry) => entry.code === 'boolean-evolution-disagreement'
    ).length;
    return { accepted: evidence.evolution !== null, dropped, disagreements };
  }

  it('keeps every carrier face name on cut and fuse geometries', () => {
    const cut = (kernel: RemusKernel, a: number, b: number) => kernel.cut(a, b);
    const fuse = (kernel: RemusKernel, a: number, b: number) =>
      kernel.fuseAll(Uint32Array.from([a, b]));
    const results = [
      checkCase({
        label: 'box pocket cut',
        operation: 'cut',
        makeOperands: (kernel) => {
          const plate = kernel.makeBox(40, 24, 10);
          const tool = kernel.makeBox(10, 6, 8);
          kernel.transformSolid(tool, rowMajor(15, 9, 6));
          return [plate, tool];
        },
        produce: cut,
        unify: (kernel, solid) => unifyBooleanFaces(kernel, solid)
      }),
      checkCase({
        label: 'box overlap fuse',
        operation: 'fuse',
        makeOperands: (kernel) => [
          kernel.makeBox(40, 24, 10),
          kernel.makeBox(12, 24, 30)
        ],
        produce: fuse,
        unify: (kernel, solid) => unifyUnionFaces(kernel, solid)
      }),
      checkCase({
        label: 'cylinder boss fuse',
        operation: 'fuse',
        makeOperands: (kernel) => {
          const plate = kernel.makeBox(40, 24, 10);
          const boss = kernel.makeCylinder(4, 8);
          kernel.transformSolid(boss, rowMajor(10, 12, 10));
          return [plate, boss];
        },
        produce: fuse,
        unify: (kernel, solid) => unifyUnionFaces(kernel, solid)
      }),
      checkCase({
        label: 'stepped cylinder fuse',
        operation: 'fuse',
        makeOperands: (kernel) => {
          const base = kernel.makeCylinder(20, 5);
          const post = kernel.makeCylinder(5, 20);
          kernel.transformSolid(post, rowMajor(0, 0, 5));
          return [base, post];
        },
        produce: fuse,
        unify: (kernel, solid) => unifyUnionFaces(kernel, solid)
      })
    ];
    // Non-vacuous: the pocket cut is the pinned accepted-probe case, so at
    // least one geometry exercises the reconciled path rather than the
    // declined-probe fallback.
    expect(
      results.some((result) => result.accepted),
      'at least one probe accepted'
    ).toBe(true);
    expect(results.flatMap((result) => result.dropped)).toEqual([]);
  });
});
