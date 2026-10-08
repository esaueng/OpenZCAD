import { describe, expect, it } from 'vitest';
import { geometryYield } from './geometryYield';

describe('geometry worker task yields', () => {
  it('spends the work budget before scheduling and resets it after message delivery', async () => {
    let clock = 0;
    let turns = 0;
    const yieldControl = geometryYield(
      () => clock,
      async () => {
        turns += 1;
        clock += 50;
      },
      8
    );
    clock = 7;
    expect(yieldControl()).toBeUndefined();
    clock = 8;
    await yieldControl();
    expect(turns).toBe(1);
    clock += 7;
    expect(yieldControl()).toBeUndefined();
    clock += 1;
    await yieldControl();
    expect(turns).toBe(2);
  });

  it('delivers tasks, which a resolved promise alone cannot deliver', async () => {
    let delivered = false;
    setTimeout(() => {
      delivered = true;
    }, 0);
    await Promise.resolve();
    expect(delivered).toBe(false);
    await geometryYield(() => 0, undefined, 0)();
    expect(delivered).toBe(true);
  });
});
