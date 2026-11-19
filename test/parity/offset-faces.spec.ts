/**
 * Multi-face Offset (`offset-faces`): faces that all face the same way
 * pushed or pulled together by one distance. Faces on one plane move in a
 * single Remus `moveFaces` call; parallel faces at different heights move as
 * a chain of such calls, one per plane, each later face carried through the
 * step's exact journal face map.
 *
 * The body: a 40 × 20 × 10 block with a 10 wide, 5 deep slot cut across its
 * top, imported from STEP so its faces carry no construction names. The slot
 * splits the top into two coplanar 15 × 20 faces; the slot's floor is
 * parallel to them, 5 lower. Kept beside the parity corpus because a kernel
 * refresh can move the group move, its refusals, the chain's face maps, or
 * the drag preview's prepared path, and each would otherwise ship silently.
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
import { shoulderCapStep } from '../support/shoulder-cap';

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

describe('offset a face set', { timeout: 180_000 }, () => {
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

  /** A body's shape, as plain data two builds can be compared by. */
  function shapeOf(body: GeometryBodyRepresentation & { volume?: number }) {
    const topology = body.topology!;
    return {
      faces: topology.faces.length,
      edges: topology.edges.length,
      edgeLengths: topology.edges
        .map((edge) => Number(edge.length!.toFixed(6)))
        .sort((a, b) => a - b),
      vertices: (topology.vertices ?? [])
        .map(({ point }) =>
          [point.x, point.y, point.z].map((value) => value.toFixed(6)).join()
        )
        .sort()
    };
  }

  /**
   * The same moves made as single `offset-face` features, one after another:
   * each face found again on the body the previous feature built.
   */
  async function singleOffsets(
    picks: ((face: FaceTopology) => boolean)[],
    offset: number
  ) {
    let document = source.document;
    let derived = await adapter.syncDocument(document);
    for (const pick of picks) {
      const face =
        derived.bodyRepresentations[source.bodyId]!.topology!.faces.find(pick);
      expect(face).toBeDefined();
      document = commandFactories
        .directEditBody({
          name: 'Offset Face',
          targetBodyId: source.bodyId,
          operation: { kind: 'offset-face', ...snapshot(face!), offset }
        })
        .apply(document);
      derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
    }
    return derived.bodyRepresentations[source.bodyId]!;
  }

  for (const offset of [2, -2, 6]) {
    it(`moves both tops and the slot floor by ${offset}, as single offsets would`, async () => {
      // Two planes, three faces: the tops move as one group, the floor as
      // another, leading plane first. At +6 the floor ends above the tops'
      // old height, which only that order reaches.
      const floorArea = source.floor.geometry!.area;
      const candidate = offsetFaces([...source.tops, source.floor], offset);
      const built = await builds(candidate);
      for (const derived of built) {
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[source.bodyId]!;
        if (body.volume !== undefined) {
          expect(body.volume).toBeCloseTo(
            SOURCE_VOLUME + (2 * TOP_AREA + floorArea) * offset,
            6
          );
        }
        expect(body.bbox.max.z).toBeCloseTo(Z + offset, 9);
      }
      const chained = built[1]!.bodyRepresentations[source.bodyId]!;
      const floorAt = (z: number) => (face: FaceTopology) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal!.z > 0.999 &&
        Math.abs(face.geometry.center.z - z) < 1e-6 &&
        Math.abs(face.geometry.center.x - X / 2) < 1e-6;
      const topAt = (side: 1 | -1, z: number) => (face: FaceTopology) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal!.z > 0.999 &&
        Math.abs(face.geometry.center.z - z) < 1e-6 &&
        Math.sign(face.geometry.center.x - X / 2) === side;
      const tops = [topAt(-1, Z), topAt(1, Z)];
      const floor = floorAt(Z - SLOT_DEPTH);
      const single = await singleOffsets(
        offset > 0 ? [...tops, floor] : [floor, ...tops],
        offset
      );
      expect(chained.volume).toBeCloseTo(single.volume, 6);
      expect(shapeOf(chained)).toEqual(shapeOf(single));
      const step = await adapter.exportStep(candidate, [source.bodyId]);
      const inspected = await adapter.inspectStep(step);
      expect(inspected).toMatchObject({ solid: true, valid: true });
      expect(inspected.volume).toBeCloseTo(single.volume, 4);
    });
  }

  it('builds the same solid whatever order the faces are stored in', async () => {
    const [a, b] = source.tops as [FaceTopology, FaceTopology];
    const shapes = [];
    for (const order of [
      [a, b, source.floor],
      [source.floor, b, a],
      [b, source.floor, a]
    ]) {
      const derived = await adapter.syncDocument(offsetFaces(order, 3));
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[source.bodyId]!;
      shapes.push({ volume: body.volume.toFixed(6), ...shapeOf(body) });
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it('refuses a top with the bottom: opposite normals', async () => {
    const bottom = (
      await adapter.syncDocument(source.document)
    ).bodyRepresentations[source.bodyId]!.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal!.z < -0.999
    );
    expect(bottom).toBeDefined();
    for (const derived of await builds(
      offsetFaces([source.tops[0]!, bottom!], 2)
    )) {
      expect(derived.warnings.join('\n')).toContain(
        'The selected faces face opposite ways, so one offset would thicken one and thin the other. Offset them separately.'
      );
    }
  });

  it('refuses a later step that would run into a face left behind', async () => {
    // One top leads up by 6; the slot floor follows to 11, past the other
    // top, still at 10 and not in the set.
    const derived = await adapter.syncDocument(
      offsetFaces([source.tops[0]!, source.floor], 6)
    );
    expect(derived.warnings.join('\n')).toContain(
      "Offsetting face 2 after the others would change the body's topology. Offset fewer faces, or a smaller distance."
    );
    expect(derived.bodyRepresentations[source.bodyId]!.volume).toBeCloseTo(
      SOURCE_VOLUME,
      6
    );
  });

  it('refuses the slot floor with a slot wall: faces that share an edge', async () => {
    const derived = await adapter.syncDocument(
      offsetFaces([source.floor, source.wall], 2)
    );
    expect(derived.warnings.join('\n')).toContain(
      'the selected faces meet at an edge and face different directions'
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
  it('refuses a set the kernel can move only with approximate surfaces', async () => {
    // The R5-filleted shoulder of the shoulder-cap fixture, beside a post
    // bridged to it whose top is on the shoulder's plane. Raised 5 together,
    // the shoulder's rim can be rebuilt only by the sampled cap join a
    // single offset discloses; a set stays exact and takes the refusal.
    const height = 19.1;
    const io = await loadRemusTranslators();
    const kernel = new RemusKernel();
    let step: string;
    try {
      let solid = kernel.deserializeSolids(
        io.importStep(await shoulderCapStep())
      )[0]!;
      const bridge = kernel.makeBox(14, 20, 5);
      kernel.transformSolid(bridge, translation(31, 0, 0));
      const post = kernel.makeBox(10, 20, height);
      kernel.transformSolid(post, translation(40, 0, 0));
      solid = kernel.fuse(kernel.fuse(solid, bridge), post);
      step = new TextDecoder().decode(
        io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)))
      );
    } finally {
      kernel.free();
    }
    const imported = importStepBody(
      createProjectDocument('Shoulder and post', toUserId('user_offset_faces')),
      {
        name: 'Shoulder',
        sourceName: 'shoulder.step',
        artifactId: 'artifact_shoulder_post',
        stepText: step
      }
    );
    const derived = await adapter.syncDocument(imported.document);
    expect(derived.warnings).toEqual([]);
    const before = derived.bodyRepresentations[imported.bodyId]!;
    const tops = before.topology!.faces.filter(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal!.z > 0.999 &&
        Math.abs(face.geometry.center.z - height) < 1e-6
    );
    expect(tops).toHaveLength(2);
    const [first, ...rest] = tops.map(snapshot);
    const candidate = commandFactories
      .directEditBody({
        name: 'Offset Faces',
        targetBodyId: imported.bodyId,
        operation: {
          kind: 'offset-faces',
          ...first!,
          offset: 5,
          additionalFaces: rest
        }
      })
      .apply(imported.document);
    const edited = await adapter.syncDocument(candidate);
    expect(edited.warnings).toHaveLength(1);
    expect(edited.warnings[0]).not.toContain('approximate');
    expect(
      (edited.featureWarnings ?? []).map((warning) => warning.kind)
    ).toEqual(['build-failed']);
    expect(edited.bodyRepresentations[imported.bodyId]!.volume).toBeCloseTo(
      before.volume,
      6
    );
  });
});

describe(
  'offset a face set across planes, at the edges of tolerance',
  {
    timeout: 180_000
  },
  () => {
    let adapter: RemusKernelAdapter;
    beforeAll(() => {
      adapter = new RemusKernelAdapter();
    });
    afterAll(() => {
      adapter.dispose();
    });

    /**
     * The slotted block, built by the kernel: `depth` deep, the whole body
     * raised `lift` in z, the slot's floor tilted `tiltDeg` about y.
     */
    async function slotted(depth: number, lift = 0, tiltDeg = 0) {
      const kernel = new RemusKernel();
      const io = await loadRemusTranslators();
      let step: string;
      try {
        const block = kernel.makeBox(X, Y, Z);
        const slot = kernel.makeBox(SLOT_WIDTH, Y + 4, depth + 2);
        const t = (tiltDeg * Math.PI) / 180;
        const [c, s] = [Math.cos(t), Math.sin(t)];
        kernel.transformSolid(
          slot,
          Float64Array.of(
            c,
            0,
            s,
            (X - SLOT_WIDTH) / 2,
            0,
            1,
            0,
            -2,
            -s,
            0,
            c,
            Z - depth,
            0,
            0,
            0,
            1
          )
        );
        const body = kernel.cut(block, slot);
        kernel.transformSolid(body, translation(0, 0, lift));
        step = new TextDecoder().decode(
          io.exportStep(kernel.serializeSolids(Uint32Array.of(body)))
        );
      } finally {
        kernel.free();
      }
      const imported = importStepBody(
        createProjectDocument('Slotted block', toUserId('user_offset_faces')),
        {
          name: 'Block',
          sourceName: 'block.step',
          artifactId: 'artifact_slotted_edge',
          stepText: step
        }
      );
      const derived = await adapter.syncDocument(imported.document);
      expect(derived.warnings).toEqual([]);
      const ups = derived.bodyRepresentations[
        imported.bodyId
      ]!.topology!.faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z > 0.999
      ).sort((a, b) => b.geometry!.center.z - a.geometry!.center.z);
      expect(ups).toHaveLength(3);
      return {
        document: imported.document,
        bodyId: imported.bodyId,
        tops: ups.slice(0, 2),
        floor: ups[2]!
      };
    }

    function offsetFaces(
      body: Awaited<ReturnType<typeof slotted>>,
      offset: number,
      sourceNormal?: { x: number; y: number; z: number }
    ) {
      const [first, ...rest] = [...body.tops, body.floor].map((face) => ({
        faceHash: face.hash,
        ...(face.reference ? { faceReference: face.reference } : {}),
        sourceSurfaceType: 'plane' as const,
        sourceArea: face.geometry!.area,
        sourceCenter: face.geometry!.center,
        sourceNormal: sourceNormal ?? face.geometry!.normal!
      }));
      return commandFactories
        .directEditBody({
          name: 'Offset Faces',
          targetBodyId: body.bodyId,
          operation: {
            kind: 'offset-faces',
            ...first!,
            offset,
            additionalFaces: rest
          }
        })
        .apply(body.document);
    }

    it('refuses a floor tilted within the replay tolerance', async () => {
      // 0.05° passes the cosine a stored normal is held to, but the chain's
      // separate steps would move two planes that are not parallel.
      const body = await slotted(SLOT_DEPTH, 0, 0.05);
      const derived = await adapter.syncDocument(offsetFaces(body, 2));
      expect(derived.warnings.join('\n')).toContain(
        'the selected faces face different directions'
      );
    });

    it('tells a shallow step apart however far the body sits from the origin', async () => {
      for (const lift of [0, 100_000]) {
        const body = await slotted(0.0005, lift);
        const derived = await adapter.syncDocument(offsetFaces(body, 0.0001));
        expect(derived.warnings).toEqual([]);
        expect(
          derived.bodyRepresentations[body.bodyId]!.bbox.max.z
        ).toBeCloseTo(lift + Z + 0.0001, 6);
      }
    });

    it('groups and orders by the body, not by slightly stale stored normals', async () => {
      // Stored normals tilted 0.05° about y, within the replay tolerance:
      // projected on them the two tops would differ by more than the step.
      const body = await slotted(0.005);
      const t = (0.05 * Math.PI) / 180;
      const shapes = [];
      for (const normal of [
        undefined,
        { x: Math.sin(t), y: 0, z: Math.cos(t) }
      ]) {
        const derived = await adapter.syncDocument(
          offsetFaces(body, 0.01, normal)
        );
        expect(derived.warnings).toEqual([]);
        const built = derived.bodyRepresentations[body.bodyId]!;
        expect(built.bbox.max.z).toBeCloseTo(Z + 0.01, 9);
        shapes.push({
          volume: built.volume.toFixed(6),
          faces: built.topology!.faces.length
        });
      }
      expect(shapes[1]).toEqual(shapes[0]);
    });
  }
);
