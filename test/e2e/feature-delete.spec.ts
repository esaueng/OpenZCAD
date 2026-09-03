import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * Deleting a feature from its history row used to be instant, silent and
 * unguarded: the row's trash icon removed the feature and everything built
 * on it, and the only trace was one line in the status log. The toast is
 * what makes that reversible without knowing the shortcut, and it says how
 * much was resting on the feature before the model shows it.
 */
test('deleting a history feature raises an undoable toast that counts its dependents', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();

  const status = page.getByRole('contentinfo');
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 120_000
  });
  await expect(status).not.toContainText(
    /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 60_000 }
  );
  const summary = page.getByRole('group', { name: 'Workspace status' });
  await expect(summary.getByLabel(/ · 16 features · 1 body\. Sync /)).toBeVisible();

  const bossRow = page.locator('.feature-row', { hasText: 'Boss' }).first();
  await bossRow.hover();
  await page.getByRole('button', { name: 'Delete Boss', exact: true }).click();

  const toast = page.locator('.toast');
  await expect(toast).toHaveText(/Deleted Boss · \d+ features depended on it/);
  const count = Number(
    (await toast.textContent())?.match(/(\d+) features/)?.[1] ?? '0'
  );
  expect(count).toBeGreaterThanOrEqual(4);
  await expect(summary.getByLabel(/ · 15 features · /)).toBeVisible();

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toHaveCount(0);
  await expect(summary.getByLabel(/ · 16 features · 1 body\. Sync /)).toBeVisible({
    timeout: 60_000
  });
  await expect(status).toContainText('Undo Delete Boss');
});
