import type { Page } from '@playwright/test';
import {
  createProject,
  expect,
  pickPlanarFace,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * The guidance at the foot of the stage, from the 12 November review. It was
 * drawn in the search field, some 255px of a 1440px window with both docks
 * in use, so the default line read "Click a body, face, or edge · Shift+Cli…"
 * and Draw's ended "Update redra…". Guidance too long for the field now
 * stands on the card over the bar; these hold it whole at the two widths the
 * review used, and hold each mode to a line that is true of its state.
 */

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 }
] as const;

const hint = (page: Page) =>
  page.locator('.command-bar-lane > .workspace-hint');

async function openDemo(page: Page, size: { width: number; height: number }) {
  // The layout the review saw: Objects docked left, Parameters right. The
  // suite's baseline (one right column) leaves a wider bar.
  await stubApi(page, {
    panelLayout: { left: [['bodies']], right: [['parameters']] }
  });
  await page.setViewportSize(size);
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 120_000
  });
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Preparing model|Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Rebuilding geometry|Exact geometry is still rebuilding/i,
    { timeout: 60_000 }
  );
}

/**
 * The guidance is drawn, says `text`, and none of it is cut: neither the
 * line's own ellipsis nor a card running off the window.
 */
async function expectWholeGuidance(page: Page, text: string | RegExp) {
  // A status message has the lane while its toast is up; the guidance
  // returns as the toast goes quiet.
  await expect(hint(page)).toContainText(text, { timeout: 20_000 });
  await expect(hint(page)).toBeVisible();
  const reading = await hint(page).evaluate((element) => {
    const line = element.querySelector<HTMLElement>('.workspace-hint-text')!;
    const box = element.getBoundingClientRect();
    return {
      cut: line.scrollWidth > line.clientWidth,
      clipped: line.scrollHeight > line.clientHeight + 1,
      left: box.left,
      right: box.right,
      top: box.top,
      window: innerWidth
    };
  });
  expect(reading.cut, 'the guidance ends in an ellipsis').toBe(false);
  expect(reading.clipped, 'the guidance is clipped').toBe(false);
  expect(reading.left).toBeGreaterThanOrEqual(0);
  expect(reading.right).toBeLessThanOrEqual(reading.window);
  expect(reading.top).toBeGreaterThanOrEqual(0);
}

async function switchMode(page: Page, mode: string) {
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: mode, exact: true })
    .click();
}

for (const size of SIZES) {
  test.describe(`at ${size.width}px`, () => {
    // These two are the smoke set's: a line cut short (Build's, and Draw's
    // long one) and a line that is not true of its state (Draw with no
    // views), at both widths.
    test('Build guidance and the picked name read in full', { tag: '@ci-smoke' }, async ({
      page
    }) => {
      test.setTimeout(180_000);
      await openDemo(page, size);

      await expectWholeGuidance(
        page,
        'Click a body, face, or edge · Shift+Click adds to selection'
      );
      // Too long for the field at either width, it stands over the bar, and
      // the bar under it is the search field again.
      const bar = page.locator('.command-bar');
      const [hintBox, barBox] = await Promise.all([
        hint(page).boundingBox(),
        bar.boundingBox()
      ]);
      expect(hintBox!.y + hintBox!.height).toBeLessThanOrEqual(barBox!.y);
      await expect
        .poll(() =>
          page
            .locator('.command-bar-input')
            .evaluate(
              (element) => getComputedStyle(element, '::placeholder').color
            )
        )
        .not.toBe('rgba(0, 0, 0, 0)');

      // A face: its name leads the card, and gives way only when the name
      // and the measurement fill the row.
      expect(await pickPlanarFace(page, { x: 0, y: 0, z: 1 })).not.toBeNull();
      const name = page.locator('.selection-readout .selection-callout-name');
      await expect(name).toContainText('Mounting Bracket · ');
      await expectWholeGuidance(page, /Esc clears the selection/);
      const fit = await name.evaluate((element) => {
        const chip = element.closest<HTMLElement>('.selection-readout')!;
        const row = element.closest<HTMLElement>('.workspace-hint')!;
        const style = getComputedStyle(row);
        return {
          cut: element.scrollWidth > element.clientWidth,
          title: element.getAttribute('title'),
          text: element.textContent,
          chip: chip.getBoundingClientRect().width,
          row:
            row.clientWidth -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight)
        };
      });
      if (fit.cut) {
        // Cut only at the row's end, and then the whole name is its tooltip.
        expect(fit.chip).toBeGreaterThan(fit.row - 1);
        expect(fit.title).toBe(fit.text);
      } else {
        expect(fit.title).toBeNull();
      }
      if (size.width >= 1440) {
        // "Mounting Bracket · Front fa…" with a hundred pixels of the row
        // unused: at this width the name fits.
        expect(fit.cut).toBe(false);
      }
    });

    test('Draw points at views only once a sheet has them', { tag: '@ci-smoke' }, async ({
      page
    }) => {
      test.setTimeout(180_000);
      await openDemo(page, size);
      await switchMode(page, 'Draw');
      const start = page.getByRole('button', { name: 'New drawing sheet' });
      await expect(start).toBeVisible({ timeout: 30_000 });
      // No sheet, no views to drag: the stage's own start says what to do,
      // and the lane rests.
      await expect(hint(page)).toHaveText('Search commands · ? shortcuts', {
        timeout: 20_000
      });
      await expect(
        page.getByRole('group', { name: 'Workspace status' })
      ).not.toContainText('Drag a view');

      await start.click();
      await expectWholeGuidance(
        page,
        'Drag a view to place it · arrow keys nudge it · Update redraws a stale sheet'
      );
    });

    test('Assemble leaves its guidance to its panel', async ({ page }) => {
      test.setTimeout(180_000);
      await openDemo(page, size);
      await switchMode(page, 'Assemble');
      await expect(page.getByText('Start an assembly')).toBeVisible({
        timeout: 30_000
      });
      const summary = page.getByRole('group', { name: 'Workspace status' });
      await expect(hint(page)).toHaveText('Search commands · ? shortcuts', {
        timeout: 20_000
      });
      // A click on the part used to arm Build's edge prompt here: "Drag the
      // arrow to set the fillet on edge", with no arrow in Assemble.
      const canvas = (await page.locator('.viewer-host canvas').boundingBox())!;
      await page.mouse.click(
        canvas.x + canvas.width / 2,
        canvas.y + canvas.height / 2
      );
      await page.waitForTimeout(1_500);
      await expect(hint(page)).toHaveText('Search commands · ? shortcuts');
      await expect(summary).not.toContainText(/fillet|Click a body/);
    });

    test('the sketch plane chooser gives its instruction once', async ({
      page
    }) => {
      test.setTimeout(180_000);
      await openDemo(page, size);
      await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
      const chooser = page.locator('.sketch-plane-prompt');
      await expect(chooser).toContainText('Pick a sketch plane');
      await expect(chooser).toContainText(
        'Click a plane in the view or a flat face on the model'
      );
      // The toast under it said "Sketch: pick a plane or a planar face to
      // draw on." a second time; the lane neither repeats it nor runs ahead
      // to the drawing keys, which mean nothing before a plane is chosen.
      await expect(page.locator('.workspace-toast')).toHaveClass(/\bhidden\b/);
      await expect(hint(page)).toHaveCount(0);
      await expect(
        page.getByRole('group', { name: 'Workspace status' })
      ).not.toContainText('Drag to draw');
      // Still recorded, for the activity log and for assistive tech.
      await expect(page.getByRole('contentinfo')).toContainText(
        'Sketch: pick a plane or a planar face to draw on.'
      );

      await page.keyboard.press('Escape');
      await expect(chooser).toHaveCount(0);
      await expect(page.locator('.workspace-toast')).not.toHaveClass(
        /\bhidden\b/
      );
      await expect(page.getByRole('contentinfo')).toContainText(
        'Sketch canceled'
      );
    });
  });
}

test('the resting line names the bar once, beside its key', async ({
  page
}) => {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await createProject(page, 'Resting line');
  // "Ctrl+K commands · ? shortcuts" stood directly beside a "Ctrl+K" badge.
  await expect(hint(page)).toHaveText('Search commands · ? shortcuts', {
    timeout: 20_000
  });
  const key = page.locator('.command-bar > kbd');
  await expect(key).toBeVisible();
  await expect(hint(page)).not.toContainText((await key.textContent())!);
  // It is the idle bar's own line: in the field, on the bar's row, whole.
  const [hintBox, barBox] = await Promise.all([
    hint(page).boundingBox(),
    page.locator('.command-bar').boundingBox()
  ]);
  expect(Math.abs(hintBox!.y - barBox!.y)).toBeLessThan(2);
  expect(
    await hint(page)
      .locator('.workspace-hint-text')
      .evaluate((line) => line.scrollWidth > line.clientWidth)
  ).toBe(false);
});

// "Has views" used to be asked of the whole document, so an emptied sheet
// beside a drawn one kept "Drag a view to place it" with nothing to drag.
test('Draw reads the sheet on screen, not any sheet', async ({ page }) => {
  test.setTimeout(180_000);
  await openDemo(page, SIZES[0]);
  await switchMode(page, 'Draw');
  const drawings = page.getByRole('region', { name: 'Drawings' });
  await page.getByRole('button', { name: 'New drawing sheet' }).click();
  const drag = /^Drag a view to place it/;
  const resting = 'Search commands · ? shortcuts';
  await expect(hint(page)).toHaveText(drag, { timeout: 30_000 });

  // A second sheet, emptied of its views.
  await drawings.getByRole('button', { name: 'New sheet' }).click();
  const second = drawings.getByRole('application', { name: 'Sheet Sheet 2' });
  await expect(second).toBeVisible({ timeout: 30_000 });
  const views = second.getByRole('button', { name: / view$/ });
  await expect(views).toHaveCount(4, { timeout: 30_000 });
  for (let left = 4; left > 0; left -= 1) {
    await views.first().click();
    await drawings.getByRole('button', { name: 'Delete view' }).click();
    await expect(views).toHaveCount(left - 1);
  }
  await expect(hint(page)).toHaveText(resting, { timeout: 20_000 });

  // The drawn sheet still says it; the empty one still does not.
  await drawings.getByRole('tab', { name: 'Sheet 1' }).click();
  await expect(hint(page)).toHaveText(drag, { timeout: 20_000 });
  await drawings.getByRole('tab', { name: 'Sheet 2' }).click();
  await expect(hint(page)).toHaveText(resting, { timeout: 20_000 });
});
