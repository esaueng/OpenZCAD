import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  assemblySweepOverrides,
  assemblySweepPoses,
  assemblySweepRefinements,
  attachDerivedState,
  createProjectDocument,
  planAssemblySweep,
  runAssemblySweep,
  sortSweptPairs,
  summarizeAssemblySweep,
  SWEEP_JOINT_STEPS,
  SWEEP_REFINEMENTS,
  type AssemblySweepCheck
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  IDENTITY_PLACEMENT,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type AssemblyFrame,
  type BodyClashVerdict,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * AS04 interference through motion (no schema change): the exact pairwise
 * clash query at positions along a joint's sweep or a motion study, for the
 * pairs that move against each other, with each overlap's start and end
 * located by halving the gap where a verdict turns.
 */
const owner = toUserId('user_sweep');

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

const check: AssemblySweepCheck = (document, components, positions) =>
  adapter.assemblyInterferenceSweep(document, components, positions);

/** A frame at `x` whose z axis (a slider's travel) is world +X. */
const along = (x: number): AssemblyFrame => ({
  origin: { x, y: 0, z: 0 },
  zAxis: { x: 1, y: 0, z: 0 },
  xAxis: { x: 0, y: 1, z: 0 }
});

/**
 * Three 10 mm cubes: a grounded block at the origin, a pin starting 40 mm
 * to its left on a slider along +X (0 to 80 mm), and a grounded post far
 * away. The pin passes through the block between 30 and 50 mm of travel,
 * fully inside it at 40.
 */
async function rig(
  limits: { min: number; max: number } | null = { min: 0, max: 80 }
) {
  const manager = new CommandManager(createProjectDocument('Slide', owner));
  for (const name of ['Block', 'Pin', 'Post'])
    manager.execute(
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
  const ids = [...manager.document.bodyOrder] as BodyId[];
  const at = [
    { x: 0, y: 0, z: 0 },
    { x: -40, y: 0, z: 0 },
    { x: 0, y: 200, z: 0 }
  ];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: ids.map((bodyId, index) => ({
        componentId: ['c_block', 'c_pin', 'c_post'][index]!,
        name: ['Block', 'Pin', 'Post'][index]!,
        bodyId,
        grounded: index !== 1,
        placement: { ...IDENTITY_PLACEMENT, translation: at[index]! }
      }))
    })
  );
  manager.execute(
    commandFactories.addAssemblyJoint({
      joint: {
        id: 'j_slide',
        name: 'Slide',
        kind: 'slider',
        parent: { componentId: 'c_block', frame: along(-40) },
        child: { componentId: 'c_pin', frame: along(0) },
        values: [0],
        limits: [limits]
      }
    })
  );
  return manager;
}

async function synced(document: ProjectDocument) {
  return attachDerivedState(document, await adapter.syncDocument(document));
}

const clear: BodyClashVerdict = {
  kind: 'clear',
  touching: false,
  distance: null,
  closest: null,
  atLeast: null
};
const hit: BodyClashVerdict = {
  kind: 'interference',
  volume: 1,
  proof: 'intersect',
  point: null,
  bounds: null,
  complete: true
};
const unknown: BodyClashVerdict = {
  kind: 'unknown',
  reason: 'x',
  message: 'x'
};
/** One position checking pair a·b. */
const at = (value: number, verdict: BodyClashVerdict) => ({
  at: value,
  pairs: [{ a: 'a', b: 'b', verdict }]
});

describe('AS04 interference through motion', () => {
  it('plans only the pairs that move against each other, and stores nothing', async () => {
    const manager = await rig();
    const document = manager.document;
    expect(document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const planned = planAssemblySweep(
      document,
      { kind: 'joint', jointId: 'j_slide', dof: 0 },
      () => true
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { plan } = planned;
    expect(plan.unit).toBe('mm');
    expect([plan.from, plan.to]).toEqual([0, 80]);
    expect(plan.positions).toHaveLength(SWEEP_JOINT_STEPS + 1);
    expect(plan.positions.at(-1)).toBe(80);
    // Block and post never move against each other.
    expect(plan.pairs).toEqual([
      ['c_block', 'c_pin'],
      ['c_pin', 'c_post']
    ]);
    expect(plan.still).toBe(1);
    // The pin's pose at 25 mm of travel: 15 mm left of the block.
    const pose = assemblySweepPoses(document.assembly!, plan.source, 25);
    expect(pose.get('c_pin')![12]).toBeCloseTo(-15, 9);
    expect(
      assemblySweepOverrides(document.assembly!, plan.source, 25).overrides.get(
        'j_slide'
      )
    ).toEqual([25]);
  });

  it('refuses what has no range or no relative motion, by name', async () => {
    const unlimited = (await rig(null)).document;
    expect(
      planAssemblySweep(unlimited, {
        kind: 'joint',
        jointId: 'j_slide',
        dof: 0
      })
    ).toEqual({
      ok: false,
      reason: 'Set limits on Slide to give it a range to sweep.'
    });
    expect(
      planAssemblySweep(unlimited, { kind: 'study', studyId: 'nope' })
    ).toEqual({
      ok: false,
      reason: 'That motion study is not in the assembly.'
    });
  });

  it('finds where the pin passes through the block, its worst overlap and the gap either side', async () => {
    const manager = await rig();
    const document = await synced(manager.document);
    const planned = planAssemblySweep(
      document,
      { kind: 'joint', jointId: 'j_slide', dof: 0 },
      () => true
    );
    if (!planned.ok) throw new Error(planned.reason);
    const report = await runAssemblySweep(document, planned.plan, check);
    expect(report.missing).toEqual([]);
    expect(report.still).toBe(1);
    expect(report.step).toBeCloseTo(80 / SWEEP_JOINT_STEPS, 12);
    expect(report.resolution).toBeCloseTo(
      80 / SWEEP_JOINT_STEPS / 2 ** SWEEP_REFINEMENTS,
      12
    );
    // Refinement added positions beyond the even ones.
    expect(report.checked).toBeGreaterThan(SWEEP_JOINT_STEPS + 1);
    const [first, second] = sortSweptPairs(report.pairs);
    expect([first!.a, first!.b]).toEqual(['c_block', 'c_pin']);
    expect(first!.overlaps).toHaveLength(1);
    const { from, to } = first!.overlaps[0]!;
    // Exactly at 30 and 50 the faces only touch: the overlap is open.
    expect(from).toBeGreaterThan(30);
    expect(from - 30).toBeLessThanOrEqual(report.resolution + 1e-9);
    expect(to).toBeLessThan(50);
    expect(50 - to).toBeLessThanOrEqual(report.resolution + 1e-9);
    const worst = first!.worst!;
    expect(worst.verdict.kind).toBe('interference');
    if (worst.verdict.kind === 'interference') {
      expect(worst.verdict.volume).toBeCloseTo(1000, 6);
      expect(worst.at).toBeCloseTo(40, 9);
    }
    expect(first!.unknownAt).toEqual([]);
    // Just outside the overlap the certified gap is under one resolution.
    expect(first!.closest!.distance).toBeLessThanOrEqual(report.resolution);
    // The pin never reaches the post.
    expect([second!.a, second!.b]).toEqual(['c_pin', 'c_post']);
    expect(second!.overlaps).toEqual([]);
    expect(second!.touches).toBe(false);
  }, 240_000);

  it('sweeps a motion study over its timeline in seconds', async () => {
    const manager = await rig();
    manager.execute(
      commandFactories.setAssemblyStudy({
        study: {
          id: 'st_pass',
          name: 'Pass through',
          durationS: 2,
          playback: 'once',
          tracks: [
            {
              jointId: 'j_slide',
              dof: 0,
              keys: [
                { t: 0, value: 0, easing: 'linear' },
                { t: 2, value: 80, easing: 'linear' }
              ]
            }
          ]
        }
      })
    );
    const document = await synced(manager.document);
    const planned = planAssemblySweep(
      document,
      { kind: 'study', studyId: 'st_pass' },
      () => true
    );
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.plan.unit).toBe('s');
    expect(planned.plan.positions).toHaveLength(25);
    const report = await runAssemblySweep(document, planned.plan, check);
    const block = report.pairs.find(
      (pair) => pair.a === 'c_block' && pair.b === 'c_pin'
    )!;
    // 30 to 50 mm of travel is 0.75 to 1.25 s.
    expect(block.overlaps).toHaveLength(1);
    expect(block.overlaps[0]!.from).toBeGreaterThan(0.75);
    expect(block.overlaps[0]!.from - 0.75).toBeLessThanOrEqual(
      report.resolution + 1e-9
    );
    expect(block.overlaps[0]!.to).toBeLessThan(1.25);
  }, 240_000);

  it('halves every gap where a verdict turns, narrowing across an unknown position', () => {
    expect(
      assemblySweepRefinements([
        at(0, clear),
        at(1, hit),
        at(2, hit),
        at(3, unknown),
        at(4, clear),
        at(5, clear)
      ])
    ).toEqual([
      { at: 0.5, pairs: [['a', 'b']] },
      // 2 overlaps, 4 does not: 3 decided nothing, so both halves narrow.
      { at: 2.5, pairs: [['a', 'b']] },
      { at: 3.5, pairs: [['a', 'b']] }
    ]);
  });

  it('says how near each turn is known, and leaves out pairs with a part that has no geometry', () => {
    const plan = {
      source: { kind: 'joint' as const, jointId: 'j', dof: 0 },
      unit: 'mm' as const,
      from: 0,
      to: 4,
      positions: [0, 1, 2, 3, 4],
      components: [],
      missing: [],
      pairs: [
        ['a', 'b'],
        ['a', 'gone']
      ] as [string, string][],
      still: 0
    };
    const report = summarizeAssemblySweep(
      plan,
      [at(0, clear), at(1, hit), at(2, hit), at(3, unknown), at(4, clear)],
      ['gone']
    );
    expect(report.missing).toEqual(['gone']);
    expect(report.pairs.map((pair) => `${pair.a}·${pair.b}`)).toEqual(['a·b']);
    expect(report.pairs[0]!.overlaps).toEqual([
      { from: 1, to: 2, fromWithin: 1, toWithin: 2 }
    ]);
    expect(report.pairs[0]!.unknownAt).toEqual([3]);
  });

  it('sweeps a coupled joint only as far as its mate allows, as Animate does', async () => {
    const document = (await rig(null)).document;
    const set = document.assembly!;
    const coupled: ProjectDocument = {
      ...document,
      assembly: {
        ...set,
        components: set.components.map((c) =>
          c.id === 'c_post' ? { ...c, grounded: false } : c
        ),
        joints: [
          { ...set.joints[0]!, limits: [{ min: 30, max: 32 }] },
          {
            id: 'j_turn',
            name: 'Turn',
            kind: 'revolute',
            parent: { componentId: 'c_block', frame: along(0) },
            child: { componentId: 'c_post', frame: along(0) },
            values: [0],
            limits: [null]
          }
        ],
        couplings: [
          {
            id: 'cp',
            name: 'Turn drives slide',
            driver: { jointId: 'j_turn', dof: 0 },
            driven: { jointId: 'j_slide', dof: 0 },
            ratio: 1,
            offset: 0
          }
        ]
      }
    };
    const planned = planAssemblySweep(
      coupled,
      { kind: 'joint', jointId: 'j_turn', dof: 0 },
      () => true
    );
    if (!planned.ok) throw new Error(planned.reason);
    expect([planned.plan.from, planned.plan.to]).toEqual([30, 32]);
    // Showing a joint position overrides that joint alone.
    expect([
      ...assemblySweepOverrides(
        coupled.assembly!,
        planned.plan.source,
        31
      ).overrides.keys()
    ]).toEqual(['j_turn']);
  });
});
