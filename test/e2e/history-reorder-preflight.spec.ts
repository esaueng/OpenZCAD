import type { Page } from '@playwright/test';
import {
  expect,
  expectBodyCount,
  revealModelDrawer,
  stubApi,
  test
} from './openzcad-fixtures';

const DEMO_ORDER = [
  'Base plate',
  'Wall plate',
  'Seat wall on base',
  'Union L bracket',
  'Boss',
  'Place boss on wall',
  'Union boss',
  'Boss bore tool',
  'Aim bore through boss',
  'Boss bore',
  'Mount hole L',
  'Place mount hole L',
  'Mount hole R',
  'Place mount hole R',
  'Mount hole L cut',
  'Mounting holes',
  'Wall top edge break'
];

function historyOrder(page: Page) {
  return page.locator('.feature-row .feature-name').allTextContents();
}

function grip(page: Page, name: string) {
  return page.getByRole('button', {
    name: `Reorder ${name}. Use the arrow keys to move it.`
  });
}

/**
 * Moving the wall's placement past the union is a legal order — the union
 * still runs after both plates exist — but the union then joins plates that
 * no longer touch, and the boss union after it cannot rebuild. A History
 * reorder must be refused by name like an edit, by drag and keyboard alike,
 * and leave the order as it was. A reorder that does rebuild still commits
 * and undoes.
 */
test('refuses a history reorder that breaks a later feature', async ({
  page
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await expectBodyCount(page, 1);
  await revealModelDrawer(page);
  const order = () => historyOrder(page);
  await expect.poll(order, { timeout: 30_000 }).toEqual(DEMO_ORDER);

  const details = page.getByRole('region', { name: 'History details' });
  const refusal = details.getByRole('alert');
  const toast = page
    .locator('.toast-message')
    .getByText(
      /Reorder Seat wall on base not applied: Union boss would not rebuild\./
    );
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeDisabled();

  // Drag the placement onto the union's row.
  await grip(page, 'Seat wall on base').dragTo(
    page.locator('.feature-row', { hasText: 'Union L bracket' })
  );
  await expect(refusal).toContainText('Edit not saved · Union boss', {
    timeout: 60_000
  });
  await expect(toast).toBeVisible();
  expect(await order()).toEqual(DEMO_ORDER);
  await expect(undo).toBeDisabled();
  await details.getByRole('button', { name: 'Dismiss failure' }).click();
  await expect(refusal).toHaveCount(0);

  // The same move from the keyboard is refused the same way.
  await grip(page, 'Seat wall on base').press('ArrowDown');
  await expect(refusal).toContainText('Edit not saved · Union boss', {
    timeout: 60_000
  });
  expect(await order()).toEqual(DEMO_ORDER);
  await expect(undo).toBeDisabled();
  await details.getByRole('button', { name: 'Dismiss failure' }).click();

  // An independent cutter moved above the bore rebuilds, so it commits.
  await grip(page, 'Mount hole L').press('ArrowUp');
  const moved = [...DEMO_ORDER];
  moved.splice(9, 2, 'Mount hole L', 'Boss bore');
  await expect.poll(order, { timeout: 60_000 }).toEqual(moved);
  await expect(refusal).toHaveCount(0);
  await expectBodyCount(page, 1);
  await undo.click();
  await expect.poll(order, { timeout: 30_000 }).toEqual(DEMO_ORDER);
  await expect(undo).toBeDisabled();
  expect(errors).toEqual([]);
});
