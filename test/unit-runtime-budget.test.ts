import { expect, it } from 'vitest';

it('keeps the ordinary unit-test default at five seconds', ({ task }) => {
  expect(task.timeout).toBe(5_000);
});
