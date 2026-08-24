import { describe, expect, it } from 'vitest';
import {
  appendKeypadKey,
  convertDimensionInput,
  evaluateKeypadInput,
  keypadClampPosition,
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
      keypadClampPosition({ x: 996, y: 100 }, SIZE, VIEWPORT).x +
        SIZE.width
    ).toBeLessThanOrEqual(VIEWPORT.width - 8);
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

  it('is unchanged when no panels are open', () => {
    expect(keypadClampPosition({ x: 820, y: 200 }, SIZE, VIEWPORT)).toEqual(
      keypadClampPosition({ x: 820, y: 200 }, SIZE, VIEWPORT, [])
    );
  });
});
