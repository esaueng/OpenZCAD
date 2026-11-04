import { expect, it } from 'vitest';

it('uses the integration default for encrypted-project flows', ({ task }) => {
  expect(task.timeout).toBe(30_000);
});

it(
  'retains an explicit five-second deadline',
  { timeout: 5_000 },
  ({ task }) => {
    expect(task.timeout).toBe(5_000);
  }
);

it(
  'retains a longer explicit integration budget',
  { timeout: 60_000 },
  ({ task }) => {
    expect(task.timeout).toBe(60_000);
  }
);
