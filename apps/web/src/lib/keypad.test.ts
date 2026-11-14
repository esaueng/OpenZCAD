import { describe, expect, it } from 'vitest';
import {
  appendKeypadKey,
  convertDimensionInput,
  dimensionModeForInput,
  evaluateKeypadInput,
  editControlState,
  keypadClampPosition,
  keypadInPlacePosition,
  typedUnitValue
} from './keypad';

const SIZE = { width: 220, height: 260 };
const VIEWPORT = { width: 1000, height: 700 };

describe('keypadClampPosition', () => {
  it('centers below the anchor when there is room', () => {
    const placement = keypadClampPosition({ x: 500, y: 200 }, SIZE, VIEWPORT);
    expect(placement.side).toBe('below');
    expect(placement.x).toBe(500 - SIZE.width / 2);
    expect(placement.y).toBeGreaterThan(200);
  });

  it('flips above the anchor near the bottom edge', () => {
    const placement = keypadClampPosition({ x: 500, y: 650 }, SIZE, VIEWPORT);
    expect(placement.side).toBe('above');
    expect(placement.y + SIZE.height).toBeLessThanOrEqual(650);
  });

  it('clamps horizontally at both edges', () => {
    expect(keypadClampPosition({ x: 4, y: 100 }, SIZE, VIEWPORT).x).toBe(8);
    expect(
      keypadClampPosition({ x: 996, y: 100 }, SIZE, VIEWPORT).x + SIZE.width
    ).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  it('keeps an old desktop anchor inside a resized phone viewport', () => {
    const placement = keypadClampPosition({ x: 1200, y: 820 }, SIZE, {
      width: 390,
      height: 360
    });
    expect(placement.x).toBeGreaterThanOrEqual(8);
    expect(placement.x + SIZE.width).toBeLessThanOrEqual(382);
    expect(placement.y).toBeGreaterThanOrEqual(8);
    expect(placement.y + SIZE.height).toBeLessThanOrEqual(352);
  });

  it('never goes above the top margin', () => {
    const placement = keypadClampPosition(
      { x: 500, y: 690 },
      { width: 220, height: 900 },
      VIEWPORT
    );
    expect(placement.y).toBe(8);
  });
});

describe('keypadInPlacePosition', () => {
  const CONTROL = { width: 260, height: 40 };
  const chip = { left: 400, top: 190, right: 470, bottom: 214 };

  it('takes the value chip’s place, its row centred on the chip', () => {
    expect(keypadInPlacePosition(chip, CONTROL, VIEWPORT, [], 36)).toEqual({
      x: 400,
      y: 202 - 18,
      side: 'over'
    });
  });

  it('moves only as far as it must to clear a docked panel', () => {
    const placement = keypadInPlacePosition(
      { left: 760, top: 190, right: 830, bottom: 214 },
      CONTROL,
      VIEWPORT,
      [{ x: 900, width: 100 }],
      40
    );
    expect(placement.side).toBe('over');
    expect(placement.x + CONTROL.width).toBeLessThanOrEqual(900 - 8);
    expect(placement.y).toBe(182);
  });

  it('stays on screen at the edges', () => {
    const top = keypadInPlacePosition(
      { left: 2, top: 1, right: 60, bottom: 25 },
      CONTROL,
      VIEWPORT
    );
    expect(top.x).toBe(8);
    expect(top.y).toBe(8);
    const bottom = keypadInPlacePosition(
      { left: 400, top: 690, right: 470, bottom: 714 },
      CONTROL,
      VIEWPORT
    );
    expect(bottom.y + CONTROL.height).toBeLessThanOrEqual(VIEWPORT.height - 8);
  });

  it.each([
    ['off screen', null, []],
    ['past the edge', { left: -90, top: 190, right: -20, bottom: 214 }, []],
    [
      'under a docked panel',
      { left: 40, top: 190, right: 110, bottom: 214 },
      [{ x: 0, width: 300 }]
    ]
  ] as const)(
    'docks at the foot of the stage, in the widest free gap, when the chip is %s',
    (_, box, bands) => {
      const placement = keypadInPlacePosition(box, CONTROL, VIEWPORT, [
        ...bands,
        { x: 0, width: 300 }
      ]);
      expect(placement.side).toBe('docked');
      expect(placement.y).toBe(VIEWPORT.height - CONTROL.height - 8);
      expect(placement.x).toBeGreaterThanOrEqual(300 + 8);
      expect(placement.x + CONTROL.width).toBeLessThanOrEqual(
        VIEWPORT.width - 8
      );
    }
  );
});

describe('editControlState', () => {
  const base = {
    entryOk: true,
    previewed: 2 as number | null,
    verdict: null as ReturnType<typeof built> | null | undefined,
    hostChecking: false,
    hostRefused: false,
    hostDisabled: false
  };
  const built = (value: number) => ({ value, status: 'built' as const });

  it('is Ready only once the value on screen has built', () => {
    expect(editControlState({ ...base, verdict: null })).toBe('checking');
    expect(editControlState({ ...base, verdict: built(2) })).toBe('ready');
  });

  it('never lets an earlier value’s preview stand for newer input', () => {
    // 2 built; 25 is typed and not answered yet.
    expect(
      editControlState({ ...base, previewed: 25, verdict: built(2) })
    ).toBe('checking');
  });

  it('is Not built for the value refused, and checks a new one afresh', () => {
    const refused = { value: 5, status: 'refused' as const };
    expect(
      editControlState({
        ...base,
        previewed: 5,
        verdict: refused,
        hostRefused: true
      })
    ).toBe('refused');
    expect(
      editControlState({
        ...base,
        previewed: 4,
        verdict: refused,
        hostRefused: true
      })
    ).toBe('checking');
  });

  it('counts a value the host settled without the kernel as ready', () => {
    expect(
      editControlState({
        ...base,
        previewed: 0,
        verdict: { value: 0, status: 'unchecked' }
      })
    ).toBe('ready');
  });

  it('is Ready on its untouched prefill, which is what the model already is', () => {
    expect(editControlState({ ...base, previewed: null })).toBe('ready');
  });

  it('puts an unevaluable entry and a commit in flight first', () => {
    expect(
      editControlState({ ...base, entryOk: false, verdict: built(2) })
    ).toBe('invalid');
    expect(
      editControlState({ ...base, verdict: built(2), hostChecking: true })
    ).toBe('checking');
  });

  it('falls back to the host’s flags where the host checks nothing', () => {
    const unchecked = { ...base, verdict: undefined };
    expect(editControlState(unchecked)).toBe('ready');
    expect(editControlState({ ...unchecked, hostDisabled: true })).toBe(
      'checking'
    );
    expect(
      editControlState({ ...unchecked, hostDisabled: true, hostRefused: true })
    ).toBe('refused');
  });
});

describe('evaluateKeypadInput', () => {
  const scope = { w: 30 };

  it('converts plain numbers from the entry unit into document units', () => {
    expect(evaluateKeypadInput('11.3', 'mm', 'mm', scope)).toMatchObject({
      ok: true,
      value: 11.3,
      isExpression: false
    });
    expect(evaluateKeypadInput('2', 'cm', 'mm', scope).value).toBeCloseTo(20);
    expect(evaluateKeypadInput('0.5', 'm', 'mm', scope).value).toBeCloseTo(500);
    expect(evaluateKeypadInput('2', 'mm', 'cm', scope).value).toBeCloseTo(0.2);
  });

  it('takes a count as a plain number and refuses units on it', () => {
    expect(evaluateKeypadInput('6', 'count', 'mm', scope).value).toBe(6);
    expect(evaluateKeypadInput('w / 5', 'count', 'mm', scope).value).toBe(6);
    expect(evaluateKeypadInput('6 deg', 'count', 'mm', scope).ok).toBe(false);
    expect(evaluateKeypadInput('6 mm', 'count', 'mm', scope).ok).toBe(false);
    // Radial notation is not a count: no prefix stripping, no halving.
    expect(evaluateKeypadInput('Ø6', 'count', 'mm', scope).ok).toBe(false);
    expect(
      evaluateKeypadInput('6', 'count', 'mm', scope, 'diameter').value
    ).toBe(6);
  });

  it('passes degrees through untouched', () => {
    expect(evaluateKeypadInput('45', 'deg', 'mm', scope).value).toBe(45);
  });

  it('evaluates expressions against the parameter scope without unit scaling', () => {
    const result = evaluateKeypadInput('w / 2 + 5', 'cm', 'mm', scope);
    expect(result).toMatchObject({ ok: true, isExpression: true });
    expect(result.value).toBeCloseTo(20);
  });

  it('rejects empty and invalid input', () => {
    expect(evaluateKeypadInput('', 'mm', 'mm', scope).ok).toBe(false);
    expect(evaluateKeypadInput('nope +', 'mm', 'mm', scope).ok).toBe(false);
  });

  it('normalizes diameter entry to the internal radius', () => {
    expect(
      evaluateKeypadInput('Ø17.4', 'mm', 'mm', scope, 'diameter')
    ).toMatchObject({
      ok: true,
      value: 8.7,
      displayValue: 17.4,
      normalizedRaw: '8.7',
      isExpression: false
    });
    expect(
      evaluateKeypadInput('hole', 'mm', 'mm', { hole: 17.4 }, 'diameter')
        .normalizedRaw
    ).toBe('(hole) / 2');
  });
});

describe('convertDimensionInput', () => {
  it('switches notation without changing the represented radius', () => {
    expect(convertDimensionInput('Ø17.4', 'diameter', 'radius')).toBe('8.7');
    expect(convertDimensionInput('8.7', 'radius', 'diameter')).toBe('17.4');
    expect(convertDimensionInput('hole', 'diameter', 'radius')).toBe(
      '(hole) / 2'
    );
  });
});

describe('appendKeypadKey', () => {
  it('appends digits and operators', () => {
    expect(appendKeypadKey('1', '2')).toBe('12');
    expect(appendKeypadKey('12', '.')).toBe('12.');
  });

  it('backspaces and toggles sign', () => {
    expect(appendKeypadKey('12', '⌫')).toBe('1');
    expect(appendKeypadKey('12', '±')).toBe('-12');
    expect(appendKeypadKey('-12', '±')).toBe('12');
  });
});

describe('typedUnitValue', () => {
  it('reads a unit the value names for itself', () => {
    expect(typedUnitValue('25 mm')).toEqual({ value: 25, unit: 'mm' });
    expect(typedUnitValue('2.5cm')).toEqual({ value: 2.5, unit: 'cm' });
    expect(typedUnitValue('1 in')).toEqual({ value: 1, unit: 'inch' });
    expect(typedUnitValue('0.5"')).toEqual({ value: 0.5, unit: 'inch' });
    expect(typedUnitValue('-3 M')).toEqual({ value: -3, unit: 'm' });
    expect(typedUnitValue('4 inches')).toEqual({ value: 4, unit: 'inch' });
  });

  it('leaves anything that is not a number and a unit alone', () => {
    // `m` is a plausible parameter name, so an expression that merely mentions
    // one must reach the expression evaluator whole rather than be read as
    // metres here.
    expect(typedUnitValue('hole_d / 2')).toBeUndefined();
    expect(typedUnitValue('m')).toBeUndefined();
    expect(typedUnitValue('25')).toBeUndefined();
    expect(typedUnitValue('25 furlongs')).toBeUndefined();
    expect(typedUnitValue('2 mm + 1')).toBeUndefined();
  });
});

describe('evaluateKeypadInput with a typed unit', () => {
  it('converts into document units and overrides the entry chip', () => {
    // The chip says millimetres; the value says inches, and the value wins.
    const result = evaluateKeypadInput('1 in', 'mm', 'mm', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBeCloseTo(25.4, 9);
    expect(result.typedUnit).toBe('inch');
    expect(result.isExpression).toBe(false);
  });

  it('reaches an inch document, which has no entry chip of its own', () => {
    expect(evaluateKeypadInput('2 in', 'mm', 'inch', {}).value).toBeCloseTo(
      2,
      9
    );
    expect(evaluateKeypadInput('25.4 mm', 'mm', 'inch', {}).value).toBeCloseTo(
      1,
      9
    );
  });

  it('halves a typed diameter like any other radial value', () => {
    expect(
      evaluateKeypadInput('1 in', 'mm', 'mm', {}, 'diameter').value
    ).toBeCloseTo(12.7, 9);
  });

  it('does not read a suffix as a unit when entry is angular', () => {
    expect(evaluateKeypadInput('45 in', 'deg', 'mm', {}).ok).toBe(false);
  });

  it('refuses dimensioned expressions in the wrong kind of field (F05)', () => {
    // Lengths (and compound length expressions) never land in angle fields.
    expect(evaluateKeypadInput('45 in', 'deg', 'mm', {}).ok).toBe(false);
    expect(evaluateKeypadInput('1 ft + 2 in', 'deg', 'mm', {}).ok).toBe(false);
    expect(evaluateKeypadInput('(2 mm) * (3 mm)', 'deg', 'mm', {}).ok).toBe(
      false
    );
    // Angles never land in length fields, but angle-suffixed input is fine
    // where angles belong, converting nothing (degrees are native).
    expect(evaluateKeypadInput('90deg', 'mm', 'mm', {}).ok).toBe(false);
    expect(evaluateKeypadInput('90deg', 'deg', 'mm', {}).value).toBe(90);
    // Dimensionless legacy expressions still pass in either kind of field.
    expect(evaluateKeypadInput('w + 1', 'deg', 'mm', { w: 30 }).value).toBe(31);
    expect(evaluateKeypadInput('sin(30)', 'deg', 'mm', {}).ok).toBe(true);
  });

  it('evaluates unit-suffixed expressions into document units (F05)', () => {
    expect(evaluateKeypadInput('5 mm + 2 cm', 'mm', 'mm', {}).value).toBe(25);
    expect(
      evaluateKeypadInput('5 mm + 2 cm', 'mm', 'inch', {}).value
    ).toBeCloseTo(25 / 25.4, 12);
    expect(
      evaluateKeypadInput('1 ft + 2 in', 'mm', 'mm', {}).value
    ).toBeCloseTo(355.6, 9);
  });

  it('still evaluates expressions against the parameter scope', () => {
    const result = evaluateKeypadInput('hole_d / 2', 'mm', 'mm', {
      hole_d: 15
    });
    expect(result.value).toBe(7.5);
    expect(result.isExpression).toBe(true);
    expect(result.typedUnit).toBeUndefined();
  });
});

describe('keypadClampPosition around docked panels', () => {
  // The inspector floats over the right of the viewport, so a handle near the
  // right edge used to open exact entry underneath it.
  const inspector = { x: 700, width: 300 };

  it('keeps clear of a panel covering the anchor', () => {
    const placement = keypadClampPosition({ x: 820, y: 200 }, SIZE, VIEWPORT, [
      inspector
    ]);
    expect(placement.x + SIZE.width).toBeLessThanOrEqual(inspector.x);
  });

  it('still centers on the anchor where nothing is in the way', () => {
    const placement = keypadClampPosition({ x: 300, y: 200 }, SIZE, VIEWPORT, [
      inspector
    ]);
    expect(placement.x).toBe(300 - SIZE.width / 2);
  });

  it('picks the widest gap when panels flank both sides', () => {
    const placement = keypadClampPosition({ x: 500, y: 200 }, SIZE, VIEWPORT, [
      { x: 0, width: 120 },
      inspector
    ]);
    expect(placement.x).toBeGreaterThanOrEqual(120);
    expect(placement.x + SIZE.width).toBeLessThanOrEqual(inspector.x);
  });

  it('clamps to the viewport rather than off-screen when nothing fits', () => {
    // Overlapping a panel is recoverable; being outside the window is not.
    const placement = keypadClampPosition({ x: 500, y: 200 }, SIZE, VIEWPORT, [
      { x: 0, width: VIEWPORT.width }
    ]);
    expect(placement.x).toBeGreaterThanOrEqual(0);
    expect(placement.x + SIZE.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('never places it inside a panel that is wider than the free room', () => {
    // The phone lane's panel under the inspector: both bands span the same
    // 330px, wider than the 280px left of them. Every pair of edges used to
    // count as a gap, so the band itself won as the widest one.
    const viewport = { width: 720, height: 800 };
    const column = { x: 10, width: 40 };
    const lane = { x: 330, width: 330 };
    for (const bands of [
      [column, lane],
      [column, lane, lane],
      [lane, column, { x: 400, width: 100 }]
    ]) {
      const placement = keypadClampPosition(
        { x: 214, y: 320 },
        { width: 232, height: 288 },
        viewport,
        bands
      );
      expect(placement.x).toBeGreaterThanOrEqual(50);
      expect(placement.x + 232).toBeLessThanOrEqual(330);
    }
  });

  it('treats overlapping panels as one obstacle', () => {
    const placement = keypadClampPosition({ x: 640, y: 200 }, SIZE, VIEWPORT, [
      { x: 500, width: 200 },
      { x: 600, width: 250 }
    ]);
    // 0–500 is the only room; 700–850 lies inside the second panel.
    expect(placement.x + SIZE.width).toBeLessThanOrEqual(500);
  });

  it('is unchanged when no panels are open', () => {
    expect(keypadClampPosition({ x: 820, y: 200 }, SIZE, VIEWPORT)).toEqual(
      keypadClampPosition({ x: 820, y: 200 }, SIZE, VIEWPORT, [])
    );
  });
});

describe('radial notation and parameter names', () => {
  it.each(['radius_target', 'radius', 'r', 'r2', 'R2'])(
    'preserves the parameter %s',
    (name) => {
      const scope = { [name]: 7 };
      expect(dimensionModeForInput(name, scope)).toBeUndefined();
      expect(evaluateKeypadInput(name, 'mm', 'mm', scope)).toMatchObject({
        ok: true,
        value: 7,
        normalizedRaw: name
      });
      expect(
        evaluateKeypadInput(`${name} + 1`, 'mm', 'mm', scope, 'diameter')
      ).toMatchObject({
        ok: true,
        value: 4,
        normalizedRaw: `(${name} + 1) / 2`
      });
      expect(convertDimensionInput(name, 'radius', 'diameter', scope)).toBe(
        `2 * (${name})`
      );
    }
  );
  it.each(['R7', 'r7', 'R 7', 'R (3 + 4)'])(
    'retains explicit radius notation %s',
    (raw) => {
      expect(dimensionModeForInput(raw)).toBe('radius');
      expect(evaluateKeypadInput(raw, 'mm', 'mm', {})).toMatchObject({
        ok: true,
        value: 7
      });
    }
  );
  it('does not switch an unknown identifier to radius mode', () => {
    expect(dimensionModeForInput('radius_target')).toBeUndefined();
    expect(
      evaluateKeypadInput('radius_target', 'mm', 'mm', {}).error
    ).toContain('radius_target');
  });
});

describe('typed unit suffixes from stored expressions', () => {
  it.each(['1 constructor', '1 toString', '1 __proto__', '2 constructors'])(
    'reads no inherited member for "%s"',
    (raw) => {
      expect(typedUnitValue(raw)).toBeUndefined();
    }
  );
});
