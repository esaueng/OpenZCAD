/**
 * M07 with K05: editing one of several repeated curved patches never moves a
 * neighbouring sibling patch, including on replay.
 *
 * The fixture is an invented slotted block. A 30 mm cube carries an R5 bore
 * along z, and two 2 mm slots cross the bore at z 9–11 and z 19–21, so the
 * bore's single wall comes back as three repeated patches with interrupted
 * trims: A spans z 0–9, B z 11–19 and C z 21–30. A and C are congruent and
 * differ only in position. Beside the block stands an uninterrupted R5
 * cylinder as the control. Every expected value is closed form:
 *
 * - block: 30³ − 30·25π − 2·(30·14·2 − 2·25π) = 25320 − 650π
 * - resizing B from r to R changes the volume by π(r² − R²)·8, since B is a
 *   hole; the slot walls it opens into are re-trimmed and nothing else moves.
 *
 * Two variants pin the partial-turn reading of the same layout: a trough (the
 * bore broken out through the block's top, so each patch is a half-turn
 * concave wall) and ribs (half-round bosses on a plate, split by gaps). The
 * pinned kernel refuses a partial wall among other curved faces; those cells
 * prove the refusal is typed and leaves every patch where it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  directEditBody,
  listFeaturesInOrder,
  normalizeDocument,
  transformBody,
  updateFeature,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type DirectEditOperation,
  type FaceTopology,
  type FeatureNode,
  type PrimitiveKind,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import { cylinderResizeFold } from '../apps/web/src/lib/interaction/cylinderResizeFold';
import { primitiveCylinderRadiusEdit } from '../apps/web/src/lib/interaction/cylinderPrimitiveAncestry';
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';

const BASE_VOLUME = 25320 - 650 * Math.PI;
const SPANS = { A: [0, 9], B: [11, 19], C: [21, 30] } as const;
type Patch = keyof typeof SPANS;

interface Model {
  document: ProjectDocument;
  bodyId: BodyId;
  controlId?: BodyId;
}

function builder(title: string) {
  let document = createProjectDocument(
    title,
    toUserId('user_repeated_patches')
  );
  const place = (
    name: string,
    primitiveKind: PrimitiveKind,
    dimensions: Record<string, number>,
    translation: Vector3
  ): BodyId => {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind,
      dimensions
    });
    const id = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: `Place ${name}`,
      targetBodyId: id,
      translation
    }).document;
    return id;
  };
  const combine = (
    name: string,
    operation: 'union' | 'subtract',
    targetBodyIds: BodyId[]
  ): BodyId => {
    const result = booleanBodies(document, { name, operation, targetBodyIds });
    document = result.document;
    return result.bodyId;
  };
  return { place, combine, document: () => document };
}

/**
 * The slotted block. `trough` lowers the block's top to the bore axis, so
 * the bore breaks out and every patch is a half-turn wall.
 */
function slottedBlock(variant: 'bore' | 'trough' = 'bore'): Model {
  const b = builder('Slotted block');
  const top = variant === 'bore' ? 15 : 0;
  let bodyId = b.place(
    'Block',
    'box',
    { width: 30, height: top + 15, depth: 30 },
    { x: -15, y: -15, z: 0 }
  );
  const bore = b.place(
    'Bore',
    'cylinder',
    { radius: 5, height: 32 },
    { x: 0, y: 0, z: -1 }
  );
  bodyId = b.combine('Drill', 'subtract', [bodyId, bore]);
  for (const [index, z] of [9, 19].entries()) {
    const slot = b.place(
      `Slot ${index + 1}`,
      'box',
      { width: 32, height: variant === 'bore' ? 14 : 8, depth: 2 },
      { x: -16, y: -7, z }
    );
    bodyId = b.combine(`Cut slot ${index + 1}`, 'subtract', [bodyId, slot]);
  }
  if (variant === 'trough') return { document: b.document(), bodyId };
  const controlId = b.place(
    'Control',
    'cylinder',
    { radius: 5, height: 30 },
    { x: 40, y: 0, z: 0 }
  );
  return { document: b.document(), bodyId, controlId };
}

/** Half-round R10 ribs on a plate, split by the 2 mm gaps between them. */
function ribbedPlate(): Model {
  const b = builder('Ribbed plate');
  let bodyId = b.place(
    'Plate',
    'box',
    { width: 30, height: 10, depth: 30 },
    { x: -15, y: -10, z: 0 }
  );
  for (const [lo, hi] of Object.values(SPANS)) {
    const rib = b.place(
      `Rib ${lo}`,
      'cylinder',
      { radius: 10, height: hi - lo },
      { x: 0, y: 0, z: lo }
    );
    bodyId = b.combine(`Join rib ${lo}`, 'union', [bodyId, rib]);
  }
  return { document: b.document(), bodyId };
}

function walls(body: BodyRepresentation): FaceTopology[] {
  return body.topology!.faces.filter(
    (face) => face.geometry?.surfaceType === 'cylinder'
  );
}

function span(face: FaceTopology): [number, number] {
  const { axisStart, axisEnd } = face.geometry!;
  return [
    Math.min(axisStart!.z, axisEnd!.z),
    Math.max(axisStart!.z, axisEnd!.z)
  ];
}

/** The one wall of `body` on the bore axis spanning exactly z lo–hi. */
function patchAt(
  body: BodyRepresentation,
  [lo, hi]: readonly [number, number]
) {
  const found = walls(body).filter((face) => {
    const [start, end] = span(face);
    const { axisStart } = face.geometry!;
    return (
      Math.abs(start - lo) < 1e-6 &&
      Math.abs(end - hi) < 1e-6 &&
      Math.hypot(axisStart!.x, axisStart!.y) < 1e-6
    );
  });
  expect(found, `one wall spanning z ${lo}–${hi}`).toHaveLength(1);
  return found[0]!;
}

const patch = (body: BodyRepresentation, name: Patch) =>
  patchAt(body, SPANS[name]);

/** Every bore-axis wall as `[lo, hi] radius`, in axial order. */
function layout(body: BodyRepresentation): string[] {
  return walls(body)
    .filter(
      (face) =>
        Math.hypot(face.geometry!.axisStart!.x, face.geometry!.axisStart!.y) <
        1e-6
    )
    .map((face) => {
      const [lo, hi] = span(face);
      return `[${lo}, ${hi}] r${+face.geometry!.radius!.toFixed(9)}`;
    })
    .sort((a, b) => parseFloat(a.slice(1)) - parseFloat(b.slice(1)));
}

/** What a sibling or the control must keep: identity, carrier and trims. */
function snapshot(face: FaceTopology) {
  const g = face.geometry!;
  return {
    hash: face.hash,
    radius: g.radius,
    area: g.area,
    axisStart: g.axisStart,
    axisEnd: g.axisEnd
  };
}

type Route = 'resize-through-hole' | 'resize-cylindrical-face';

/**
 * The edit as the product writes it. A bore patch measures as a
 * `through-hole`, so the radius drag commits `resize-through-hole`
 * (`buildCylinderRadiusCommand` in App.tsx); the generic wall resize is the
 * route for every other cylindrical face and is covered alongside.
 */
function resize(
  face: FaceTopology,
  radius: number,
  route: Route = 'resize-through-hole',
  concavity: 'hole' | 'boss' = 'hole'
): DirectEditOperation {
  const g = face.geometry!;
  const reference = face.reference ? { faceReference: face.reference } : {};
  return route === 'resize-through-hole'
    ? {
        kind: 'resize-through-hole',
        faceHash: face.hash,
        ...reference,
        sourceDiameter: g.radius! * 2,
        sourceAxisStart: g.axisStart!,
        sourceAxisEnd: g.axisEnd!,
        diameter: radius * 2
      }
    : {
        kind: 'resize-cylindrical-face',
        faceHash: face.hash,
        ...reference,
        sourceRadius: g.radius!,
        sourceAxisStart: g.axisStart!,
        sourceAxisEnd: g.axisEnd!,
        concavity,
        radius
      };
}

function featureNamed(document: ProjectDocument, name: string): FeatureNode {
  const feature = listFeaturesInOrder(document).find((f) => f.name === name);
  expect(feature, name).toBeDefined();
  return feature!;
}

/** Move one slot's placement along z. */
function moveSlot(document: ProjectDocument, slot: 1 | 2, z: number) {
  const feature = featureNamed(document, `Place Slot ${slot}`);
  if (feature.data.featureKind !== 'transform') throw new Error('transform');
  return updateFeature(document, {
    featureId: feature.featureId,
    data: {
      ...feature.data,
      transform: {
        ...feature.data.transform,
        translation: { x: -16, y: -7, z }
      }
    }
  });
}

/** Lengthen the block and its bore by `extra`, growing only patch C. */
function lengthen(document: ProjectDocument, extra: number) {
  const block = featureNamed(document, 'Block');
  const bore = featureNamed(document, 'Bore');
  const longer = updateFeature(document, {
    featureId: block.featureId,
    data: { dimensions: { width: 30, height: 30, depth: 30 + extra } }
  });
  return updateFeature(longer, {
    featureId: bore.featureId,
    data: { dimensions: { radius: 5, height: 32 + extra } }
  });
}

function blocking(derived: DerivedState) {
  return (derived.featureWarnings ?? []).filter(
    (warning) => warning.kind === 'build-failed' || warning.kind === 'refusal'
  );
}

/** Strict kernel validation of the exported solid, plus display closure. */
async function expectClosedValid(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  body: BodyRepresentation,
  bodyId: BodyId
) {
  expect(body.exportableStep).toBe(true);
  expect(
    isClosedConsistentlyOrientedMesh(
      inspectTriangleMeshClosure(body.mesh.vertices, body.mesh.indices)
    )
  ).toBe(true);
  const exported = await adapter.exportStep(document, [bodyId]);
  const kernel = new RemusKernel();
  try {
    const io = await loadRemusTranslators();
    const solids = [
      ...kernel.deserializeSolids(
        io.importStep(new TextEncoder().encode(exported))
      )
    ];
    expect(solids).toHaveLength(1);
    // Strict validation checks every face's trims against its carrier.
    expect(kernel.validateSolid(solids[0]!)).toBe(0);
    expect(kernel.volume(solids[0]!, 0.01)).toBeCloseTo(body.volume, 3);
  } finally {
    kernel.free();
  }
}

describe('repeated curved patches', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  let model: Model;
  let base: DerivedState;
  let block: BodyRepresentation;
  let control: BodyRepresentation;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    model = slottedBlock();
    base = await adapter.syncDocument(model.document);
    expect(base.warnings).toEqual([]);
    block = base.bodyRepresentations[model.bodyId]!;
    control = base.bodyRepresentations[model.controlId!]!;
  }, 120_000);
  afterAll(() => adapter.dispose());

  const build = async (document: ProjectDocument) => {
    const derived = await adapter.syncDocument(document);
    return {
      derived,
      body: derived.bodyRepresentations[model.bodyId]!,
      control: derived.bodyRepresentations[model.controlId!]!
    };
  };

  it('splits one bore wall into three repeated patches with distinct identities', () => {
    expect(block.volume).toBeCloseTo(BASE_VOLUME, 6);
    expect(control.volume).toBeCloseTo(750 * Math.PI, 6);
    expect(layout(block)).toEqual(['[0, 9] r5', '[11, 19] r5', '[21, 30] r5']);
    const [a, b, c] = (['A', 'B', 'C'] as const).map((name) =>
      patch(block, name)
    );
    // A and C are congruent: the same carrier and area, only translated.
    expect(a!.geometry!.area).toBeCloseTo(c!.geometry!.area, 9);
    expect(a!.geometry!.radius).toBe(c!.geometry!.radius);
    // A hash-only edit can only stay put if congruent siblings never share
    // a fingerprint.
    expect(new Set([a!.hash, b!.hash, c!.hash]).size).toBe(3);
    // Every patch measures as a through-hole, which decides the edit the
    // radius drag commits.
    for (const face of [a, b, c])
      expect(face!.geometry!.featureType).toBe('through-hole');
    // Split carriers publish no lineage name at this pin (K05), so the edit
    // is pinned by hash and measured axis. Any name published later must
    // name one patch only, or a stored reference could resolve to a sibling.
    const names = [a, b, c].flatMap((face) =>
      face!.reference ? [face!.reference.lineageName] : []
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps a patch drag local instead of resizing the bore primitive', () => {
    const b = patch(block, 'B');
    // The source edit would resize the Bore primitive, and with it A and C.
    expect(
      primitiveCylinderRadiusEdit(
        { ...model.document, derived: base },
        model.bodyId,
        b.reference,
        b.hash
      )
    ).toBeNull();
  });

  describe.each<Route>(['resize-through-hole', 'resize-cylindrical-face'])(
    '%s',
    (route) => {
      it.each([4.5, 5.5])(
        'resizes only patch B to R%s with the closed-form volume',
        async (radius) => {
          const edited = directEditBody(model.document, {
            name: 'Resize patch B',
            targetBodyId: model.bodyId,
            operation: resize(patch(block, 'B'), radius, route)
          }).document;
          const { derived, body, control: after } = await build(edited);
          expect(derived.warnings).toEqual([]);
          const b = patch(body, 'B');
          expect(b.geometry!.radius).toBeCloseTo(radius, 9);
          expect(b.geometry!.axialLength).toBeCloseTo(8, 9);
          expect(body.volume - block.volume).toBeCloseTo(
            Math.PI * (25 - radius * radius) * 8,
            6
          );
          // Siblings: same fingerprint, carrier and trims.
          expect(snapshot(patch(body, 'A'))).toEqual(
            snapshot(patch(block, 'A'))
          );
          expect(snapshot(patch(body, 'C'))).toEqual(
            snapshot(patch(block, 'C'))
          );
          expect(layout(body)).toEqual([
            '[0, 9] r5',
            `[11, 19] r${radius}`,
            '[21, 30] r5'
          ]);
          expect(body.faceCount).toBe(block.faceCount);
          expect(body.topology!.edges).toHaveLength(
            block.topology!.edges.length
          );
          // The control is another body: untouched in radius and topology.
          expect(after.volume).toBe(control.volume);
          expect(after.topology!.faces.map(snapshot)).toEqual(
            control.topology!.faces.map(snapshot)
          );
          await expectClosedValid(adapter, edited, body, model.bodyId);
        }
      );

      it.each([
        ['slot 1', 1, 10, [0, 10], [12, 19]],
        ['slot 2', 2, 20, [0, 9], [11, 20]]
      ] as const)(
        'refuses with a repair prompt when moving %s rebuilds patch B',
        async (_label, slot, z, aSpan, bSpan) => {
          const edited = directEditBody(model.document, {
            name: 'Resize patch B',
            targetBodyId: model.bodyId,
            operation: resize(patch(block, 'B'), 4.5, route)
          }).document;
          const moved = await build(moveSlot(edited, slot, z));
          const unedited = await build(moveSlot(model.document, slot, z));
          expect(unedited.derived.warnings).toEqual([]);
          const [refused] = blocking(moved.derived);
          expect(blocking(moved.derived)).toHaveLength(1);
          expect(refused!.featureName).toBe('Resize patch B');
          expect(refused!.kernelRefusal).toMatchObject({
            family: 'reference',
            code: 'reference_missing'
          });
          expect(refused!.message).toMatch(/Re-select the face/);
          // No silent retarget: every patch keeps the radius its slots give
          // it, and the body is exactly the unedited rebuild.
          expect(moved.body.volume).toBeCloseTo(unedited.body.volume, 9);
          expect(layout(moved.body)).toEqual(layout(unedited.body));
          expect(patchAt(moved.body, aSpan).geometry!.radius).toBe(5);
          expect(patchAt(moved.body, bSpan).geometry!.radius).toBe(5);
          expect(walls(moved.body).every((w) => w.geometry!.radius === 5)).toBe(
            true
          );
        }
      );

      it('stays on patch B when lengthening the block rebuilds patch C', async () => {
        const edited = directEditBody(model.document, {
          name: 'Resize patch B',
          targetBodyId: model.bodyId,
          operation: resize(patch(block, 'B'), 4.5, route)
        }).document;
        const longer = await build(lengthen(edited, 6));
        const unedited = await build(lengthen(model.document, 6));
        expect(longer.derived.warnings).toEqual([]);
        expect(layout(longer.body)).toEqual([
          '[0, 9] r5',
          '[11, 19] r4.5',
          '[21, 36] r5'
        ]);
        expect(longer.body.volume - unedited.body.volume).toBeCloseTo(
          Math.PI * (25 - 20.25) * 8,
          6
        );
        expect(snapshot(patch(longer.body, 'A'))).toEqual(
          snapshot(patch(unedited.body, 'A'))
        );
        expect(snapshot(patchAt(longer.body, [21, 36]))).toEqual(
          snapshot(patchAt(unedited.body, [21, 36]))
        );
      });
    }
  );

  it('gives the same patch layout after undo, redo and reopening', async () => {
    const manager = new CommandManager(model.document);
    manager.execute(
      commandFactories.directEditBody({
        name: 'Resize patch B',
        targetBodyId: model.bodyId,
        operation: resize(patch(block, 'B'), 4.5)
      })
    );
    const edited = await build(manager.document);
    expect(edited.derived.warnings).toEqual([]);
    const expected = {
      volume: edited.body.volume,
      layout: layout(edited.body),
      faces: edited.body.topology!.faces.map(snapshot)
    };
    expect(expected.layout).toEqual([
      '[0, 9] r5',
      '[11, 19] r4.5',
      '[21, 30] r5'
    ]);
    manager.undo();
    const undone = await build(manager.document);
    expect(undone.derived.warnings).toEqual([]);
    expect(undone.body.topology!.faces.map(snapshot)).toEqual(
      block.topology!.faces.map(snapshot)
    );
    manager.redo();
    const redone = await build(manager.document);
    expect(redone.body.topology!.faces.map(snapshot)).toEqual(expected.faces);
    const reopened = normalizeDocument(
      JSON.parse(
        JSON.stringify(withoutDerivedProjection(manager.document))
      ) as ProjectDocument
    );
    const fresh = await createExactKernelAdapter();
    try {
      const after = await fresh.syncDocument(reopened);
      expect(after.warnings).toEqual([]);
      const body = after.bodyRepresentations[model.bodyId]!;
      expect(body.volume).toBeCloseTo(expected.volume, 6);
      expect(body.topology!.faces.map(snapshot)).toEqual(expected.faces);
      expect(
        after.bodyRepresentations[model.controlId!]!.topology!.faces.map(
          snapshot
        )
      ).toEqual(control.topology!.faces.map(snapshot));
    } finally {
      fresh.dispose();
    }
  });

  describe('a second radius drag', () => {
    const held = (face: FaceTopology) => ({
      bodyId: model.bodyId,
      radius: face.geometry!.radius!,
      axisStart: face.geometry!.axisStart!,
      axisEnd: face.geometry!.axisEnd!,
      concavity: 'hole' as const
    });

    it('folds into the resize of the same patch', async () => {
      const edited = directEditBody(model.document, {
        name: 'Resize patch B',
        targetBodyId: model.bodyId,
        operation: resize(patch(block, 'B'), 4.5)
      }).document;
      const { body } = await build(edited);
      const tip = featureNamed(edited, 'Resize patch B');
      const fold = cylinderResizeFold(edited, held(patch(body, 'B')), 4);
      expect(fold?.featureId).toBe(tip.featureId);
      expect(fold?.operation).toMatchObject({
        kind: 'resize-through-hole',
        faceHash: patch(block, 'B').hash,
        diameter: 8
      });
      // A sibling still at the source radius is a new edit, not a fold.
      expect(cylinderResizeFold(edited, held(patch(body, 'A')), 4)).toBeNull();
    });

    // Once B and then A are both resized to R4.5, B shares A's radius and
    // axis line, so a fold matched by those alone rewrote the tip "Resize
    // patch A": A moved to R4 and B stayed at R4.5. The fold now requires the
    // face the tip resized, here by its recorded span, so the drag on B
    // appends a new edit. The setup is checked in the hook, so a replay or
    // build error cannot pass as a refused fold.
    describe('a drag on B when the tip resized sibling A', () => {
      let document: ProjectDocument;
      let body: BodyRepresentation;
      beforeAll(async () => {
        document = directEditBody(model.document, {
          name: 'Resize patch B',
          targetBodyId: model.bodyId,
          operation: resize(patch(block, 'B'), 4.5)
        }).document;
        document = directEditBody(document, {
          name: 'Resize patch A',
          targetBodyId: model.bodyId,
          operation: resize(patch(block, 'A'), 4.5)
        }).document;
        const built = await build(document);
        expect(built.derived.warnings).toEqual([]);
        body = built.body;
      });

      it('builds both resizes on their own patches', () => {
        expect(layout(body)).toEqual([
          '[0, 9] r4.5',
          '[11, 19] r4.5',
          '[21, 30] r5'
        ]);
      });

      it('never folds into the resize of sibling A', () => {
        expect(
          cylinderResizeFold(document, held(patch(body, 'B')), 4)
        ).toBeNull();
        // A itself still folds into its own resize.
        expect(
          cylinderResizeFold(document, held(patch(body, 'A')), 4)
        ).toMatchObject({
          featureId: featureNamed(document, 'Resize patch A').featureId,
          operation: { faceHash: patch(block, 'A').hash, diameter: 8 }
        });
      });
    });
  });
});

describe('partial-turn repeated patches', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it.each([
    [
      'trough',
      () => slottedBlock('trough'),
      5,
      'hole',
      { reason: 'partial_reversed_wall' }
    ],
    ['ribs', ribbedPlate, 10, 'boss', { code: 'topology_change' }]
  ] as const)(
    'refuses a %s patch resize with a typed reason and leaves every patch in place',
    async (_label, make, radius, concavity, pinned) => {
      const { document, bodyId } = make();
      const before = await adapter.syncDocument(document);
      expect(before.warnings).toEqual([]);
      const body = before.bodyRepresentations[bodyId]!;
      const faces = (['A', 'B', 'C'] as const).map((name) => patch(body, name));
      // Half-turn walls: half the full-turn area of each span.
      for (const [index, face] of faces.entries()) {
        const [lo, hi] = Object.values(SPANS)[index]!;
        expect(face.geometry!.radius).toBe(radius);
        expect(face.geometry!.area).toBeCloseTo(
          Math.PI * radius * (hi - lo),
          6
        );
      }
      const edited = directEditBody(document, {
        name: 'Resize patch B',
        targetBodyId: bodyId,
        operation: resize(
          faces[1]!,
          radius - 0.5,
          'resize-cylindrical-face',
          concavity
        )
      }).document;
      const after = await adapter.syncDocument(edited);
      const [refused] = blocking(after);
      expect(blocking(after)).toHaveLength(1);
      expect(refused!.featureName).toBe('Resize patch B');
      expect(refused!.kernelRefusal).toMatchObject({
        family: 'direct-edit',
        operation: 'resize-cylindrical-face',
        category: 'unsupported',
        ...pinned
      });
      const result = after.bodyRepresentations[bodyId]!;
      expect(result.volume).toBe(body.volume);
      expect(result.topology!.faces.map(snapshot)).toEqual(
        body.topology!.faces.map(snapshot)
      );
      // The card reads a product sentence, never the kernel's face ids.
      const shown = plainRefusal(
        refused!.message.replace(/^Feature "[^"]*": /, ''),
        refused!.kernelRefusal
      );
      expect(shown.message).not.toMatch(/Id\(|move-face|Some\(/);
    }
  );
});
