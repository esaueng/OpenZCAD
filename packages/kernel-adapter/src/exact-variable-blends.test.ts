import { beforeEach, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  listNodesByKind
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type FeatureData,
  type ProjectDocument
} from '@openzcad/shared';
import { RemusKernel } from './remus-runtime';
import { createExactKernelAdapter } from './exact';
import {
  assertQualifiedVariableFillet,
  variableBlendRefusalMessage,
  variableFilletRequest
} from './exact-variable-blends';

const user = toUserId('user_variable_blend');

/** The data of the feature this document most recently appended. */
function lastFeatureData(document: ProjectDocument): FeatureData {
  const features = listNodesByKind(document, 'feature');
  return features[features.length - 1]!.data;
}
const DEFLECTION = 0.001;

/**
 * Material a rolling-ball fillet takes out of one convex right-angle edge,
 * per unit of edge length, at radius `r`: the square corner minus the quarter
 * disc that replaces it.
 */
const CORNER_AREA_COEFFICIENT = 1 - Math.PI / 4;

/**
 * Volume the same fillet removes from a straight right-angle edge of length
 * `length` when the radius runs from `start` to `end` under `law`.
 *
 * The removed area goes as r², so this is not the constant fillet at the
 * average radius — a law that spends any time away from the mean removes
 * MORE than the mean's constant blend does. That difference is the whole
 * point of the feature and is what the tests below measure.
 */
function removedVolumeOracle(
  start: number,
  end: number,
  length: number,
  law: 'linear' | 'scurve'
): number {
  const samples = 20_000;
  let integral = 0;
  for (let index = 0; index < samples; index += 1) {
    const t = (index + 0.5) / samples;
    const blend = law === 'linear' ? t : t * t * (3 - 2 * t);
    const radius = start + (end - start) * blend;
    integral += radius * radius;
  }
  return (integral / samples) * length * CORNER_AREA_COEFFICIENT;
}

function verticalEdgeOf(kernel: RemusKernel, solid: number): number {
  const edges = Array.from(kernel.getSolidEdges(solid));
  const vertical = edges.filter((edge) => {
    const ends = Array.from(kernel.getEdgeVertices(edge));
    return (
      Math.abs(ends[0]! - ends[3]!) < 1e-9 && Math.abs(ends[1]! - ends[4]!) < 1e-9
    );
  });
  if (vertical.length !== 4) {
    throw new Error(`Expected four vertical edges and found ${vertical.length}.`);
  }
  return vertical[0]!;
}

function faceAreasByNormal(
  kernel: RemusKernel,
  solid: number
): Map<string, number> {
  const areas = new Map<string, number>();
  for (const face of Array.from(kernel.getSolidFaces(solid))) {
    const normal = Array.from(kernel.getFaceNormal(face), (component) =>
      component.toFixed(6)
    ).join(',');
    areas.set(face.toString(), kernel.faceArea(face, DEFLECTION));
    areas.set(normal, (areas.get(normal) ?? 0) + kernel.faceArea(face, DEFLECTION));
  }
  return areas;
}

function normalKeyOf(kernel: RemusKernel, face: number): string {
  return Array.from(kernel.getFaceNormal(face), (component) =>
    component.toFixed(6)
  ).join(',');
}

/**
 * Variable-radius fillets and asymmetric chamfers, measured rather than
 * assumed.
 *
 * Remus ships both behind an experimental blend surface, and one of them
 * fails in a way no type or schema can catch: `filletVariable` answers a
 * radius law it does not recognize with a silent CONSTANT blend instead of a
 * refusal. The first group below pins that behaviour, because it is the
 * entire reason the qualified-law gate sits on the ZCAD side of the call.
 */
describe('variable-radius fillet', { timeout: 60_000 }, () => {
  let kernel: RemusKernel;

  beforeEach(() => {
    kernel = new RemusKernel();
  });

  it('removes more than the constant blend at the same mean radius, and matches the r² oracle', () => {
    const box = kernel.makeBox(20, 20, 10);
    const before = kernel.volume(box, DEFLECTION);
    const edge = verticalEdgeOf(kernel, box);
    const length = kernel.edgeLength(edge);
    expect(length).toBeCloseTo(10, 9);

    const constantAtMean =
      before - kernel.volume(kernel.fillet(box, Uint32Array.from([edge]), 2), DEFLECTION);
    const variable =
      before -
      kernel.volume(
        kernel.filletVariable(
          box,
          variableFilletRequest([edge], {
            law: 'linear',
            startRadius: 1,
            endRadius: 3
          })
        ),
        DEFLECTION
      );

    // Direction: a radius that runs 1 → 3 takes out more material than the
    // constant r=2 between the same endpoints, because the removed area goes
    // as r² and the ramp spends as long above the mean as below it.
    expect(variable).toBeGreaterThan(constantAtMean);
    // Bracket: and never more than the constant blend at the larger radius,
    // nor less than the constant blend at the smaller one.
    const constantAtStart =
      before - kernel.volume(kernel.fillet(box, Uint32Array.from([edge]), 1), DEFLECTION);
    const constantAtEnd =
      before - kernel.volume(kernel.fillet(box, Uint32Array.from([edge]), 3), DEFLECTION);
    expect(variable).toBeGreaterThan(constantAtStart);
    expect(variable).toBeLessThan(constantAtEnd);

    // Magnitude: within 3% of the analytic integral. The variable engine runs
    // 1.5–2% heavy against it across every case measured here, including the
    // constant law, so this tolerance is the engine's known bias and not
    // slack for an arbitrary result.
    const oracle = removedVolumeOracle(1, 3, length, 'linear');
    expect(Math.abs(variable - oracle) / oracle).toBeLessThan(0.03);
  });

  it('spends longer near its end radii under the s-curve than under the ramp', () => {
    const box = kernel.makeBox(20, 20, 10);
    const before = kernel.volume(box, DEFLECTION);
    const edge = verticalEdgeOf(kernel, box);
    const length = kernel.edgeLength(edge);
    const removed = (law: 'linear' | 'scurve') =>
      before -
      kernel.volume(
        kernel.filletVariable(
          box,
          variableFilletRequest([edge], { law, startRadius: 1, endRadius: 3 })
        ),
        DEFLECTION
      );

    // A smoothstep between the same two radii has a larger mean square than
    // the straight ramp, so it removes strictly more. This is the only claim
    // that tells the two laws apart at all, and it is why both are offered.
    expect(removed('scurve')).toBeGreaterThan(removed('linear'));
    const oracle = removedVolumeOracle(1, 3, length, 'scurve');
    expect(Math.abs(removed('scurve') - oracle) / oracle).toBeLessThan(0.03);
  });

  it('is answered by a silent constant blend when the law is unqualified', () => {
    // The distrust harness for this feature. An unrecognized law does not
    // refuse, does not warn, and does not mark the result: it comes back as
    // the constant blend at the START radius, indistinguishable from a
    // success. Sending an unqualified law and checking afterwards is
    // therefore not a design that can work, and this test fails the moment
    // the kernel starts refusing — at which point the gate can move.
    const box = kernel.makeBox(20, 20, 10);
    const before = kernel.volume(box, DEFLECTION);
    const edge = verticalEdgeOf(kernel, box);
    const degraded = kernel.filletVariable(
      box,
      JSON.stringify([{ edge, law: 'cubic', start: 1, end: 3 }])
    );
    expect(kernel.validateSolid(degraded)).toBe(0);
    const removed = before - kernel.volume(degraded, DEFLECTION);
    const constantAtStart =
      before -
      kernel.volume(
        kernel.filletVariable(
          box,
          JSON.stringify([{ edge, law: 'constant', start: 1, end: 3 }])
        ),
        DEFLECTION
      );
    expect(removed).toBeCloseTo(constantAtStart, 9);
  });

  it('refuses an unqualified law before the kernel can degrade it', () => {
    expect(() => assertQualifiedVariableFillet('cubic', 1, 3)).toThrow(
      /not one of the radius laws this kernel qualifies \(linear, scurve\)/
    );
    expect(() => assertQualifiedVariableFillet('linear', 0, 3)).toThrow(
      /start radius must be a finite value greater than zero/
    );
    expect(() => assertQualifiedVariableFillet('scurve', 1, Number.NaN)).toThrow(
      /end radius must be a finite value greater than zero/
    );
    expect(() => assertQualifiedVariableFillet('linear', 1, 3)).not.toThrow();
  });

  it('never writes a setback, which is the unqualified N-way vertex blend', () => {
    const request = JSON.parse(
      variableFilletRequest([4, 9], {
        law: 'linear',
        startRadius: 1,
        endRadius: 3
      })
    ) as Record<string, unknown>[];
    expect(request).toEqual([
      { edge: 4, law: 'linear', start: 1, end: 3 },
      { edge: 9, law: 'linear', start: 1, end: 3 }
    ]);

    // What the kernel says when one is written, and the reason the request
    // builder cannot offer them: a setback is only accepted when EVERY stripe
    // meeting at a corner declares one, which a per-edge selection cannot
    // promise.
    const kernelRefusal = (() => {
      const box = kernel.makeBox(20, 20, 10);
      try {
        kernel.filletVariable(
          box,
          JSON.stringify([
            {
              edge: verticalEdgeOf(kernel, box),
              law: 'linear',
              start: 1,
              end: 3,
              startSetback: 1,
              endSetback: 1
            }
          ])
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    expect(kernelRefusal).toMatch(/^unsupported-setback-corner:/);
    // And that the adapter relays it verbatim rather than paraphrasing.
    expect(variableBlendRefusalMessage(kernelRefusal)).toBe(
      kernelRefusal?.trim()
    );
  });
});

describe('asymmetric chamfer', { timeout: 60_000 }, () => {
  let kernel: RemusKernel;

  beforeEach(() => {
    kernel = new RemusKernel();
  });

  /**
   * `chamferV2(solid, edges, d1, d2)` does not say which distance lands on
   * which face, and the answer is not recoverable from the result: the volume
   * it removes is 0.5·d1·d2·length, identical under a swap. It is recoverable
   * from the FACES, because each one loses exactly its own setback times the
   * edge length, and that is what this pins: d1 on the first face of the
   * edge's `edgeToFaceMap` pair, d2 on the second.
   */
  it('lands d1 on the first adjacent face and d2 on the second', () => {
    const box = kernel.makeBox(20, 20, 10);
    const adjacency = JSON.parse(kernel.edgeToFaceMap(box)) as Record<
      string,
      number[]
    >;
    for (const edge of Array.from(kernel.getSolidEdges(box))) {
      const pair = adjacency[edge.toString()]!;
      expect(pair).toHaveLength(2);
      const [first, second] = pair as [number, number];
      const length = kernel.edgeLength(edge);
      const areaBefore = [first, second].map((face) =>
        kernel.faceArea(face, DEFLECTION)
      );
      const normals = [first, second].map((face) => normalKeyOf(kernel, face));

      const chamfered = kernel.chamferV2(box, Uint32Array.from([edge]), 1, 3);
      expect(kernel.validateSolid(chamfered)).toBe(0);
      const areasAfter = faceAreasByNormal(kernel, chamfered);

      // Each face keeps its outward normal, so it is found again by it, and
      // it has lost a strip exactly its own setback wide.
      expect(areaBefore[0]! - areasAfter.get(normals[0]!)!).toBeCloseTo(
        1 * length,
        6
      );
      expect(areaBefore[1]! - areasAfter.get(normals[1]!)!).toBeCloseTo(
        3 * length,
        6
      );

      // Swapping the two arguments swaps the two faces, and nothing else:
      // the material removed is the same either way.
      const swapped = kernel.chamferV2(box, Uint32Array.from([edge]), 3, 1);
      const swappedAreas = faceAreasByNormal(kernel, swapped);
      expect(areaBefore[0]! - swappedAreas.get(normals[0]!)!).toBeCloseTo(
        3 * length,
        6
      );
      expect(areaBefore[1]! - swappedAreas.get(normals[1]!)!).toBeCloseTo(
        1 * length,
        6
      );
      expect(kernel.volume(swapped, DEFLECTION)).toBeCloseTo(
        kernel.volume(chamfered, DEFLECTION),
        6
      );
    }
  });
});

describe('variable blends through the document', { timeout: 120_000 }, () => {
  it('replays a constant fillet and a symmetric chamfer unchanged', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const base = addPrimitiveFeature(createProjectDocument('Plate', user), {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const bodyId = base.bodyOrder[0] as BodyId;
      const built = await adapter.syncDocument(base);
      const edges = built.bodyRepresentations[bodyId]?.topology?.edges ?? [];
      const rounded = filletEdges(base, {
        name: 'Round',
        targetBodyId: bodyId,
        edgeHashes: [edges[0]!.hash],
        size: 2
      });
      const doc = rounded.document;

      // The new fields are additive: a feature authored without them stores
      // none of them, so an existing document's bytes are untouched and its
      // rebuild takes the constant engine it always took.
      const data = lastFeatureData(doc) as Extract<
        FeatureData,
        { featureKind: 'fillet' }
      >;
      expect(data).toEqual({
        featureKind: 'fillet',
        targetBodyId: bodyId,
        edgeHashes: [edges[0]!.hash],
        radius: 2
      });
      expect('endRadius' in data).toBe(false);
      expect('radiusLaw' in data).toBe(false);

      const derived = await adapter.syncDocument(doc);
      expect(derived.warnings).toEqual([]);
      const constantVolume =
        derived.bodyRepresentations[rounded.bodyId]!.volume;

      // Chamfered off the plain box, not off the rounded body: an edge that
      // ends on an existing blend is a refusal the kernel owns and this test
      // is not about.
      const chamfered = chamferEdges(base, {
        name: 'Bevel',
        targetBodyId: bodyId,
        edgeHashes: [edges[1]!.hash],
        size: 1
      });
      const chamferData = lastFeatureData(chamfered.document) as Extract<
        FeatureData,
        { featureKind: 'chamfer' }
      >;
      expect('distance2' in chamferData).toBe(false);
      const withChamfer = await adapter.syncDocument(chamfered.document);
      expect(withChamfer.warnings).toEqual([]);
      expect(constantVolume).toBeGreaterThan(0);
    } finally {
      adapter.dispose();
    }
  });

  it('builds a variable-radius fillet that differs from the constant one', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const base = addPrimitiveFeature(createProjectDocument('Plate', user), {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const bodyId = base.bodyOrder[0] as BodyId;
      const built = await adapter.syncDocument(base);
      const edges = built.bodyRepresentations[bodyId]?.topology?.edges ?? [];
      const shortEdge = edges.find((edge) => Math.abs((edge.length ?? 0) - 10) < 1e-6)!;

      const constant = filletEdges(base, {
        name: 'Round',
        targetBodyId: bodyId,
        edgeHashes: [shortEdge.hash],
        size: 2
      });
      const variable = filletEdges(base, {
        name: 'Round',
        targetBodyId: bodyId,
        edgeHashes: [shortEdge.hash],
        size: 1,
        endRadius: 3,
        radiusLaw: 'linear'
      });

      const constantDerived = await adapter.syncDocument(constant.document);
      expect(constantDerived.warnings).toEqual([]);
      const variableDerived = await adapter.syncDocument(variable.document);
      expect(variableDerived.warnings).toEqual([]);

      // 1 → 3 takes more out than a constant 2 does, end to end through the
      // document, not only at the kernel boundary.
      expect(variableDerived.bodyRepresentations[variable.bodyId]!.volume).toBeLessThan(
        constantDerived.bodyRepresentations[constant.bodyId]!.volume
      );
    } finally {
      adapter.dispose();
    }
  });

  it('refuses a stored law the kernel does not qualify, rather than rounding at the start radius', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const base = addPrimitiveFeature(createProjectDocument('Plate', user), {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const bodyId = base.bodyOrder[0] as BodyId;
      const built = await adapter.syncDocument(base);
      const edges = built.bodyRepresentations[bodyId]?.topology?.edges ?? [];
      const created = filletEdges(base, {
        name: 'Round',
        targetBodyId: bodyId,
        edgeHashes: [edges[0]!.hash],
        size: 1,
        endRadius: 3,
        radiusLaw: 'linear'
      });
      // A document is untrusted input: this is what a hand-edited or
      // generated one can carry, and the schema's union cannot stop it.
      const stored = lastFeatureData(created.document) as unknown as Record<
        string,
        unknown
      >;
      stored.radiusLaw = 'cubic';

      const derived = await adapter.syncDocument(created.document);
      const failure = derived.warnings.join(' ');
      expect(failure).toMatch(/"cubic" is not one of the radius laws/);
      expect(failure).toMatch(/linear, scurve/);
      // And the refusal is named, not a quietly different blend.
      expect(failure).toMatch(/refused rather than approximated/);
    } finally {
      adapter.dispose();
    }
  });

  it('refuses a chamfer that stores both a second distance and an angle', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const base = addPrimitiveFeature(createProjectDocument('Plate', user), {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const bodyId = base.bodyOrder[0] as BodyId;
      const built = await adapter.syncDocument(base);
      const edges = built.bodyRepresentations[bodyId]?.topology?.edges ?? [];
      const created = chamferEdges(base, {
        name: 'Bevel',
        targetBodyId: bodyId,
        edgeHashes: [edges[0]!.hash],
        size: 1,
        distance2: 3
      });
      const stored = lastFeatureData(created.document) as unknown as Record<
        string,
        unknown
      >;
      stored.angleDeg = 30;

      const derived = await adapter.syncDocument(created.document);
      expect(derived.warnings.join(' ')).toMatch(
        /either a second distance or an angle, not both/
      );
    } finally {
      adapter.dispose();
    }
  });

  it('builds an asymmetric chamfer whose setbacks differ from the symmetric one', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const base = addPrimitiveFeature(createProjectDocument('Plate', user), {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const bodyId = base.bodyOrder[0] as BodyId;
      const built = await adapter.syncDocument(base);
      const edges = built.bodyRepresentations[bodyId]?.topology?.edges ?? [];
      const edge = edges[0]!;

      const symmetric = chamferEdges(base, {
        name: 'Bevel',
        targetBodyId: bodyId,
        edgeHashes: [edge.hash],
        size: 2
      });
      const asymmetric = chamferEdges(base, {
        name: 'Bevel',
        targetBodyId: bodyId,
        edgeHashes: [edge.hash],
        size: 1,
        distance2: 3
      });

      const symmetricDerived = await adapter.syncDocument(symmetric.document);
      expect(symmetricDerived.warnings).toEqual([]);
      const asymmetricDerived = await adapter.syncDocument(asymmetric.document);
      expect(asymmetricDerived.warnings).toEqual([]);

      // 0.5·d1·d2·L: the symmetric 2×2 takes out 4/3 of what 1×3 does.
      const removedSymmetric =
        built.bodyRepresentations[bodyId]!.volume -
        symmetricDerived.bodyRepresentations[symmetric.bodyId]!.volume;
      const removedAsymmetric =
        built.bodyRepresentations[bodyId]!.volume -
        asymmetricDerived.bodyRepresentations[asymmetric.bodyId]!.volume;
      expect(removedAsymmetric / removedSymmetric).toBeCloseTo(3 / 4, 6);
    } finally {
      adapter.dispose();
    }
  });
});
