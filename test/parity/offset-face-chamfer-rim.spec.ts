/**
 * Offsetting a face whose whole rim is chamfered carries the chamfer.
 *
 * Production QA: a body with rounded vertical corners and a 0.35 chamfer
 * round its bottom edge could not offset the bottom face at any distance.
 * The pinned kernel's move treats the chamfer faces as neighbours to
 * re-limit, and the cones over the rounded corners either run into their
 * apex (outward) or the face sweeps into the walls (inward). On a
 * sharp-cornered body the same move "succeeds" by extending the chamfer
 * planes: pushing the bottom in grew the body sideways. The adapter now
 * squares the rim off, moves the face and chamfers it again, and holds the
 * result to the exact swept-prism volume.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commandFactories } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { RemusKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { tryCarryChamferRim } from '../../packages/kernel-adapter/src/exact-chamfer-rim-carry';

const X = 60;
const Y = 40;
const Z = 20;
const ROUND = 3;
const CHAMFER = 0.35;

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

interface Fixture {
  document: ProjectDocument;
  bodyId: BodyId;
  bottom: FaceTopology;
  volume: number;
  /** The wall cross-section: the cap's area before its chamfer was cut. */
  section: number;
}

function edgesWhere(
  kernel: RemusKernel,
  solid: number,
  keep: (a: number[], b: number[]) => boolean
): Uint32Array {
  return Uint32Array.from(
    Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
      const v = kernel.getEdgeVertices(edge);
      return keep([v[0]!, v[1]!, v[2]!], [v[3]!, v[4]!, v[5]!]);
    })
  );
}

describe('offset face ringed by a chamfer', { timeout: 180_000 }, () => {
  let adapter: RemusKernelAdapter;
  const fixtures = new Map<string, Fixture>();

  async function fixture(
    name: string,
    build: (kernel: RemusKernel) => number,
    section: number
  ): Promise<Fixture> {
    const kernel = new RemusKernel();
    const io = await loadRemusTranslators();
    const step = new TextDecoder().decode(
      io.exportStep(kernel.serializeSolids(Uint32Array.of(build(kernel))))
    );
    const imported = importStepBody(
      createProjectDocument(name, toUserId('user_chamfer_rim')),
      {
        name: 'Block',
        sourceName: `${name}.step`,
        artifactId: `artifact_${name}`,
        stepText: step
      }
    );
    const derived = await adapter.syncDocument(imported.document);
    const representation = derived.bodyRepresentations[imported.bodyId]!;
    const bottom = representation
      .topology!.faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z < -0.999
      )
      .sort((a, b) => b.geometry!.area - a.geometry!.area)[0]!;
    return {
      document: imported.document,
      bodyId: imported.bodyId,
      bottom,
      volume: representation.volume,
      section
    };
  }

  beforeAll(async () => {
    adapter = new RemusKernelAdapter();
    const bottomRim = (a: number[], b: number[]) =>
      near(a[2]!, 0) && near(b[2]!, 0);
    const vertical = (a: number[], b: number[]) =>
      near(a[0]!, b[0]!) && near(a[1]!, b[1]!);
    fixtures.set(
      'rounded',
      await fixture(
        'rounded',
        (kernel) => {
          const box = kernel.makeBox(X, Y, Z);
          const rounded = kernel.filletDetailed(
            box,
            edgesWhere(kernel, box, vertical),
            ROUND,
            true
          );
          if (rounded.status !== 'ok') throw new Error('fixture fillet');
          return kernel.chamfer(
            rounded.value,
            edgesWhere(kernel, rounded.value, bottomRim),
            CHAMFER
          );
        },
        X * Y - (4 - Math.PI) * ROUND * ROUND
      )
    );
    fixtures.set(
      'sharp',
      await fixture(
        'sharp',
        (kernel) => {
          const box = kernel.makeBox(X, Y, Z);
          return kernel.chamfer(
            box,
            edgesWhere(kernel, box, bottomRim),
            CHAMFER
          );
        },
        X * Y
      )
    );
    fixtures.set(
      'one-edge',
      await fixture(
        'one-edge',
        (kernel) => {
          const box = kernel.makeBox(X, Y, Z);
          // Only the front bottom edge: the kernel's move built a body
          // 1.65 wider and ~29000 mm³ short when pushed in by 2.
          return kernel.chamfer(
            box,
            edgesWhere(
              kernel,
              box,
              (a, b) => bottomRim(a, b) && near(a[1]!, 0) && near(b[1]!, 0)
            ),
            CHAMFER
          );
        },
        X * Y
      )
    );
    fixtures.set(
      'holed',
      await fixture(
        'holed',
        (kernel) => {
          // A Ø10 through hole: its bottom mouth is chamfered with the rim,
          // so the carried band includes a full cone and its seam.
          const box = kernel.makeBox(X, Y, Z);
          const bore = kernel.copyAndTransformSolid(
            kernel.makeCylinder(5, Z + 10),
            Float64Array.of(1, 0, 0, 20, 0, 1, 0, 20, 0, 0, 1, -5, 0, 0, 0, 1)
          );
          const plate = kernel.cut(box, bore);
          return kernel.chamfer(
            plate,
            edgesWhere(kernel, plate, bottomRim),
            CHAMFER
          );
        },
        X * Y - Math.PI * 25
      )
    );
    fixtures.set(
      'uneven',
      await fixture(
        'uneven',
        (kernel) => {
          const box = kernel.makeBox(X, Y, Z);
          return kernel.chamferV2(
            box,
            edgesWhere(kernel, box, bottomRim),
            CHAMFER,
            2 * CHAMFER
          );
        },
        X * Y
      )
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

  for (const shape of [
    'rounded',
    'sharp',
    'one-edge',
    'holed',
    'uneven'
  ] as const) {
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

  it('leaves a drafted side to the kernel move', () => {
    // A frustum's side is a cone about the bottom's normal, like a chamfer
    // over a round, but it climbs to the top cap rather than to a wall:
    // re-limiting it is the right move, and stays the kernel's.
    const kernel = new RemusKernel();
    const frustum = kernel.makeCone(20, 12, 15);
    const bottom = Array.from(kernel.getSolidFaces(frustum)).find(
      (face) =>
        kernel.getSurfaceType(face) === 'plane' &&
        kernel.getFaceNormal(face)[2]! < -0.999
    )!;
    expect(tryCarryChamferRim(kernel, frustum, bottom, 2)).toBeNull();
    expect(tryCarryChamferRim(kernel, frustum, bottom, -2)).toBeNull();
  });
});
