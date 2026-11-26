import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumPlane,
  addSketchFeature,
  addSplitFeature,
  createProjectDocument,
  extrudeSketch,
  filletEdges,
  findSketch,
  normalizeDocument,
  updateFeature,
  updateSketchObject,
  type SplitInput
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type EdgeTopology,
  type FaceTopology,
  type ProjectDocument,
  type SketchId,
  type Vector3
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import {
  IN_PLACE_TOOL_SPECS,
  type InPlaceContext,
  type InPlaceSlots
} from '../apps/web/src/lib/inPlace/tools';
import {
  GENERIC_REFUSAL,
  plainRefusal
} from '../apps/web/src/lib/refusalLanguage';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';

/**
 * K10 CAD-workflow coupon (Slice 0): one invented slotted coupon carried
 * through a mixed history — sketch-and-cut channels and a bore, two direct
 * wall offsets, a fillet and a Split by plane — on the production adapter
 * and the installed Remus WASM. The direct-edit corpus covers offsets,
 * resizes, Undo and reopen only, so the mixed chain lives here.
 *
 * Every number is a closed form in mm³ (see the table in
 * `docs/roadmap-evidence/k10--workflow-coupon.md`), checked to the K10
 * oracles' tolerance, max(0.05 mm³, 1e-6·V). A refusal is asserted by its
 * typed family, category and code, never by kernel prose.
 */

const user = toUserId('user_k10_coupon');
const PI = Math.PI;
const XY = { type: 'canonical', plane: 'XY', offset: 0 } as const;
const YZ = { type: 'canonical', plane: 'YZ', offset: 0 } as const;

/** The K10 oracles' volume tolerance (`test/support/combination-matrix.ts`). */
const tolerance = (volume: number) => Math.max(0.05, 1e-6 * Math.abs(volume));
function expectVolume(
  actual: number | undefined,
  expected: number,
  label: string
) {
  expect(actual, label).toBeDefined();
  expect(
    Math.abs(actual! - expected),
    `${label}: ${actual} vs ${expected}`
  ).toBeLessThanOrEqual(tolerance(expected));
}

// Closed forms, mm³.
const V = {
  A0: 90 * 36 * 14, // 45360
  witness: 20 * 36 * 14, // 10080
  A2: 45360 - 2800,
  A3: 45360 - 5600,
  A4: 39760 - 504 * PI,
  A5: 39760 - 504 * PI + 420,
  A6: 39760 - 504 * PI + 420 - 119,
  A7: 40285 - 560 * PI, // ≈ 38525.708
  lowA8: 23709 - 504 * PI, // ≈ 22125.637
  highA8: 16576 - 56 * PI, // ≈ 16400.071
  /** C1: the x < 42 half, halving the bore. */
  lowC1: 18669 - 252 * PI,
  /** C2: the x < 63 half, through the two x = 62 corner fillets. */
  lowC2: 29029 - 504 * PI - (56 / 3) * PI + 14 * Math.sqrt(3),
  /** R1: channel 1 drawn x 12–24, A5 following to a wall at 22.5. */
  lowR1: 23121 - 504 * PI
};

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

// ---------------------------------------------------------------- outcomes

const TOUCH_SENTENCE =
  'The cutting plane lies exactly along an existing edge. Move the plane slightly off the edge.';

/** What the Split command bar shows for a stored warning. */
function barSentence(message: string): string {
  return plainRefusal(message.replace(/^Feature "[^"]+":\s*/, '')).message;
}

interface Typed {
  kind: 'typed';
  family: string;
  category: string;
  code: string;
  /** The stored warning text (kernel prose; recorded, never asserted). */
  message: string;
  /**
   * The sentence the in-place command bar shows for it: the bar takes the
   * warning without its `Feature "…":` lead and translates it with no
   * classification (`InPlaceCommandBar.tsx`). The browser twin,
   * `test/e2e/split-recovery.spec.ts`, reads the same sentences on screen.
   */
  bar: string;
}
type Outcome = { kind: 'built'; derived: DerivedState } | Typed;

/**
 * Build `document` and classify the feature named `featureName`: a typed
 * refusal of that feature, or a build. A prose refusal, an `internal`
 * category or any other blocking warning fails the test.
 */
async function outcome(
  document: ProjectDocument,
  featureName: string,
  using = adapter
): Promise<Outcome> {
  const derived = await using.syncDocument(document);
  const blocking = (derived.featureWarnings ?? []).filter(
    (warning) => warning.kind === 'build-failed' || warning.kind === 'refusal'
  );
  if (blocking.length === 0) {
    expect(derived.warnings, `${featureName}: warnings`).toEqual([]);
    return { kind: 'built', derived };
  }
  expect(blocking, `${featureName}: one blocking warning`).toHaveLength(1);
  const [warning] = blocking;
  expect(warning!.featureName).toBe(featureName);
  const refusal = warning!.kernelRefusal;
  expect(refusal, `${featureName}: typed (${warning!.message})`).toBeDefined();
  expect(refusal!.category, `${featureName}: not internal`).not.toBe(
    'internal'
  );
  return {
    kind: 'typed',
    family: refusal!.family,
    category: refusal!.category,
    code: refusal!.code,
    message: warning!.message,
    bar: barSentence(warning!.message)
  };
}

function expectBuilt(result: Outcome, label: string): DerivedState {
  expect(
    result.kind,
    `${label}: ${result.kind === 'typed' ? `${result.category}/${result.code} — ${result.message}` : ''}`
  ).toBe('built');
  return (result as Extract<Outcome, { kind: 'built' }>).derived;
}

function expectTyped(result: Outcome, category: string, label: string): Typed {
  expect(result.kind, label).toBe('typed');
  const typed = result as Typed;
  expect(
    { family: typed.family, category: typed.category, code: typed.code },
    label
  ).toEqual({ family: 'modeling', category, code: 'split_refused' });
  return typed;
}

/** A body that is exact, with a closed consistently oriented mesh. */
function solid(
  derived: DerivedState,
  id: BodyId,
  label: string
): BodyRepresentation {
  const body = derived.bodyRepresentations[id];
  expect(body, `${label}: body ${id}`).toBeDefined();
  expect(body!.exportableStep, `${label}: exact`).toBe(true);
  expect(
    isClosedConsistentlyOrientedMesh(
      inspectTriangleMeshClosure(body!.mesh.vertices, body!.mesh.indices)
    ),
    `${label}: closed`
  ).toBe(true);
  return body!;
}

// ---------------------------------------------------------------- fixture

function rectangle(
  document: ProjectDocument,
  name: string,
  [x0, x1]: [number, number],
  [y0, y1]: [number, number]
) {
  return addSketchFeature(document, {
    name,
    planeRef: XY,
    objects: [
      {
        objectKind: 'rectangle',
        width: x1 - x0,
        height: y1 - y0,
        centerX: (x0 + x1) / 2,
        centerY: (y0 + y1) / 2
      }
    ]
  });
}

function pad(document: ProjectDocument, name: string, sketchId: SketchId) {
  return extrudeSketch(document, {
    name,
    sketchId,
    distance: 14,
    operation: 'new-body'
  });
}

/** A through-all cut of `sketchId` from `targetBodyId`; returns the result. */
function cut(
  document: ProjectDocument,
  name: string,
  sketchId: SketchId,
  targetBodyId: BodyId
) {
  return extrudeSketch(document, {
    name,
    sketchId,
    distance: 14,
    operation: 'cut',
    targetBodyId,
    endCondition: 'through-all',
    throughAllSide: 'both'
  });
}

/** A0: the 90 × 36 × 14 coupon blank, x 0–90, y 0–36, z 0–14. */
function blank() {
  const sketched = rectangle(
    createProjectDocument('K10 coupon', user),
    'Coupon sketch',
    [0, 90],
    [0, 36]
  );
  const padded = pad(sketched.document, 'Coupon', sketched.sketchId);
  return { document: padded.document, coupon: padded.bodyId };
}

const planarFaces = (body: BodyRepresentation) =>
  (body.topology?.faces ?? []).filter(
    (face) => face.geometry?.surfaceType === 'plane' && face.geometry.normal
  );

/** Each planar face as `<axis><sign>@<offset>`: the walls of the body. */
function walls(body: BodyRepresentation): string[] {
  return planarFaces(body)
    .map((face) => {
      const n = face.geometry!.normal!;
      const c = face.geometry!.center;
      const axis = (['x', 'y', 'z'] as const).find(
        (a) => Math.abs(Math.abs(n[a]) - 1) < 1e-9
      );
      if (!axis) return `tilted@${c.x},${c.y},${c.z}`;
      return `${n[axis] > 0 ? '+' : '-'}${axis}@${Math.round(c[axis] * 1e6) / 1e6}`;
    })
    .sort();
}

/** The planar wall whose outward normal is `normal`, lying at `at`. */
function wall(
  body: BodyRepresentation,
  normal: Vector3,
  at: number,
  [x0, x1]: [number, number] = [-Infinity, Infinity]
): FaceTopology {
  const axis = (['x', 'y', 'z'] as const).find((a) => normal[a] !== 0)!;
  const matches = planarFaces(body).filter(
    (face) =>
      face.geometry!.normal![axis] * normal[axis] > 0.999 &&
      Math.abs(face.geometry!.center[axis] - at) < 1e-6 &&
      face.geometry!.center.x >= x0 &&
      face.geometry!.center.x <= x1
  );
  expect(matches, `wall ${JSON.stringify(normal)} at ${at}`).toHaveLength(1);
  return matches[0]!;
}

/** Offset one planar face through the app's face-offset planner. */
function offsetFace(
  document: ProjectDocument,
  derived: DerivedState,
  bodyId: BodyId,
  face: FaceTopology,
  offset: number
): ProjectDocument {
  const plan = planFaceOffset({
    document: { ...document, derived },
    bodyId,
    face,
    faceHash: face.hash,
    offset
  });
  expect(plan?.kind).toBe('direct-edit');
  expect(
    plan && 'preflightRejection' in plan ? plan.preflightRejection : undefined
  ).toBeUndefined();
  const manager = new CommandManager(document);
  manager.execute(plan!.command);
  return manager.document;
}

/** The vertical edges where two of channel 2's walls meet. */
function channelTwoCorners(body: BodyRepresentation): EdgeTopology[] {
  const inChannel = (face: FaceTopology | undefined) =>
    !!face &&
    face.geometry?.surfaceType === 'plane' &&
    Math.abs(face.geometry.normal!.z) < 1e-9 &&
    face.geometry.center.x >= 62 - 1e-6 &&
    face.geometry.center.x <= 72 + 1e-6 &&
    face.geometry.center.y >= 8 - 1e-6 &&
    face.geometry.center.y <= 28 + 1e-6;
  const faces = new Map(
    (body.topology?.faces ?? []).map((face) => [face.hash, face])
  );
  return (body.topology?.edges ?? []).filter((edge) => {
    const adjacent = (edge.adjacentFaceHashes ?? []).map((hash) =>
      faces.get(hash)
    );
    return (
      edge.displayRole !== 'seam' &&
      adjacent.length === 2 &&
      adjacent.every(inChannel)
    );
  });
}

interface Stage {
  document: ProjectDocument;
  derived: DerivedState;
  coupon: BodyId;
}

/**
 * The fixture-A chain A0–A7, each step checked against its closed form, the
 * witness block unchanged and each offset moving only its named wall.
 */
async function chain() {
  const stages: Record<string, Stage> = {};
  const record = async (
    name: string,
    document: ProjectDocument,
    coupon: BodyId
  ) => {
    const derived = expectBuilt(await outcome(document, name), name);
    stages[name] = { document, derived, coupon };
    return derived;
  };
  const a0 = blank();
  await record('A0', a0.document, a0.coupon);

  const witnessSketch = rectangle(
    a0.document,
    'Witness sketch',
    [100, 120],
    [0, 36]
  );
  const a1 = pad(witnessSketch.document, 'Witness', witnessSketch.sketchId);
  const witness = a1.bodyId;
  const d1 = await record('A1', a1.document, a0.coupon);
  const witnessBody = solid(d1, witness, 'A1 witness');
  expectVolume(witnessBody.volume, V.witness, 'A1 witness');
  const witnessBox = witnessBody.bbox;

  const ch1Sketch = rectangle(
    a1.document,
    'Channel 1 sketch',
    [12, 22],
    [8, 28]
  );
  const a2 = cut(
    ch1Sketch.document,
    'Channel 1',
    ch1Sketch.sketchId,
    a0.coupon
  );
  await record('A2', a2.document, a2.bodyId);

  const ch2Sketch = rectangle(
    a2.document,
    'Channel 2 sketch',
    [62, 72],
    [8, 28]
  );
  const a3 = cut(
    ch2Sketch.document,
    'Channel 2',
    ch2Sketch.sketchId,
    a2.bodyId
  );
  await record('A3', a3.document, a3.bodyId);

  const boreSketch = addSketchFeature(a3.document, {
    name: 'Bore sketch',
    planeRef: XY,
    objects: [{ objectKind: 'circle', radius: 6, centerX: 42, centerY: 18 }]
  });
  const a4 = cut(boreSketch.document, 'Bore', boreSketch.sketchId, a3.bodyId);
  const d4 = await record('A4', a4.document, a4.bodyId);
  const coupon = a4.bodyId;

  // A5: channel 1's wall x = 22 faces −X (into the channel); +1.5 along that
  // normal moves it to 20.5 and narrows the channel.
  const a5 = offsetFace(
    a4.document,
    d4,
    coupon,
    wall(d4.bodyRepresentations[coupon]!, { x: -1, y: 0, z: 0 }, 22),
    1.5
  );
  const d5 = await record('A5', a5, coupon);
  // A6: wall y = 28 faces −Y; −1 moves it to 29 and widens the channel.
  const a6 = offsetFace(
    a5,
    d5,
    coupon,
    wall(d5.bodyRepresentations[coupon]!, { x: 0, y: -1, z: 0 }, 28, [12, 22]),
    -1
  );
  const d6 = await record('A6', a6, coupon);

  const corners = channelTwoCorners(d6.bodyRepresentations[coupon]!);
  expect(corners, 'A7: channel 2 has four vertical corners').toHaveLength(4);
  const a7 = filletEdges(a6, {
    name: 'Channel 2 fillet',
    targetBodyId: coupon,
    edgeHashes: corners.map((edge) => edge.hash),
    ...(corners.every((edge) => edge.reference)
      ? { edgeReferences: corners.map((edge) => edge.reference!) }
      : {}),
    size: 2
  });
  await record('A7', a7.document, a7.bodyId);

  return {
    stages,
    witness,
    witnessBox,
    sketches: { channel1: ch1Sketch.sketchId }
  };
}

let fixture: Awaited<ReturnType<typeof chain>>;
const stage = (name: string) => fixture.stages[name]!;
const couponAt = (name: string) => {
  const { derived, coupon } = stage(name);
  return derived.bodyRepresentations[coupon]!;
};

const xPlane = (x: number) => ({
  origin: { x, y: 0, z: 0 },
  normal: { x: 1, y: 0, z: 0 }
});

/** The two halves of a built split, low (−normal) side first, by bounds. */
function halves(
  derived: DerivedState,
  ids: [BodyId, BodyId],
  x: number,
  label: string
): [BodyRepresentation, BodyRepresentation] {
  const bodies = ids.map((id) => solid(derived, id, label));
  const low = bodies.find((body) => body.bbox.max.x <= x + 1e-6);
  const high = bodies.find((body) => body.bbox.min.x >= x - 1e-6);
  expect(low, `${label}: a half wholly at x ≤ ${x}`).toBeDefined();
  expect(high, `${label}: a half wholly at x ≥ ${x}`).toBeDefined();
  expect(low).not.toBe(high);
  expect(low!.bbox.max.x).toBeCloseTo(x, 6);
  expect(high!.bbox.min.x).toBeCloseTo(x, 6);
  return [low!, high!];
}

// ---------------------------------------------------------------- cells

describe('K10 workflow coupon: Split on the A0 blank (S1–S6)', () => {
  it('S1: plane x = 30 builds two closed halves of 15120 and 30240', async () => {
    const { document, coupon } = blank();
    const split = addSplitFeature(document, {
      name: 'Split',
      targetBodyId: coupon,
      plane: xPlane(30)
    });
    const derived = expectBuilt(await outcome(split.document, 'Split'), 'S1');
    const [low, high] = halves(
      derived,
      [split.bodyId, split.secondBodyId],
      30,
      'S1'
    );
    expectVolume(low.volume, 15120, 'S1 low');
    expectVolume(high.volume, 30240, 'S1 high');
    // The stored body id is the +normal side; the second id the −normal side.
    expect(derived.bodyRepresentations[split.bodyId]).toBe(high);
    expect(derived.bodyRepresentations[split.secondBodyId]).toBe(low);
    // Both halves publish hash-only lineage: the kernel split reports no
    // face ancestry across the cut.
    for (const body of [low, high]) {
      expect(body.topology?.faces.every((face) => !face.reference)).toBe(true);
    }
  });

  it.each([
    // S2: wholly on one side — verified InvalidInput in the pinned split.rs.
    [
      'S2 strict miss, plane x = 98, as invalid_input',
      xPlane(98),
      'invalid_input'
    ],
    // S3: coincident with the end face x = 90.
    ['S3 face touch, plane x = 90, as unsupported', xPlane(90), 'unsupported'],
    // S4: x + y = 0 touches only the vertical edge at the origin.
    [
      'S4 edge touch, plane x + y = 0, as unsupported',
      {
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }
      },
      'unsupported'
    ],
    // S5: x + y + z = 0 touches only the vertex at the origin, which the
    // kernel treats as wholly on one side.
    [
      'S5 vertex touch, plane x + y + z = 0, as invalid_input',
      {
        origin: { x: 0, y: 0, z: 0 },
        normal: {
          x: 1 / Math.sqrt(3),
          y: 1 / Math.sqrt(3),
          z: 1 / Math.sqrt(3)
        }
      },
      'invalid_input'
    ]
  ] as const)('%s refuses by type', async (label, plane, category) => {
    const { document, coupon } = blank();
    const split = addSplitFeature(document, {
      name: 'Split',
      targetBodyId: coupon,
      plane
    });
    const refused = expectTyped(
      await outcome(split.document, 'Split'),
      category,
      label
    );
    // Nothing is replaced: the blank stands, neither half exists.
    const derived = await adapter.syncDocument(split.document);
    expectVolume(derived.bodyRepresentations[coupon]?.volume, V.A0, label);
    expect(derived.bodyRepresentations[coupon]?.consumed).toBe(false);
    expect(derived.bodyRepresentations[split.bodyId]).toBeUndefined();
    expect(derived.bodyRepresentations[split.secondBodyId]).toBeUndefined();
    // Whatever the wording, the bar never leads with the kernel's prose.
    expect(refused.bar).not.toMatch(
      /invalid input:|unsupported configuration|edge \d/
    );
    if (label.startsWith('S4')) expect(refused.bar).toBe(TOUCH_SENTENCE);
  });

  // Wording findings (owner refusalLanguage.ts). Each `it.fails` states the
  // expected behaviour and passes while the defect stands; it fails, and
  // should become a plain `it`, once the copy is fixed.
  it.fails(
    'Wording, S2/S5: a strict miss names the miss instead of the generic sentence',
    async () => {
      // Expected: a sentence saying the plane misses the body (or only
      // touches a corner) and to slide it through the body. Actual: the
      // table has no entry for "cutting plane does not split the solid", so
      // the bar shows GENERIC_REFUSAL, which K10 counts as a failure.
      for (const plane of [
        xPlane(98),
        {
          origin: { x: 0, y: 0, z: 0 },
          normal: {
            x: 1 / Math.sqrt(3),
            y: 1 / Math.sqrt(3),
            z: 1 / Math.sqrt(3)
          }
        }
      ]) {
        const { document, coupon } = blank();
        const split = addSplitFeature(document, {
          name: 'Split',
          targetBodyId: coupon,
          plane
        });
        const refused = expectTyped(
          await outcome(split.document, 'Split'),
          'invalid_input',
          'strict miss'
        );
        expect(refused.bar).not.toBe(GENERIC_REFUSAL);
      }
    }
  );

  it.fails(
    'Wording, S3: a plane on a face is not described as lying along an edge',
    async () => {
      // Expected: a sentence saying the plane lies on a face of the body and
      // only touches it, so slide it into the body. Actual: the face-touch
      // refusal shares the edge-touch entry ("lies exactly along an existing
      // edge … off the edge"), which names the wrong cause for a face pick —
      // and a picked face's plane always starts here, at offset 0.
      const { document, coupon } = blank();
      const split = addSplitFeature(document, {
        name: 'Split',
        targetBodyId: coupon,
        plane: xPlane(90)
      });
      const refused = expectTyped(
        await outcome(split.document, 'Split'),
        'unsupported',
        'face touch'
      );
      expect(refused.bar).not.toBe(TOUCH_SENTENCE);
    }
  );

  it('S6: a typed zero normal makes no Split request', () => {
    const slots: InPlaceSlots = {
      profiles: [],
      axis: null,
      path: [],
      guide: [],
      faces: [],
      bodies: [
        {
          bodyId: 'body_coupon' as BodyId,
          min: { x: 0, y: 0, z: 0 },
          max: { x: 90, y: 36, z: 14 }
        }
      ],
      plane: null,
      edges: [],
      refs: [],
      image: null
    };
    const context: InPlaceContext = {
      sketchViews: [],
      datumAxes: {},
      datumLabel: () => '',
      linearSnap: null
    };
    const typed = (nx: number, ny: number, nz: number) => ({
      planeOX: 52,
      planeOY: 0,
      planeOZ: 0,
      planeNX: nx,
      planeNY: ny,
      planeNZ: nz
    });
    const spec = IN_PLACE_TOOL_SPECS.split;
    const request = (nx: number, ny: number, nz: number) =>
      spec.request(
        slots,
        typed(nx, ny, nz),
        { planeMode: 'typed', keepOriginal: 'no' },
        context,
        typed(nx, ny, nz)
      );
    expect(request(0, 0, 0)).toBeNull();
    // Control: the same plane with a unit normal does make a request.
    expect(request(1, 0, 0)).toMatchObject({
      state: { operation: 'split', value: { targetBodyId: 'body_coupon' } }
    });
  });
});

describe('K10 workflow coupon: the mixed chain (W1–W8, C1–C2, R1–R3)', () => {
  beforeAll(async () => {
    fixture = await chain();
  }, 300_000);

  it('W1–W7: each step matches its closed form and leaves the witness alone', () => {
    const expected: Record<string, number> = {
      A0: V.A0,
      A1: V.A0,
      A2: V.A2,
      A3: V.A3,
      A4: V.A4,
      A5: V.A5,
      A6: V.A6,
      A7: V.A7
    };
    for (const [name, volume] of Object.entries(expected)) {
      const { derived, coupon } = stage(name);
      expectVolume(solid(derived, coupon, name).volume, volume, name);
      if (name === 'A0') continue;
      const witness = solid(derived, fixture.witness, `${name} witness`);
      expectVolume(witness.volume, V.witness, `${name} witness`);
      expect(witness.bbox, `${name} witness bounds`).toEqual(
        fixture.witnessBox
      );
    }
  });

  it('W5–W6: each offset moves only its named wall', () => {
    // A multiset difference: channel 2 also has a wall at y = 28.
    const minus = (from: string[], take: string[]) => {
      const left = [...take];
      return from.filter((w) => {
        const at = left.indexOf(w);
        if (at < 0) return true;
        left.splice(at, 1);
        return false;
      });
    };
    const diff = (before: string[], after: string[]) => ({
      removed: minus(before, after),
      added: minus(after, before)
    });
    expect(diff(walls(couponAt('A4')), walls(couponAt('A5')))).toEqual({
      removed: ['-x@22'],
      added: ['-x@20.5']
    });
    expect(diff(walls(couponAt('A5')), walls(couponAt('A6')))).toEqual({
      removed: ['-y@28'],
      added: ['-y@29']
    });
  });

  it('W8: Split at x = 52 builds two closed halves that sum to W7', async () => {
    const { document, coupon } = stage('A7');
    const split = addSplitFeature(document, {
      name: 'Split',
      targetBodyId: coupon,
      plane: xPlane(52)
    });
    const derived = expectBuilt(await outcome(split.document, 'Split'), 'W8');
    const [low, high] = halves(
      derived,
      [split.bodyId, split.secondBodyId],
      52,
      'W8'
    );
    expectVolume(low.volume, V.lowA8, 'W8 low');
    expectVolume(high.volume, V.highA8, 'W8 high');
    expectVolume(low.volume + high.volume, V.A7, 'W8 sum');
    // The coupon is consumed; the witness is untouched.
    expect(derived.bodyRepresentations[coupon]?.consumed).toBe(true);
    expect(low.consumed || high.consumed).toBe(false);
    const witness = solid(derived, fixture.witness, 'W8 witness');
    expectVolume(witness.volume, V.witness, 'W8 witness');
    expect(witness.bbox).toEqual(fixture.witnessBox);
  });

  it('C1: plane x = 42 through the bore builds', async () => {
    const { document, coupon } = stage('A7');
    const split = addSplitFeature(document, {
      name: 'Split',
      targetBodyId: coupon,
      plane: xPlane(42)
    });
    // Characterized on the pin: it builds. The plane crosses the bore's
    // cylinder and the inner wires it leaves in both caps.
    const derived = expectBuilt(await outcome(split.document, 'Split'), 'C1');
    const [low, high] = halves(
      derived,
      [split.bodyId, split.secondBodyId],
      42,
      'C1'
    );
    expectVolume(low.volume, V.lowC1, 'C1 low');
    expectVolume(low.volume + high.volume, V.A7, 'C1 sum');
  });

  it('C2: plane x = 63 through two fillets builds', async () => {
    const { document, coupon } = stage('A7');
    const split = addSplitFeature(document, {
      name: 'Split',
      targetBodyId: coupon,
      plane: xPlane(63)
    });
    // Characterized on the pin: it builds, cutting the two R2 corner
    // fillets at x = 62 one millimetre from their tangent lines.
    const derived = expectBuilt(await outcome(split.document, 'Split'), 'C2');
    const [low, high] = halves(
      derived,
      [split.bodyId, split.secondBodyId],
      63,
      'C2'
    );
    expectVolume(low.volume, V.lowC2, 'C2 low');
    expectVolume(low.volume + high.volume, V.A7, 'C2 sum');
  });

  it('R1: redrawing channel 1 as x 12–24 carries A5 to x = 22.5', async () => {
    const { document, coupon } = stage('A7');
    const split = addSplitFeature(document, {
      name: 'Split',
      targetBodyId: coupon,
      plane: xPlane(52)
    });
    const sketchId = fixture.sketches.channel1;
    const objectId = findSketch(split.document, sketchId)!.objectIds[0]!;
    const edited = updateSketchObject(split.document, {
      sketchId,
      objectId,
      data: {
        objectKind: 'rectangle',
        width: 12,
        height: 20,
        centerX: 18,
        centerY: 18
      }
    });
    // Characterized on the pin: A5 follows its wall to 22.5 (the edit moves
    // the face A5 names; it does not retarget), A6 keeps y = 29, and the
    // split halves rebuild with no warning.
    const derived = expectBuilt(await outcome(edited, 'Split'), 'R1');
    const [low, high] = halves(
      derived,
      [split.bodyId, split.secondBodyId],
      52,
      'R1'
    );
    expectVolume(low.volume, V.lowR1, 'R1 low');
    expectVolume(high.volume, V.highA8, 'R1 high unchanged');
    expect(walls(low)).toEqual(
      [
        '+x@12',
        '-x@22.5',
        '+y@8',
        '-y@29',
        '-x@0',
        '+x@52',
        '-y@0',
        '+y@36',
        '-z@0',
        '+z@14'
      ].sort()
    );
  });

  it('R2: Undo and Redo across A8, then a fresh adapter on the reopened document', async () => {
    const { document, coupon } = stage('A7');
    const input: SplitInput = {
      name: 'Split',
      targetBodyId: coupon,
      plane: xPlane(52)
    };
    const manager = new CommandManager(document);
    manager.execute(commandFactories.splitBody(input));
    const committed = manager.document;
    const added = committed.bodyOrder.filter(
      (id) => !document.bodyOrder.includes(id)
    );
    expect(added).toHaveLength(2);
    const measure = (derived: DerivedState) =>
      Object.fromEntries(
        [...added, fixture.witness].map((id) => [
          id,
          solid(derived, id, `R2 ${id}`).volume
        ])
      );
    const first = measure(
      expectBuilt(await outcome(committed, 'Split'), 'R2 commit')
    );

    manager.undo();
    const undone = expectBuilt(
      await outcome(manager.document, 'A7'),
      'R2 undo'
    );
    expect(manager.document.bodyOrder).toEqual(document.bodyOrder);
    expectVolume(undone.bodyRepresentations[coupon]?.volume, V.A7, 'R2 undo');
    for (const id of added)
      expect(undone.bodyRepresentations[id]).toBeUndefined();

    manager.redo();
    expect(manager.document.bodyOrder).toEqual(committed.bodyOrder);
    const redone = measure(
      expectBuilt(await outcome(manager.document, 'Split'), 'R2 redo')
    );
    expect(Object.keys(redone)).toEqual(Object.keys(first));
    for (const id of Object.keys(first)) {
      expectVolume(redone[id], first[id]!, `R2 redo ${id}`);
    }

    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    const fresh = await createExactKernelAdapter();
    try {
      const again = measure(
        expectBuilt(await outcome(reopened, 'Split', fresh), 'R2 reopen')
      );
      expect(reopened.bodyOrder).toEqual(committed.bodyOrder);
      for (const id of Object.keys(first)) {
        expectVolume(again[id], first[id]!, `R2 reopen ${id}`);
      }
    } finally {
      fresh.dispose();
    }
  });

  it('R3: a split on an R01 offset datum follows the datum from 30 to 40', async () => {
    const { document, coupon } = blank();
    const planed = addDatumPlane(document, {
      name: 'Cut plane',
      definition: { kind: 'offset', source: YZ, offset: 30 }
    });
    const split = addSplitFeature(planed.document, {
      name: 'Split',
      targetBodyId: coupon,
      plane: { type: 'datum', datumFeatureId: planed.featureId }
    });
    const ids: [BodyId, BodyId] = [split.bodyId, split.secondBodyId];
    const at30 = expectBuilt(
      await outcome(split.document, 'Split'),
      'R3 at 30'
    );
    const [low30, high30] = halves(at30, ids, 30, 'R3 at 30');
    expectVolume(low30.volume, 15120, 'R3 low at 30');
    expectVolume(high30.volume, 30240, 'R3 high at 30');

    const moved = updateFeature(split.document, {
      featureId: planed.featureId,
      data: {
        featureKind: 'datum-plane',
        definition: { kind: 'offset', source: YZ, offset: 40 }
      }
    });
    const at40 = expectBuilt(await outcome(moved, 'Split'), 'R3 at 40');
    const [low40, high40] = halves(at40, ids, 40, 'R3 at 40');
    expectVolume(low40.volume, 20160, 'R3 low at 40');
    expectVolume(high40.volume, 25200, 'R3 high at 40');
  });
});
