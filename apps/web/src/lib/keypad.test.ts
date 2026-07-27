import { describe, expect, it } from 'vitest';
import {
  appendKeypadKey,
  evaluateKeypadInput,
  keypadClampPosition
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
