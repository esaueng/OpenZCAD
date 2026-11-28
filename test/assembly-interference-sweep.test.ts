import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  assemblyInterferenceOperands,
  assemblySweepOverrides,
  assemblySweepPoses,
  assemblySweepRefinements,
  attachDerivedState,
  createProjectDocument,
  planAssemblySweep,
  runAssemblySweep,
  sortSweptPairs,
  summarizeAssemblySweep,
  summarizeInterference,
  summarizeSweptPairs,
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

const check: AssemblySweepCheck = (document, components, positions, sweep) =>
  adapter.assemblyInterferenceSweep(document, components, positions, sweep);

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
      held: [],
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
    expect(report.pairs[0]!.checked).toBe(5);
    expect(summarizeSweptPairs(report)).toEqual({
      overlapping: 1,
      unknown: 1,
      unknownEverywhere: 0,
      onlyUnknown: { positions: 1, checked: 5 },
      touching: 0,
      clear: 0,
      missing: 1
    });
  });

  it('counts a pair unknown at every sample apart from the clear ones (#2183)', () => {
    // The issue's sweep: 37 samples, the gear pair unknown at each of them,
    // the two other moving pairs clear throughout.
    const positions = Array.from({ length: 37 }, (_, index) => index);
    const plan = {
      source: { kind: 'joint' as const, jointId: 'j', dof: 0 },
      unit: 'mm' as const,
      from: 0,
      to: 36,
      positions,
      components: [],
      missing: [],
      pairs: [
        ['pinion', 'rack'],
        ['plate', 'rack'],
        ['pinion', 'plate']
      ] as [string, string][],
      held: [],
      still: 0
    };
    const report = summarizeAssemblySweep(
      plan,
      positions.map((value) => ({
        at: value,
        pairs: [
          { a: 'pinion', b: 'rack', verdict: unknown },
          { a: 'plate', b: 'rack', verdict: clear },
          { a: 'pinion', b: 'plate', verdict: clear }
        ]
      }))
    );
    expect(report.checked).toBe(37);
    const gears = report.pairs[0]!;
    expect(gears.unknownAt).toHaveLength(37);
    expect(gears.overlaps).toEqual([]);
    expect(summarizeSweptPairs(report)).toEqual({
      overlapping: 0,
      unknown: 1,
      unknownEverywhere: 1,
      onlyUnknown: { positions: 37, checked: 37 },
      touching: 0,
      clear: 2,
      missing: 0
    });
    // The control: the same sweep with every pair decided is all clear.
    const control = summarizeAssemblySweep(
      plan,
      positions.map((value) => ({
        at: value,
        pairs: plan.pairs.map(([a, b]) => ({ a, b, verdict: clear }))
      }))
    );
    expect(summarizeSweptPairs(control)).toMatchObject({
      overlapping: 0,
      unknown: 0,
      onlyUnknown: null,
      clear: 3
    });
  });

  it('reads a planned position with no verdict as unknown, never as clear', () => {
    const plan = {
      source: { kind: 'joint' as const, jointId: 'j', dof: 0 },
      unit: 'mm' as const,
      from: 0,
      to: 2,
      positions: [0, 1, 2],
      components: [],
      missing: [],
      pairs: [['a', 'b']] as [string, string][],
      held: [],
      still: 0
    };
    // Position 1 came back without the pair; position 2 never came back.
    const report = summarizeAssemblySweep(plan, [
      at(0, clear),
      { at: 1, pairs: [] }
    ]);
    expect(report.pairs[0]!.unknownAt).toEqual([1, 2]);
    expect(report.pairs[0]!.checked).toBe(3);
    expect(summarizeSweptPairs(report)).toMatchObject({ unknown: 1, clear: 0 });
  });

  it('finds the clash at a study playhead that the rest-pose check is clear of (#2154)', async () => {
    // Two 20 × 12 × 10 carriers on parallel sliders, 60 mm apart at rest.
    // One 2 s study drives them +30 and −30 mm: they coincide at 1.00 s.
    const manager = new CommandManager(createProjectDocument('Pass', owner));
    for (const name of ['Base', 'Left', 'Right'])
      manager.execute(
        commandFactories.addPrimitive({
          name,
          primitiveKind: 'box',
          dimensions:
            name === 'Base'
              ? { width: 10, height: 10, depth: 10 }
              : { width: 20, height: 12, depth: 10 }
        })
      );
    const ids = [...manager.document.bodyOrder] as BodyId[];
    const start = [
      { x: 0, y: 0, z: -50 },
      { x: 0, y: 0, z: 0 },
      { x: 60, y: 0, z: 0 }
    ];
    manager.execute(
      commandFactories.addAssemblyComponents({
        components: ids.map((bodyId, index) => ({
          componentId: ['c_base', 'c_left', 'c_right'][index]!,
          name: ['Base', 'Left', 'Right'][index]!,
          bodyId,
          grounded: index === 0,
          placement: { ...IDENTITY_PLACEMENT, translation: start[index]! }
        }))
      })
    );
    for (const [id, child, x] of [
      ['j_left', 'c_left', 0],
      ['j_right', 'c_right', 60]
    ] as const)
      manager.execute(
        commandFactories.addAssemblyJoint({
          joint: {
            id,
            name: id,
            kind: 'slider',
            // In the base's own frame, 50 mm above it: world z = 0.
            parent: {
              componentId: 'c_base',
              frame: { ...along(x), origin: { x, y: 0, z: 50 } }
            },
            child: { componentId: child, frame: along(0) },
            values: [0],
            limits: [{ min: -60, max: 60 }]
          }
        })
      );
    manager.execute(
      commandFactories.setAssemblyStudy({
        study: {
          id: 'st_cross',
          name: 'Cross',
          durationS: 2,
          playback: 'once',
          tracks: [
            {
              jointId: 'j_left',
              dof: 0,
              keys: [
                { t: 0, value: 0, easing: 'linear' },
                { t: 2, value: 60, easing: 'linear' }
              ]
            },
            {
              jointId: 'j_right',
              dof: 0,
              keys: [
                { t: 0, value: 0, easing: 'linear' },
                { t: 2, value: -60, easing: 'linear' }
              ]
            }
          ]
        }
      })
    );
    const document = await synced(manager.document);

    // The static check reads the saved values: clear, 40 mm apart, and it
    // stays so whatever position a study or "Show" poses the view at.
    const { operands } = assemblyInterferenceOperands(document, () => true);
    const rest = await adapter.assemblyInterference(document, operands);
    expect(summarizeInterference(rest)).toMatchObject({
      interfering: 0,
      unknown: 0,
      clear: 3
    });
    expect(
      rest.pairs.find((p) => p.a === 'c_left' && p.b === 'c_right')!.verdict
    ).toMatchObject({ kind: 'clear', distance: 40 });

    // The sweep of the study finds the whole-volume clash at its playhead.
    const planned = planAssemblySweep(
      document,
      { kind: 'study', studyId: 'st_cross' },
      () => true
    );
    if (!planned.ok) throw new Error(planned.reason);
    const report = await runAssemblySweep(document, planned.plan, check);
    const carriers = report.pairs.find(
      (pair) => pair.a === 'c_left' && pair.b === 'c_right'
    )!;
    expect(carriers.overlaps).toHaveLength(1);
    expect(carriers.worst!.at).toBeCloseTo(1, 9);
    const worst = carriers.worst!.verdict;
    expect(worst.kind).toBe('interference');
    if (worst.kind === 'interference')
      expect(worst.volume).toBeCloseTo(2400, 6);
    // "Show at 1 s" poses both joints there, as overrides the model never
    // stores: the document the static check reads is unchanged.
    const shown = assemblySweepOverrides(
      document.assembly!,
      planned.plan.source,
      carriers.worst!.at
    ).overrides;
    expect([shown.get('j_left'), shown.get('j_right')]).toEqual([[30], [-30]]);
    expect(document.assembly!.joints.map((joint) => joint.values)).toEqual([
      [0],
      [0]
    ]);
  }, 240_000);

  it('checks a pair a study holds away from its rest pose, though it never moves along the study', async () => {
    // Two 20 × 12 × 10 carriers on parallel sliders, 60 mm apart at rest.
    // The study keys both to the same place for its whole length, so their
    // relative pose never changes along it; a pin far away does the moving.
    const manager = new CommandManager(createProjectDocument('Held', owner));
    for (const name of ['Base', 'Left', 'Right', 'Pin'])
      manager.execute(
        commandFactories.addPrimitive({
          name,
          primitiveKind: 'box',
          dimensions:
            name === 'Base' || name === 'Pin'
              ? { width: 10, height: 10, depth: 10 }
              : { width: 20, height: 12, depth: 10 }
        })
      );
    const ids = [...manager.document.bodyOrder] as BodyId[];
    const start = [
      { x: 0, y: 0, z: -50 },
      { x: 0, y: 0, z: 0 },
      { x: 60, y: 0, z: 0 },
      { x: 0, y: 300, z: 0 }
    ];
    manager.execute(
      commandFactories.addAssemblyComponents({
        components: ids.map((bodyId, index) => ({
          componentId: ['c_base', 'c_left', 'c_right', 'c_pin'][index]!,
          name: ['Base', 'Left', 'Right', 'Pin'][index]!,
          bodyId,
          grounded: index === 0,
          placement: { ...IDENTITY_PLACEMENT, translation: start[index]! }
        }))
      })
    );
    for (const [id, child, x, y] of [
      ['j_left', 'c_left', 0, 0],
      ['j_right', 'c_right', 60, 0],
      ['j_pin', 'c_pin', 0, 300]
    ] as const)
      manager.execute(
        commandFactories.addAssemblyJoint({
          joint: {
            id,
            name: id,
            kind: 'slider',
            // In the base's own frame, 50 mm above it: world z = 0.
            parent: {
              componentId: 'c_base',
              frame: { ...along(x), origin: { x, y, z: 50 } }
            },
            child: { componentId: child, frame: along(0) },
            values: [0],
            limits: [{ min: -60, max: 60 }]
          }
        })
      );
    const held = (jointId: string, value: number) => ({
      jointId,
      dof: 0,
      keys: [
        { t: 0, value, easing: 'linear' as const },
        { t: 2, value, easing: 'linear' as const }
      ]
    });
    manager.execute(
      commandFactories.setAssemblyStudy({
        study: {
          id: 'st_held',
          name: 'Held',
          durationS: 2,
          playback: 'once',
          tracks: [
            held('j_left', 30),
            held('j_right', -30),
            {
              jointId: 'j_pin',
              dof: 0,
              keys: [
                { t: 0, value: 0, easing: 'linear' },
                { t: 2, value: 20, easing: 'linear' }
              ]
            }
          ]
        }
      })
    );
    const document = await synced(manager.document);

    // At rest the carriers are 40 mm apart, and the static check says so.
    const { operands } = assemblyInterferenceOperands(document, () => true);
    const rest = await adapter.assemblyInterference(document, operands);
    expect(
      rest.pairs.find((p) => p.a === 'c_left' && p.b === 'c_right')!.verdict
    ).toMatchObject({ kind: 'clear', distance: 40 });

    const planned = planAssemblySweep(
      document,
      { kind: 'study', studyId: 'st_held' },
      () => true
    );
    if (!planned.ok) throw new Error(planned.reason);
    const { plan } = planned;
    // Only the pin moves against the others along the study.
    expect(plan.pairs).toEqual([
      ['c_base', 'c_pin'],
      ['c_left', 'c_pin'],
      ['c_right', 'c_pin']
    ]);
    // The study holds every other pair somewhere the static check did not
    // look: none of them is left to it.
    expect(plan.held).toEqual([
      ['c_base', 'c_left'],
      ['c_base', 'c_right'],
      ['c_left', 'c_right']
    ]);
    expect(plan.still).toBe(0);

    const asked: number[] = [];
    const report = await runAssemblySweep(
      document,
      plan,
      (doc, components, positions, sweep) => {
        for (const position of positions)
          if (
            position.pairs.some(([a, b]) => a === 'c_left' && b === 'c_right')
          )
            asked.push(position.at);
        return check(doc, components, positions, sweep);
      }
    );
    // One exact check decides a pose held for the whole study.
    expect(asked).toEqual([0]);
    const carriers = report.pairs.find(
      (pair) => pair.a === 'c_left' && pair.b === 'c_right'
    )!;
    expect(carriers.held).toBe(true);
    expect(carriers.overlaps).toEqual([
      { from: 0, to: 2, fromWithin: 0, toWithin: 0 }
    ]);
    expect(carriers.unknownAt).toEqual([]);
    expect(carriers.checked).toBe(plan.positions.length);
    expect(carriers.worst!.at).toBe(0);
    const worst = carriers.worst!.verdict;
    expect(worst.kind).toBe('interference');
    if (worst.kind === 'interference')
      expect(worst.volume).toBeCloseTo(2400, 6);
    expect(summarizeSweptPairs(report).overlapping).toBe(1);
    expect(report.still).toBe(0);
    // A moving pair is not marked held.
    expect(
      report.pairs.find((pair) => pair.a === 'c_left' && pair.b === 'c_pin')!
        .held
    ).toBe(false);
  }, 240_000);

  it('sweeps a study that only holds parts away from rest, and leaves a pair at its rest pose to the static check', async () => {
    const manager = await rig();
    const study = (value: number) =>
      commandFactories.setAssemblyStudy({
        study: {
          id: 'st_hold',
          name: 'Hold',
          durationS: 1,
          playback: 'once',
          tracks: [
            {
              jointId: 'j_slide',
              dof: 0,
              keys: [
                { t: 0, value, easing: 'linear' },
                { t: 1, value, easing: 'linear' }
              ]
            }
          ]
        }
      });
    // Held at 40 mm, the pin sits inside the block for the whole study.
    manager.execute(study(40));
    const planned = planAssemblySweep(
      manager.document,
      { kind: 'study', studyId: 'st_hold' },
      () => true
    );
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.plan.pairs).toEqual([]);
    expect(planned.plan.held).toEqual([
      ['c_block', 'c_pin'],
      ['c_pin', 'c_post']
    ]);
    expect(planned.plan.still).toBe(1);
    // Held where the parts rest, nothing differs from the static check.
    manager.execute(study(0));
    expect(
      planAssemblySweep(
        manager.document,
        { kind: 'study', studyId: 'st_hold' },
        () => true
      )
    ).toEqual({
      ok: false,
      reason: 'This motion moves no part relative to another.'
    });
  });

  it('applies the one verdict of a held pair to every position, unknown included', () => {
    const plan = {
      source: { kind: 'study' as const, studyId: 's' },
      unit: 's' as const,
      from: 0,
      to: 2,
      positions: [0, 1, 2],
      components: [],
      missing: [],
      pairs: [['a', 'b']] as [string, string][],
      held: [
        ['a', 'c'],
        ['b', 'c']
      ] as [string, string][],
      still: 0
    };
    const report = summarizeAssemblySweep(plan, [
      {
        at: 0,
        pairs: [
          { a: 'a', b: 'b', verdict: clear },
          { a: 'a', b: 'c', verdict: unknown }
        ]
      },
      at(1, clear),
      at(2, clear)
    ]);
    expect(report.pairs.map((pair) => [pair.a, pair.b, pair.held])).toEqual([
      ['a', 'b', false],
      ['a', 'c', true],
      ['b', 'c', true]
    ]);
    // Undecided where it was checked: undecided for the whole motion.
    expect(report.pairs[1]!.unknownAt).toEqual([0, 1, 2]);
    // Never answered: unknown throughout, never clear.
    expect(report.pairs[2]!.unknownAt).toEqual([0, 1, 2]);
    expect(report.pairs[2]!.unknownReasons).toEqual([
      'the check returned no result for this position'
    ]);
    expect(summarizeSweptPairs(report)).toMatchObject({
      unknown: 2,
      unknownEverywhere: 2,
      clear: 1
    });
  });

  it('counts a refinement the check does not answer as unknown, and never asks the same position twice', async () => {
    const document = (await rig()).document;
    const planned = planAssemblySweep(
      document,
      { kind: 'joint', jointId: 'j_slide', dof: 0 },
      () => true
    );
    if (!planned.ok) throw new Error(planned.reason);
    const rounds: number[][] = [];
    // The even positions are answered (the pin is in the block between 30
    // and 50 mm); every refinement comes back without the pair, or without
    // the position at all.
    const report = await runAssemblySweep(
      document,
      planned.plan,
      async (_document, _components, positions) => {
        rounds.push(positions.map((position) => position.at));
        if (rounds.length > 1)
          return {
            positions: positions
              .filter((_position, index) => index % 2 === 0)
              .map((position) => ({ at: position.at, pairs: [] })),
            missing: []
          };
        return {
          positions: positions.map((position) => ({
            at: position.at,
            pairs: position.pairs.map(([a, b]) => ({
              a,
              b,
              verdict:
                a === 'c_block' && position.at > 30 && position.at < 50
                  ? hit
                  : clear
            }))
          })),
          missing: []
        };
      }
    );
    expect(rounds).toHaveLength(1 + SWEEP_REFINEMENTS);
    const refined = rounds.slice(1).flat();
    expect(refined.length).toBeGreaterThan(0);
    expect(new Set(refined).size).toBe(refined.length);
    const pair = report.pairs.find(
      (entry) => entry.a === 'c_block' && entry.b === 'c_pin'
    )!;
    // Every position asked and not answered is listed, never dropped.
    expect(pair.unknownAt).toEqual([...refined].sort((p, q) => p - q));
    expect(pair.checked).toBe(planned.plan.positions.length + refined.length);
    expect(pair.unknownReasons).toEqual([
      'the check returned no result for this position'
    ]);
    expect(summarizeSweptPairs(report)).toMatchObject({
      overlapping: 1,
      unknown: 1,
      unknownEverywhere: 0
    });
    // The pair the refinements never named is untouched by them.
    expect(
      report.pairs.find((entry) => entry.a === 'c_pin' && entry.b === 'c_post')!
        .unknownAt
    ).toEqual([]);
  });

  it('keeps the reason a position could not be checked, for the details (#2388)', () => {
    const plan = {
      source: { kind: 'joint' as const, jointId: 'j', dof: 0 },
      unit: 'mm' as const,
      from: 0,
      to: 2,
      positions: [0, 1, 2],
      components: [],
      missing: [],
      pairs: [['plate', 'stop']] as [string, string][],
      held: [],
      still: 0
    };
    const unbuilt: BodyClashVerdict = {
      kind: 'unknown',
      reason: 'configuration_unavailable',
      message: 'the Wide configuration of Plate could not be built'
    };
    const report = summarizeAssemblySweep(plan, [
      { at: 0, pairs: [{ a: 'plate', b: 'stop', verdict: unbuilt }] },
      { at: 1, pairs: [{ a: 'plate', b: 'stop', verdict: unbuilt }] }
    ]);
    expect(report.pairs[0]!.unknownAt).toEqual([0, 1, 2]);
    // Each distinct reason once, in the order the positions give them.
    expect(report.pairs[0]!.unknownReasons).toEqual([
      'the Wide configuration of Plate could not be built',
      'the check returned no result for this position'
    ]);
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
