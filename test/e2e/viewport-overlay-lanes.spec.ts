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
    // stage chrome (--z-inspector-float over --z-viewer-overlay), so any
    // overlap silently eats buttons: in the old bottom dock it covered four of
    // ten, including the projection toggle cloud-sync.spec.ts clicks. The
    // chrome now lives in the instrument rail, the readout and the search bar.
    const obscured = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '.instrument-rail button, .viewport-readout button, .command-bar'
        )
      ]
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

    // Nor the notice lane above the search bar. The card sat in the lane's
    // bottom-left corner, so the status toast ("Created Tour lane.") and the
    // selection chip it asks for in step 2 ran under it at 1024px.
    //
    // Measure the lane's status row, not the message in it. Every status the
    // toast shows is drawn inside that row, which is laid out whether or not
    // a message is up. The creation message itself is an 8 s transient whose
    // clock runs while the geometry worker's own status covers it: on a cold
    // CI runner the worker took longer than that to start, and the message
    // had already expired, blank, by the time the tour was measured.
    const row = page.locator('.workspace-toast');
    const statusBox = await row.boundingBox();
    const card = (await tour.boundingBox())!;
    expect(statusBox).not.toBeNull();
    expect(statusBox!.width).toBeGreaterThan(0);
    expect(statusBox!.height).toBeGreaterThan(0);
    const overlaps =
      statusBox!.x < card.x + card.width &&
      card.x < statusBox!.x + statusBox!.width &&
      statusBox!.y < card.y + card.height &&
      card.y < statusBox!.y + statusBox!.height;
    expect(overlaps).toBe(false);
  });
}

test('search bar and toast clear the column at phone width', async ({
  page
}) => {
  // 390px sits inside the <=520px branch, where the bottom lanes run from the
  // column to the window's right edge and the scale bar gives way.
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await seedDismissedWorkspaceTour(page);
  await createProject(page, 'Phone dock');

  const right = await columnRight(page);

  const bar = page.locator('.command-bar');
  await expect(bar).toBeVisible();
  const barBox = await bar.boundingBox();
  expect(barBox).not.toBeNull();
  expect(barBox!.x).toBeGreaterThanOrEqual(right);
  expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(390);

  const toast = page.locator('.workspace-toast');
  const toastBox = await toast.boundingBox();
  expect(toastBox).not.toBeNull();
  expect(toastBox!.x).toBeGreaterThanOrEqual(right);

  // The readout sits under the column, and every control in it is reachable:
  // nothing floats over it at this width.
  const readout = page.locator('.viewport-readout');
  const readoutBox = await readout.boundingBox();
  expect(readoutBox!.x + readoutBox!.width).toBeLessThanOrEqual(barBox!.x);
  const covered = await readout.evaluate((el) =>
    [...el.querySelectorAll('button')]
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
  expect(covered).toEqual([]);
});

// Below 1160px the sketch readout trades its words for glyphs, so the search
// row beside it keeps its full width (520px: the bar and Ask) instead of the
// readout wrapping or squeezing it. Narrower still, the lane stops mirroring
// the readout on the right (at 960px and below it runs to the edge, the cube
// standing above it), and below 664px the bar drops its ⌘K glyph as on a
// phone, so the field keeps room.
for (const { width, compact, minLane, phoneBar } of [
  { width: 1440, compact: false, minLane: 520, phoneBar: false },
  { width: 1024, compact: true, minLane: 520, phoneBar: false },
  { width: 600, compact: true, minLane: 320, phoneBar: true }
]) {
  test(`sketch readout keeps its segments on one row at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page);
    await seedDismissedWorkspaceTour(page);
    await createProject(page, 'Readout row');
    await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
    await page.getByRole('button', { name: 'Top (XY)' }).click();
    await expect(page.locator('.sketch-rail')).toBeVisible();

    const readout = page.locator('.viewport-readout');
    const grid = readout.locator('.viewport-dock-grid');
    await expect(grid).toBeVisible();
    await expect(grid).toHaveText(/^Grid \S+ mm$/);

    const icons = readout.locator('.viewport-readout-icon');
    await expect(icons).toHaveCount(3);
    for (const icon of await icons.all()) {
      await (compact ? expect(icon).toBeVisible() : expect(icon).toBeHidden());
    }
    // Hidden words stay in the accessibility tree: 1px and clipped, never
    // display: none.
    const snapWord = readout.locator(
      '.viewport-dock-snap .viewport-readout-word'
    );
    const wordWidth = await snapWord.evaluate(
      (el) => el.getBoundingClientRect().width
    );
    if (compact) {
      expect(wordWidth).toBeLessThanOrEqual(1);
    } else {
      expect(wordWidth).toBeGreaterThan(10);
    }

    // Filter, snap and grid used to outgrow the width a sketch reserves and
    // wrap the grid onto a second row, led by a stray separator.
    const tops = await readout.evaluate((el) =>
      [
        ...el.querySelectorAll(
          '.viewport-dock-filter, .viewport-dock-snap, .viewport-dock-grid'
        )
      ].map((segment) => segment.getBoundingClientRect().top)
    );
    expect(tops).toHaveLength(3);
    for (const top of tops) {
      expect(Math.abs(top - tops[0]!)).toBeLessThan(1);
    }

    // The reserve that keeps it on one row also moves the search lane, so
    // the readout still ends before the search bar starts.
    const readoutBox = await readout.boundingBox();
    const barBox = await page.locator('.command-bar').boundingBox();
    expect(readoutBox).not.toBeNull();
    expect(barBox).not.toBeNull();
    expect(readoutBox!.x + readoutBox!.width).toBeLessThanOrEqual(barBox!.x);
    const laneBox = await page.locator('.command-bar-lane').boundingBox();
    expect(laneBox).not.toBeNull();
    expect(laneBox!.width).toBeGreaterThanOrEqual(minLane);
    const searchKey = page.locator('.command-bar > kbd');
    await (phoneBar
      ? expect(searchKey).toBeHidden()
      : expect(searchKey).toBeVisible());
  });
}
