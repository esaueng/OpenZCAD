import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FeatureId,
  type EdgeWitnessV1,
  type FaceWitnessV1
} from '@openzcad/shared';
import { quantizeCoordinate } from '../../packages/kernel-adapter/src/topology-fingerprint';
import {
  canonicalCylinderWitness,
  canonicalPlaneWitness,
  propagateRigidTransformLineage,
  quantizedTopologyPoint,
  transformOcctWitness
} from './occt-reference/occt-lineage';
import { topologyHashOfWitness } from '../../packages/kernel-adapter/src/topology-lineage';
import { OcctStepKernelAdapter } from './occt-reference/occt-step';

/**
 * M10: a Move that scales about a pivot builds the same solid in both exact
 * kernels — the OCCT reference applies L = scale·R and p − L·p as well.
 */
describe('transform scale about a pivot across exact kernels', () => {
  let remus: ExactKernelAdapter;
  let occt: OcctStepKernelAdapter;
  beforeAll(async () => {
    remus = await createExactKernelAdapter();
    occt = await OcctStepKernelAdapter.create();
  });
  afterAll(() => {
    remus.dispose();
    occt.dispose();
  });

  it.each([
    ['scale only', { x: 0, y: 0, z: 0 }, [-10, -5, -5], [30, 15, 15]],
    ['turn and scale', { x: 0, y: 0, z: 90 }, [0, -15, -5], [20, 25, 15]]
  ] as const)(
    '%s ×2 about the body centre',
    async (_label, rotationDeg, min, max) => {
      // A 20 × 10 × 10 block from the origin: centre (10, 5, 5).
      const document = addPrimitiveFeature(
        createProjectDocument('Pivot scale parity', toUserId('user_m10')),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 20, height: 10, depth: 10 }
        }
      );
      const blockId = document.bodyOrder[0] as BodyId;
      const scaled = transformBody(document, {
        name: 'Grow',
        targetBodyId: blockId,
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg,
        scale: 2,
        // Suffixed, as the Move form accepts: both kernels read document units.
        pivot: { x: '1 cm', y: '5 mm', z: '0.5 cm' }
      }).document;
      for (const adapter of [remus, occt]) {
        const derived = await adapter.syncDocument(scaled);
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[blockId]!;
        expect(body.volume).toBeCloseTo(16_000, 6);
        expect(body.bbox.min.x).toBeCloseTo(min[0], 6);
        expect(body.bbox.min.y).toBeCloseTo(min[1], 6);
        expect(body.bbox.min.z).toBeCloseTo(min[2], 6);
        expect(body.bbox.max.x).toBeCloseTo(max[0], 6);
        expect(body.bbox.max.y).toBeCloseTo(max[1], 6);
        expect(body.bbox.max.z).toBeCloseTo(max[2], 6);
      }
    }
  );
});

describe('OCCT reference witnesses under a uniform scale', () => {
  it('grows lengths, perimeters, radii and plane offsets by the scale', () => {
    // ×2 about the origin: the linear block is 2·I, no translation.
    const matrix = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0];
    const cylinder: FaceWitnessV1 = {
      surfaceType: 'cylinder',
      perimeter: quantizeCoordinate(40),
      centroid: quantizedTopologyPoint({ x: 0, y: 0, z: 5 }),
      analytic: canonicalCylinderWitness(
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
        5
      ),
      closure: { u: 'closed', v: 'open' }
    };
    const scaled = transformOcctWitness('face', cylinder, matrix);
    expect(scaled.perimeter).toBe(quantizeCoordinate(80));
    expect(scaled.analytic).toEqual(
      canonicalCylinderWitness({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 10)
    );
    const plane: FaceWitnessV1 = {
      ...cylinder,
      surfaceType: 'plane',
      analytic: canonicalPlaneWitness({ x: 0, y: 0, z: 1 }, 10)
    };
    expect(transformOcctWitness('face', plane, matrix).analytic).toEqual(
      canonicalPlaneWitness({ x: 0, y: 0, z: 1 }, 20)
    );
    const edge: EdgeWitnessV1 = {
      curveType: 'line',
      length: quantizeCoordinate(10),
      closed: false,
      endpoints: [
        quantizedTopologyPoint({ x: 0, y: 0, z: 0 }),
        quantizedTopologyPoint({ x: 10, y: 0, z: 0 })
      ],
      midpoint: quantizedTopologyPoint({ x: 5, y: 0, z: 0 })
    };
    expect(transformOcctWitness('edge', edge, matrix).length).toBe(
      quantizeCoordinate(20)
    );
  });
});

describe('OCCT reference lineage through a scaled Move', () => {
  it('keeps an edge whose scaled length lands one grid step off', () => {
    // A third quantizes to 333333; ×2 of that is 666666, while the
    // re-measured two-thirds edge quantizes to 666667.
    const edge = (length: number, x: number): EdgeWitnessV1 => ({
      curveType: 'line',
      length: quantizeCoordinate(length),
      closed: false,
      endpoints: [
        quantizedTopologyPoint({ x: 0, y: 0, z: 0 }),
        quantizedTopologyPoint({ x, y: 0, z: 0 })
      ],
      midpoint: quantizedTopologyPoint({ x: x / 2, y: 0, z: 0 })
    });
    const source = edge(1 / 3, 1 / 3);
    const measured = edge(2 / 3, 2 / 3);
    const state = propagateRigidTransformLineage(
      {
        status: 'lineage',
        diagnostics: [],
        references: [
          {
            kind: 'edge',
            producingFeatureId: 'feat_edge' as FeatureId,
            lineageName: 'edge:third',
            currentHash: topologyHashOfWitness('edge', source),
            witnessVersion: 1,
            witness: source
          }
        ]
      },
      [
        {
          kind: 'edge',
          currentHash: topologyHashOfWitness('edge', measured),
          witness: measured
        }
      ],
      [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0]
    );
    expect(state.status).toBe('lineage');
    expect(state.diagnostics).toEqual([]);
    expect(state.references).toHaveLength(1);
    // Recorded as measured, so a later exact lookup finds it.
    expect(state.references[0]!.witness).toEqual(measured);
  });
});
