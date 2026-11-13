import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { expectPassedThrough } from './support/failed-pass-through';
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
  threadChamfersShortOfFace,
  threadEndSpec,
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

describe('thread chamfers', () => {
  it('finds the chamfered ends that stop short of the face', () => {
    const face = { radius: 3, faceLength: 8 };
    const short = (fields: Partial<ThreadData>) =>
      threadChamfersShortOfFace(
        resolveThread(
          data({ chamferStart: true, chamferEnd: true, ...fields }),
          values,
          { kind: 'external', ...face },
          1
        ),
        face
      );
    // The whole face, and a span within the kernel's snap of it.
    expect(short({})).toEqual([]);
    expect(short({ length: 8 - 1e-12 })).toEqual([]);
    // From the start, short of the end; from the end, short of the start.
    expect(short({ length: 5 })).toEqual(['end']);
    expect(short({ length: 5, anchor: 'end' })).toEqual(['start']);
    // Set off from the end it starts at.
    expect(short({ offset: 2 })).toEqual(['start']);
    expect(short({ offset: 2, anchor: 'end' })).toEqual(['end']);
    expect(short({ offset: 1, length: 5 })).toEqual(['start', 'end']);
    // Only a chamfered end counts.
    expect(short({ length: 5, chamferEnd: false })).toEqual([]);
    // A span past the face is the kernel's to refuse, by its own code.
    expect(short({ offset: 2, length: 7 })).toEqual([]);
  });

  it('sends a chamfered end to the kernel and leaves a plain one out', () => {
    const chamfered = resolveThread(
      data({ chamferEnd: true, chamferAngleDeg: 30 }),
      values,
      { kind: 'external', radius: 3, faceLength: 8 },
      1
    );
    expect(threadEndSpec(chamfered)).toEqual({
      end: { kind: 'chamfer', angle: 30 }
    });
    const both = resolveThread(
      data({ chamferStart: true, chamferEnd: true }),
      values,
      { kind: 'external', radius: 3, faceLength: 8 },
      1
    );
    expect(threadEndSpec(both)).toEqual({
      start: { kind: 'chamfer', angle: 45 },
      end: { kind: 'chamfer', angle: 45 }
    });
    const plain = resolveThread(
      data(),
      values,
      { kind: 'external', radius: 3, faceLength: 8 },
      1
    );
    expect(threadEndSpec(plain)).toEqual({});
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
    expect(() =>
      apply({ profile: 'printable', chamferEnd: true, chamferAngleDeg: 90 })
    ).toThrow(/chamfer angle must be strictly between 0 and 90/);
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

  it.each([
    ['thread:span-outside-face', 'runs past an end'],
    ['future:structured-refusal', 'unknown field `start`: synthetic diagnostic']
  ])(
    'uses the typed %s refusal without interpreting its prose',
    async (code, reason) => {
      const { document, bodyId, side } = await shank(3, 8);
      const threaded = threadBody(document, {
        name: 'Thread',
        targetBodyId: bodyId,
        faceHash: side.hash,
        profile: 'iso-metric',
        chamferStart: true
      });
      const mock = vi
        .spyOn(RemusKernel.prototype, 'cutThreadDetailed')
        .mockReturnValue({
          status: 'error',
          code,
          category: 'invalid_input',
          value: null,
          details: { message: 'unknown field `start`: synthetic diagnostic' }
        });
      try {
        const derived = await adapter.syncDocument(threaded.document);
        const refusal = derived.featureWarnings!.find(
          (warning) => warning.kind === 'build-failed'
        );
        expect(refusal?.message).toContain(reason);
        expect(refusal?.message).not.toContain('cannot chamfer threads');
        expect(refusal?.kernelRefusal).toMatchObject({
          family: 'thread',
          code
        });
        // Refused: the shank stands in for the thread, unchanged (ADR-017).
        expectPassedThrough(derived, threaded.bodyId, bodyId);
      } finally {
        mock.mockRestore();
      }
    }
  );

  it.runIf(kernelHasThreads)(
    'chamfers both ends of an M6 boss with the pinned kernel',
    async () => {
      const { document, bodyId, side } = await shank(3, 8);
      const plain = threadBody(document, {
        name: 'Thread',
        targetBodyId: bodyId,
        faceHash: side.hash,
        profile: 'iso-metric'
      });
      const chamfered = threadBody(document, {
        name: 'Thread',
        targetBodyId: bodyId,
        faceHash: side.hash,
        profile: 'iso-metric',
        chamferStart: true,
        chamferEnd: true
      });
      const plainBody = (await adapter.syncDocument(plain.document))
        .bodyRepresentations[plain.bodyId]!;
      const derived = await adapter.syncDocument(chamfered.document);
      expect(
        derived.featureWarnings!.filter(
          (warning) => warning.kind === 'build-failed'
        )
      ).toEqual([]);
      expect(derived.warnings).toHaveLength(2);
      expect(derived.warnings[0]).toContain('overhangs 60°');
      expect(derived.warnings[1]).toContain('crest flat is 0.125 mm');
      const body = derived.bodyRepresentations[chamfered.bodyId]!;
      // The two cones take about 1.9 mm³ off the plain M6 (the kernel's
      // own test integrates it); the ends never grow.
      expect(plainBody.volume - body.volume).toBeGreaterThan(1.5);
      expect(plainBody.volume - body.volume).toBeLessThan(2.5);
      expect(body.bbox.max.x - body.bbox.min.x).toBeLessThan(6 + 1e-6);
    },
    120_000
  );

  it.runIf(kernelHasThreads)(
    'keeps the chamfer at the end a partial thread starts from',
    async () => {
      const { document, bodyId, side } = await shank(3, 8);
      const thread = (fields: Partial<ThreadInput>) =>
        threadBody(document, {
          name: 'Thread',
          targetBodyId: bodyId,
          faceHash: side.hash,
          profile: 'iso-metric',
          ...fields
        });
      const built = async (fields: Partial<ThreadInput>) => {
        const threaded = thread(fields);
        const derived = await adapter.syncDocument(threaded.document);
        expect(
          derived.featureWarnings!.filter(
            (warning) => warning.kind === 'build-failed'
          )
        ).toEqual([]);
        return derived.bodyRepresentations[threaded.bodyId]!;
      };
      // The M6 outline's area in closed form, as above: a plain thread 5
      // long leaves a 3 long collar of the shank.
      const [crest, root] = [3, 3 - ISO_DEPTH];
      const flank =
        ((2 * Math.PI * ISO_DEPTH * Math.tan(Math.PI / 6)) / 6) *
        (crest * crest + crest * root + root * root);
      const area =
        0.5 * crest * crest * 2 * Math.PI * (1 / 8) +
        0.5 * root * root * 2 * Math.PI * (1 / 4) +
        2 * flank;
      const plain = await built({ length: 5 });
      expect(plain.volume).toBeCloseTo(area * 5 + Math.PI * 9 * 3, 2);
      // What a 45° cone through the end plane at radius `atEnd` takes off
      // the thread: the outline outside the cone's circle, in closed form
      // at each height (arcs ½(r² − c²)Δθ, a flank's part above the circle
      // Δθ·f·((r₁² + r₁c + c²)/6 − c²/2)), integrated up to the crest.
      const outside = (c: number) => {
        const turn = (width: number) => 2 * Math.PI * width;
        const arc = (r: number, width: number) =>
          r > c ? 0.5 * (r * r - c * c) * turn(width) : 0;
        const from = Math.max(c, root);
        const above =
          ((crest - from) / ISO_DEPTH) *
          turn(ISO_DEPTH * Math.tan(Math.PI / 6)) *
          ((crest * crest + crest * from + from * from) / 6 - (c * c) / 2);
        return arc(crest, 1 / 8) + arc(root, 1 / 4) + 2 * above;
      };
      const coneTakes = (atEnd: number) => {
        const steps = 4000;
        const height = crest - atEnd;
        let sum = 0;
        for (let step = 0; step < steps; step += 1) {
          sum += outside(atEnd + (height * (step + 0.5)) / steps);
        }
        return (sum * height) / steps;
      };
      // The cone leaves the end plane just inside the root: between the
      // root itself and a tenth of the depth below it.
      const [least, most] = [coneTakes(root), coneTakes(root - ISO_DEPTH / 10)];
      // From the face's start, and from its end.
      const fromStart = await built({ length: 5, chamferStart: true });
      expect(plain.volume - fromStart.volume).toBeGreaterThan(least);
      expect(plain.volume - fromStart.volume).toBeLessThan(most);
      expect(fromStart.bbox.max.x - fromStart.bbox.min.x).toBeLessThan(
        6 + 1e-6
      );
      const fromEnd = await built({
        length: 5,
        anchor: 'end',
        chamferEnd: true
      });
      expect(plain.volume - fromEnd.volume).toBeGreaterThan(least);
      expect(plain.volume - fromEnd.volume).toBeLessThan(most);
    },
    240_000
  );

  it.each([
    [{ length: 5, chamferEnd: true }, /short of the face's end\./],
    [{ length: 5, anchor: 'end', chamferStart: true }, /face's start\./],
    [{ offset: 2, chamferStart: true, chamferEnd: true }, /face's start\./],
    [
      { offset: 1, length: 5, chamferStart: true, chamferEnd: true },
      /short of both/
    ]
  ] as const)(
    'refuses a chamfer on an end short of the face by code: %j',
    async (fields, reason) => {
      const { document, bodyId, side } = await shank(3, 8);
      const threaded = threadBody(document, {
        name: 'Thread',
        targetBodyId: bodyId,
        faceHash: side.hash,
        profile: 'iso-metric',
        ...fields
      });
      const kernelCall = vi.spyOn(RemusKernel.prototype, 'cutThreadDetailed');
      try {
        const derived = await adapter.syncDocument(threaded.document);
        const refusal = derived.featureWarnings!.find(
          (warning) => warning.kind === 'build-failed'
        );
        expect(refusal?.message).toMatch(reason);
        expect(refusal?.kernelRefusal).toEqual({
          family: 'thread',
          category: 'unsupported',
          code: 'thread:chamfer-short-of-face'
        });
        // Refused before the kernel is asked; the shank stands in for it.
        expect(kernelCall).not.toHaveBeenCalled();
        expectPassedThrough(derived, threaded.bodyId, bodyId);
      } finally {
        kernelCall.mockRestore();
      }
    },
    120_000
  );
});
