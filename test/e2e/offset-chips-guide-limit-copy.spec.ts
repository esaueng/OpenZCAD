import type { Page } from '@playwright/test';
import { collapseLimitBlockDocument } from '../support/collapse-limit-block';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  clickWorldPoint,
  waitForStillViewport,
  openActivityLogFromSettings,
  MODEL_ONLY,
  type SeedPanelLayout
} from './openzcad-fixtures';

/**
 * Three findings from browser checks of the beta, on the collapse-limit
 * block (`test/support/collapse-limit-block.ts`): its Front face refuses an
 * inward move past 6.4 mm because the rounded Right face's flat would
 * shrink to nothing.
 */

type Box = { x: number; y: number; width: number; height: number };

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

async function openCollapseBlock(
  page: Page,
  size: { width: number; height: number },
  panelLayout: SeedPanelLayout,
  workspaceTour = false
) {
  await stubApi(page, { panelLayout, workspaceTour });
  await page.setViewportSize(size);
  const { document } = await collapseLimitBlockDocument();
  await page.goto('/');
  await page.getByRole('button', { name: 'Import project' }).click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'collapse-limit-block.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: []
      })
    )
  });
  await expectBodyCount(page, 1, 30_000);
  // A fresh device opens the tool menu over the stage; close it.
  const tools = page.getByRole('button', { name: 'Close' }).first();
  if (await tools.isVisible()) await tools.click();
  await waitForStillViewport(page);
}

test('a phone’s offset tag and value stay on the stage beside Objects after exact entry', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openCollapseBlock(page, { width: 390, height: 844 }, MODEL_ONLY);
  await clickWorldPoint(page, [12, 12, 16]);
  await expect(page.getByRole('group', { name: 'Picked' })).toContainText(
    'Block · Top face'
  );
  const objectsButton = page
    .getByRole('toolbar', { name: 'Model panels' })
    .getByRole('button', { name: 'Objects panel' });
  if ((await objectsButton.getAttribute('aria-pressed')) !== 'true') {
    await objectsButton.click();
  }
  const objects = page.locator('.panel-lane-float .model-panel');
  await expect(objects).toBeVisible();
  const value = page.getByTestId('direct-manipulation-value');
  const mode = page.getByTestId('direct-manipulation-mode');
  await expect(mode).toHaveText(/^Offset/);

  // Exact entry opens and closes again, as in the finding. Before it, the
  // pair can stand under the panel that just opened, so it is pressed
  // directly.
  await value.evaluate((element) => (element as HTMLElement).click());
  const keypad = page.getByRole('dialog', { name: /value/i });
  await expect(keypad).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(keypad).toBeHidden();

  const stage = (await page.locator('.viewer-host canvas').boundingBox())!;
  await expect
    .poll(async () => {
      const boxes = await Promise.all(
        [mode, value].map((chip) => chip.boundingBox())
      );
      const panel = await objects.boundingBox();
      return boxes.every(
        (box) =>
          box !== null &&
          box.x >= stage.x &&
          box.x + box.width <= stage.x + stage.width &&
          (panel === null || !overlaps(box, panel))
      );
    })
    .toBe(true);
  await expect(mode).toBeInViewport({ ratio: 1 });
  await expect(value).toBeInViewport({ ratio: 1 });
});

test('a refused offset names its limit with units, and the guide never covers why', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openCollapseBlock(page, { width: 1280, height: 800 }, MODEL_ONLY, true);
  await page.keyboard.press('?');
  await page.getByRole('button', { name: 'Open modeling guide' }).click();
  const guide = page.locator('.workspace-tour');
  await expect(guide).toBeVisible();

  // Push the Front face in 9 mm on its arrow: past the 6.4 mm limit.
  await clickWorldPoint(page, [8, 0, 8]);
  await expect(page.getByRole('group', { name: 'Picked' })).toContainText(
    'Block · Front face'
  );
  const canvas = page.locator('.viewer-host canvas');
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  const at = (units: number) => ({
    x: bounds.x + handle.x + handle.dx * handle.pixelsPerUnit * units,
    y: bounds.y + handle.y + handle.dy * handle.pixelsPerUnit * units
  });
  await page.mouse.move(at(0).x, at(0).y);
  await page.mouse.down();
  // Paced like a hand, and held at the end until the refused frame has
  // come back, so release lands on a refusal that names its limit.
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(at(-0.9 * step).x, at(-0.9 * step).y);
    await page.waitForTimeout(50);
  }
  await expect(page.getByTestId('direct-manipulation-value')).toContainText(
    'max',
    { timeout: 30_000 }
  );
  await page.mouse.up();

  const refusal = page.locator('.edit-refusal.is-bar');
  await expect(refusal).toContainText('Not built', { timeout: 30_000 });
  // Release validation settles the refusal and offers the value inside it.
  await expect(
    refusal.getByRole('button', { name: 'Keep -6.39 mm' })
  ).toBeVisible({ timeout: 30_000 });
  await refusal.getByRole('button', { name: 'Why?' }).click();
  const card = refusal.locator('.edit-refusal-card');
  // The limit is signed like Keep, in the document's unit.
  await expect(card).toContainText(
    'A neighbouring face would shrink to nothing past -6.4 mm. Try a smaller offset.'
  );
  await expect(card).toContainText('The solid is unchanged.');

  const clear = async () => {
    const shown = await guide.isVisible();
    const [a, b] = await Promise.all([guide.boundingBox(), card.boundingBox()]);
    return !shown || a === null || b === null || !overlaps(a, b);
  };
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 800 },
    { width: 1280, height: 800 }
  ]) {
    await page.setViewportSize(size);
    await expect(card).toBeVisible();
    await expect.poll(clear).toBe(true);
    await expect(
      card.getByRole('button', { name: 'Technical details' })
    ).toBeVisible();
  }

  // The guide comes back once the explanation closes.
  await card.getByRole('button', { name: /close/i }).click();
  await expect(card).toBeHidden();
  await expect(guide).toBeVisible();
});

test('a drag cancelled on a refused frame logs its limit with units', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openCollapseBlock(page, { width: 1280, height: 800 }, MODEL_ONLY);
  await clickWorldPoint(page, [8, 0, 8]);
  await expect(page.getByRole('group', { name: 'Picked' })).toContainText(
    'Block · Front face'
  );
  const canvas = page.locator('.viewer-host canvas');
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  const at = (units: number) => ({
    x: bounds.x + handle.x + handle.dx * handle.pixelsPerUnit * units,
    y: bounds.y + handle.y + handle.dy * handle.pixelsPerUnit * units
  });
  await page.mouse.move(at(0).x, at(0).y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(at(-0.9 * step).x, at(-0.9 * step).y);
    await page.waitForTimeout(50);
  }
  // Held past the limit until the preview's refused frame is back.
  await expect(page.getByTestId('direct-manipulation-value')).toContainText(
    'max',
    { timeout: 30_000 }
  );
  // Letting go here parks the refusal, so the prompt no longer promises an
  // apply under the held hand.
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText(
    'Can’t move this face here · Release won’t apply'
  );
  await expect(status).not.toContainText('Release to apply');
  // Cancelled: no release-time refusal ever restates the limit.
  await page.keyboard.press('Escape');
  await page.mouse.up();

  const log = await openActivityLogFromSettings(page);
  await expect(log).toContainText('shrink to nothing past -6.4 mm', {
    timeout: 30_000
  });
  await expect(log).not.toContainText(/past -6\.4\. /);
});

/** Whether the guide stands over `box`: hidden, it stands over nothing. */
async function guideCovers(page: Page, box: Box | null) {
  const guide = page.locator('.workspace-tour');
  if (box === null || !(await guide.isVisible())) return false;
  const shown = await guide.boundingBox();
  return shown !== null && overlaps(shown, box);
}

/** What a press at the centre of `box` lands on, by the guide or not. */
async function pressLandsOnGuide(page: Page, box: Box) {
  return page.evaluate(
    ([x, y]) =>
      document.elementFromPoint(x!, y!)?.closest('.workspace-tour') !== null,
    [box.x + box.width / 2, box.y + box.height / 2]
  );
}

test('the guide never covers the exact-entry keypad’s Why? or its explanation, across a resize', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openCollapseBlock(page, { width: 1280, height: 844 }, MODEL_ONLY, true);
  await page.keyboard.press('?');
  await page.getByRole('button', { name: 'Open modeling guide' }).click();
  const guide = page.locator('.workspace-tour');
  await expect(guide).toBeVisible();

  // Typed past the Front face's 6.4 mm limit in exact entry: the keypad
  // says the refusal in place, Why? beside it.
  await clickWorldPoint(page, [8, 0, 8]);
  await expect(page.getByRole('group', { name: 'Picked' })).toContainText(
    'Block · Front face'
  );
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.locator('.numeric-keypad');
  await expect(keypad).toBeVisible();
  await keypad.getByRole('textbox').fill('-9');
  const refusal = keypad.locator('.edit-refusal.is-control');
  const why = refusal.getByRole('button', { name: 'Why?' });
  await expect(why).toBeVisible({ timeout: 30_000 });
  // The keypad stands wherever its chip put it, so the guide stands aside
  // while its refusal is up, rather than being placed around it.
  await expect(guide).toBeHidden();

  // Unopened, at each size, the guide neither covers the keypad nor takes
  // the press meant for Why?.
  for (const size of [
    { width: 1280, height: 844 },
    { width: 390, height: 844 },
    { width: 1280, height: 844 }
  ]) {
    await page.setViewportSize(size);
    await expect(why).toBeVisible();
    await expect
      .poll(async () => guideCovers(page, await keypad.boundingBox()))
      .toBe(false);
    expect(await pressLandsOnGuide(page, (await why.boundingBox())!)).toBe(
      false
    );
  }

  await why.click();
  const card = refusal.locator('.edit-refusal-card');
  await expect(card).toBeVisible();
  for (const size of [
    { width: 1280, height: 844 },
    { width: 390, height: 844 },
    { width: 1280, height: 844 }
  ]) {
    await page.setViewportSize(size);
    await expect(card).toBeVisible();
    await expect
      .poll(async () => guideCovers(page, await card.boundingBox()))
      .toBe(false);
    expect(await pressLandsOnGuide(page, (await card.boundingBox())!)).toBe(
      false
    );
  }

  // Escape closes the explanation first; the refusal (and Why?) is still
  // up, so the guide still stands aside. It comes back once the keypad
  // closes.
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(why).toBeVisible();
  await expect(guide).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(keypad).toBeHidden();
  await expect(guide).toBeVisible();
});

for (const folded of [false, true]) {
  test(`a phone’s offset pair stays on the stage, clear of Objects and the face tools, after exact entry across a resize${
    folded ? ' (guide folded)' : ''
  }`, async ({ page }) => {
    test.setTimeout(120_000);
    // Objects docked at the desktop width, as the finding had it.
    await openCollapseBlock(
      page,
      { width: 1280, height: 844 },
      { right: [['bodies']] },
      folded
    );
    if (folded) {
      await page.keyboard.press('?');
      await page.getByRole('button', { name: 'Open modeling guide' }).click();
      await page
        .locator('.workspace-tour')
        .getByRole('button', { name: 'Minimize modeling guide' })
        .click();
      await expect(
        page.getByRole('button', { name: 'Expand modeling guide' })
      ).toBeVisible();
    }
    await clickWorldPoint(page, [8, 0, 8]);
    await expect(page.getByRole('group', { name: 'Picked' })).toContainText(
      'Block · Front face'
    );
    const objectsButton = page
      .getByRole('toolbar', { name: 'Model panels' })
      .getByRole('button', { name: 'Objects panel' });
    await expect(objectsButton).toHaveAttribute('aria-pressed', 'true');

    const value = page.getByTestId('direct-manipulation-value');
    const mode = page.getByTestId('direct-manipulation-mode');
    await expect(mode).toHaveText(/^Offset/);
    await value.click();
    const keypad = page.locator('.numeric-keypad');
    await expect(keypad).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Escape');
    await expect(keypad).toBeHidden();

    const objects = page.locator('.model-panel').first();
    const rail = page.locator('.selection-rail');
    const guide = page.locator('.workspace-tour');
    await expect(objects).toBeVisible();
    await expect(rail).toBeVisible();
    const placement = async () => {
      const [modeBox, valueBox, objectsBox, railBox] = await Promise.all([
        mode.boundingBox(),
        value.boundingBox(),
        objects.boundingBox(),
        rail.boundingBox()
      ]);
      const guideBox = (await guide.isVisible())
        ? await guide.boundingBox()
        : null;
      const viewport = page.viewportSize()!;
      return [modeBox, valueBox].map((box) =>
        box === null
          ? 'missing'
          : box.x < 0 ||
              box.y < 0 ||
              box.x + box.width > viewport.width ||
              box.y + box.height > viewport.height
            ? `off-screen ${JSON.stringify(box)}`
            : objectsBox && overlaps(box, objectsBox)
              ? 'under Objects'
              : railBox && overlaps(box, railBox)
                ? 'under the face tools'
                : guideBox && overlaps(box, guideBox)
                  ? 'under the guide'
                  : 'clear'
      );
    };
    await expect.poll(placement).toEqual(['clear', 'clear']);
    // And it holds: no frame-to-frame swing once settled.
    await page.waitForTimeout(500);
    expect(await placement()).toEqual(['clear', 'clear']);
    await expect(mode).toBeInViewport({ ratio: 1 });
    await expect(value).toBeInViewport({ ratio: 1 });
  });
}
