/**
 * Multi-face Offset (`offset-faces`): faces on one plane pushed or pulled
 * together by one distance through a single Remus `moveFaces` call.
 *
 * The body: a 40 × 20 × 10 block with a 10 wide, 5 deep slot cut across its
 * top, imported from STEP so its faces carry no construction names. The slot
 * splits the top into two coplanar 15 × 20 faces; the slot's floor is
 * parallel to them, 5 lower. Kept beside the parity corpus because a kernel
 * refresh can move the group move, its refusals, or the drag preview's
 * prepared path, and each would otherwise ship silently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commandFactories } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { RemusKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DirectEditOperation,
  type FaceTopology,
  type GeometryBodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

const X = 40;
const Y = 20;
const Z = 10;
const SLOT_WIDTH = 10;
const SLOT_DEPTH = 5;
const TOP_AREA = ((X - SLOT_WIDTH) / 2) * Y;
const SOURCE_VOLUME = X * Y * Z - SLOT_WIDTH * Y * SLOT_DEPTH;

interface Built {
  bodyRepresentations: Record<
    BodyId,
    GeometryBodyRepresentation & { volume?: number }
  >;
  warnings: string[];
}

const translation = (x: number, y: number, z: number) =>
  Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);

describe('offset a coplanar face set', { timeout: 180_000 }, () => {
  let adapter: RemusKernelAdapter;
  let source: {
    document: ProjectDocument;
    bodyId: BodyId;
    tops: FaceTopology[];
    floor: FaceTopology;
    wall: FaceTopology;
  };

  beforeAll(async () => {
    adapter = new RemusKernelAdapter();
    const kernel = new RemusKernel();
    const io = await loadRemusTranslators();
    let step: string;
    try {
      const block = kernel.makeBox(X, Y, Z);
      const slot = kernel.makeBox(SLOT_WIDTH, Y + 4, SLOT_DEPTH + 2);
      kernel.transformSolid(
        slot,
        translation((X - SLOT_WIDTH) / 2, -2, Z - SLOT_DEPTH)
      );
      step = new TextDecoder().decode(
        io.exportStep(
          kernel.serializeSolids(Uint32Array.of(kernel.cut(block, slot)))
        )
      );
    } finally {
      kernel.free();
    }
    const imported = importStepBody(
      createProjectDocument('Slotted block', toUserId('user_offset_faces')),
      {
        name: 'Block',
        sourceName: 'block.step',
        artifactId: 'artifact_slotted_block',
        stepText: step
      }
    );
    const derived = await adapter.syncDocument(imported.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[imported.bodyId]!;
    expect(body.volume).toBeCloseTo(SOURCE_VOLUME, 6);
    const faces = body.topology!.faces;
    const upAt = (z: number) =>
      faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z > 0.999 &&
          Math.abs(face.geometry.center.z - z) < 1e-6
      );
    const tops = upAt(Z);
    expect(tops).toHaveLength(2);
    for (const top of tops) expect(top.geometry!.area).toBeCloseTo(TOP_AREA, 9);
    const [floor] = upAt(Z - SLOT_DEPTH);
    const wall = faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal!.x > 0.999 &&
        Math.abs(face.geometry.center.x - (X - SLOT_WIDTH) / 2) < 1e-6
    );
    expect(floor && wall).toBeDefined();
    source = {
      document: imported.document,
      bodyId: imported.bodyId,
      tops,
      floor: floor!,
      wall: wall!
    };
  });

  afterAll(() => {
    adapter.dispose();
  });

  const snapshot = (face: FaceTopology) => ({
    faceHash: face.hash,
    ...(face.reference ? { faceReference: face.reference } : {}),
    sourceSurfaceType: 'plane' as const,
    sourceArea: face.geometry!.area,
    sourceCenter: face.geometry!.center,
    sourceNormal: face.geometry!.normal!
  });

  function offsetFaces(
    faces: FaceTopology[],
    offset: number,
    patch: Partial<Extract<DirectEditOperation, { kind: 'offset-faces' }>> = {}
  ): ProjectDocument {
    const [first, ...rest] = faces.map(snapshot);
    return commandFactories
      .directEditBody({
        name: 'Offset Faces',
        targetBodyId: source.bodyId,
        operation: {
          kind: 'offset-faces',
          ...first!,
          offset,
          additionalFaces: rest,
          ...patch
        }
      })
      .apply(source.document);
  }

  /** The preview a drag shows (prepared move), then the commit's rebuild. */
  async function builds(candidate: ProjectDocument): Promise<Built[]> {
    return [
      await adapter.previewGeometry(candidate, { deferTopology: true }),
      await adapter.syncDocument(candidate)
    ];
  }

  for (const offset of [2, -2]) {
    it(`moves both tops by ${offset}, exactly`, async () => {
      const candidate = offsetFaces(source.tops, offset);
      const built = await builds(candidate);
      for (const derived of built) {
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[source.bodyId]!;
        if (body.volume !== undefined) {
          expect(body.volume).toBeCloseTo(
            SOURCE_VOLUME + 2 * TOP_AREA * offset,
            6
          );
        }
        expect(body.bbox.max.z).toBeCloseTo(Z + offset, 9);
        expect(body.bbox.min.z).toBeCloseTo(0, 9);
      }
      const step = await adapter.exportStep(candidate, [source.bodyId]);
      const inspected = await adapter.inspectStep(step);
      expect(inspected).toMatchObject({ solid: true, valid: true });
      expect(inspected.volume).toBeCloseTo(
        SOURCE_VOLUME + 2 * TOP_AREA * offset,
        4
      );
    });
  }

  it('refuses a top with the slot floor: parallel, not coplanar', async () => {
    for (const derived of await builds(
      offsetFaces([source.tops[0]!, source.floor], 2)
    )) {
      expect(derived.warnings.join('\n')).toContain(
        'the selected faces are parallel but at different heights'
      );
    }
  });

  it('refuses a top with a slot wall: different normals', async () => {
    const derived = await adapter.syncDocument(
      offsetFaces([source.tops[0]!, source.wall], 2)
    );
    expect(derived.warnings.join('\n')).toContain(
      'the selected faces face different directions'
    );
    expect(derived.bodyRepresentations[source.bodyId]!.volume).toBeCloseTo(
      SOURCE_VOLUME,
      6
    );
  });

  it('refuses a stale additional face instead of moving another', async () => {
    // The second top as an upstream edit would leave it: its name is one
    // the body no longer publishes.
    const stale = snapshot(source.tops[1]!);
    expect(stale.faceReference?.lineageName).toMatch(/^import\.step\.face\./);
    const derived = await adapter.syncDocument(
      offsetFaces(source.tops, 2, {
        additionalFaces: [
          {
            ...stale,
            faceReference: {
              ...stale.faceReference!,
              lineageName: 'import.step.face.00000000'
            }
          }
        ]
      })
    );
    expect(derived.warnings.join('\n')).toContain(
      'Face 2 of the offset set no longer matches the body. Select the faces again.'
    );
    expect(derived.bodyRepresentations[source.bodyId]!.volume).toBeCloseTo(
      SOURCE_VOLUME,
      6
    );
  });

  it('an unknown edit kind refuses whole, as an older build meets this one', async () => {
    const candidate = offsetFaces(source.tops, 2);
    const feature = Object.values(candidate.nodes).find(
      (node) => node.kind === 'feature' && node.name === 'Offset Faces'
    )!;
    // The kind an older build has never heard of: it must skip the edit,
    // never move the first face alone.
    const future = structuredClone(candidate);
    const data = (
      future.nodes[feature.id] as typeof feature & {
        data: { operation: { kind: string } };
      }
    ).data;
    data.operation.kind = 'offset-faces-from-a-newer-build';
    const derived = await adapter.syncDocument(future);
    expect(derived.warnings.join('\n')).toContain(
      'Direct-edit operation kind is not supported.'
    );
    expect(derived.bodyRepresentations[source.bodyId]!.volume).toBeCloseTo(
      SOURCE_VOLUME,
      6
    );
  });
});
