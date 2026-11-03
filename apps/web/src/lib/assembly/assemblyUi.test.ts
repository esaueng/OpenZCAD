import { describe, expect, it } from 'vitest';
import {
  assemblyName,
  defaultLimit,
  formatAssemblyValue,
  jointValueSummary,
  nextPositionName,
  sliderRange,
  suggestJointKind,
  sweepDof,
  sweepUnavailableReason
} from './assemblyUi';
import { emptyAssemblySet } from '@openzcad/shared';

describe('assembly presentation helpers', () => {
  it('suggests a joint type from the two picks', () => {
    expect(suggestJointKind('circle', 'cylinder')).toBe('revolute');
    expect(suggestJointKind('cylinder', 'circle')).toBe('revolute');
    expect(suggestJointKind('plane', 'plane')).toBe('rigid');
    expect(suggestJointKind('line', 'plane')).toBe('slider');
    expect(suggestJointKind('vertex', 'line')).toBe('slider');
    expect(suggestJointKind('vertex', 'plane')).toBe('revolute');
    expect(suggestJointKind('circle', null)).toBe('revolute');
  });

  it('formats values in their stored units, one decimal, never -0.0', () => {
    expect(formatAssemblyValue(12, 'deg')).toBe('12.0°');
    expect(formatAssemblyValue(-4.46, 'mm')).toBe('-4.5 mm');
    expect(formatAssemblyValue(-0.01, 'deg')).toBe('0.0°');
    expect(jointValueSummary('cylindrical', [90, 5])).toBe('90.0° · 5.0 mm');
    expect(jointValueSummary('rigid', [])).toBe('Fixed');
  });

  it('plays the first value with a range, and says why when none has one', () => {
    expect(sweepDof({ kind: 'revolute', limits: [null] })).toBe(0);
    expect(sweepDof({ kind: 'slider', limits: [null] })).toBeNull();
    expect(sweepDof({ kind: 'slider', limits: [{ min: 0, max: 20 }] })).toBe(0);
    // Planar slides are unlimited; its turn still plays.
    expect(sweepDof({ kind: 'planar', limits: [null, null, null] })).toBe(2);
    expect(sweepUnavailableReason({ kind: 'rigid', limits: [] })).toMatch(
      /rigid/
    );
    expect(sweepUnavailableReason({ kind: 'slider', limits: [null] })).toMatch(
      /limits/
    );
    expect(sweepUnavailableReason({ kind: 'revolute', limits: [null] })).toBe(
      null
    );
  });

  it('starts limits and slider travel around the current value', () => {
    expect(defaultLimit('deg', 120)).toEqual({ min: -90, max: 120 });
    expect(defaultLimit('mm', -5)).toEqual({ min: -5, max: 100 });
    expect(sliderRange('deg', null, 0)).toEqual({ min: -180, max: 180 });
    expect(sliderRange('mm', { min: 2, max: 8 }, 4)).toEqual({
      min: 2,
      max: 8
    });
  });

  it('names positions and trims stored names', () => {
    const set = emptyAssemblySet();
    expect(nextPositionName(set)).toBe('Position 1');
    set.positions.push({ id: 'p', name: 'Position 1', values: {} });
    expect(nextPositionName(set)).toBe('Position 2');
    expect(assemblyName('  Lid  ', 'Body')).toBe('Lid');
    expect(assemblyName('   ', 'Body')).toBe('Body');
    expect(assemblyName('x'.repeat(200), 'Body')).toHaveLength(120);
  });
});
