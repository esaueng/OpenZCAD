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
 * The adapter refuses any such result, typed, through both the drag preview
 * (prepared move) and the full rebuild a commit uses, and keeps the plate.
 * Since Remus 2026.1.146 (esaueng/remus#1808) the kernel carries a
 * chamfer-only hole mouth with the moved face, so those offsets build: the
 * body grows or shrinks by exactly the plain slab the face sweeps (the
 * chamfer keeps its size and both holes stay through), the bounds stay on
 * the plate, and the guard lets the correct result through. A conical
 * pocket that runs to its apex is still left in place by the kernel, and
 * still refused.
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

/** `chamfer-both` chamfers the hole's bottom rim as well as its top one. */
type Rim = 'chamfer' | 'chamfer-both' | 'fillet' | 'none';

/** The plate, with the first hole's top rim finished as `first` and the second's as `second`. */
function plate(kernel: RemusKernel, first: Rim, second: Rim): number {
  let solid = kernel.makeBox(X, Y, Z);
  for (const x of HOLES) {
    const tool = kernel.makeCylinder(BORE, Z + 4);
    kernel.transformSolid(tool, translation(x, Y / 2, -2));
    solid = kernel.cut(solid, tool);
  }
  const rimAt = (body: number, x: number, z: number) =>
    Array.from(kernel.getSolidEdges(body)).filter((edge) => {
      if (kernel.getEdgeCurveType(edge) !== 'CIRCLE') return false;
      const v = kernel.getEdgeVertices(edge);
      return (
        Math.abs(Math.hypot(v[0]! - x, v[1]! - Y / 2) - BORE) < 1e-6 &&
        Math.abs(v[2]! - z) < 1e-6
      );
    });
  for (const [x, rim] of [
    [HOLES[0], first],
    [HOLES[1], second]
  ] as const) {
    if (rim === 'none') continue;
    const edges = Uint32Array.from(rimAt(solid, x, Z));
    expect(edges.length).toBeGreaterThan(0);
    solid =
      rim === 'fillet'
        ? kernel.fillet(solid, edges, CHAMFER)
        : kernel.chamfer(solid, edges, CHAMFER);
    if (rim === 'chamfer-both') {
      const under = Uint32Array.from(rimAt(solid, x, 0));
      expect(under.length).toBeGreaterThan(0);
      solid = kernel.chamfer(solid, under, CHAMFER);
    }
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
      const bottom = body.topology!.faces.find(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z < -0.999 &&
          Math.abs(face.geometry.center.z) < 1e-6
      )!;
      return {
        document: imported.document,
        bodyId: imported.bodyId,
        top,
        bottom,
        volume: body.volume
      };
    }

    function offsetBy(
      source: { document: ProjectDocument; bodyId: BodyId; top: FaceTopology },
      offset: number,
      /** Store the pick's normal reversed, as a body turned over since has it. */
      reversedNormal = false
    ): ProjectDocument {
      const normal = source.top.geometry!.normal!;
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
            sourceNormal: reversedNormal
              ? { x: -normal.x, y: -normal.y, z: -normal.z }
              : normal,
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

    /**
     * The chamfer moved with the face: no refusal, the body changed by the
     * plain slab the face swept, and it stays on the plate's outline.
     */
    function expectCarried(
      derived: Built,
      candidate: ProjectDocument,
      volume: number,
      bounds: { minZ: number; maxZ: number }
    ) {
      expect(derived.warnings).toEqual([]);
      expect(
        (derived.featureWarnings ?? []).filter(
          (warning) => warning.featureName === 'Offset Face'
        )
      ).toEqual([]);
      expectVolume(derived, candidate, volume, 3);
      const moved = resultOf(derived, candidate);
      expect(moved.bbox.min.x).toBeCloseTo(0, 6);
      expect(moved.bbox.max.x).toBeCloseTo(X, 6);
      expect(moved.bbox.min.y).toBeCloseTo(0, 6);
      expect(moved.bbox.max.y).toBeCloseTo(Y, 6);
      expect(moved.bbox.min.z).toBeCloseTo(bounds.minZ, 6);
      expect(moved.bbox.max.z).toBeCloseTo(bounds.maxZ, 6);
    }

    for (const offset of [4, 0.4, 2, 16.5, -1]) {
      it(`carries the chamfer with the face at ${offset}`, async () => {
        const source = await part('chamfer', 'none');
        expect(source.volume).toBeCloseTo(PLATE_AREA * Z - CHAMFER_VOLUME, 2);
        const candidate = offsetBy(source, offset);
        for (const derived of await builds(candidate)) {
          expectCarried(
            derived,
            candidate,
            source.volume + PLATE_AREA * offset,
            { minZ: 0, maxZ: Z + offset }
          );
        }
      });
    }

    it('moves the face along its current normal when the recorded one is reversed', async () => {
      // Chamfers at both ends of the hole, and an offset equal to the
      // plate's thickness. The kernel moves the face along its current
      // outward normal, so the top rises by Z and the bottom mouth stays.
      const source = await part('chamfer-both', 'none');
      const candidate = offsetBy(source, Z, true);
      for (const derived of await builds(candidate)) {
        expectCarried(derived, candidate, source.volume + PLATE_AREA * Z, {
          minZ: 0,
          maxZ: 2 * Z
        });
      }
    });

    it('carries the chamfer of a face whose outward normal points down', async () => {
      const source = await part('chamfer-both', 'none');
      const candidate = offsetBy({ ...source, top: source.bottom }, 2);
      for (const derived of await builds(candidate)) {
        expectCarried(derived, candidate, source.volume + PLATE_AREA * 2, {
          minZ: -2,
          maxZ: Z
        });
      }
    });

    it('guards a conical pocket that runs to its apex', async () => {
      // A cone-shaped pocket, r 6 at the face down to a point 6 below: its
      // cone has only the rim and a seam, whichever way the seam runs. The
      // kernel leaves the cone in place here too, so the mouth would widen.
      const kernel = new RemusKernel();
      const io = await loadRemusTranslators();
      let step: string;
      try {
        const tool = kernel.makeCone(0, 6, 6);
        kernel.transformSolid(tool, translation(15, 10, 4));
        step = new TextDecoder().decode(
          io.exportStep(
            kernel.serializeSolids(
              Uint32Array.of(kernel.cut(kernel.makeBox(30, 20, 10), tool))
            )
          )
        );
      } finally {
        kernel.free();
      }
      const imported = importStepBody(
        createProjectDocument('Pocket', toUserId('user_offset_hole_chamfer')),
        {
          name: 'Pocket',
          sourceName: 'pocket.step',
          artifactId: 'artifact_pocket',
          stepText: step
        }
      );
      const derived = await adapter.syncDocument(imported.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[imported.bodyId]!;
      expect(body.volume).toBeCloseTo(30 * 20 * 10 - (Math.PI * 36 * 6) / 3, 3);
      const top = body.topology!.faces.find(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z > 0.999 &&
          Math.abs(face.geometry.center.z - 10) < 1e-6
      )!;
      const candidate = offsetBy(
        { document: imported.document, bodyId: imported.bodyId, top },
        1
      );
      for (const built of await builds(candidate)) {
        expect(refusalOf(built).kernelRefusal).toMatchObject({
          family: 'direct-edit',
          category: 'unsupported',
          code: 'offset_face_hole_chamfer_not_carried'
        });
        expectVolume(built, candidate, body.volume, 6);
        expect(resultOf(built, candidate).bbox.max.z).toBeCloseTo(10, 6);
      }
    });

    it('leaves a tapered boss standing on the face alone', async () => {
      // A Ø8 → Ø4 boss, 5 tall, sunk 1 into a 30 × 20 × 5 plate. Its flank
      // meets the plate's top on an inner loop, like a hole's chamfer, but
      // it rises out of the face: raising the face 1 runs it up the flank
      // (the base circle goes from r 3.6 to r 3.2), which is correct.
      const kernel = new RemusKernel();
      const io = await loadRemusTranslators();
      let step: string;
      try {
        const boss = kernel.makeCone(4, 2, 5);
        kernel.transformSolid(boss, translation(15, 10, 4));
        step = new TextDecoder().decode(
          io.exportStep(
            kernel.serializeSolids(
              Uint32Array.of(kernel.fuse(kernel.makeBox(30, 20, 5), boss))
            )
          )
        );
      } finally {
        kernel.free();
      }
      const imported = importStepBody(
        createProjectDocument('Boss', toUserId('user_offset_hole_chamfer')),
        {
          name: 'Boss',
          sourceName: 'boss.step',
          artifactId: 'artifact_boss',
          stepText: step
        }
      );
      const derived = await adapter.syncDocument(imported.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[imported.bodyId]!;
      const top = body.topology!.faces.find(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z > 0.999 &&
          Math.abs(face.geometry.center.z - 5) < 1e-6
      )!;
      const candidate = offsetBy(
        { document: imported.document, bodyId: imported.bodyId, top },
        1
      );
      // The slab the face sweeps, less the boss it now covers between
      // z = 5 (r 3.6) and z = 6 (r 3.2).
      const covered = (Math.PI * (3.6 * 3.6 + 3.6 * 3.2 + 3.2 * 3.2)) / 3;
      for (const built of await builds(candidate)) {
        expect(built.warnings).toEqual([]);
        expectVolume(built, candidate, body.volume + 30 * 20 - covered, 3);
        expect(resultOf(built, candidate).bbox.max.z).toBeCloseTo(9, 6);
      }
    });

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
