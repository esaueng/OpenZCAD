import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  getParameterScope,
  renameParameter,
  resolveParamValue,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type ParamValue,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchPatternLayout
} from '@openzcad/shared';
import {
  planSketchEdit,
  type SketchPatternOptions
} from '../apps/web/src/lib/sketch/edits';
import { storedPatternStep } from '../apps/web/src/lib/sketch/modify';
import { describeConstraint } from '../apps/web/src/lib/sketch/constraints';
import { printHistory } from '@openzcad/scripting';

/**
 * A sketch pattern keeps the expression its spacing or angle was typed as,
 * not the number it evaluated to, so a parameter-driven pattern follows a
 * rename, a re-evaluation and the typed-parameter checks like any other
 * expression field. The circular prompt takes the total angle while the
 * relation stores one step, so the expression is divided into steps exactly
 * as the number was. Checked against the numeric pattern on the pinned
 * kernel.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

/** `pitchL` 12 mm and `stepA` 30°, as in the preview check that found it. */
function parameterised(): ProjectDocument {
  let document = createProjectDocument(
    'Pattern expressions',
    toUserId('user_pattern_expressions')
  );
  document = setParameter(document, {
    name: 'pitchL',
    expression: '12 mm',
    quantity: 'length'
  });
  return setParameter(document, {
    name: 'stepA',
    expression: '30 deg',
    quantity: 'angle'
  });
}

const resolverFor = (document: ProjectDocument) => {
  const { scope } = getParameterScope(document);
  return (value: ParamValue) =>
    resolveParamValue(value, scope, undefined, document.units);
};

/** A source circle, a direction line along +x and a pivot circle. */
function fixture(document = parameterised()) {
  const manager = new CommandManager(document);
  manager.execute(
    commandFactories.addSketch({
      name: 'Pattern',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'circle', centerX: 10, centerY: 0, radius: 1 },
        { objectKind: 'line', x1: 0, y1: -5, x2: 100, y2: -5 },
        { objectKind: 'circle', centerX: 0, centerY: 0, radius: 0.5 }
      ]
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const ids = findSketch(manager.document, sketchId)!.objectIds.map(String);
  const [source, direction, pivot] = ids as [string, string, string];
  const sketch = () => findSketch(manager.document, sketchId)!;
  /** Run a pattern from its keypad values and the text they were typed as. */
  const pattern = (
    kind: 'linear-pattern' | 'circular-pattern',
    values: number[],
    raws: string[],
    options?: SketchPatternOptions,
    selection = false
  ) => {
    const plan = planSketchEdit(
      manager.document,
      sketch(),
      sketchId,
      kind,
      [source, kind === 'linear-pattern' ? direction : pivot],
      values,
      raws,
      resolverFor(manager.document),
      undefined,
      undefined,
      options,
      // Armed over a selection, the pattern plans the set instead.
      selection ? [source] : undefined
    );
    if (plan.status !== 'commands') {
      throw new Error(plan.status === 'refuse' ? plan.reason : plan.status);
    }
    manager.execute(composeCommands(plan.label, plan.commands));
  };
  const relation = (): Extract<
    SketchConstraintData,
    { constraintKind: 'pattern' }
  > => {
    const found = (sketch().constraints ?? []).find(
      ({ data }) => data.constraintKind === 'pattern'
    );
    if (found?.data.constraintKind !== 'pattern') {
      throw new Error('no pattern relation');
    }
    return found.data;
  };
  /** Every instance's solved centre, in step order. */
  const centres = async (document = manager.document) => {
    const outcome = await adapter.solveSketch(document, sketchId);
    expect(outcome.converged).toBe(true);
    expect(outcome.rolledBack).toBe(false);
    return relation().instances.map(({ objectId }) => {
      const solved = outcome.objects.find(
        (entry) => entry.objectId === objectId
      ) as unknown as { centerX: number; centerY: number };
      return [solved.centerX, solved.centerY] as const;
    });
  };
  return { manager, sketchId, pattern, relation, centres };
}

function expectSameCentres(
  actual: readonly (readonly [number, number])[],
  expected: readonly (readonly [number, number])[]
) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach(([x, y], index) => {
    expect(x).toBeCloseTo(expected[index]![0], 8);
    expect(y).toBeCloseTo(expected[index]![1], 8);
  });
}

describe('a sketch pattern typed with an expression', () => {
  it('keeps a linear spacing expression and solves as its value would', async () => {
    const typed = fixture();
    typed.pattern('linear-pattern', [24, 3], ['pitchL * 2', '3']);
    expect(typed.relation().layout).toMatchObject({
      kind: 'linear',
      spacing: 'pitchL * 2'
    });
    const numeric = fixture();
    numeric.pattern('linear-pattern', [24, 3], ['24', '3']);
    expect(numeric.relation().layout).toMatchObject({ spacing: 24 });
    const centres = await typed.centres();
    expectSameCentres(centres, await numeric.centres());
    expectSameCentres(centres, [
      [34, 0],
      [58, 0]
    ]);
  });

  it('divides a linear extent expression into steps as its value was', async () => {
    const typed = fixture();
    const options: SketchPatternOptions = {
      spacing: 'extent',
      orientation: 'rotate'
    };
    typed.pattern('linear-pattern', [24, 3], ['pitchL * 2', '3'], options);
    expect(typed.relation().layout).toMatchObject({
      spacing: '(pitchL * 2) / 2'
    });
    const numeric = fixture();
    numeric.pattern('linear-pattern', [24, 3], ['24', '3'], options);
    expect(numeric.relation().layout).toMatchObject({ spacing: 12 });
    expectSameCentres(await typed.centres(), await numeric.centres());
  });

  it('stores a partial circular angle as the total over the count less one', async () => {
    // Six instances over a total of `stepA` (30°): five steps of 6°.
    const typed = fixture();
    typed.pattern('circular-pattern', [6, 30], ['6', 'stepA']);
    expect(typed.relation().layout).toMatchObject({
      kind: 'circular',
      stepDeg: '(stepA) / 5'
    });
    const numeric = fixture();
    numeric.pattern('circular-pattern', [6, 30], ['6', '30']);
    const stored = (numeric.relation().layout as { stepDeg: number }).stepDeg;
    expect(stored).toBeCloseTo(6, 12);
    const centres = await typed.centres();
    expectSameCentres(centres, await numeric.centres());
    const last = centres.at(-1)!;
    expect(Math.atan2(last[1], last[0]) * (180 / Math.PI)).toBeCloseTo(30, 8);
  });

  it('stores a full circular turn as the total over the count', async () => {
    // A full turn spaces six instances 60° apart, none on the source.
    const typed = fixture();
    typed.pattern('circular-pattern', [6, 360], ['6', 'stepA * 12']);
    expect(typed.relation().layout).toMatchObject({
      stepDeg: '(stepA * 12) / 6'
    });
    const numeric = fixture();
    numeric.pattern('circular-pattern', [6, 360], ['6', '360']);
    expect(
      (numeric.relation().layout as { stepDeg: number }).stepDeg
    ).toBeCloseTo(60, 12);
    expectSameCentres(await typed.centres(), await numeric.centres());
  });

  it('keeps the expressions when armed over a selection', async () => {
    const linear = fixture();
    linear.pattern(
      'linear-pattern',
      [24, 3],
      ['pitchL * 2', '3'],
      undefined,
      true
    );
    expect(linear.relation().layout).toMatchObject({ spacing: 'pitchL * 2' });
    const circular = fixture();
    circular.pattern(
      'circular-pattern',
      [6, 30],
      ['6', 'stepA'],
      undefined,
      true
    );
    expect(circular.relation().layout).toMatchObject({
      stepDeg: '(stepA) / 5'
    });
    expectSameCentres(await linear.centres(), [
      [34, 0],
      [58, 0]
    ]);
  });

  it('follows a parameter rename and re-evaluates with the parameter', async () => {
    const linear = fixture();
    linear.pattern('linear-pattern', [24, 2], ['pitchL * 2', '2']);
    const renamed = renameParameter(linear.manager.document, {
      name: 'pitchL',
      newName: 'pitch'
    });
    const layout = findSketch(renamed, linear.sketchId)!.constraints!.find(
      ({ data }) => data.constraintKind === 'pattern'
    )!.data as { layout: SketchPatternLayout };
    expect(layout.layout).toMatchObject({ spacing: 'pitch * 2' });
    // History as text shows the expression, as the preview check read it.
    expect(printHistory(renamed)).toContain('spacing: `pitch * 2`');
    const longer = setParameter(renamed, {
      name: 'pitch',
      expression: '15 mm',
      quantity: 'length'
    });
    expectSameCentres(await linear.centres(longer), [[40, 0]]);

    const circular = fixture();
    circular.pattern('circular-pattern', [3, 30], ['3', 'stepA']);
    const turned = renameParameter(circular.manager.document, {
      name: 'stepA',
      newName: 'sweep'
    });
    const step = findSketch(turned, circular.sketchId)!.constraints!.find(
      ({ data }) => data.constraintKind === 'pattern'
    )!.data as { layout: SketchPatternLayout };
    expect(step.layout).toMatchObject({ stepDeg: '(sweep) / 2' });
  });

  it('labels the evaluated value, never the expression text', () => {
    const typed = fixture();
    typed.pattern('circular-pattern', [6, 30], ['6', 'stepA']);
    const linear = fixture();
    linear.pattern('linear-pattern', [24, 3], ['pitchL * 2', '3']);
    const name = () => 'entity';
    const resolve = resolverFor(typed.manager.document);
    expect(
      describeConstraint(typed.relation(), name, undefined, resolve)
    ).toMatch(/^Circular pattern 6° · /);
    expect(
      describeConstraint(linear.relation(), name, undefined, resolve)
    ).toMatch(/^Linear pattern 24 · /);
    // An expression that no longer evaluates reads as a dash, not as text,
    // NaN or an object.
    const broken = (value: ParamValue) =>
      typeof value === 'number' ? value : Number.NaN;
    expect(
      describeConstraint(linear.relation(), name, undefined, broken)
    ).toMatch(/^Linear pattern — · /);
    expect(
      describeConstraint(linear.relation(), name, undefined, () => {
        throw new Error('unknown parameter');
      })
    ).toMatch(/^Linear pattern — · /);
    // A numeric step reads rounded for reading.
    const seven = fixture();
    seven.pattern('circular-pattern', [7, 360], ['7', '360']);
    expect(describeConstraint(seven.relation(), name)).toMatch(
      /^Circular pattern 51\.429° · /
    );
  });
});

describe('storedPatternStep', () => {
  it('keeps a plain numeral as the evaluated number', () => {
    expect(storedPatternStep(24, '24', 1)).toBe(24);
    expect(storedPatternStep(12, ' 24 ', 2)).toBe(12);
    expect(storedPatternStep(6, undefined, 5)).toBe(6);
    expect(storedPatternStep(6, '', 5)).toBe(6);
  });

  it('keeps an expression, divided into steps when the value was', () => {
    expect(storedPatternStep(24, 'pitchL * 2', 1)).toBe('pitchL * 2');
    expect(storedPatternStep(6, 'stepA', 5)).toBe('(stepA) / 5');
    expect(storedPatternStep(60, ' 360 deg ', 6)).toBe('(360 deg) / 6');
  });
});
