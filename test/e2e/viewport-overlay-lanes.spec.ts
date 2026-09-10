import { expect, test, type Page } from '@playwright/test';
import {
  createProject,
  seedDismissedWorkspaceTour,
  stubApi
} from './openzcad-fixtures';

/*
  The workspace column floats over the viewport's left edge rather than
  claiming a grid track, so every overlay drawn on the canvas has to start
  from `--column-w`. Three of them had been positioned against the window
  instead, and each regression is invisible to a type or unit test: the
  offsets are correct CSS that lands in the wrong place.
*/

/** Left edge of the floating column, which every canvas overlay must clear. */
async function columnRight(page: Page) {
  const column = page.locator('.workspace-column');
  await expect(column).toBeVisible();
  const box = await column.boundingBox();
  expect(box).not.toBeNull();
  return box!.x + box!.width;
}

for (const width of [1440, 1024]) {
  test(`first-run tour card clears the workspace column at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page, { workspaceTour: true });
    await createProject(page, 'Tour lane');

    const tour = page.locator('.workspace-tour');
    await expect(tour).toBeVisible();
    const box = await tour.boundingBox();
    expect(box).not.toBeNull();
    // The whole card, not merely its right half: a partial overlap clipped
    // the heading's first word ("Create your first feature" read as "our
    // first feature").
    expect(box!.x).toBeGreaterThanOrEqual(await columnRight(page));
    // And it still fits on screen once it has been pushed clear.
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await expect(tour).toContainText('Create your first feature');

    // Clearing the column sideways is only half of it. The card outranks the
    // dock (--z-inspector-float over --z-viewer-overlay), so any vertical
    // overlap silently eats dock buttons: at `bottom: 14px` it covered four of
    // ten, and pushing it clear of the column took that to seven — including
    // the projection toggle cloud-sync.spec.ts clicks, which timed out on it.
    const obscured = await page.locator('.viewport-dock').evaluate((dock) =>
      [...dock.querySelectorAll('button')]
        .filter((button) => {
          const r = button.getBoundingClientRect();
          const top = document.elementFromPoint(
            r.x + r.width / 2,
            r.y + r.height / 2
          );
          return !!top && top !== button && !button.contains(top);
        })
        .map((button) => button.getAttribute('aria-label') ?? '')
    );
    expect(obscured).toEqual([]);
  });
}

test('viewport dock and toast clear the column at phone width', async ({
  page
}) => {
  // 390px sits inside the <=520px branch, where the dock drops its snap
  // readout and scale bar to hug the remaining width.
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await seedDismissedWorkspaceTour(page);
  await createProject(page, 'Phone dock');

  const right = await columnRight(page);

  const dock = page.locator('.viewport-dock-lane');
  await expect(dock).toBeVisible();
  const dockBox = await dock.boundingBox();
  expect(dockBox).not.toBeNull();
  expect(dockBox!.x).toBeGreaterThanOrEqual(right);

  const toast = page.locator('.workspace-toast');
  const toastBox = await toast.boundingBox();
  expect(toastBox).not.toBeNull();
  expect(toastBox!.x).toBeGreaterThanOrEqual(right);

  // Clearing the column is not enough on its own: 378px of dock into the
  // 194px that is left ran four of its ten buttons off the right edge
  // instead. The dock keeps to the lane and scrolls.
  const dockPill = page.locator('.viewport-dock');
  const pillBox = await dockPill.boundingBox();
  expect(pillBox).not.toBeNull();
  expect(pillBox!.x + pillBox!.width).toBeLessThanOrEqual(390);

  const reach = await dockPill.evaluate((el) => {
    const buttons = [...el.querySelectorAll('button')];
    const start = el.scrollLeft;
    const visible = () => {
      const clip = el.getBoundingClientRect();
      return buttons
        .filter((button) => {
          const r = button.getBoundingClientRect();
          return r.left >= clip.left - 0.5 && r.right <= clip.right + 0.5;
        })
        .map((button) => button.getAttribute('aria-label') ?? '');
    };
    el.scrollLeft = 0;
    const reachable = new Set(visible());
    el.scrollLeft = el.scrollWidth;
    visible().forEach((label) => reachable.add(label));
    el.scrollLeft = start;
    return { total: buttons.length, reachable: reachable.size };
  });
  expect(reach.total).toBeGreaterThan(0);
  expect(reach.reachable).toBe(reach.total);
});

test('orientation cube labels keep viewport text in both themes', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page);
  await seedDismissedWorkspaceTour(page);
  await createProject(page, 'Cube contrast');

  const label = page.locator('.cube-face-label').first();
  await expect(label).toBeAttached();
  const root = page.locator('html');

  // The cube is drawn on the viewport's dark stage, which never re-themes,
  // so its labels must not follow --color-text. At #1a2330 on #070b10 they
  // reached 1.25:1 under the light chrome.
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(root).toHaveAttribute('data-theme', scheme);
    await expect(label).toHaveCSS('fill', 'rgb(230, 237, 243)');
  }
});
