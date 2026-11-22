/**
 * Offsetting a face whose rim is chamfered carries the chamfer.
 *
 * Production QA: a body with rounded vertical corners and a 0.7 chamfer
 * round its bottom edge could not offset the bottom face at any distance.
 * The pinned kernel's move treats the chamfer faces as neighbours to
 * re-limit, and the cones over the rounded corners either run into their
 * apex (outward) or the face sweeps into the walls (inward). On a
 * sharp-cornered body the same move "succeeds" by extending the chamfer
 * planes: pushing the bottom in grew the body sideways
 * (esaueng/remus#1957). The adapter now slides the cap and its chamfer band
 * along the walls in the native arena.
 *
 * The bodies are built the way a user builds them (box, rounds, chamfer),
 * because only a band matching a chamfer in the history is carried: the
 * same shape as a drafted section keeps the kernel's re-limiting move.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import { RemusKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toFeatureId,
  toUserId,
  type BodyId,
  type EdgeTopology,
  type FaceTopology,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import {
  chamferSetbacksBefore,
  tryCarryChamferRim
} from '../../packages/kernel-adapter/src/exact-chamfer-rim-carry';

const X = 60;
const Y = 40;
const Z = 20;
const ROUND = 3;
const CHAMFER = 0.35;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Every point of the edge's display polyline satisfies `keep`. */
const along =
  (keep: (x: number, y: number, z: number) => boolean) =>
  (edge: EdgeTopology) => {
    const p = edge.points;
    for (let i = 0; i < p.length; i += 3) {
      if (!keep(p[i]!, p[i + 1]!, p[i + 2]!)) return false;
    }
    return p.length > 0;
  };
const onBottom = along((_x, _y, z) => near(z, 0));
const vertical = (edge: EdgeTopology) =>
  along((x, y) => near(x, edge.points[0]!) && near(y, edge.points[1]!))(edge) &&
  (edge.length ?? 0) > Z / 2;

interface Fixture {
  document: ProjectDocument;
  bodyId: BodyId;
  bottom: FaceTopology;
  volume: number;
  /** The wall cross-section. */
  section: number;
}

describe('offset face ringed by a chamfer', { timeout: 300_000 }, () => {
  let adapter: RemusKernelAdapter;
  const fixtures = new Map<string, Fixture>();

  async function edgesOf(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return derived.bodyRepresentations[bodyId]!.topology!.edges;
  }

  async function chamfered(
    name: string,
    options: {
      round?: boolean;
      pick?: (edge: EdgeTopology) => boolean;
      distance2?: number;
    }
  ): Promise<Fixture> {
    let document = addPrimitiveFeature(
      createProjectDocument(name, toUserId('user_chamfer_rim')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: X, height: Y, depth: Z }
      }
    );
    let bodyId = document.bodyOrder[0]!;
    if (options.round) {
      const verticals = (await edgesOf(document, bodyId)).filter(vertical);
      expect(verticals).toHaveLength(4);
      const rounded = filletEdges(document, {
        name: 'Corners',
        targetBodyId: bodyId,
        edgeHashes: verticals.map((edge) => edge.hash),
        edgeReferences: verticals.map((edge) => edge.reference!),
        size: ROUND
      });
      document = rounded.document;
      bodyId = rounded.bodyId;
    }
    const rim = (await edgesOf(document, bodyId)).filter(
      (edge) => onBottom(edge) && (options.pick?.(edge) ?? true)
    );
    expect(rim.length).toBeGreaterThan(0);
    const result = chamferEdges(document, {
      name: 'Chamfer',
      targetBodyId: bodyId,
      edgeHashes: rim.map((edge) => edge.hash),
      edgeReferences: rim.map((edge) => edge.reference!),
      size: CHAMFER,
      ...(options.distance2 === undefined
        ? {}
        : { distance2: options.distance2 })
    });
    const derived = await adapter.syncDocument(result.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[result.bodyId]!;
    const bottom = body
      .topology!.faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z < -0.999
      )
      .sort((a, b) => b.geometry!.area - a.geometry!.area)[0]!;
    return {
      document: result.document,
      bodyId: result.bodyId,
      bottom,
      volume: body.volume,
      section: options.round ? X * Y - (4 - Math.PI) * ROUND * ROUND : X * Y
    };
  }

  beforeAll(async () => {
    adapter = new RemusKernelAdapter();
    fixtures.set('rounded', await chamfered('rounded', { round: true }));
    fixtures.set('sharp', await chamfered('sharp', {}));
    // Only the front bottom edge: the kernel's move built a body 1.65
    // deeper and ~29000 mm³ too small when pushed in by 2.
    fixtures.set(
      'one-edge',
      await chamfered('one-edge', {
        pick: along((_x, y) => near(y, 0))
      })
    );
    fixtures.set(
      'uneven',
      await chamfered('uneven', { round: true, distance2: 2 * CHAMFER })
    );
  });

  afterAll(() => {
    adapter.dispose();
  });

  function offsetBy(f: Fixture, offset: number): ProjectDocument {
    return commandFactories
      .directEditBody({
        name: 'Offset Face',
        targetBodyId: f.bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: f.bottom.hash,
          ...(f.bottom.reference ? { faceReference: f.bottom.reference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: f.bottom.geometry!.area,
          sourceCenter: f.bottom.geometry!.center,
          sourceNormal: f.bottom.geometry!.normal!,
          offset
        }
      })
      .apply(f.document);
  }

  function failures(warnings: readonly FeatureWarning[] | undefined) {
    return (warnings ?? []).filter(
      (warning) =>
        warning.featureName === 'Offset Face' &&
        (warning.kind === 'build-failed' || warning.kind === 'refusal')
    );
  }

  for (const shape of ['rounded', 'sharp', 'one-edge', 'uneven'] as const) {
    for (const offset of [20, 2, 0.1, -0.1, -2, -12]) {
      it(`${shape}: carries the chamfer through an offset of ${offset}`, async () => {
        const f = fixtures.get(shape)!;
        const candidate = offsetBy(f, offset);
        const preview = await adapter.previewGeometry(candidate, {
          deferTopology: true
        });
        expect(failures(preview.featureWarnings)).toEqual([]);
        const committed = await adapter.syncDocument(candidate);
        expect(failures(committed.featureWarnings)).toEqual([]);
        const body = Object.values(committed.bodyRepresentations).at(-1)!;
        // The walls keep their footprint; only the bottom moves.
        expect(body.bbox.min.x).toBeCloseTo(0, 6);
        expect(body.bbox.max.x).toBeCloseTo(X, 6);
        expect(body.bbox.min.y).toBeCloseTo(0, 6);
        expect(body.bbox.max.y).toBeCloseTo(Y, 6);
        expect(body.bbox.min.z).toBeCloseTo(-offset, 6);
        expect(body.bbox.max.z).toBeCloseTo(Z, 6);
        // The chamfer is carried, not stretched: exactly the swept prism.
        expect(body.volume).toBeCloseTo(f.volume + offset * f.section, 2);
        // The moved face keeps the chamfer's inset: same area as before.
        const moved = body.topology!.faces.filter(
          (face) =>
            face.geometry?.surfaceType === 'plane' &&
            face.geometry.normal!.z < -0.999
        );
        expect(moved).toHaveLength(1);
        expect(moved[0]!.geometry!.area).toBeCloseTo(
          f.bottom.geometry!.area,
          6
        );
      });
    }
  }

  for (const [shape, offset] of [
    // Past the top of the walls: nothing is left to carry the chamfer on.
    ['rounded', -Z],
    ['sharp', -(Z - CHAMFER / 2)]
  ] as const) {
    it(`${shape}: refuses ${offset} as a chamfer it cannot carry`, async () => {
      const f = fixtures.get(shape)!;
      const candidate = offsetBy(f, offset);
      for (const derived of [
        await adapter.previewGeometry(candidate, { deferTopology: true }),
        await adapter.syncDocument(candidate)
      ]) {
        const [refusal] = failures(derived.featureWarnings);
        expect(refusal, 'the offset is refused').toBeDefined();
        expect(refusal!.kernelRefusal).toMatchObject({
          family: 'direct-edit',
          category: 'unsupported',
          code: 'offset_face_chamfer_rim_not_carried'
        });
        expect(refusal!.message).toContain(
          "This face's chamfered edge can't move with it here."
        );
      }
    });
  }

  it('counts only the chamfers that built the edited body', () => {
    const f = fixtures.get('sharp')!;
    const other = addPrimitiveFeature(f.document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const otherBody = other.bodyOrder.at(-1)!;
    const later = toFeatureId('feat_later');
    expect(chamferSetbacksBefore(other, later, f.bodyId, {})).toEqual([
      [CHAMFER, CHAMFER]
    ]);
    // A chamfer elsewhere in the document cannot have made a band here.
    expect(chamferSetbacksBefore(other, later, otherBody, {})).toEqual([]);
  });

  describe('the carry on bare kernel bodies', () => {
    const bottomOf = (kernel: RemusKernel, solid: number) =>
      Array.from(kernel.getSolidFaces(solid)).find(
        (face) =>
          kernel.getSurfaceType(face) === 'plane' &&
          kernel.getFaceNormal(face)[2]! < -0.999
      )!;
    const bottomEdges = (kernel: RemusKernel, solid: number) =>
      Uint32Array.from(
        Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
          const v = kernel.getEdgeVertices(edge);
          return near(v[2]!, 0) && near(v[5]!, 0);
        })
      );

    it('carries a chamfered hole mouth with the outer rim', () => {
      const kernel = new RemusKernel();
      // A Ø10 through hole whose bottom mouth is chamfered with the rim, so
      // the band includes a full cone and its seam.
      const bore = kernel.copyAndTransformSolid(
        kernel.makeCylinder(5, Z + 10),
        Float64Array.of(1, 0, 0, 20, 0, 1, 0, 20, 0, 0, 1, -5, 0, 0, 0, 1)
      );
      const plate = kernel.cut(kernel.makeBox(X, Y, Z), bore);
      const solid = kernel.chamfer(plate, bottomEdges(kernel, plate), CHAMFER);
      const volume = kernel.volume(solid, 1e-3);
      const section = X * Y - Math.PI * 25;
      for (const offset of [20, 2, -2, -12]) {
        const carried = tryCarryChamferRim(
          kernel,
          solid,
          bottomOf(kernel, solid),
          offset,
          [[CHAMFER, CHAMFER]]
        );
        expect(carried).not.toBeNull();
        expect(kernel.validateSolid(carried!.solid)).toBe(0);
        expect(kernel.volume(carried!.solid, 1e-3)).toBeCloseTo(
          volume + offset * section,
          2
        );
      }
    });

    it('refuses a wall that leans enough to leave the rim off it', () => {
      // Walls 8e-8 rad off vertical pass the analytic match, but sliding the
      // rim 1000 along them would leave it 8e-5 off its wall planes.
      const kernel = new RemusKernel();
      const box = kernel.makeBox(30, 30, 0.5);
      const leaning = kernel.copyAndTransformSolid(
        box,
        Float64Array.of(1, 0, 8e-8, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
      );
      const solid = kernel.chamfer(leaning, bottomEdges(kernel, leaning), 0.1);
      const bottom = bottomOf(kernel, solid);
      expect(() =>
        tryCarryChamferRim(kernel, solid, bottom, 1000, [[0.1, 0.1]])
      ).toThrow(/chamfered edge can't move with it/);
    });

    it('leaves a drafted section on straight walls to the kernel move', () => {
      // A frustum foot under a straight cylinder: its side is a cone about
      // the bottom's normal standing on a wall, the shape of a chamfer band,
      // but no chamfer in the history made it. Re-limiting it is the right
      // move, and stays the kernel's.
      const kernel = new RemusKernel();
      const foot = kernel.makeCone(10, 15, 10);
      const column = kernel.copyAndTransformSolid(
        kernel.makeCylinder(15, 30),
        Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 10, 0, 0, 0, 1)
      );
      const solid = kernel.fuse(foot, column);
      const bottom = bottomOf(kernel, solid);
      for (const setbacks of [[], [[CHAMFER, CHAMFER]]] as const) {
        expect(
          tryCarryChamferRim(kernel, solid, bottom, -2, setbacks)
        ).toBeNull();
        expect(
          tryCarryChamferRim(kernel, solid, bottom, 2, setbacks)
        ).toBeNull();
      }
    });
  });
});
