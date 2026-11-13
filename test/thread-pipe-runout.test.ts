import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  normalizeDocument,
  threadBody,
  type ThreadInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { commandFactories } from '@openzcad/command-system';
import {
  PIPE_THREAD_SIZES,
  PIPE_THREAD_TABLES,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  pipeThreadForFace,
  pipeThreadForm,
  pipeThreadLabel,
  pipeThreadSpec,
  toUserId,
  type BodyId,
  type FeatureData,
  type ParamValue,
  type ProjectDocument
} from '@openzcad/shared';
import {
  requireBuiltAsAsked,
  resolveThread,
  threadEndSpec,
  threadPrintAdvisories
} from '../packages/kernel-adapter/src/exact-thread';

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
    profile: 'npt',
    ...overrides
  };
}

const INCH = 25.4;

describe('pipe thread tables (M15, schema v57)', () => {
  it('holds every NPT row to ASME B1.20.1’s own relations', () => {
    for (const size of PIPE_THREAD_SIZES) {
      const [tpi, D, E0, L1, E1, L2] = PIPE_THREAD_TABLES.npt[size];
      const p = 1 / tpi;
      // E0 = D − (0.05D + 1.1)p, E1 = E0 + L1/16, L2 = (0.8D + 6.8)p.
      expect(Math.abs(E0 - (D - (0.05 * D + 1.1) * p))).toBeLessThan(1e-5);
      expect(Math.abs(E1 - (E0 + L1 / 16))).toBeLessThan(1e-5);
      expect(Math.abs(L2 - (0.8 * D + 6.8) * p)).toBeLessThan(1e-4);
    }
  });

  it('holds every BSPT row to ISO 7-1’s profile', () => {
    for (const size of PIPE_THREAD_SIZES) {
      const [tpi, , major, pitchDiameter, minor, gauge, useful] =
        PIPE_THREAD_TABLES.bspt[size];
      const h = 0.640327 * (INCH / tpi);
      expect(Math.abs(major - minor - 2 * h)).toBeLessThan(1.5e-3);
      expect(Math.abs(major - pitchDiameter - h)).toBeLessThan(1.5e-3);
      expect(useful).toBeGreaterThan(gauge);
    }
  });

  it('gives each standard its form, callout and gauge plane', () => {
    const p = INCH / 14;
    expect(pipeThreadForm('npt', p)).toEqual({
      depth: 0.8 * p,
      crestWidth: 0.03812 * p,
      flankAngleDeg: 30
    });
    const bspt = pipeThreadForm('bspt', p);
    expect(bspt.flankAngleDeg).toBe(27.5);
    // The flanks leave equal P/6 flats at the crest and the root.
    expect(
      bspt.crestWidth + 2 * bspt.depth * Math.tan((27.5 * Math.PI) / 180)
    ).toBeCloseTo((5 / 6) * p, 4);
    const half = pipeThreadSpec('npt', '1/2');
    expect(half.pitch).toBeCloseTo(p, 12);
    expect(half.gaugeMajor).toBeCloseTo(0.77843 * INCH + 0.8 * p, 9);
    expect(half.gaugeLength).toBeCloseTo(0.32 * INCH, 9);
    expect(half.threadLength).toBeCloseTo(0.5337 * INCH, 9);
    expect(pipeThreadLabel('npt', '1/2')).toBe('1/2-14 NPT');
    expect(pipeThreadLabel('bspt', '1/2', 'external')).toBe('R 1/2');
    expect(pipeThreadLabel('bspt', '1/2', 'internal')).toBe('Rc 1/2');
  });

  it('sizes a boss by its pipe and a bore by its minor diameter', () => {
    expect(pipeThreadForFace('npt', 'external', 21.3).size).toBe('1/2');
    expect(pipeThreadForFace('bspt', 'external', 33.7).size).toBe('1');
    expect(pipeThreadForFace('npt', 'internal', 18).size).toBe('1/2');
    expect(pipeThreadForFace('bspt', 'internal', 11.4).size).toBe('1/4');
  });
});

describe('pipe thread resolution against its face', () => {
  it('tapers an NPT boss small at its fitting end, gauged L1 in', () => {
    const thread = resolveThread(
      data({ pipeSize: '1/2' }),
      values,
      { kind: 'external', radius: 0.84 * (INCH / 2), faceLength: 20 },
      1
    );
    const p = INCH / 14;
    expect(thread.pitch).toBeCloseTo(p, 12);
    expect(thread.depth).toBeCloseTo(0.8 * p, 12);
    expect(thread.crestWidth).toBeCloseTo(0.03812 * p, 12);
    expect([thread.upperFlankAngleDeg, thread.lowerFlankAngleDeg]).toEqual([
      30, 30
    ]);
    expect(thread.majorDiameter).toBeCloseTo(0.77843 * INCH + 0.8 * p, 9);
    expect(thread.taper).toMatchObject({
      ratio: 1 / 16,
      smallEnd: 'start'
    });
    expect(thread.taper!.gaugeOffset).toBeCloseTo(0.32 * INCH, 9);
    // On its nominal pipe the crest meets the boss 16·(D − E0 − 0.8P) from
    // the pipe's end, short of L2: the thread stops there, and says so.
    const reach = 16 * (0.84 - 0.75843 - 0.8 / 14) * INCH;
    expect(thread.length).toBeCloseTo(reach, 3);
    expect(thread.offset).toBe(0);
    expect(thread.truncation).toBe(0);
    expect(thread.shortOfStandard).toBeCloseTo(0.5337 * INCH, 9);
    expect(threadPrintAdvisories(thread, 1, 'mm').join('\n')).toMatch(
      /stops after 9\.92\d* mm, where its crest meets the boss, short of the standard's 13\.5\d* mm/
    );
  });

  it('opens an NPT bore large at its fitting end, gauged on it', () => {
    // A Ø18 bore takes 1/2 NPT; anchored at the face's end, the small end
    // is the face's start side.
    const thread = resolveThread(
      data({ anchor: 'end' }),
      values,
      { kind: 'internal', radius: 9, faceLength: 30 },
      1
    );
    const spec = pipeThreadSpec('npt', '1/2');
    expect(thread.pipe?.size).toBe('1/2');
    expect(thread.majorDiameter).toBeCloseTo(spec.gaugeMajor, 12);
    // The minor diameter shrinks 1 in 16 toward the deep end and may not
    // fall below the bore.
    const reach = (spec.gaugeMajor - 2 * 0.8 * spec.pitch - 18) * 16;
    expect(thread.length).toBeCloseTo(reach, 9);
    expect(thread.offset).toBeCloseTo(30 - reach, 9);
    expect(thread.taper).toMatchObject({
      ratio: 1 / 16,
      smallEnd: 'start'
    });
    expect(thread.taper!.gaugeOffset).toBeCloseTo(reach, 9);
  });

  it('gauges Rc half a pitch behind its fitting face and R its gauge length in', () => {
    const rc = resolveThread(
      data({ profile: 'bspt', pipeSize: '1/2', length: 10 }),
      values,
      { kind: 'internal', radius: 9, faceLength: 30 },
      1
    );
    const p = INCH / 14;
    expect(rc.majorDiameter).toBe(20.955);
    expect(rc.depth).toBeCloseTo(0.640327 * p, 12);
    expect(rc.crestWidth).toBeCloseTo(p / 6, 12);
    expect(rc.taper).toMatchObject({
      ratio: 1 / 16,
      smallEnd: 'end'
    });
    expect(rc.taper!.gaugeOffset).toBeCloseTo(10 - p / 2, 12);
    expect(rc.shortOfStandard).toBeUndefined();
    expect(threadPrintAdvisories(rc, 1, 'mm').join('\n')).toMatch(
      /BSPT profile is approximate/
    );
    // R 1/2 on its Ø21.3 pipe runs the standard's useful 13.2 mm.
    const r = resolveThread(
      data({ profile: 'bspt', anchor: 'end' }),
      values,
      { kind: 'external', radius: 21.3 / 2, faceLength: 30 },
      1
    );
    expect(r.pipe?.size).toBe('1/2');
    expect(r.length).toBeCloseTo(13.2, 12);
    expect(r.offset).toBeCloseTo(30 - 13.2, 12);
    expect(r.taper).toEqual({
      ratio: 1 / 16,
      smallEnd: 'end',
      gaugeOffset: 8.2
    });
  });

  it('moves a pipe thread away from its mate by the clearance, in any unit', () => {
    const r = resolveThread(
      data({ profile: 'bspt', pipeSize: '1/2', clearance: 0.1 / INCH }),
      values,
      { kind: 'external', radius: 21.3 / 2 / INCH, faceLength: 2 },
      INCH
    );
    expect(r.majorDiameter * INCH).toBeCloseTo(20.955 - 0.2, 9);
    expect(r.pitch).toBeCloseTo(1 / 14, 12);
    expect(r.taper!.gaugeOffset * INCH).toBeCloseTo(8.2, 9);
  });
});

describe('thread runouts (M15, schema v57)', () => {
  const face = { kind: 'external' as const, radius: 3, faceLength: 8 };

  it('sends a runout to the kernel with the end angle', () => {
    const thread = resolveThread(
      data({
        profile: 'iso-metric',
        length: 5,
        chamferStart: true,
        runoutEnd: true,
        chamferAngleDeg: 30
      }),
      values,
      face,
      1
    );
    expect(threadEndSpec(thread)).toEqual({
      start: { kind: 'chamfer', angle: 30 },
      end: { kind: 'runout', angle: 30 }
    });
    const runoutOnly = resolveThread(
      data({ profile: 'printable', offset: 2, runoutStart: true }),
      values,
      face,
      1
    );
    expect(threadEndSpec(runoutOnly)).toEqual({
      start: { kind: 'runout', angle: 45 }
    });
  });

  it('refuses an end with both a chamfer and a runout', () => {
    const thread = resolveThread(
      data({ profile: 'iso-metric', chamferEnd: true, runoutEnd: true }),
      values,
      face,
      1
    );
    expect(() => threadEndSpec(thread)).toThrow(
      /end takes a chamfer or a runout, not both/
    );
  });

  it('refuses a kernel that did not build the runout or the taper it was asked for', () => {
    expect(() =>
      requireBuiltAsAsked(
        { runout: { end: 45 } },
        { geometry: { end: { kind: 'plain' } } }
      )
    ).toThrow(/no thread runouts/);
    expect(() =>
      requireBuiltAsAsked(
        { runout: { end: 45 } },
        { geometry: { end: { kind: 'runout' } } }
      )
    ).not.toThrow();
    expect(() =>
      requireBuiltAsAsked(
        { taper: { ratio: 1 / 16, smallEnd: 'start', gaugeOffset: 0 } },
        { geometry: {} }
      )
    ).toThrow(/no tapered threads/);
  });
});

describe('thread command validation (schema v57)', () => {
  function apply(
    input: Omit<ThreadInput, 'name' | 'targetBodyId' | 'faceHash'>
  ): ProjectDocument {
    const document = addPrimitiveFeature(
      createProjectDocument('Pipe', toUserId('user_thread')),
      {
        name: 'Nipple',
        primitiveKind: 'cylinder',
        dimensions: { radius: 10.65, height: 20 }
      }
    );
    const command = commandFactories.threadBody({
      name: 'Thread',
      targetBodyId: document.bodyOrder[0]!,
      faceHash: 7,
      ...input
    });
    command.validate(document);
    return command.apply(document);
  }

  it('records a pipe thread and a runout', () => {
    expect(() =>
      apply({ profile: 'bspt', pipeSize: '1/2', runoutEnd: true, length: 9 })
    ).not.toThrow();
  });

  it('refuses a size on a non-pipe thread, a diameter on a pipe one and an unknown size', () => {
    expect(() => apply({ profile: 'iso-metric', pipeSize: '1/2' })).toThrow(
      /Only an NPT or BSPT pipe thread takes a pipe size/
    );
    expect(() => apply({ profile: 'npt', majorDiameter: 21 })).toThrow(
      /takes its diameter from its pipe size/
    );
    expect(() =>
      apply({ profile: 'npt', pipeSize: '5/8' as unknown as '1/2' })
    ).toThrow(/is not one/);
    expect(() => apply({ profile: 'npt', depth: 1 })).toThrow(
      /a pipe thread takes its standard's/
    );
  });

  it('refuses a chamfer and a runout on one end', () => {
    expect(() =>
      apply({ profile: 'printable', chamferStart: true, runoutStart: true })
    ).toThrow(/start takes a chamfer or a runout, not both/);
  });
});

describe('schema v57 migration', () => {
  function threadedV56(fields: Partial<ThreadInput> = {}): ProjectDocument {
    const document = addPrimitiveFeature(
      createProjectDocument('Bolt', toUserId('user_thread')),
      {
        name: 'Shank',
        primitiveKind: 'cylinder',
        dimensions: { radius: 3, height: 8 }
      }
    );
    const threaded = threadBody(document, {
      name: 'Thread',
      targetBodyId: document.bodyOrder[0]!,
      faceHash: 7,
      profile: 'iso-metric',
      chamferStart: true,
      ...fields
    }).document;
    return { ...threaded, schemaVersion: 56 } as unknown as ProjectDocument;
  }

  it('opens a v56 thread unchanged but for the version', () => {
    const v56 = threadedV56();
    const opened = normalizeDocument(v56);
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(57);
    expect(opened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(opened.nodes).toEqual(v56.nodes);
    expect(opened.featureOrder).toEqual(v56.featureOrder);
  });

  it.each([
    [{ runoutEnd: true, length: 5 }],
    [{ profile: 'npt' as const }],
    [{ profile: 'bspt' as const, pipeSize: '1/4' as const }]
  ])('refuses a v57 thread in a document that declares v56: %j', (fields) => {
    expect(() =>
      normalizeDocument(threadedV56({ chamferStart: undefined, ...fields }))
    ).toThrow(/Thread runouts and pipe threads require project schema v57/);
  });
});

/**
 * Runouts and tapers arrived in Remus after the kernel the thread feature
 * shipped on (esaueng/remus#1698, #1701); the pin carries both.
 */
describe('runouts and pipe threads on the exact kernel', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  async function boss(radius: number, height: number) {
    const document = addPrimitiveFeature(
      createProjectDocument('Pipe', toUserId('user_thread')),
      {
        name: 'Boss',
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

  async function built(
    document: ProjectDocument,
    input: Omit<ThreadInput, 'name'>
  ) {
    const threaded = threadBody(document, { name: 'Thread', ...input });
    const derived = await adapter.syncDocument(threaded.document);
    expect(
      derived.featureWarnings!.filter(
        (warning) => warning.kind === 'build-failed'
      )
    ).toEqual([]);
    return { derived, body: derived.bodyRepresentations[threaded.bodyId]! };
  }

  it('runs a partial M6 thread out where it stops short of the face', async () => {
    const { document, bodyId, side } = await boss(3, 8);
    const base = {
      targetBodyId: bodyId,
      faceHash: side.hash,
      profile: 'iso-metric' as const,
      length: 5
    };
    const plain = await built(document, base);
    const runout = await built(document, { ...base, runoutEnd: true });
    // The cone fills the groove's last turn up to it: material is added
    // back, never taken past the crest.
    expect(runout.body.volume).toBeGreaterThan(plain.body.volume);
    expect(runout.body.volume - plain.body.volume).toBeLessThan(
      Math.PI * (9 - (3 - 0.65) ** 2) * 1.5
    );
    expect(runout.body.bbox.max.x - runout.body.bbox.min.x).toBeLessThan(
      6 + 1e-6
    );
  }, 240_000);

  it('refuses runouts that overlap with plain-language copy', async () => {
    const { document, bodyId, side } = await boss(3, 8);
    const threaded = threadBody(document, {
      name: 'Thread',
      targetBodyId: bodyId,
      faceHash: side.hash,
      profile: 'iso-metric',
      offset: 3,
      length: 0.8,
      runoutStart: true,
      runoutEnd: true,
      chamferAngleDeg: 20
    });
    const derived = await adapter.syncDocument(threaded.document);
    const refusal = derived.featureWarnings!.find(
      (warning) => warning.kind === 'build-failed'
    );
    expect(refusal?.message).toMatch(
      /The finishes at the two ends overlap: the thread is too short for both/
    );
    expect(refusal?.kernelRefusal).toMatchObject({
      family: 'thread',
      code: 'thread:ends-overlap'
    });
  }, 120_000);

  it('cuts a 1/4-18 NPT thread on its pipe, small at the free end', async () => {
    const { document, bodyId, side } = await boss((0.54 * INCH) / 2, 20);
    const { derived, body } = await built(document, {
      targetBodyId: bodyId,
      faceHash: side.hash,
      profile: 'npt',
      pipeSize: '1/4',
      anchor: 'end',
      runoutStart: true
    });
    // The only notes are the advisories (a 30° flank, a sharp crest, the
    // standard's length the nominal pipe cannot hold).
    expect(
      derived.featureWarnings!.every((warning) => warning.kind === 'advisory')
    ).toBe(true);
    expect(derived.warnings.join('\n')).toMatch(/short of the standard's/);
    expect(body.bbox.max.x - body.bbox.min.x).toBeLessThan(0.54 * INCH + 1e-6);
    expect(derived.bodyRepresentations[bodyId]?.consumed).toBe(true);
  }, 240_000);
});
