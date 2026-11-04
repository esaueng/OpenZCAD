import { describe, expect, it } from 'vitest';
import { parameterDisplayName } from './parameterDisplayName';

describe('parameter display names', () => {
  it.each([
    ['plate_t', 'Plate t'],
    ['grid_r', 'Grid r'],
    ['slot_t', 'Slot t'],
    ['rib_h', 'Rib h'],
    ['mount_inset', 'Mount inset'],
    ['outerRadius', 'Outer Radius'],
    ['r', 'R'],
    ['ratio', 'Ratio']
  ])('reads %s as %s without changing its identifier', (name, label) => {
    expect(parameterDisplayName(name)).toBe(label);
  });
  it('uses a short authored description, without turning prose into a label', () => {
    expect(parameterDisplayName('plate_t', 'Plate thickness')).toBe(
      'Plate thickness'
    );
    expect(parameterDisplayName('grid_r', 'Rows in the grid.')).toBe('Grid r');
  });
});
