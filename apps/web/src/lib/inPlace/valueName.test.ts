import { describe, expect, it } from 'vitest';
import { IN_PLACE_TOOL_SPECS } from './tools';
import { toolValueName } from './valueName';

describe('toolValueName', () => {
  it('names a value after its tool', () => {
    expect(toolValueName('Box', 'Width')).toBe('Box width');
    expect(toolValueName('Hole', 'Countersink angle')).toBe(
      'Hole countersink angle'
    );
  });

  it('says a word the title ends on once', () => {
    expect(toolValueName('Solid offset', 'Offset')).toBe('Solid offset');
    expect(toolValueName('Solid offset', 'Offset distance')).toBe(
      'Solid offset distance'
    );
  });

  // Every tool's every value, so a new label cannot bring the repeat back.
  it('never repeats a word for any in-place tool value', () => {
    for (const spec of Object.values(IN_PLACE_TOOL_SPECS)) {
      for (const value of spec.values) {
        const name = toolValueName(spec.title, value.label);
        expect(name, `${spec.id}.${value.id}`).not.toMatch(/\b(\w+) \1\b/i);
      }
    }
  });
});
