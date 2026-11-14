import type { Page } from '@playwright/test';
import { expect, revealModelPanel, stubApi, test } from './openzcad-fixtures';

/**
 * Sketch findings from the 13 November design review: a selected line takes
 * a driving length from the Dimension key (I39); the sketch's state stays in
 * view as a DOF chip that follows each commit (I38); a refused value leaves
 * the committed sketch, its colours and its state exactly as they were
 * (I35); and a sketch re-opened from History starts in Select, so the first
 * drag never draws a stray line (I36).
 */

async function newSketch(page: Page) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Sketch review');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await page.waitForTimeout(800);
}

/** Draws a rectangle away from the rail's cards; returns its top edge. */
async function drawRectangle(page: Page) {
  const canvas = page.locator('.viewer-host canvas');
  const bounds = (await canvas.boundingBox())!;
  const a = {
    x: bounds.x + bounds.width * 0.55,
    y: bounds.y + bounds.height * 0.4
  };
  const b = {
    x: bounds.x + bounds.width * 0.68,
    y: bounds.y + bounds.height * 0.55
  };
  await page.keyboard.press('r');
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await expect(page.getByRole('contentinfo')).toContainText(/Sketch 01/);
  await page.keyboard.press('v');
  return {
    top: { x: (a.x + b.x) / 2, y: a.y },
    bottom: { x: (a.x + b.x) / 2, y: b.y }
  };
}

async function dimensionSelectedLine(page: Page, value: string) {
  await page.keyboard.press('d');
  const keypad = page.getByRole('dialog', { name: 'Distance value' });
  await expect(keypad).toBeVisible();
  await keypad.getByRole('textbox').fill(value);
  await keypad.getByRole('button', { name: 'Apply distance' }).click();
}

test(
  'a selected line takes its length from D, and a refused value changes nothing',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    await newSketch(page);
    const edges = await drawRectangle(page);
    const status = page.getByRole('contentinfo');
    const chip = page.getByRole('button', { name: /^Sketch state:/ });

    await page.mouse.click(edges.top.x, edges.top.y);
    await dimensionSelectedLine(page, '50');
    await expect(status).toContainText('Distance dimension added', {
      timeout: 30_000
    });
    // I38: the state is on screen after the commit, not only in a toast.
    await expect(chip).toHaveText(/\d+ DOF/);
    await expect(chip).toHaveAttribute('data-state', 'free');

    // A rectangle's opposite sides are equal, so 60 on the bottom fights the
    // top's 50 and is refused.
    await page.keyboard.press('Escape');
    await page.mouse.click(edges.bottom.x, edges.bottom.y);
    await dimensionSelectedLine(page, '60');
    await expect(status).toContainText('Distance 60 mm was not added', {
      timeout: 30_000
    });
    // I35: nothing was committed, so nothing paints as conflicted.
    await expect(chip).toHaveAttribute('data-state', 'free');
    await expect(
      page.getByRole('region', { name: 'Constraint feedback' })
    ).toHaveCount(0);
    await expect(status).not.toContainText('profile');
  }
);

test('a sketch re-opened from History starts in Select', async ({ page }) => {
  test.setTimeout(90_000);
  await newSketch(page);
  await drawRectangle(page);
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toHaveCount(
    0
  );
  await revealModelPanel(page, 'History');
  await page
    .getByRole('region', { name: 'History', exact: true })
    .locator('.feature-row-main')
    .filter({ hasText: 'Sketch 01' })
    .dblclick();
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(rail).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Select' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(rail.getByRole('button', { name: 'Line' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
});

test('a value prompt in a sketch says Esc cancels it, and its Escape stays in the sketch (I43)', async ({
  page
}) => {
  test.setTimeout(90_000);
  await newSketch(page);
  const edges = await drawRectangle(page);
  const status = page.getByRole('contentinfo');
  const finish = page.getByRole('button', {
    name: 'Finish Sketch',
    exact: true
  });

  await page.mouse.click(edges.top.x, edges.top.y);
  await page.keyboard.press('d');
  const keypad = page.getByRole('dialog', { name: 'Distance value' });
  await expect(keypad).toBeVisible();
  // The hint is the open prompt's keys, not the sketch ladder's last rung.
  await expect(status).toContainText('Enter apply · Esc cancel');
  await expect(status).not.toContainText('leaves the sketch');

  // Escape cancels the value only: the sketch stays open.
  await keypad.getByRole('textbox').press('Escape');
  await expect(keypad).toBeHidden();
  await expect(finish).toBeVisible();
  await expect(status).not.toContainText('Press Esc again');

  // Finish leaves in one click.
  await finish.click();
  await expect(finish).toBeHidden();
});
