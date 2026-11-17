/**
 * Issue #1595: offsetting a face must not stretch the chamfer of a hole in it.
 *
 * The body: a 30 × 12 × 5 plate with two Ø9 through holes, one of them with
 * a 0.5 mm chamfer on its top rim. Pushing the plate's top face out, the
 * pinned kernel keeps the chamfer's cone where it is and re-cuts its rim on
 * the moved face, so the rim grows by the offset: at +4 mm the 0.5 mm
 * chamfer is a 4.5 mm one, the hole's mouth runs 3 mm past the plate on both
 * sides, and the kernel validates that as a clean solid (esaueng/remus#1799).
 * The adapter used to commit it.
 *
 * The adapter now refuses any such result, typed, through both the drag
 * preview (prepared move) and the full rebuild a commit uses, and keeps the
 * plate. The same plate with no chamfer still offsets, and so does the one
 * the kernel already handles: with a fillet on the other hole's rim it
 * carries the chamfer with the face, and that correct result is accepted.
 *
 * When the pinned kernel carries a chamfer-only hole mouth, the refusals
 * below turn into builds: assert then that the chamfer keeps its size, the
 * bounds stay on the plate and both holes stay through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commandFactories } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { RemusKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FeatureWarning,
  type GeometryBodyRepresentation,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

const X = 30;
const Y = 12;
const Z = 5;
const BORE = 4.5;
const CHAMFER = 0.5;
/** Hole centres along the plate, 12 apart. */
const HOLES = [9, 21] as const;
const PLATE_AREA = X * Y - 2 * Math.PI * BORE * BORE;
/** What the 0.5 mm chamfer takes off one hole's rim. */
const CHAMFER_VOLUME =
  (Math.PI *
    CHAMFER *
    ((BORE + CHAMFER) ** 2 + (BORE + CHAMFER) * BORE + BORE ** 2)) /
    3 -
  Math.PI * BORE * BORE * CHAMFER;

/**
 * What a drag preview and a commit rebuild both report. A preview's bodies
 * carry no volume; a rebuild's do.
 */
interface Built {
  bodyRepresentations: Record<
    BodyId,
    GeometryBodyRepresentation & { volume?: number }
  >;
  warnings: string[];
  featureWarnings?: FeatureWarning[];
}

const translation = (x: number, y: number, z: number) =>
  Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);

type Rim = 'chamfer' | 'fillet' | 'none';

/** The plate, with the first hole's top rim finished as `first` and the second's as `second`. */
function plate(kernel: RemusKernel, first: Rim, second: Rim): number {
  let solid = kernel.makeBox(X, Y, Z);
  for (const x of HOLES) {
    const tool = kernel.makeCylinder(BORE, Z + 4);
    kernel.transformSolid(tool, translation(x, Y / 2, -2));
    solid = kernel.cut(solid, tool);
  }
  const topRim = (body: number, x: number) =>
    Array.from(kernel.getSolidEdges(body)).filter((edge) => {
      if (kernel.getEdgeCurveType(edge) !== 'CIRCLE') return false;
      const v = kernel.getEdgeVertices(edge);
      return (
        Math.abs(Math.hypot(v[0]! - x, v[1]! - Y / 2) - BORE) < 1e-6 &&
        Math.abs(v[2]! - Z) < 1e-6
      );
    });
  for (const [x, rim] of [
    [HOLES[0], first],
    [HOLES[1], second]
  ] as const) {
    if (rim === 'none') continue;
    const edges = Uint32Array.from(topRim(solid, x));
    expect(edges.length).toBeGreaterThan(0);
    solid =
      rim === 'chamfer'
        ? kernel.chamfer(solid, edges, CHAMFER)
        : kernel.fillet(solid, edges, CHAMFER);
  }
  return solid;
}

describe(
  'offset face with a chamfered hole in it (#1595)',
  { timeout: 180_000 },
  () => {
    let adapter: RemusKernelAdapter;

    beforeAll(() => {
      adapter = new RemusKernelAdapter();
    });

    afterAll(() => {
      adapter.dispose();
    });

    /** The plate as an imported body, and its top face. */
    async function part(first: Rim, second: Rim) {
      const kernel = new RemusKernel();
      const io = await loadRemusTranslators();
      let step: string;
      try {
        step = new TextDecoder().decode(
          io.exportStep(
            kernel.serializeSolids(Uint32Array.of(plate(kernel, first, second)))
          )
        );
      } finally {
        kernel.free();
      }
      const imported = importStepBody(
        createProjectDocument(
          `Plate ${first} ${second}`,
          toUserId('user_offset_hole_chamfer')
        ),
        {
          name: 'Plate',
          sourceName: 'plate.step',
          artifactId: `artifact_plate_${first}_${second}`,
          stepText: step
        }
      );
      const derived = await adapter.syncDocument(imported.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[imported.bodyId]!;
      const top = body
        .topology!.faces.filter(
          (face) =>
            face.geometry?.surfaceType === 'plane' &&
            face.geometry.normal!.z > 0.999 &&
            Math.abs(face.geometry.center.z - Z) < 1e-6
        )
        .sort((a, b) => b.geometry!.area - a.geometry!.area)[0]!;
      return {
        document: imported.document,
        bodyId: imported.bodyId,
        top,
        volume: body.volume
      };
    }

    function offsetBy(
      source: { document: ProjectDocument; bodyId: BodyId; top: FaceTopology },
      offset: number
    ): ProjectDocument {
      return commandFactories
        .directEditBody({
          name: 'Offset Face',
          targetBodyId: source.bodyId,
          operation: {
            kind: 'offset-face',
            faceHash: source.top.hash,
            ...(source.top.reference
              ? { faceReference: source.top.reference }
              : {}),
            sourceSurfaceType: 'plane',
            sourceArea: source.top.geometry!.area,
            sourceCenter: source.top.geometry!.center,
            sourceNormal: source.top.geometry!.normal!,
            offset
          }
        })
        .apply(source.document);
    }

    /** The preview a drag shows, then the rebuild a commit runs. */
    async function builds(candidate: ProjectDocument): Promise<Built[]> {
      return [
        await adapter.previewGeometry(candidate, { deferTopology: true }),
        await adapter.syncDocument(candidate)
      ];
    }

    const resultOf = (derived: Built, candidate: ProjectDocument) =>
      derived.bodyRepresentations[candidate.bodyOrder.at(-1)!]!;

    function refusalOf(derived: Built) {
      const refusal = (derived.featureWarnings ?? []).find(
        (warning) =>
          warning.featureName === 'Offset Face' &&
          (warning.kind === 'build-failed' || warning.kind === 'refusal')
      );
      expect(refusal, 'the offset is refused').toBeDefined();
      return refusal!;
    }

    /** A drag preview defers the volume; the commit rebuild measures it. */
    function expectVolume(
      derived: Built,
      candidate: ProjectDocument,
      volume: number,
      digits: number
    ) {
      const measured = resultOf(derived, candidate).volume;
      if (measured !== undefined) expect(measured).toBeCloseTo(volume, digits);
    }

    /** The plate as it was: its volume, and bounds inside its own outline. */
    function expectKept(
      derived: Built,
      candidate: ProjectDocument,
      volume: number
    ) {
      expectVolume(derived, candidate, volume, 6);
      const kept = resultOf(derived, candidate);
      expect(kept.bbox.min.y).toBeCloseTo(0, 6);
      expect(kept.bbox.max.y).toBeCloseTo(Y, 6);
      expect(kept.bbox.max.z).toBeCloseTo(Z, 6);
    }

    it('refuses +4, which the kernel builds with a 4.5 mm chamfer', async () => {
      const source = await part('chamfer', 'none');
      expect(source.volume).toBeCloseTo(PLATE_AREA * Z - CHAMFER_VOLUME, 2);
      const candidate = offsetBy(source, 4);
      for (const derived of await builds(candidate)) {
        const refusal = refusalOf(derived);
        expect(refusal.kernelRefusal).toMatchObject({
          family: 'direct-edit',
          operation: 'offset-face',
          category: 'unsupported',
          code: 'offset_face_hole_chamfer_not_carried'
        });
        expect(refusal.message).toContain(
          'offsetting the face cannot move that chamfer with it yet'
        );
        // Nothing of the stretched result is kept.
        expectKept(derived, candidate, source.volume);
      }
    });

    for (const offset of [0.4, 2, 16.5, -1]) {
      it(`never builds a stretched chamfer at ${offset}`, async () => {
        const source = await part('chamfer', 'none');
        const candidate = offsetBy(source, offset);
        for (const derived of await builds(candidate)) {
          // Whether the adapter's check or the kernel caught it, the
          // refusal reads the same and is typed the same.
          expect(refusalOf(derived).kernelRefusal).toMatchObject({
            family: 'direct-edit',
            operation: 'offset-face',
            category: 'unsupported',
            code: 'offset_face_hole_chamfer_not_carried'
          });
          expectKept(derived, candidate, source.volume);
        }
      });
    }

    it('still offsets the plate with plain holes', async () => {
      const source = await part('none', 'none');
      const candidate = offsetBy(source, 4);
      for (const derived of await builds(candidate)) {
        expect(derived.warnings).toEqual([]);
        expectVolume(derived, candidate, PLATE_AREA * (Z + 4), 4);
        expect(resultOf(derived, candidate).bbox.max.z).toBeCloseTo(Z + 4, 6);
      }
    });

    it('leaves a cone on the face outline alone: a frustum end still extends', async () => {
      // A Ø20 → Ø10 frustum, 10 tall. Its top face is bounded by the cone
      // itself, on the face's outer loop: pushing it out extends the flank,
      // which is what offsetting the end of a tapered part means.
      const kernel = new RemusKernel();
      const io = await loadRemusTranslators();
      let step: string;
      try {
        step = new TextDecoder().decode(
          io.exportStep(
            kernel.serializeSolids(Uint32Array.of(kernel.makeCone(10, 5, 10)))
          )
        );
      } finally {
        kernel.free();
      }
      const imported = importStepBody(
        createProjectDocument('Frustum', toUserId('user_offset_hole_chamfer')),
        {
          name: 'Frustum',
          sourceName: 'frustum.step',
          artifactId: 'artifact_frustum',
          stepText: step
        }
      );
      const derived = await adapter.syncDocument(imported.document);
      const body = derived.bodyRepresentations[imported.bodyId]!;
      const top = body.topology!.faces.find(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z > 0.999
      )!;
      const source = {
        document: imported.document,
        bodyId: imported.bodyId,
        top
      };
      const candidate = offsetBy(source, 1);
      // The flank runs on to r = 4.5 at z = 11.
      const frustum = (h: number, r: number) =>
        (Math.PI * h * (100 + 10 * r + r * r)) / 3;
      for (const built of await builds(candidate)) {
        expect(built.warnings).toEqual([]);
        expectVolume(built, candidate, frustum(11, 4.5), 3);
        expect(resultOf(built, candidate).bbox.max.z).toBeCloseTo(11, 6);
      }
    });

    it('accepts the move the kernel carries: a fillet on the other rim', async () => {
      const source = await part('chamfer', 'fillet');
      const candidate = offsetBy(source, 4);
      for (const derived of await builds(candidate)) {
        expect(derived.warnings).toEqual([]);
        // Both rims moved with the face: the body grew by a plain slab.
        expectVolume(derived, candidate, source.volume + PLATE_AREA * 4, 3);
        const moved = resultOf(derived, candidate);
        expect(moved.bbox.min.y).toBeCloseTo(0, 6);
        expect(moved.bbox.max.y).toBeCloseTo(Y, 6);
        expect(moved.bbox.max.z).toBeCloseTo(Z + 4, 6);
      }
    });
  }
);
