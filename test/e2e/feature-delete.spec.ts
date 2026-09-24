import type { Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * The Undo toast, the status toast, the selection chip and the search bar
 * share one lane. Each notice used to carry a fixed offset of its own, so the
 * Undo toast was drawn over the status toast ("Deleted … Undo" across
 * "Measuring … as stale"), over the chip, and over the chrome under the lane.
 * Every visible notice now has pixels of its own, and the toast stands clear
 * above the search bar and beside the readout.
 */
async function expectNoticeLaneClear(page: Page) {
  const lane = await page.evaluate(async () => {
    const selectors = [
      '.toast',
      '.workspace-toast',
      '.workspace-toast-body',
      '.selection-chip',
      '.activity-pill'
    ];
    // Past the pop-in and the status fade: the pop-in's transform nudges the
    // toast's box while it runs.
    await Promise.all(
      selectors
        .flatMap((selector) => [...document.querySelectorAll(selector)])
        .flatMap((element) => element.getAnimations())
        .map((animation) => animation.finished)
    );
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        if (Number(getComputedStyle(node).opacity) === 0) return null;
      }
      const { top, bottom, left, right, width } =
        element.getBoundingClientRect();
      // `display: none` (the hint while the chip names the selection).
      if (width === 0) return null;
      return { top, bottom, left, right };
    };
    return {
      toast: box('.toast'),
      bar: box('.command-bar-row'),
      readout: box('.viewport-readout'),
      rows: {
        status: box('.workspace-toast-body'),
        chip: box('.selection-chip'),
        pill: box('.activity-pill'),
        hint: box('.workspace-hint')
      }
    };
  });
  expect(lane.toast).not.toBeNull();
  // The search bar is the chrome the lane stands on.
  expect(lane.bar).not.toBeNull();
  expect(lane.toast!.bottom).toBeLessThanOrEqual(lane.bar!.top);
  // The readout sits in the bottom-left corner, under the column.
  expect(lane.readout).not.toBeNull();
  expect(
    lane.toast!.right <= lane.readout!.left ||
      lane.toast!.left >= lane.readout!.right ||
      lane.toast!.bottom <= lane.readout!.top
  ).toBe(true);
  // A running or warning status keeps its own row under the toast (a
  // settled one steps aside rather than repeat it), as do the chip, the
  // activity pill and the guidance hint.
  for (const [name, row] of Object.entries(lane.rows)) {
    if (!row) continue;
    expect(lane.toast!.bottom, `toast clears the ${name}`).toBeLessThanOrEqual(
      row.top
    );
  }
}

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
    summary.getByLabel(/ · 17 features · 1 body\. Sync /)
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
  await expect(summary.getByLabel(/ · 16 features · /)).toBeVisible();
  await expectNoticeLaneClear(page);

  // The full stack: a selection chip, a rebuild still running and the Undo
  // toast at once. Holding the toast under the pointer keeps it up while the
  // pick lands. The running tone is set directly: a real rebuild is over
  // before a spec could measure it, and the lane keys on the tone alone.
  await toast.hover();
  const canvas = page.locator('.viewer-host canvas');
  const canvasBox = (await canvas.boundingBox())!;
  await page.mouse.click(
    canvasBox.x + canvasBox.width / 2,
    canvasBox.y + canvasBox.height / 2
  );
  await expect(page.locator('.selection-chip')).toBeVisible();
  await toast.hover();
  await status.evaluate((footer) => {
    footer.classList.remove('ready', 'hidden');
    footer.classList.add('running');
  });
  await expectNoticeLaneClear(page);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toHaveCount(0);
  await expect(
    summary.getByLabel(/ · 17 features · 1 body\. Sync /)
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
  await expect(rows).toHaveCount(17);

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
