import type { Page } from '@playwright/test';
import { collapseLimitBlockDocument } from '../support/collapse-limit-block';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  clickWorldPoint,
  waitForStillViewport,
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
