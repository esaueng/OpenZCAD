/**
 * Face names after a boss-wall resize on a filleted box ∪ cylinder.
 *
 * The kernel's journaled cylinder resize rebuilds a boss in a different face
 * order and binds its outputs to the source faces positionally, marked
 * `provenance: "inferred"`. Consumed as construction history, that pairing
 * moved names onto unrelated faces — a side plane's name onto the top, the
 * top's onto the bottom — and published one name on two faces, so a later
 * push of the top face refused with "Direct-edit face is stale: The selected
 * face lineage resolves to multiple compatible candidates."
 *
 * Inferred bindings are now refused, so the faces they would have named are
 * hash-only. A document saved while they were consumed stores those wrong
 * names; its features must still find their faces (ADR-013 step 2).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { filletEdges } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type {
  BodyId,
  BodyRepresentation,
  FaceTopology,
  ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  JUNCTION_FILLET_DISCLOSURE,
  filletedUnion
} from './support/filleted-union';

function cylinderWall(body: BodyRepresentation, radius: number): FaceTopology {
  const walls = body.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs(face.geometry.radius! - radius) < 1e-9
  );
  expect(walls).toHaveLength(1);
  return walls[0]!;
}

function boxTop(body: BodyRepresentation): FaceTopology {
  // The largest upward plane: the box top, not the cylinder's own cap.
  return body
    .topology!.faces.filter(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal!.z > 1 - 1e-9
    )
    .sort((a, b) => b.geometry!.area - a.geometry!.area)[0]!;
}

function identity(face: FaceTopology): string | null {
  return face.reference
    ? `${face.reference.producingFeatureId}:${face.reference.lineageName}`
    : null;
}

/** Exact planar carrier: a resize of a cylinder never moves a plane. */
function planeKey(face: FaceTopology): string | null {
  const g = face.geometry;
  if (g?.surfaceType !== 'plane' || !g.normal || g.planeOffset === undefined)
    return null;
  const r = (value: number) => Math.round(value * 1e6) / 1e6 + 0;
  return [g.normal.x, g.normal.y, g.normal.z, g.planeOffset].map(r).join(',');
}

/**
 * The public filleted union with its cylinder's top rim rounded as well, by
 * hash as an older pick stores it. With that band in place the resized boss
 * comes back in a different face order from the one it was built in.
 */
async function roundedUnion(adapter: ExactKernelAdapter) {
  const model = await filletedUnion(adapter, { heightEdit: false, radius: 2 });
  const faceName = (hash: number) =>
    model.body.topology!.faces.find((face) => face.hash === hash)?.reference
      ?.lineageName ?? '';
  const rim = model.body.topology!.edges.filter((edge) => {
    const names = (edge.adjacentFaceHashes ?? []).map(faceName);
    return (
      names.some((name) => name.endsWith('primitive.cylinder.face.wall')) &&
      names.some((name) => name.endsWith('primitive.cylinder.face.cap.end'))
    );
  });
  expect(rim.length).toBeGreaterThan(0);
  const rounded = filletEdges(model.document, {
    name: 'Rim fillet',
    targetBodyId: model.bodyId,
    edgeHashes: rim.map((edge) => edge.hash),
    size: 2
  });
  const derived = await adapter.syncDocument(rounded.document);
  expect(derived.warnings).toEqual([JUNCTION_FILLET_DISCLOSURE]);
  return {
    document: { ...rounded.document, derived },
    bodyId: rounded.bodyId,
    body: derived.bodyRepresentations[rounded.bodyId]!
  };
}

/** The app's Resize Cylinder of the boss wall, recording the wall's name. */
function resizeWall(
  document: ProjectDocument,
  bodyId: BodyId,
  wall: FaceTopology,
  radius: number
): ProjectDocument {
  const g = wall.geometry!;
  return new CommandManager(document).runTransaction('Resize Cylinder', [
    commandFactories.directEditBody({
      name: 'Resize Cylinder',
      targetBodyId: bodyId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: wall.hash,
        ...(wall.reference ? { faceReference: wall.reference } : {}),
        sourceRadius: g.radius!,
        sourceAxisStart: g.axisStart!,
        sourceAxisEnd: g.axisEnd!,
        concavity: 'boss',
        radius
      }
    })
  ]);
}

describe('boss cylinder resize face lineage', { timeout: 180_000 }, () => {
  let adapter: ExactKernelAdapter;
  let base: ProjectDocument;
  let resized: ProjectDocument;
  let bodyId: BodyId;
  let before: BodyRepresentation;
  let after: BodyRepresentation;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    const model = await roundedUnion(adapter);
    base = model.document;
    bodyId = model.bodyId;
    before = model.body;
    resized = resizeWall(base, bodyId, cylinderWall(before, 6), 4.75);
    const derived = await adapter.syncDocument(resized);
    expect(derived.warnings).toEqual([JUNCTION_FILLET_DISCLOSURE]);
    resized = { ...resized, derived };
    after = derived.bodyRepresentations[bodyId]!;
    cylinderWall(after, 4.75);
  }, 180_000);
  afterAll(() => adapter.dispose());

  it('publishes each face name at most once', () => {
    const names = after
      .topology!.faces.map(identity)
      .filter((name): name is string => name !== null);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never moves a plane’s name onto a different plane', () => {
    const carrierOf = new Map(
      before.topology!.faces.flatMap((face) => {
        const name = identity(face);
        const key = planeKey(face);
        return name && key ? [[name, key] as const] : [];
      })
    );
    let checked = 0;
    for (const face of after.topology!.faces) {
      const name = identity(face);
      const was = name ? carrierOf.get(name) : undefined;
      if (!was) continue;
      checked += 1;
      expect({ name, carrier: planeKey(face) }).toEqual({
        name,
        carrier: was
      });
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.each([2, -3, 4])(
    'pushes the box top by %s mm after the resize',
    async (offset) => {
      const top = boxTop(after);
      const plan = planFaceOffset({
        document: resized,
        bodyId,
        face: top,
        faceHash: top.hash,
        offset
      });
      expect(plan?.kind).toBe('direct-edit');
      const pushed = await adapter.syncDocument(
        new CommandManager(resized).runTransaction('Offset Face', [
          plan!.command
        ])
      );
      expect(pushed.warnings).toEqual([JUNCTION_FILLET_DISCLOSURE]);
      expect(
        boxTop(pushed.bodyRepresentations[bodyId]!).geometry!.center.z
      ).toBeCloseTo(top.geometry!.center.z + offset, 6);
    }
  );

  it('explains a push into the cylinder’s rounded rim as a real limit', async () => {
    // The top would rise into the rim band, a face it does not border: a
    // real limit, refused as one rather than as an internal failure.
    const top = boxTop(after);
    const plan = planFaceOffset({
      document: resized,
      bodyId,
      face: top,
      faceHash: top.hash,
      offset: 8
    });
    const pushed = await adapter.syncDocument(
      new CommandManager(resized).runTransaction('Offset Face', [plan!.command])
    );
    // Not a stale name: the kernel's own topology guard, which the card
    // explains in plain words.
    expect(pushed.warnings).toHaveLength(2);
    const refusal = pushed.warnings[1]!;
    expect(refusal).toMatch(/swept face reaches nonadjacent face/);
    expect(refusal).not.toMatch(/stale/);
    expect(
      plainRefusal(refusal.replace(/^Feature "[^"]+":\s*/, '')).message
    ).toBe(
      'The face would run into another part of the body before it got that far.'
    );
  });
});

describe(
  'a document saved while inferred bindings named faces',
  {
    timeout: 180_000
  },
  () => {
    it('still replays a later edit that stored a misplaced name', async () => {
      // Author the history the way the reader did before: every inferred
      // binding taken as construction history.
      const read = RemusKernel.prototype.resolveOperationOutput;
      const asConstruction = vi
        .spyOn(RemusKernel.prototype, 'resolveOperationOutput')
        .mockImplementation(function (this: RemusKernel, op, kind, index) {
          return read
            .call(this, op, kind, index)
            .replace('"provenance":"inferred"', '"provenance":"construction"');
        });
      const legacy = await createExactKernelAdapter();
      let saved: ProjectDocument;
      let bodyId: BodyId;
      try {
        const model = await roundedUnion(legacy);
        bodyId = model.bodyId;
        const first = resizeWall(
          model.document,
          bodyId,
          cylinderWall(model.body, 6),
          4.75
        );
        const derived = await legacy.syncDocument(first);
        expect(derived.warnings).toEqual([JUNCTION_FILLET_DISCLOSURE]);
        const wall = cylinderWall(derived.bodyRepresentations[bodyId]!, 4.75);
        // The old reader named the resized wall after some other face.
        expect(wall.reference).toBeDefined();
        expect(wall.reference!.lineageName).not.toMatch(
          /cylinder\.face\.wall$/
        );
        saved = resizeWall({ ...first, derived }, bodyId, wall, 4);
      } finally {
        asConstruction.mockRestore();
        legacy.dispose();
      }

      const reopened = await createExactKernelAdapter();
      try {
        const replay = await reopened.syncDocument(saved);
        expect(replay.warnings).toEqual([JUNCTION_FILLET_DISCLOSURE]);
        cylinderWall(replay.bodyRepresentations[bodyId]!, 4);
      } finally {
        reopened.dispose();
      }
    });
  }
);
