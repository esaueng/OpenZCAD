import { describe, expect, it } from 'vitest';
import { booleanOperationSwitch } from './tools';

describe('booleanOperationSwitch (#1654)', () => {
  it('switches a running boolean to the launched operation', () => {
    expect(booleanOperationSwitch('subtract', 'union')).toBe('union');
    expect(booleanOperationSwitch('union', 'subtract')).toBe('subtract');
    expect(booleanOperationSwitch('subtract', 'intersect')).toBe('intersect');
    // The same operation is still the running command's, not a new launch.
    expect(booleanOperationSwitch('union', 'union')).toBe('union');
  });

  it('leaves every other launch to the tool rail', () => {
    expect(booleanOperationSwitch(null, 'union')).toBeNull();
    expect(booleanOperationSwitch('hole', 'union')).toBeNull();
    expect(booleanOperationSwitch('subtract', 'fillet')).toBeNull();
    expect(booleanOperationSwitch('subtract', 'transform')).toBeNull();
  });
});
