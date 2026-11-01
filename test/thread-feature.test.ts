import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  threadBody,
  type ThreadInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { commandFactories } from '@openzcad/command-system';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  isoMetricThreadForBore,
  isoMetricThreadLabel,
  nearestIsoMetricThread,
  toUserId,
  type BodyId,
  type FeatureData,
  type ParamValue,
  type ProjectDocument
} from '@openzcad/shared';
import {
  resolveThread,
  threadPrintAdvisories,
  threadProfileForm
} from '../packages/kernel-adapter/src/exact-thread';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

type ThreadData = Extract<FeatureData, { featureKind: 'thread' }>;

const values = {
  optional: (value: ParamValue | undefined) =>
    value === undefined ? undefined : Number(value)
};

function data(overrides: Partial<ThreadData> = {}): ThreadData {
  return {
    featureKind: 'thread',
    targetBodyId: 'body_x' as BodyId,
    faceHash: 1,
    profile: 'iso-metric',
    ...overrides
  };
}

const ISO_DEPTH = (5 / 8) * (Math.sqrt(3) / 2);

describe('ISO metric thread sizes', () => {
  it('finds the nearest coarse size and the size a tap drill fits', () => {
    expect(nearestIsoMetricThread(6)).toEqual({ nominal: 6, pitch: 1 });
    expect(nearestIsoMetricThread(7.9)).toEqual({ nominal: 8, pitch: 1.25 });
    // ISO 2306 tap drills: D − P.
    expect(isoMetricThreadForBore(5)).toEqual({ nominal: 6, pitch: 1 });
    expect(isoMetricThreadForBore(6.8)).toEqual({ nominal: 8, pitch: 1.25 });
    expect(isoMetricThreadForBore(2.5)).toEqual({ nominal: 3, pitch: 0.5 });
    expect(isoMetricThreadLabel(6, 1)).toBe('M6×1');
    expect(isoMetricThreadLabel(1.6, 0.35)).toBe('M1.6×0.35');
  });
});

describe('thread resolution against its face', () => {
  it('sizes an ISO thread from a boss', () => {
    const thread = resolveThread(
      data(),
      values,
      { kind: 'external', radius: 3, faceLength: 8 },
      1
    );
    expect(thread.majorDiameter).toBeCloseTo(6, 12);
    expect(thread.pitch).toBe(1);
    expect(thread.depth).toBeCloseTo(ISO_DEPTH, 12);
    expect(thread.crestWidth).toBeCloseTo(1 / 8, 12);
    expect([thread.upperFlankAngleDeg, thread.lowerFlankAngleDeg]).toEqual([
      30, 30
    ]);
    expect(thread.truncation).toBe(0);
    expect([thread.offset, thread.length]).toEqual([0, 8]);
  });

  it('sizes an internal thread from its tap drill and lets the bore truncate the crest', () => {
    // A Ø5 tap drill takes M6×1, whose basic minor diameter is 4.917: the
    // bore cuts the crest down to Ø5, flat and wider by the flanks it loses.
    const thread = resolveThread(
      data(),
      values,
      { kind: 'internal', radius: 2.5, faceLength: 10 },
      1
    );
    expect(thread.majorDiameter).toBeCloseTo(6, 12);
    expect(thread.pitch).toBe(1);
    const cut = 2.5 - (3 - ISO_DEPTH);
    expect(thread.truncation).toBeCloseTo(cut, 12);
    expect(thread.depth).toBeCloseTo(0.5, 12);
    expect(thread.crestWidth).toBeCloseTo(
      0.25 + cut * 2 * Math.tan(Math.PI / 6),
      12
    );
  });

  it('moves the profile away from the mating part by the clearance', () => {
    const boss = resolveThread(
      data({ clearance: 0.15 }),
      values,
      { kind: 'external', radius: 3, faceLength: 8 },
      1
    );
    expect(boss.majorDiameter).toBeCloseTo(5.7, 12);
    expect(boss.truncation).toBe(0);
    const bore = resolveThread(
      data({ clearance: 0.15, majorDiameter: 6 }),
      values,
      { kind: 'internal', radius: 2.4, faceLength: 8 },
      1
    );
    expect(bore.majorDiameter).toBeCloseTo(6.3, 12);
  });

  it('measures the offset from either end of the face', () => {
    const fromEnd = resolveThread(
      data({ anchor: 'end', offset: 1, length: 4 }),
      values,
      { kind: 'external', radius: 3, faceLength: 10 },
      1
    );
    expect([fromEnd.offset, fromEnd.length]).toEqual([5, 4]);
    const rest = resolveThread(
      data({ offset: 2 }),
      values,
      { kind: 'external', radius: 3, faceLength: 10 },
      1
    );
    expect([rest.offset, rest.length]).toEqual([2, 8]);
  });

  it('reads ISO sizes in millimetres whatever the document units', () => {
    // A Ø0.25 in boss is near M6: its coarse pitch, 1 mm, in inches.
    const thread = resolveThread(
      data(),
      values,
      { kind: 'external', radius: 0.125, faceLength: 0.5 },
      25.4
    );
    expect(thread.pitch).toBeCloseTo(1 / 25.4, 12);
  });

  it('takes a custom form as typed and refuses a boss it would mostly cut away', () => {
    const thread = resolveThread(
      data({
        profile: 'custom',
        pitch: 2,
        depth: 0.8,
        crestWidth: 0.6,
        upperFlankAngleDeg: 0,
        lowerFlankAngleDeg: 45,
        starts: 2,
        hand: 'left'
      }),
      values,
      { kind: 'external', radius: 4, faceLength: 6 },
      1
    );
    expect(thread).toMatchObject({
      pitch: 2,
      depth: 0.8,
      crestWidth: 0.6,
      upperFlankAngleDeg: 0,
      lowerFlankAngleDeg: 45,
      starts: 2,
      hand: 'left'
    });
    expect(() =>
      resolveThread(
        data({ majorDiameter: 8 }),
        values,
        { kind: 'external', radius: 3.4, faceLength: 6 },
        1
      )
    ).toThrow(/boss is too small/);
  });

  it('gives the printable profile 45° flanks and quarter-pitch flats', () => {
    expect(threadProfileForm('printable', 'external', 2)).toEqual({
      depth: 0.5,
      crestWidth: 0.5,
      upperFlankAngleDeg: 45,
      lowerFlankAngleDeg: 45
    });
  });
});

describe('thread print advisories', () => {
  const base = resolveThread(
    data(),
    values,
    { kind: 'external', radius: 3, faceLength: 8 },
    1
  );

  it('flags an ISO thread overhanging past 45° and its narrow crest', () => {
    const advisories = threadPrintAdvisories(base, 1, 'mm');
    expect(advisories).toHaveLength(2);
    expect(advisories[0]).toMatch(/overhangs 60° from vertical/);
    expect(advisories[1]).toMatch(/crest flat is 0.125 mm wide/);
  });

  it('passes a printable M12 and flags a shallow thread', () => {
    const printable = resolveThread(
      data({ profile: 'printable' }),
      values,
      { kind: 'external', radius: 6, faceLength: 8 },
      1
    );
    expect(threadPrintAdvisories(printable, 1, 'mm')).toEqual([]);
    const fine = resolveThread(
      data({ profile: 'printable' }),
      values,
      { kind: 'external', radius: 1, faceLength: 4 },
      1
    );
    expect(threadPrintAdvisories(fine, 1, 'mm').join(' ')).toMatch(
      /about one 0.2 mm layer/
    );
  });
});

describe('thread command validation', () => {
  function blank(): { document: ProjectDocument; bodyId: BodyId } {
    const document = addPrimitiveFeature(
      createProjectDocument('Bolt', toUserId('user_thread')),
      {
        name: 'Shank',
        primitiveKind: 'cylinder',
        dimensions: { radius: 3, height: 8 }
      }
    );
    return { document, bodyId: document.bodyOrder[0]! };
  }

  function apply(
    input: Omit<ThreadInput, 'name' | 'targetBodyId' | 'faceHash'>
  ): ProjectDocument {
    const { document, bodyId } = blank();
    const command = commandFactories.threadBody({
      name: 'Thread',
      targetBodyId: bodyId,
      faceHash: 7,
      ...input
    });
    command.validate(document);
    return command.apply(document);
  }

  it('records a thread feature and consumes nothing until it builds', () => {
    const next = apply({ profile: 'iso-metric', clearance: 0.1 });
    expect(next.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const feature = listFeaturesInOrder(next).find(
      (candidate) => candidate.data.featureKind === 'thread'
    );
    expect(feature?.data).toMatchObject({
      featureKind: 'thread',
      profile: 'iso-metric',
      clearance: 0.1
    });
  });

  it('refuses custom fields on a derived profile and a custom form without them', () => {
    expect(() => apply({ profile: 'printable', depth: 0.3 })).toThrow(
      /Only a custom thread profile sets its depth/
    );
    expect(() => apply({ profile: 'custom', pitch: 1 })).toThrow(
      /needs its depth/
    );
    expect(() =>
      apply({
        profile: 'custom',
        pitch: 1,
        depth: 0.7,
        crestWidth: 0.3,
        upperFlankAngleDeg: 30,
        lowerFlankAngleDeg: 30
      })
    ).toThrow(/leaving no root/);
  });

  it('refuses out-of-range starts, flanks and negative clearances', () => {
    expect(() => apply({ profile: 'iso-metric', starts: 0 })).toThrow(
      /whole number from 1 to 16/
    );
    expect(() => apply({ profile: 'iso-metric', clearance: -0.1 })).toThrow(
      /clearance must not be negative/
    );
    expect(() =>
      apply({
        profile: 'custom',
        pitch: 1,
        depth: 0.2,
        crestWidth: 0.1,
        upperFlankAngleDeg: 80,
        lowerFlankAngleDeg: 30
      })
    ).toThrow(/from 0° to 75°/);
  });
});

/**
 * The thread generator arrived in Remus after the kernel this repository
 * pinned when the feature was added. On a kernel without it the feature
 * refuses by name instead of building something else; on one with it, it
 * builds and the cases below run.
 */
const kernelHasThreads =
  typeof (RemusKernel.prototype as unknown as Record<string, unknown>)
    .cutThreadDetailed === 'function';

describe('thread features on the exact kernel', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  async function shank(radius: number, height: number) {
    const document = addPrimitiveFeature(
      createProjectDocument('Bolt', toUserId('user_thread')),
      {
        name: 'Shank',
        primitiveKind: 'cylinder',
        dimensions: { radius, height }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    const body = (await adapter.syncDocument(document)).bodyRepresentations[
      bodyId
    ]!;
    const side = body.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    return { document, bodyId, side };
  }

  it.runIf(!kernelHasThreads)(
    'refuses by name on a kernel without the thread generator',
    async () => {
      const { document, bodyId, side } = await shank(3, 8);
      const threaded = threadBody(document, {
        name: 'Thread',
        targetBodyId: bodyId,
        faceHash: side.hash,
        profile: 'iso-metric'
      });
      const derived = await adapter.syncDocument(threaded.document);
      expect(derived.warnings.join('\n')).toMatch(
        /This kernel build has no thread generator/
      );
    },
    120_000
  );

  it.runIf(kernelHasThreads)(
    'cuts an ISO M6 thread along a boss',
    async () => {
      const { document, bodyId, side } = await shank(3, 8);
      const threaded = threadBody(document, {
        name: 'Thread',
        targetBodyId: bodyId,
        faceHash: side.hash,
        ...(side.reference ? { faceReference: side.reference } : {}),
        profile: 'iso-metric'
      });
      const derived = await adapter.syncDocument(threaded.document);
      // Only the print advisories: an ISO flank overhangs 60°, its crest is
      // 0.125 wide.
      expect(
        derived.featureWarnings!.every((warning) => warning.kind === 'advisory')
      ).toBe(true);
      expect(derived.bodyRepresentations[bodyId]?.consumed).toBe(true);
      const body = derived.bodyRepresentations[threaded.bodyId]!;
      // The outline's area in closed form times the length (arcs r²Δθ/2,
      // linear spirals Δθ(r₀² + r₀r₁ + r₁²)/6, Δθ = 2πw/P).
      const [crest, root] = [3, 3 - ISO_DEPTH];
      const flank =
        ((2 * Math.PI * ISO_DEPTH * Math.tan(Math.PI / 6)) / 6) *
        (crest * crest + crest * root + root * root);
      const area =
        0.5 * crest * crest * 2 * Math.PI * (1 / 8) +
        0.5 * root * root * 2 * Math.PI * (1 / 4) +
        2 * flank;
      expect(body.volume).toBeCloseTo(area * 8, 2);
      expect(body.bbox.max.x - body.bbox.min.x).toBeLessThan(6 + 1e-6);
    },
    120_000
  );

  it.runIf(kernelHasThreads)(
    'refuses a thread past the end of the face with its typed code',
    async () => {
      const { document, bodyId, side } = await shank(3, 8);
      const threaded = threadBody(document, {
        name: 'Thread',
        targetBodyId: bodyId,
        faceHash: side.hash,
        profile: 'printable',
        offset: 2,
        length: 7
      });
      const derived = await adapter.syncDocument(threaded.document);
      const refusal = derived.featureWarnings!.find(
        (warning) => warning.kind === 'build-failed'
      );
      expect(refusal?.message).toMatch(/runs past an end/);
      expect(refusal?.kernelRefusal).toMatchObject({
        family: 'thread',
        code: 'thread:span-outside-face'
      });
    },
    120_000
  );
});
