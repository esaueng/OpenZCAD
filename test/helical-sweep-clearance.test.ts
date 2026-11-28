import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  deleteParameter,
  findFeature,
  findSketch,
  setParameter,
  helicalSweepProfile,
  resolveParamValue,
  updateFeature,
  updateSketchObject
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { compileHistoryEdit, printHistory } from '@openzcad/scripting';
import {
  toUserId,
  type BodyId,
  type ProjectDocument,
  type SketchObjectData,
  type Vector3
} from '@openzcad/shared';

const WIRE_RADIUS = 1.5;
const COIL_RADIUS = 12;
/** Pappus for a screw: a section in a plane through the axis sweeps this. */
const turnVolume = (coilRadius: number) =>
  2 * Math.PI * coilRadius * Math.PI * WIRE_RADIUS ** 2;

interface Placement {
  /** The wire's centre in its XZ sketch, whose second axis runs down world Z. */
  centre: readonly [number, number];
  origin: Vector3;
  direction: Vector3;
}

/**
 * #2188's coil: a Ø3 mm wire at (27.6, 0, −11.2), 12 mm from an axis through
 * (18, 0, −4) along (0.6, 0, 0.8). The axis lies in the sketch plane, at an
 * angle to the world axes, so the wire's highest and lowest points along it
 * fall between the points the kernel samples.
 */
const OBLIQUE: Placement = {
  centre: [27.6, 11.2],
  origin: { x: 18, y: 0, z: -4 },
  direction: { x: 0.6, y: 0, z: 0.8 }
};
/** The same coil turned rigidly to stand on world Z. */
const UPRIGHT: Placement = {
  centre: [COIL_RADIUS, 0],
  origin: { x: 0, y: 0, z: 0 },
  direction: { x: 0, y: 0, z: 1 }
};

/** A sweep of the one closed profile `objects` draw in an XZ sketch. */
function sweepOf(
  objects: SketchObjectData[],
  placement: Pick<Placement, 'origin' | 'direction'>,
  pitch: number,
  turns: number,
  construction: 'in-place' | 'faceted' = 'in-place'
) {
  const profile = addSketchFeature(
    createProjectDocument('Coil', toUserId('user_test')),
    {
      name: 'Wire',
      planeRef: { type: 'canonical', plane: 'XZ', offset: 0 },
      objects
    }
  );
  const sketch = findSketch(profile.document, profile.sketchId)!;
  const drawn = sketch.objectIds.map((id) => {
    const node = profile.document.nodes[id];
    if (node?.kind !== 'sketch-object') {
      throw new Error('Expected a sketch object.');
    }
    return { id: node.id, data: node.data };
  });
  const regions = computeSketchProfileAnalysis(drawn, (value) =>
    resolveParamValue(value, {}, 'profile dimension')
  ).profiles;
  const [region] = regions;
  if (!region || regions.length !== 1) {
    throw new Error('Expected one closed profile.');
  }
  return helicalSweepProfile(profile.document, {
    name: 'Coil',
    profile: {
      sketchId: profile.sketchId,
      profile: {
        profileId: region.profileId,
        regionFingerprint: region.regionFingerprint,
        samplePoint: region.samplePoint,
        sourceArea: region.area,
        sourceEntityIds: region.sourceEntityIds
      }
    },
    axisOrigin: placement.origin,
    axisDirection: placement.direction,
    radius: COIL_RADIUS,
    pitch,
    turns,
    ...(construction === 'in-place' ? { construction } : {})
  });
}

function coil(
  placement: Placement,
  pitch: number,
  turns: number,
  construction: 'in-place' | 'faceted' = 'in-place'
) {
  return sweepOf(
    [
      {
        objectKind: 'circle',
        radius: WIRE_RADIUS,
        centerX: placement.centre[0],
        centerY: placement.centre[1]
      }
    ],
    placement,
    pitch,
    turns,
    construction
  );
}

describe('exact helical sweep', { timeout: 300_000 }, () => {
  let adapter: Awaited<ReturnType<typeof createExactKernelAdapter>>;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  async function built(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(document);
    return { derived, body: derived.bodyRepresentations[bodyId] };
  }

  /** The coil built, checked as a solid here and again through STEP. */
  async function expectSound(
    placement: Placement,
    pitch: number,
    turns: number
  ) {
    return expectSoundSweep(
      coil(placement, pitch, turns),
      turnVolume(COIL_RADIUS) * turns
    );
  }

  /** `exact` is the volume Pappus gives the sweep. */
  async function expectSoundSweep(
    made: ReturnType<typeof sweepOf>,
    exact: number
  ) {
    const { derived, body } = await built(made.document, made.bodyId);
    expect(
      (derived.featureWarnings ?? []).filter(
        (warning) => warning.kind !== 'advisory'
      )
    ).toEqual([]);
    expect(derived.exportableBodyIds).toContain(made.bodyId);
    // A coil that ran through itself counts the shared material twice: the
    // 2.997 mm coil of #2188 measured 9% over.
    expect(Math.abs(body!.volume - exact) / exact).toBeLessThan(2e-3);
    const caps = body!.topology!.faces.filter(
      (face) => face.geometry?.surfaceType === 'plane'
    );
    expect(caps).toHaveLength(2);
    // The exported file reads back as one valid closed solid of that size.
    const step = await adapter.exportStep(made.document, [made.bodyId]);
    const inspected = await adapter.inspectStep(step);
    expect(inspected).toMatchObject({ solid: true, valid: true });
    expect(Math.abs(inspected.volume - exact) / exact).toBeLessThan(2e-3);
    return { caps: caps.map((cap) => cap.geometry!.centroid!) };
  }

  async function expectRefused(
    placement: Placement,
    pitch: number,
    turns: number
  ) {
    await expectRefusedSweep(coil(placement, pitch, turns));
  }

  async function expectRefusedSweep(
    made: ReturnType<typeof sweepOf>,
    reason = 'helical sweep coils would overlap'
  ) {
    const { derived, body } = await built(made.document, made.bodyId);
    expect(body).toBeUndefined();
    expect(derived.exportableBodyIds).not.toContain(made.bodyId);
    expect(derived.featureWarnings).toEqual([
      expect.objectContaining({
        kind: 'build-failed',
        message: expect.stringContaining(reason) as string
      })
    ]);
  }

  describe.each([
    ['on an oblique axis', OBLIQUE],
    ['turned to stand on world Z', UPRIGHT]
  ] as const)('one turn of Ø3 mm wire %s (#2188)', (_name, placement) => {
    // The wire spans exactly 3 mm along the axis. Below that the two end
    // caps of a one-turn coil lie in one plane and overlap; at it they touch.
    it.each([2.99, 2.997, 3, -2.997])(
      'refuses a %s mm pitch: the end caps would overlap',
      async (pitch) => {
        await expectRefused(placement, pitch, 1);
      }
    );

    it('refuses further turns at that pitch too', async () => {
      await expectRefused(placement, 2.997, 2);
    });

    it.each([3.02, -3.02])(
      'builds a %s mm pitch as a valid solid with its caps apart',
      async (pitch) => {
        const { caps } = await expectSound(placement, pitch, 1);
        // The caps are discs of radius 1.5 in one plane: clear of one
        // another once their centres are more than 3 mm apart.
        const [first, second] = caps;
        const apart = Math.hypot(
          second!.x - first!.x,
          second!.y - first!.y,
          second!.z - first!.z
        );
        expect(apart).toBeCloseTo(Math.abs(pitch), 6);
        expect(apart).toBeGreaterThan(2 * WIRE_RADIUS);
      }
    );

    it('builds just short of a turn at any pitch: the ends do not meet', async () => {
      await expectSound(placement, 2.99, 0.999);
    });
  });

  describe('a profile whose tallest point is not where a curve is sampled', () => {
    /**
     * The Ø3 mm wire drawn as six 60° arcs, one join 0.01 rad before the
     * wire's highest point along the axis: that point lies on an arc, a
     * hair inside its end.
     */
    const sixArcs = (): SketchObjectData[] => {
      const join = 90 - (0.01 * 180) / Math.PI;
      return Array.from({ length: 6 }, (_unused, index) => ({
        objectKind: 'arc' as const,
        centerX: COIL_RADIUS,
        centerY: 0,
        radius: WIRE_RADIUS,
        startAngleDeg: join + 60 * index,
        endAngleDeg: join + 60 * (index + 1)
      }));
    };

    it('refuses a turn 75 nm short of the wire, wherever its arcs join', async () => {
      // The wire is 3 mm tall whatever it is drawn from: one turn of
      // 2.999925 mm leaves the two end caps overlapping.
      await expectRefusedSweep(sweepOf(sixArcs(), UPRIGHT, 2.999925, 1));
    });

    it('builds the same wire with clearance', async () => {
      await expectSoundSweep(
        sweepOf(sixArcs(), UPRIGHT, 3.02, 1),
        turnVolume(COIL_RADIUS)
      );
    });
  });

  describe('a profile taller than any line along the axis through it', () => {
    // An ellipse of semi-axes 4 × 0.5 mm turned 0.75 rad in the plane
    // through the axis: 5.501979 mm from its lowest point to its highest,
    // but no line along the axis runs more than 1.357528 mm inside it. A
    // turn carries the profile along such a line, so it is that length the
    // pitch must clear.
    const ellipse = (): SketchObjectData[] => [
      {
        objectKind: 'ellipse',
        centerX: COIL_RADIUS,
        centerY: 0,
        radiusX: 4,
        radiusY: 0.5,
        rotationDeg: (0.75 * 180) / Math.PI
      }
    ];
    const ellipseTurn = 2 * Math.PI * COIL_RADIUS * Math.PI * 4 * 0.5;

    it('builds a turn that clears it, though shorter than the profile is tall', async () => {
      await expectSoundSweep(
        sweepOf(ellipse(), UPRIGHT, 5.500979, 1),
        ellipseTurn
      );
    });

    it('refuses a turn no longer than its longest line along the axis', async () => {
      await expectRefusedSweep(
        sweepOf(ellipse(), UPRIGHT, 1.3, 1),
        'one turn carries the profile 1.3 along the axis, onto itself'
      );
    });
  });

  it('builds a hair short of a full turn: the ends have not come round', async () => {
    // 0.99999999 of a turn is not a turn. The kernel builds it, and nothing
    // here stands in for an angle the coil has not swept.
    await expectSound(UPRIGHT, 2.997, 0.99999999);
  });

  describe('the coil radius in History as text (#2120)', () => {
    const textEdit = (
      document: ProjectDocument,
      change: (text: string) => string
    ) => compileHistoryEdit(document, change(printHistory(document)));

    it('refuses a radius edit on a coil wound in place, and says what moves it', async () => {
      const made = coil(UPRIGHT, 5.25, 2);
      const result = textEdit(made.document, (text) =>
        text.replace('radius: 12,', 'radius: 20,')
      );
      expect(result.proposal).toBeNull();
      expect(result.diagnostics.map((entry) => entry.message)).toEqual([
        expect.stringMatching(
          /wound through its profile.*`radius` only records it.*Move the profile/
        )
      ]);
      // What it names does move the coil: the wire drawn 15 mm from the axis.
      const moved = textEdit(made.document, (text) =>
        text.replace('centerX: 12,', 'centerX: 15,')
      );
      expect(moved.diagnostics).toEqual([]);
      const [operation] = moved.proposal!.operations;
      if (operation?.kind !== 'update_sketch_object') {
        throw new Error('Expected a sketch object edit.');
      }
      const before = await built(made.document, made.bodyId);
      const after = await built(
        updateSketchObject(made.document, {
          sketchId: operation.sketchId,
          objectId: operation.objectId as never,
          data: operation.data
        }),
        made.bodyId
      );
      const exact = (radius: number) => turnVolume(radius) * 2;
      expect(
        Math.abs(before.body!.volume - exact(12)) / exact(12)
      ).toBeLessThan(2e-3);
      expect(Math.abs(after.body!.volume - exact(15)) / exact(15)).toBeLessThan(
        2e-3
      );
    });

    it('builds a coil wound in place whose recorded radius no longer reads, and takes its repair', async () => {
      // `radius: R`, and R since deleted. The coil is wound through its
      // profile and never reads the record, so it builds as it did; the
      // text takes a number in the record's place.
      const made = coil(UPRIGHT, 5.25, 2);
      const coilId = made.document.featureOrder.at(-1)!;
      const named = updateFeature(
        setParameter(made.document, { name: 'R', expression: '12' }),
        { featureId: coilId, data: { radius: 'R' } }
      );
      const stranded = deleteParameter(named, { name: 'R' });
      expect(findFeature(stranded, coilId)?.data).toMatchObject({
        radius: 'R',
        construction: 'in-place'
      });
      const { derived, body } = await built(stranded, made.bodyId);
      expect(
        (derived.featureWarnings ?? []).filter(
          (warning) => warning.kind !== 'advisory'
        )
      ).toEqual([]);
      const exact = turnVolume(COIL_RADIUS) * 2;
      expect(Math.abs(body!.volume - exact) / exact).toBeLessThan(2e-3);

      const repaired = textEdit(stranded, (text) =>
        text.replace('radius: `R`,', 'radius: 12,')
      );
      expect(repaired.diagnostics).toEqual([]);
      expect(repaired.proposal!.operations).toEqual([
        expect.objectContaining({
          kind: 'update_feature',
          data: { radius: 12 }
        })
      ]);
      // A faceted helix is built at its radius, and still says so.
      const faceted = coil(UPRIGHT, 5.25, 2, 'faceted');
      const lost = await built(
        deleteParameter(
          updateFeature(
            setParameter(faceted.document, { name: 'R', expression: '12' }),
            {
              featureId: faceted.document.featureOrder.at(-1)!,
              data: { radius: 'R' }
            }
          ),
          { name: 'R' }
        ),
        faceted.bodyId
      );
      expect(lost.body).toBeUndefined();
      expect(lost.derived.featureWarnings).toEqual([
        expect.objectContaining({ kind: 'build-failed' })
      ]);
    });

    it('applies a radius edit to a faceted helix, which is built at it', async () => {
      const made = coil(UPRIGHT, 5.25, 2, 'faceted');
      const result = textEdit(made.document, (text) =>
        text.replace('radius: 12,', 'radius: 20,')
      );
      expect(result.diagnostics).toEqual([]);
      const [operation] = result.proposal!.operations;
      if (operation?.kind !== 'update_feature') {
        throw new Error('Expected a feature edit.');
      }
      expect(operation.data).toEqual({ radius: 20 });
      const before = await built(made.document, made.bodyId);
      const after = await built(
        updateFeature(made.document, {
          featureId: operation.featureId,
          data: operation.data
        }),
        made.bodyId
      );
      // The coil runs 20 mm out instead of 12: two thirds more material.
      expect(before.body!.volume).toBeGreaterThan(0);
      expect(after.body!.volume / before.body!.volume).toBeCloseTo(20 / 12, 2);
    });
  });
});
