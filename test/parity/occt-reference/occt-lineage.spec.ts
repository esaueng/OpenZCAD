import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  importStepBody,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  toFeatureId,
  toUserId,
  type FaceWitnessV1,
  type TopologyReferenceV5
} from '@openzcad/shared';

import { OcctStepKernelAdapter } from './occt-step';
import {
  importedStepLineageName,
  inspectTopologyWitness
} from '../../../packages/kernel-adapter/src/topology-lineage';
import {
  canonicalPlaneWitness,
  edgeCandidate,
  faceCandidate,
  hashOnlyOcctLineage,
  occtSurfaceClosure,
  propagateRigidTransformLineage,
  quantizedTopologyDirection,
  referenceForOcctCandidate,
  resolveOcctTopologyReference,
  semanticPrimitiveLineage,
  semanticSweepLineage,
  transformOcctWitness,
  type OcctLineageState,
  type OcctTopologyCandidate
} from './occt-lineage';

const DIRECTION = 1_000_000_000;
const FEATURE_ID = toFeatureId('feat_lineage');

function planeFace(
  normal: [number, number, number],
  offset: number,
  centroid: [number, number, number]
): Extract<OcctTopologyCandidate, { kind: 'face' }> {
  return faceCandidate({
    surfaceType: 'plane',
    perimeter: 40_000_000,
    centroid,
    analytic: { kind: 'plane', normal, offset },
    closure: { u: 'open', v: 'open' }
  });
}

function lineEdge(
  start: [number, number, number],
  end: [number, number, number]
): Extract<OcctTopologyCandidate, { kind: 'edge' }> {
  const midpoint: [number, number, number] = [
    (start[0] + end[0]) / 2,
    (start[1] + end[1]) / 2,
    (start[2] + end[2]) / 2
  ];
  return edgeCandidate({
    curveType: 'LINE',
    length:
      Math.abs(end[0] - start[0]) +
      Math.abs(end[1] - start[1]) +
      Math.abs(end[2] - start[2]),
    closed: false,
    endpoints: [start, end],
    midpoint
  });
}

function circleEdge(
  center: [number, number, number]
): Extract<OcctTopologyCandidate, { kind: 'edge' }> {
  return edgeCandidate({
    curveType: 'CIRCLE',
    length: 62_831_853,
    closed: true,
    center,
    axis: [0, 0, DIRECTION]
  });
}

function boxCandidates(
  width = 10_000_000,
  height = 20_000_000,
  depth = 30_000_000
): OcctTopologyCandidate[] {
  const faces: OcctTopologyCandidate[] = [
    planeFace([DIRECTION, 0, 0], 0, [0, height / 2, depth / 2]),
    planeFace([DIRECTION, 0, 0], width, [width, height / 2, depth / 2]),
    planeFace([0, DIRECTION, 0], 0, [width / 2, 0, depth / 2]),
    planeFace([0, DIRECTION, 0], height, [width / 2, height, depth / 2]),
    planeFace([0, 0, DIRECTION], 0, [width / 2, height / 2, 0]),
    planeFace([0, 0, DIRECTION], depth, [width / 2, height / 2, depth])
  ];
  const edges: OcctTopologyCandidate[] = [];
  for (const y of [0, height]) {
    for (const z of [0, depth]) {
      edges.push(lineEdge([0, y, z], [width, y, z]));
    }
  }
  for (const x of [0, width]) {
    for (const z of [0, depth]) {
      edges.push(lineEdge([x, 0, z], [x, height, z]));
    }
  }
  for (const x of [0, width]) {
    for (const y of [0, height]) {
      edges.push(lineEdge([x, y, 0], [x, y, depth]));
    }
  }
  return [...faces, ...edges];
}

function names(state: OcctLineageState): string[] {
  return state.references.map((reference) => reference.lineageName).sort();
}

describe('OCCT lineage contracts', () => {
  it('canonicalizes plane signs after direction quantization', () => {
    const positiveNoise = canonicalPlaneWitness({ x: 1e-12, y: -1, z: 0 }, 5);
    const negativeNoise = canonicalPlaneWitness({ x: -1e-12, y: -1, z: 0 }, 5);

    expect(positiveNoise).toEqual(negativeNoise);
    expect(positiveNoise.normal[1]).toBeGreaterThan(0);
  });

  it('assigns box semantic identities from exact roles, independent of traversal', () => {
    const candidates = boxCandidates();
    const forward = semanticPrimitiveLineage(FEATURE_ID, 'box', candidates);
    const reverse = semanticPrimitiveLineage(
      FEATURE_ID,
      'box',
      [...candidates].reverse()
    );

    expect(forward.status).toBe('lineage');
    expect(forward.references).toHaveLength(18);
    expect(names(forward)).toEqual(names(reverse));
    expect(names(forward)).toContain('primitive.box.face.z-max');
    expect(names(forward)).toContain('primitive.box.edge.x.y-min.z-max');
  });

  it('uses the BrepKit cylinder semantic identity vocabulary', () => {
    const state = semanticPrimitiveLineage(FEATURE_ID, 'cylinder', [
      faceCandidate({
        surfaceType: 'cylinder',
        perimeter: 82_831_853,
        centroid: [0, 0, 5_000_000],
        analytic: {
          kind: 'cylinder',
          axis: [0, 0, DIRECTION],
          axisFoot: [0, 0, 0],
          radius: 10_000_000
        },
        closure: { u: 'closed', v: 'open' }
      }),
      planeFace([0, 0, DIRECTION], 0, [0, 0, 0]),
      planeFace([0, 0, DIRECTION], 10_000_000, [0, 0, 10_000_000]),
      circleEdge([0, 0, 0]),
      circleEdge([0, 0, 10_000_000])
    ]);

    expect(names(state)).toEqual([
      'primitive.cylinder.edge.rim.end',
      'primitive.cylinder.edge.rim.start',
      'primitive.cylinder.face.cap.end',
      'primitive.cylinder.face.cap.start',
      'primitive.cylinder.face.wall'
    ]);
  });

  it('assigns exact extrude caps and semantic source-profile sides', () => {
    expect(quantizedTopologyDirection({ x: 0, y: 0, z: 1 })).toEqual([
      0,
      0,
      DIRECTION
    ]);
    const candidates = [
      planeFace([0, 0, DIRECTION], 0, [5_000_000, 5_000_000, 0]),
      planeFace(
        [0, 0, DIRECTION],
        10_000_000,
        [5_000_000, 5_000_000, 10_000_000]
      ),
      planeFace([DIRECTION, 0, 0], 0, [0, 5_000_000, 5_000_000]),
      planeFace(
        [DIRECTION, 0, 0],
        10_000_000,
        [10_000_000, 5_000_000, 5_000_000]
      ),
      planeFace([0, DIRECTION, 0], 0, [5_000_000, 0, 5_000_000]),
      planeFace(
        [0, DIRECTION, 0],
        10_000_000,
        [5_000_000, 10_000_000, 5_000_000]
      )
    ];
    expect(
      new Set(candidates.map((candidate) => candidate.currentHash)).size
    ).toBe(6);
    expect(
      candidates.map((candidate) =>
        candidate.kind === 'face'
          ? inspectTopologyWitness('face', candidate.witness).status
          : 'edge'
      )
    ).toEqual([
      'supported',
      'supported',
      'supported',
      'supported',
      'supported',
      'supported'
    ]);
    expect(
      candidates.filter(
        (candidate) =>
          candidate.kind === 'face' &&
          candidate.witness.analytic.kind === 'plane' &&
          candidate.witness.analytic.normal.join(',') === `0,0,${DIRECTION}`
      )
    ).toHaveLength(2);
    const state = semanticSweepLineage(
      FEATURE_ID,
      {
        kind: 'extrude',
        sourceKey: 'sketch_rect',
        sourceKind: 'rectangle',
        direction: { x: 0, y: 0, z: 10 },
        sideAnchors: [
          {
            lineageName: 'sweep.face.side.sketch_rect.0',
            midpoint: { x: 0, y: 5, z: 5 }
          },
          {
            lineageName: 'sweep.face.side.sketch_rect.1',
            midpoint: { x: 10, y: 5, z: 5 }
          },
          {
            lineageName: 'sweep.face.side.sketch_rect.2',
            midpoint: { x: 5, y: 0, z: 5 }
          },
          {
            lineageName: 'sweep.face.side.sketch_rect.3',
            midpoint: { x: 5, y: 10, z: 5 }
          }
        ]
      },
      candidates
    );
    if (state.status !== 'lineage') {
      throw new Error('Semantic sweep unexpectedly became hash-only.');
    }
    expect(state.diagnostics).toEqual([]);
    expect(names(state)).toEqual([
      'sweep.face.cap.end.sketch_rect',
      'sweep.face.cap.start.sketch_rect',
      'sweep.face.side.sketch_rect.0',
      'sweep.face.side.sketch_rect.1',
      'sweep.face.side.sketch_rect.2',
      'sweep.face.side.sketch_rect.3'
    ]);
  });

  it('propagates only unique exact rigid-transform witnesses', () => {
    const sourceCandidate = boxCandidates()[0]!;
    const source = semanticPrimitiveLineage(FEATURE_ID, 'box', boxCandidates());
    const matrix = [1, 0, 0, 7, 0, 1, 0, 8, 0, 0, 1, 9];
    const resultCandidates = source.references.map((reference) =>
      reference.kind === 'edge'
        ? edgeCandidate(transformOcctWitness('edge', reference.witness, matrix))
        : faceCandidate(transformOcctWitness('face', reference.witness, matrix))
    );
    const transformed = propagateRigidTransformLineage(
      source,
      resultCandidates,
      matrix
    );
    if (transformed.status !== 'lineage') {
      throw new Error('Semantic transform unexpectedly became hash-only.');
    }

    expect(transformed.references).toHaveLength(source.references.length);
    expect(transformed.diagnostics).toEqual([]);
    expect(names(transformed)).toEqual(names(source));
    expect(sourceCandidate.currentHash).not.toBe(
      resultCandidates[0]?.currentHash
    );

    const missing = propagateRigidTransformLineage(source, [], matrix);
    if (missing.status !== 'lineage') {
      throw new Error('Semantic transform unexpectedly became hash-only.');
    }
    expect(missing.references).toEqual([]);
    expect(missing.diagnostics).toHaveLength(source.references.length);
    expect(
      missing.diagnostics.every((entry) => entry.status === 'unsupported')
    ).toBe(true);
  });

  it('resolves an upstream dimension edit by lineage, not its stale hash', () => {
    const oldCandidates = boxCandidates();
    const storedState = semanticPrimitiveLineage(
      FEATURE_ID,
      'box',
      oldCandidates
    );
    const storedReference = storedState.references.find(
      (reference) =>
        reference.lineageName === 'primitive.box.edge.x.y-min.z-min'
    )!;
    const currentCandidates = boxCandidates(15_000_000);
    const currentState = semanticPrimitiveLineage(
      FEATURE_ID,
      'box',
      currentCandidates
    );

    const resolution = resolveOcctTopologyReference(
      storedReference,
      currentState,
      currentCandidates,
      'fillet'
    );
    expect(resolution).toMatchObject({ status: 'resolved', via: 'lineage' });
    if (resolution.status === 'resolved') {
      expect(resolution.candidate.currentHash).not.toBe(
        storedReference.currentHash
      );
    }
  });

  it('keeps lone closed or unknown B-spline/NURBS faces unsupported', () => {
    for (const weakFace of [
      {
        surfaceType: 'bspline',
        perimeter: 100,
        centroid: [0, 0, 0],
        analytic: { kind: 'none' },
        closure: occtSurfaceClosure('bspline')
      },
      {
        surfaceType: 'nurbs',
        perimeter: 100,
        centroid: [0, 0, 0],
        analytic: { kind: 'none' },
        closure: { u: 'closed', v: 'open' }
      }
    ] satisfies FaceWitnessV1[]) {
      const candidate = faceCandidate(weakFace);
      const state = semanticSweepLineage(
        FEATURE_ID,
        { kind: 'revolve', sourceKey: 'weak' },
        [candidate]
      );
      expect(state.references).toEqual([]);

      const forgedReference: TopologyReferenceV5 = {
        kind: 'face',
        producingFeatureId: FEATURE_ID,
        lineageName: `sweep.face.side.weak.${weakFace.surfaceType}`,
        currentHash: candidate.currentHash,
        witnessVersion: 1,
        witness: weakFace
      };
      expect(
        resolveOcctTopologyReference(
          forgedReference,
          state,
          [candidate],
          'fillet'
        )
      ).toMatchObject({ status: 'failed', reason: 'unsupported-witness' });
    }
  });

  it('never projects lineage across an explicit hash-only boundary', () => {
    const state = hashOnlyOcctLineage('STEP provenance unavailable.');
    expect(
      referenceForOcctCandidate(state, boxCandidates()[0]!)
    ).toBeUndefined();
    expect(state).toEqual({
      status: 'hash-only',
      references: [],
      reason: 'STEP provenance unavailable.'
    });
  });
});

describe('OCCT lineage adapter integration', () => {
  let adapter: OcctStepKernelAdapter;

  beforeAll(async () => {
    adapter = await OcctStepKernelAdapter.create();
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('projects primitive lineage, preserves it through transforms, and marks unsafe outputs hash-only', async () => {
    const box = addPrimitiveFeature(
      createProjectDocument('OCCT lineage', toUserId('user_occt_lineage')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = box.bodyOrder[0]!;
    const primitiveFeature = listFeaturesInOrder(box)[0]!;
    const first = await adapter.syncDocument(box);
    const firstBody = first.bodyRepresentations[bodyId]!;
    const firstReferences = [
      ...(firstBody.topology?.faces.flatMap((face) =>
        face.reference ? [face.reference] : []
      ) ?? []),
      ...(firstBody.topology?.edges.flatMap((edge) =>
        edge.reference ? [edge.reference] : []
      ) ?? [])
    ];
    expect(firstReferences).toHaveLength(18);
    expect(
      firstReferences.every(
        (reference) =>
          reference.producingFeatureId === primitiveFeature.featureId
      )
    ).toBe(true);
    expect(firstBody.topology?.lineageDiagnostics).toBeUndefined();

    const moved = transformBody(box, {
      name: 'Move box',
      targetBodyId: bodyId,
      translation: { x: 7, y: 8, z: 9 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const movedBody = (await adapter.syncDocument(moved)).bodyRepresentations[
      bodyId
    ]!;
    const movedNames = [
      ...(movedBody.topology?.faces.flatMap((face) =>
        face.reference ? [face.reference.lineageName] : []
      ) ?? []),
      ...(movedBody.topology?.edges.flatMap((edge) =>
        edge.reference ? [edge.reference.lineageName] : []
      ) ?? [])
    ].sort();
    expect(movedNames).toEqual(
      firstReferences.map((reference) => reference.lineageName).sort()
    );

    const edgeReference = firstReferences.find(
      (
        reference
      ): reference is Extract<TopologyReferenceV5, { kind: 'edge' }> =>
        reference.kind === 'edge' &&
        reference.lineageName === 'primitive.box.edge.x.y-min.z-min'
    )!;
    const filleted = filletEdges(box, {
      name: 'Fillet after edit',
      targetBodyId: bodyId,
      edgeHashes: [edgeReference.currentHash],
      edgeReferences: [edgeReference],
      size: 0.5
    }).document;
    const edited = updateFeature(filleted, {
      featureId: primitiveFeature.featureId,
      data: { dimensions: { width: 15 } }
    });
    const filletProjection = await adapter.syncDocument(edited);
    expect(filletProjection.warnings).toEqual([]);
    const resultBody =
      filletProjection.bodyRepresentations[edited.bodyOrder.at(-1)!]!;
    expect(resultBody.topology?.lineageDiagnostics).toEqual([
      expect.objectContaining({ kind: 'body', status: 'hash-only' })
    ]);
    expect(
      resultBody.topology?.faces.every((face) => face.reference === undefined)
    ).toBe(true);
  });

  /**
   * K0.6 changed this contract. An imported B-rep is the ROOT of its own
   * lineage rather than a transition out of an earlier one, so the ADR-013
   * rule that imported STEP provenance is hash-only governs provenance THROUGH
   * the import, not identity within it. Every face and edge is named by its own
   * exact ADR-011 witness — the same rule the BrepKit adapter uses, so a pick
   * stored on an imported body resolves to the same identity on either kernel
   * across the Z3 route flip.
   */
  it('names imported STEP topology by its own exact fingerprint', async () => {
    const source = addPrimitiveFeature(
      createProjectDocument('STEP source', toUserId('user_step_source')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 3, height: 4, depth: 5 }
      }
    );
    const step = await adapter.exportStep(source, [source.bodyOrder[0]!]);
    const imported = importStepBody(
      createProjectDocument('STEP boundary', toUserId('user_step_boundary')),
      {
        name: 'Imported',
        artifactId: 'artifact_lineage_boundary',
        sourceName: 'box.step',
        stepText: step
      }
    ).document;
    const body = (await adapter.syncDocument(imported)).bodyRepresentations[
      imported.bodyOrder[0]!
    ]!;
    expect(body.topology?.lineageDiagnostics).toBeUndefined();
    expect(body.topology?.faces).toHaveLength(6);
    for (const face of body.topology?.faces ?? []) {
      expect(face.reference?.producingFeatureId).toBeTruthy();
      expect(face.reference?.currentHash).toBe(face.hash);
      expect(face.reference?.lineageName).toBe(
        importedStepLineageName('face', face.hash)
      );
    }
    for (const edge of body.topology?.edges ?? []) {
      expect(edge.reference?.currentHash).toBe(edge.hash);
      expect(edge.reference?.lineageName).toBe(
        importedStepLineageName('edge', edge.hash)
      );
    }
  });
});
