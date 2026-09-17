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
  await expect(
    summary.getByLabel(/ · 16 features · 1 body\. Sync /)
  ).toBeVisible();

  const bossRow = page.locator('.feature-row', { hasText: 'Boss' }).first();
  await bossRow.hover();
  // The load-bearing delete confirms first (native confirm, accepted here —
  // Playwright would auto-dismiss it as cancel otherwise).
  await Promise.all([
    page.waitForEvent('dialog').then((dialog) => dialog.accept()),
    page.getByRole('button', { name: 'Delete Boss', exact: true }).click()
  ]);

  const toast = page.locator('.toast');
  await expect(toast).toHaveText(/Deleted Boss · \d+ features depended on it/);
  const count = Number(
    (await toast.textContent())?.match(/(\d+) features/)?.[1] ?? '0'
  );
  expect(count).toBeGreaterThanOrEqual(4);
  await expect(summary.getByLabel(/ · 15 features · /)).toBeVisible();

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toHaveCount(0);
  await expect(
    summary.getByLabel(/ · 16 features · 1 body\. Sync /)
  ).toBeVisible({
    timeout: 60_000
  });
  await expect(status).toContainText('Undo Delete Boss');
});

/**
 * The history list is a CSS grid, and its one implicit `auto` track sized
 * itself to the longest nowrap feature name. A long name (an imported part's
 * "Hammer Holder 46mm v4.step opening: negativeEnd mask placement") widened
 * every row past the sidebar and carried the suppress, rollback and delete
 * buttons off-screen; at a 200px column even the demo's own names did it.
 * Now the row keeps to the list, the name takes the ellipsis, and every
 * control stays inside the sidebar no matter how narrow it is.
 */
test('keeps every history row control inside a narrow sidebar', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  // 820px caps the column at 200px (workspace-column.css).
  await page.setViewportSize({ width: 820, height: 768 });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 120_000
  });
  const rows = page.locator('.sidebar .feature-row');
  await expect(rows).toHaveCount(16);

  const sidebar = await page.locator('.sidebar').boundingBox();
  const list = await page
    .locator('.sidebar .feature-row')
    .first()
    .locator('..')
    .boundingBox();
  expect(sidebar).not.toBeNull();
  expect(list).not.toBeNull();
  const sidebarRight = sidebar!.x + sidebar!.width;
  for (const row of await rows.all()) {
    const box = await row.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(list!.width + 0.5);
    const del = await row.locator('.row-delete').boundingBox();
    expect(del!.x + del!.width).toBeLessThanOrEqual(sidebarRight);
  }

  // The controls themselves still show on hover, at this width, on the
  // row whose name is now cut short.
  const longest = page.locator('.feature-row', {
    hasText: 'Aim bore through boss'
  });
  await longest.hover();
  await expect(
    longest.getByRole('button', { name: 'Delete Aim bore through boss' })
  ).toBeVisible();
  const name = longest.locator('.feature-name');
  const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(clipped).toBe(true);
});
