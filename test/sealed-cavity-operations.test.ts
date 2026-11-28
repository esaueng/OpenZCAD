import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSplitFeature,
  booleanBodies,
  createProjectDocument,
  draftBody,
  importStepBody,
  transformBody
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  BOOLEAN_SEALED_CAVITY,
  DRAFT_SEALED_CAVITY,
  SPLIT_SEALED_CAVITY,
  plainRefusalSentence
} from '../apps/web/src/lib/refusalLanguage';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';

/**
 * Issues #2383–#2386 through the document: Subtract, Intersect, Split and
 * Draft on a body with a sealed internal cavity.
 *
 * A body with a sealed void is a legitimate solid, and each operation must
 * build the correct body (the void kept, volume = outer − voids, one STEP
 * `BREP_WITH_VOIDS`) or refuse with a typed cause and a sentence that names
 * the cavity. Before this suite the four refused as "try a smaller angle or
 * fewer faces", "does not support this combination of shapes" and
 * "repositioning the overlap sometimes clears it": advice about inputs that
 * play no part.
 *
 * The pinned kernel (Remus 2026.1.173) cannot build these, so each case pins
 * its typed refusal and the sentence a person reads, with the body it should
 * build recorded beside it from closed forms. The kernel-level twin
 * (`packages/kernel-adapter/src/sealed-cavity-refusal.test.ts`) fails the
 * moment a kernel update builds one. The controls and the orders that do
 * build are held to volume, bounds and STEP shell structure.
 */

const user = toUserId('user_sealed_cavity');
const STOCK = 64 * 42 * 16;
const CYLINDER = Math.PI * 3 ** 2 * 6;
const RECT = 23 * 19 * 4;
const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

type Vec = { x: number; y: number; z: number };

const stockDocument = () =>
  addPrimitiveFeature(createProjectDocument('Sealed cavity', user), {
    name: 'Stock',
    primitiveKind: 'box',
    dimensions: { width: 64, height: 42, depth: 16 }
  });

function placed(
  document: ProjectDocument,
  name: string,
  primitive:
    | {
        primitiveKind: 'box';
        dimensions: { width: number; height: number; depth: number };
      }
    | {
        primitiveKind: 'cylinder';
        dimensions: { radius: number; height: number };
      },
  at: Vec
): ProjectDocument {
  const added = addPrimitiveFeature(document, { name, ...primitive });
  return transformBody(added, {
    name: `Place ${name}`,
    targetBodyId: last(added),
    translation: at
  }).document;
}

/** The R3 × 6 cylinder standing at (52, 21) from z = 5 to z = 11. */
const withCylinder = (document: ProjectDocument, z = 5) =>
  placed(
    document,
    'Cylinder',
    { primitiveKind: 'cylinder', dimensions: { radius: 3, height: 6 } },
    { x: 52, y: 21, z }
  );
/** The 23 × 19 × 4 box from (18, 10, 6). */
const withRect = (document: ProjectDocument) =>
  placed(
    document,
    'Pocket',
    { primitiveKind: 'box', dimensions: { width: 23, height: 19, depth: 4 } },
    { x: 18, y: 10, z: 6 }
  );
/** An 84 × 62 × 32 box from (−10, −10, `z`). */
const withClip = (document: ProjectDocument, z: number) =>
  placed(
    document,
    'Clip',
    { primitiveKind: 'box', dimensions: { width: 84, height: 62, depth: 32 } },
    { x: -10, y: -10, z }
  );

const boolean = (
  document: ProjectDocument,
  operation: 'subtract' | 'intersect',
  targetBodyIds: BodyId[]
) => booleanBodies(document, { name: 'Boolean', operation, targetBodyIds });

/** The stock with the sealed cylindrical cavity. */
function housing(): { document: ProjectDocument; bodyId: BodyId } {
  const stock = stockDocument();
  const tooled = withCylinder(stock);
  return boolean(tooled, 'subtract', [last(stock), last(tooled)]);
}

const blocking = (derived: DerivedState): FeatureWarning[] =>
  (derived.featureWarnings ?? []).filter(
    (warning) => warning.kind === 'build-failed' || warning.kind === 'refusal'
  );

interface Built {
  volume: number;
  min: Vec;
  max: Vec;
}

/** Build `document` with no refusal, and read exact closed bodies. */
async function built(
  document: ProjectDocument,
  bodyIds: BodyId[]
): Promise<Built[]> {
  const derived = await adapter.syncDocument(document);
  expect(
    blocking(derived).map((warning) => warning.message),
    'no refusal'
  ).toEqual([]);
  return bodyIds.map((id) => {
    const body = derived.bodyRepresentations[id];
    expect(body, `body ${id}`).toBeDefined();
    expect(body!.exportableStep, `body ${id} exact`).toBe(true);
    expect(
      isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(body!.mesh.vertices, body!.mesh.indices)
      ),
      `body ${id} closed`
    ).toBe(true);
    return { volume: body!.volume, min: body!.bbox.min, max: body!.bbox.max };
  });
}

function expectBounds(body: Built, min: Vec, max: Vec): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    expect(body.min[axis], `min ${axis}`).toBeCloseTo(min[axis], 5);
    expect(body.max[axis], `max ${axis}`).toBeCloseTo(max[axis], 5);
  }
}

/**
 * The solids of a STEP export by shell structure: each `BREP_WITH_VOIDS`
 * with the number of oriented inner shells it lists, and the plain solids.
 */
async function stepShells(
  document: ProjectDocument,
  bodyIds: BodyId[]
): Promise<{ plain: number; voids: number[] }> {
  const step = await adapter.exportStep(document, bodyIds);
  const voids = [...step.matchAll(/BREP_WITH_VOIDS\s*\(([^;]*);/g)].map(
    (match) => {
      const lists = match[1]!.match(/\(([^()]*)\)\s*\)\s*$/);
      expect(lists, 'BREP_WITH_VOIDS lists its voids').not.toBeNull();
      return lists![1]!.split(',').filter((ref) => ref.trim()).length;
    }
  );
  return {
    plain: [...step.matchAll(/=\s*MANIFOLD_SOLID_BREP\s*\(/g)].length,
    voids
  };
}

/**
 * Sync `document`, expecting exactly one refusal: its typed record and the
 * sentence a person reads for it.
 */
async function refused(
  document: ProjectDocument,
  featureName: string,
  record: NonNullable<FeatureWarning['kernelRefusal']>,
  sentence: string
): Promise<DerivedState> {
  const derived = await adapter.syncDocument(document);
  const warnings = blocking(derived);
  expect(
    warnings.map((warning) => warning.kernelRefusal),
    warnings.map((warning) => warning.message).join(' | ')
  ).toEqual([record]);
  expect(
    plainRefusalSentence(
      warnings[0]!.message,
      warnings[0]!.kernelRefusal,
      'mm',
      featureName
    )
  ).toBe(sentence);
  return derived;
}

const BOOLEAN_CAVITY = (operation: 'cut' | 'intersect') => ({
  family: 'boolean' as const,
  operation,
  category: 'quality_refused',
  code: 'exact_only_unattainable',
  reason: 'sealed_cavity'
});
const MODELING_CAVITY = (code: string) => ({
  family: 'modeling' as const,
  category: 'unsupported',
  code,
  reason: 'sealed_cavity'
});

describe('the sealed cavity itself', () => {
  it('builds as one solid with one inner shell and survives a STEP round trip', async () => {
    const { document, bodyId } = housing();
    const [body] = await built(document, [bodyId]);
    expect(body!.volume).toBeCloseTo(STOCK - CYLINDER, 3);
    expectBounds(body!, { x: 0, y: 0, z: 0 }, { x: 64, y: 42, z: 16 });
    expect(await stepShells(document, [bodyId])).toEqual({
      plain: 0,
      voids: [1]
    });

    const imported = importStepBody(createProjectDocument('Round trip', user), {
      name: 'Housing',
      artifactId: 'sealed-cavity-housing',
      sourceName: 'housing.step',
      stepText: await adapter.exportStep(document, [bodyId])
    });
    const [again] = await built(imported.document, [imported.bodyId]);
    expect(again!.volume).toBeCloseTo(STOCK - CYLINDER, 3);
    expectBounds(again!, { x: 0, y: 0, z: 0 }, { x: 64, y: 42, z: 16 });
    expect(await stepShells(imported.document, [imported.bodyId])).toEqual({
      plain: 0,
      voids: [1]
    });
  }, 300_000);
});

describe('#2383: one Subtract with a rectangular and a cylindrical cavity', () => {
  // Should build: 41,090.354 mm³, one solid with two inner shells, the same
  // in both tool orders.
  it.each([['box, cylinder'], ['cylinder, box']])(
    'refuses %s by naming the cavity',
    async (order) => {
      const stock = stockDocument();
      const boxed = withRect(stock);
      const rect = last(boxed);
      const tooled = withCylinder(boxed);
      const cylinder = last(tooled);
      const cut = boolean(tooled, 'subtract', [
        last(stock),
        ...(order === 'box, cylinder' ? [rect, cylinder] : [cylinder, rect])
      ]);
      await refused(
        cut.document,
        'Boolean',
        BOOLEAN_CAVITY('cut'),
        BOOLEAN_SEALED_CAVITY
      );
    },
    300_000
  );

  it('builds each tool alone, two rectangular cavities, and a cylinder opened through the roof', async () => {
    const stock = stockDocument();
    const target = last(stock);

    const rectDocument = withRect(stock);
    const rectCut = boolean(rectDocument, 'subtract', [
      target,
      last(rectDocument)
    ]);
    expect(
      (await built(rectCut.document, [rectCut.bodyId]))[0]!.volume
    ).toBeCloseTo(STOCK - RECT, 3);
    expect(await stepShells(rectCut.document, [rectCut.bodyId])).toEqual({
      plain: 0,
      voids: [1]
    });

    // A second, 5 × 5 × 4 pocket 9 mm clear of the first.
    const narrow = placed(
      rectDocument,
      'Second pocket',
      { primitiveKind: 'box', dimensions: { width: 5, height: 5, depth: 4 } },
      { x: 50, y: 18, z: 6 }
    );
    const narrowCut = boolean(narrow, 'subtract', [
      target,
      last(rectDocument),
      last(narrow)
    ]);
    expect(
      (await built(narrowCut.document, [narrowCut.bodyId]))[0]!.volume
    ).toBeCloseTo(STOCK - RECT - 100, 3);
    expect(await stepShells(narrowCut.document, [narrowCut.bodyId])).toEqual({
      plain: 0,
      voids: [2]
    });

    // Raised to z = 11–17 the cylinder opens through the roof: a blind bore
    // in the outer shell beside the one sealed rectangular cavity.
    const roofOpen = withCylinder(rectDocument, 11);
    const roofCut = boolean(roofOpen, 'subtract', [
      target,
      last(rectDocument),
      last(roofOpen)
    ]);
    expect(
      (await built(roofCut.document, [roofCut.bodyId]))[0]!.volume
    ).toBeCloseTo(STOCK - RECT - Math.PI * 3 ** 2 * 5, 3);
    expect(await stepShells(roofCut.document, [roofCut.bodyId])).toEqual({
      plain: 0,
      voids: [1]
    });
  }, 300_000);
});

describe('#2384: Split of a body with a sealed cavity', () => {
  const plane = (z: number) => ({
    origin: { x: 0, y: 0, z },
    normal: { x: 0, y: 0, z: 1 }
  });

  // Should build: at z = 3 a 3 mm plate and a 13 mm body that keeps the
  // inner shell (8,064 + 34,774.354 mm³); at z = 8 two halves that each open
  // the cavity onto the cut, summing to 42,838.354 mm³.
  it.each([[3], [8]])(
    'refuses at z = %i by naming the cavity, not the shapes',
    async (z) => {
      const body = housing();
      const split = addSplitFeature(body.document, {
        name: 'Split',
        targetBodyId: body.bodyId,
        plane: plane(z)
      });
      const derived = await refused(
        split.document,
        'Split',
        MODELING_CAVITY('split_refused'),
        SPLIT_SEALED_CAVITY
      );
      // The refused Split leaves the housing as it was.
      expect(derived.bodyRepresentations[body.bodyId]!.volume).toBeCloseTo(
        STOCK - CYLINDER,
        3
      );
    },
    300_000
  );

  it('splits the uncut stock into two 8 mm halves', async () => {
    const stock = stockDocument();
    const split = addSplitFeature(stock, {
      name: 'Split',
      targetBodyId: last(stock),
      plane: plane(8)
    });
    const halves = await built(split.document, [
      split.bodyId,
      split.secondBodyId
    ]);
    for (const half of halves) {
      expect(half.volume).toBeCloseTo(STOCK / 2, 3);
      expect(half.max.z - half.min.z).toBeCloseTo(8, 6);
    }
  }, 300_000);

  it('builds in the order its sentence names: split first, then cut the cavity', async () => {
    const stock = stockDocument();
    const split = addSplitFeature(stock, {
      name: 'Split',
      targetBodyId: last(stock),
      plane: plane(3)
    });
    const [first, second] = await built(split.document, [
      split.bodyId,
      split.secondBodyId
    ]);
    const upperId = first!.min.z > 1 ? split.bodyId : split.secondBodyId;
    const lower = first!.min.z > 1 ? second! : first!;
    expect(lower.volume).toBeCloseTo(64 * 42 * 3, 3);

    const tooled = withCylinder(split.document);
    const cut = boolean(tooled, 'subtract', [upperId, last(tooled)]);
    const [upper] = await built(cut.document, [cut.bodyId]);
    expect(upper!.volume).toBeCloseTo(64 * 42 * 13 - CYLINDER, 3);
    expectBounds(upper!, { x: 0, y: 0, z: 3 }, { x: 64, y: 42, z: 16 });
    expect(upper!.volume + lower.volume).toBeCloseTo(STOCK - CYLINDER, 3);
    expect(await stepShells(cut.document, [cut.bodyId])).toEqual({
      plain: 0,
      voids: [1]
    });
  }, 300_000);
});

describe('#2385: trimming a body that keeps its sealed cavity whole', () => {
  // Should build: X 0–64, Y 0–42, Z 3–16 with the closed cylindrical inner
  // shell from z = 5 to 11, 34,774.354 mm³, one `BREP_WITH_VOIDS`.
  it('refuses Intersect with the clip 2 mm clear of the cavity by naming the cavity', async () => {
    const body = housing();
    const clipped = withClip(body.document, 3);
    const trim = boolean(clipped, 'intersect', [body.bodyId, last(clipped)]);
    await refused(
      trim.document,
      'Boolean',
      BOOLEAN_CAVITY('intersect'),
      BOOLEAN_SEALED_CAVITY
    );
  }, 300_000);

  it('refuses the equivalent Subtract the same way', async () => {
    const body = housing();
    const clipped = withClip(body.document, -29);
    const trim = boolean(clipped, 'subtract', [body.bodyId, last(clipped)]);
    await refused(
      trim.document,
      'Boolean',
      BOOLEAN_CAVITY('cut'),
      BOOLEAN_SEALED_CAVITY
    );
  }, 300_000);

  it('clips plain stock, keeps a rectangular cavity and opens a crossed one', async () => {
    const stock = stockDocument();
    const plainClip = withClip(stock, 3);
    const plain = boolean(plainClip, 'intersect', [
      last(stock),
      last(plainClip)
    ]);
    const [slab] = await built(plain.document, [plain.bodyId]);
    expect(slab!.volume).toBeCloseTo(64 * 42 * 13, 3);
    expect(await stepShells(plain.document, [plain.bodyId])).toEqual({
      plain: 1,
      voids: []
    });

    const rectDocument = withRect(stock);
    const pocketed = boolean(rectDocument, 'subtract', [
      last(stock),
      last(rectDocument)
    ]);
    const pocketClip = withClip(pocketed.document, 3);
    const kept = boolean(pocketClip, 'intersect', [
      pocketed.bodyId,
      last(pocketClip)
    ]);
    const [retained] = await built(kept.document, [kept.bodyId]);
    expect(retained!.volume).toBeCloseTo(64 * 42 * 13 - RECT, 3);
    expectBounds(retained!, { x: 0, y: 0, z: 3 }, { x: 64, y: 42, z: 16 });
    expect(await stepShells(kept.document, [kept.bodyId])).toEqual({
      plain: 0,
      voids: [1]
    });

    // At z = 8 the clip crosses the cylindrical cavity, which opens onto the
    // new face as a 3 mm bore: no inner shell is left to carry.
    const body = housing();
    const crossing = withClip(body.document, 8);
    const opened = boolean(crossing, 'intersect', [
      body.bodyId,
      last(crossing)
    ]);
    const [half] = await built(opened.document, [opened.bodyId]);
    expect(half!.volume).toBeCloseTo(64 * 42 * 8 - Math.PI * 3 ** 2 * 3, 3);
    expect(await stepShells(opened.document, [opened.bodyId])).toEqual({
      plain: 1,
      voids: []
    });
  }, 300_000);

  it('builds when the trim comes first and the cavity is cut last', async () => {
    const stock = stockDocument();
    const clipped = withClip(stock, 3);
    const trim = boolean(clipped, 'intersect', [last(stock), last(clipped)]);
    const tooled = withCylinder(trim.document);
    const cut = boolean(tooled, 'subtract', [trim.bodyId, last(tooled)]);
    const [body] = await built(cut.document, [cut.bodyId]);
    expect(body!.volume).toBeCloseTo(64 * 42 * 13 - CYLINDER, 3);
    expectBounds(body!, { x: 0, y: 0, z: 3 }, { x: 64, y: 42, z: 16 });
    expect(await stepShells(cut.document, [cut.bodyId])).toEqual({
      plain: 0,
      voids: [1]
    });
  }, 300_000);
});

describe('#2386: Draft of an exterior wall of a body with a sealed cavity', () => {
  /** The +3° taper of the 16 mm wall moves its top edge out by this much. */
  const RUN = 16 * Math.tan((3 * Math.PI) / 180);
  /** The wedge the drafted Y = 0 wall adds: ½ · run · height · length. */
  const WEDGE = 0.5 * RUN * 16 * 64;

  async function draftFront(
    document: ProjectDocument,
    bodyId: BodyId,
    angleDeg: number
  ) {
    const derived = await adapter.syncDocument(document);
    const front = derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.y ?? 0) < -0.99 &&
        // The Y = 0 exterior wall, not a cavity wall that faces the same way.
        Math.abs(face.geometry.center.y) < 1e-6
    );
    expect(front).toHaveLength(1);
    return draftBody(document, {
      name: 'Draft',
      targetBodyId: bodyId,
      faceHashes: front.map((face) => face.hash),
      ...(front.every((face) => face.reference)
        ? { faceReferences: front.map((face) => face.reference!) }
        : {}),
      pullDirection: { x: 0, y: 0, z: 1 },
      neutralPoint: { x: 0, y: 0, z: 0 },
      angleDeg
    });
  }

  // Should build: the Y = 0 wall reaching −0.838524 mm at z = 16, the base
  // fixed, the cylindrical inner shell in place, 43,267.679 mm³.
  it.each([[3], [1]])(
    'refuses a %i° draft by naming the cavity, not the angle',
    async (angleDeg) => {
      const body = housing();
      const draft = await draftFront(body.document, body.bodyId, angleDeg);
      const derived = await refused(
        draft.document,
        'Draft',
        MODELING_CAVITY('draft_refused'),
        DRAFT_SEALED_CAVITY
      );
      expect(DRAFT_SEALED_CAVITY).not.toMatch(/angle|fewer faces/i);
      // Cancelling leaves the housing and its inner shell as they were.
      expect(derived.bodyRepresentations[body.bodyId]!.volume).toBeCloseTo(
        STOCK - CYLINDER,
        3
      );
    },
    300_000
  );

  it('refuses the same way with two rectangular cavities', async () => {
    const stock = stockDocument();
    const rectDocument = withRect(stock);
    const second = placed(
      rectDocument,
      'Second pocket',
      { primitiveKind: 'box', dimensions: { width: 5, height: 5, depth: 4 } },
      { x: 50, y: 18, z: 6 }
    );
    const pocketed = boolean(second, 'subtract', [
      last(stock),
      last(rectDocument),
      last(second)
    ]);
    const draft = await draftFront(pocketed.document, pocketed.bodyId, 3);
    await refused(
      draft.document,
      'Draft',
      MODELING_CAVITY('draft_refused'),
      DRAFT_SEALED_CAVITY
    );
  }, 300_000);

  it('drafts the plain stock, moving the top front edge out by 0.838524 mm', async () => {
    const stock = stockDocument();
    const draft = await draftFront(stock, last(stock), 3);
    const [body] = await built(draft.document, [draft.bodyId]);
    expect(RUN).toBeCloseTo(0.838524, 6);
    expect(body!.min.y).toBeCloseTo(-RUN, 5);
    expect(body!.volume).toBeCloseTo(STOCK + WEDGE, 3);
  }, 300_000);

  it('builds in the order its sentence names: draft first, then cut the cavity', async () => {
    const stock = stockDocument();
    const draft = await draftFront(stock, last(stock), 3);
    const tooled = withCylinder(draft.document);
    const cut = boolean(tooled, 'subtract', [draft.bodyId, last(tooled)]);
    const [body] = await built(cut.document, [cut.bodyId]);
    expect(body!.volume).toBeCloseTo(STOCK + WEDGE - CYLINDER, 3);
    expect(body!.volume).toBeCloseTo(43267.679, 2);
    expectBounds(body!, { x: 0, y: -RUN, z: 0 }, { x: 64, y: 42, z: 16 });
    expect(await stepShells(cut.document, [cut.bodyId])).toEqual({
      plain: 0,
      voids: [1]
    });
  }, 300_000);
});
