import type { Page } from '@playwright/test';
import {
  KEYED_HISTORY,
  keyedCore,
  projectBackup
} from '../support/history-reorder';
import {
  expect,
  expectBodyCount,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';

function historyOrder(page: Page) {
  return page.locator('.feature-row .feature-name').allTextContents();
}

function grip(page: Page, name: string) {
  return page.getByRole('button', {
    name: `Reorder ${name}. Use the arrow keys to move it.`
  });
}

/**
 * Moving the key's placement below the copy taken from the key is a legal
 * order: the copy only reads the key, so nothing is consumed twice. But the
 * copy is then taken from the unparked key, misses the block, and the
 * Intersect after it cannot rebuild. A History reorder must be refused by
 * name like an edit, by drag and keyboard alike, and leave the order as it
 * was. A reorder that does rebuild still commits and undoes.
 *
 * (The demo bracket's wall placement moved past its Union stood here until
 * #2334: that order puts a placement after the consumer of the placed body,
 * and the order gate now refuses it before any rebuild. See
 * `history-reorder-consumed-cutter.spec.ts`.)
 */
test('refuses a history reorder that breaks a later feature', async ({
  page
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // History docked alone: a drag between two rows needs both on screen, and
  // a fifth of a five-panel column scrolled the target away mid-drag.
  await stubApi(page, { panelLayout: { right: [['history']] } });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await page
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'keyed-core.openzcad',
    mimeType: 'application/json',
    buffer: projectBackup(keyedCore())
  });
  await page
    .getByRole('button', { name: 'History panel', exact: true })
    .waitFor({ state: 'visible', timeout: 60_000 });
  // The parked key and the keyed core.
  await expectBodyCount(page, 2);
  await revealModelPanel(page);
  const order = () => historyOrder(page);
  await expect.poll(order, { timeout: 30_000 }).toEqual([...KEYED_HISTORY]);

  const details = page.getByRole('region', { name: 'History details' });
  const refusal = details.getByRole('alert');
  const toast = page
    .locator('.toast-message')
    .getByText(/Reorder Park key not applied: Keyed core would not rebuild\./);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeDisabled();

  // Drag the placement onto the copy's row.
  await grip(page, 'Park key').dragTo(
    page.locator('.feature-row', {
      has: page.locator('.feature-name', { hasText: /^Key copy$/ })
    })
  );
  await expect(refusal).toContainText('Edit not saved · Keyed core', {
    timeout: 60_000
  });
  await expect(toast).toBeVisible();
  expect(await order()).toEqual([...KEYED_HISTORY]);
  await expect(undo).toBeDisabled();
  await details.getByRole('button', { name: 'Dismiss failure' }).click();
  await expect(refusal).toHaveCount(0);

  // The same move from the keyboard is refused the same way.
  await grip(page, 'Park key').press('ArrowDown');
  await expect(refusal).toContainText('Edit not saved · Keyed core', {
    timeout: 60_000
  });
  expect(await order()).toEqual([...KEYED_HISTORY]);
  await expect(undo).toBeDisabled();
  await details.getByRole('button', { name: 'Dismiss failure' }).click();

  // The key made ahead of the block rebuilds, so it commits.
  await grip(page, 'Key').press('ArrowUp');
  const moved = ['Key', 'Block', ...KEYED_HISTORY.slice(2)];
  await expect.poll(order, { timeout: 60_000 }).toEqual(moved);
  await expect(refusal).toHaveCount(0);
  await expectBodyCount(page, 2);
  await undo.click();
  await expect.poll(order, { timeout: 30_000 }).toEqual([...KEYED_HISTORY]);
  await expect(undo).toBeDisabled();
  expect(errors).toEqual([]);
});
