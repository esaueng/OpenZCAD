import type { Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  enterCommandValue,
  expect,
  expectBodyCount,
  pressTool,
  stubApi,
  test
} from './openzcad-fixtures';

/** A chip's centre in page pixels. */
async function centre(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('The chip is not on screen.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The handle each command value's arrow stands on, in page pixels. */
async function handlePoints(page: Page) {
  const raw = await page
    .locator('.viewer-host canvas')
    .getAttribute('data-e2e-command-handles');
  return JSON.parse(raw ?? '{}') as Record<
    string,
    { x: number; y: number; value: number }
  >;
}

const apart = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/**
 * A value the kernel refuses leaves its arrow and chip at the edge being
 * edited: on the last value that built, which is the fillet or chamfer still
 * on screen, not 1000 mm along the arrow at the canvas edge. The chip still
 * reads the refused value, and its keypad opens beside it to fix it.
 */
for (const { tool, valueId, label } of [
  { tool: 'Fillet', valueId: 'radius', label: 'R' },
  { tool: 'Chamfer', valueId: 'distance', label: 'Distance' }
] as const) {
  test(
    `in-place ${tool} keeps a refused value's chip at the edited edge`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(120_000);
      await stubApi(page);
      await page.goto('/');
      await page.getByLabel('Project name').fill(`Refused ${tool} chip`);
      await page.getByRole('button', { name: 'New project' }).click();
      await createPrimitiveInPlace(page, 'cylinder', {
        sizes: { radius: '10', height: '20' }
      });
      await expectBodyCount(page, 1);

      await pressTool(page, new RegExp(`^${tool}`));
      const bar = page.getByRole('group', { name: `${tool} command` });
      await bar.locator('summary').click();
      await bar.getByRole('button', { name: 'Select all 2 edges' }).click();
      await bar.locator('summary').click();
      const status = bar.getByRole('status');
      const done = bar.getByRole('button', { name: /Done/ });
      const chip = page.getByTestId(`command-handle-${valueId}`);
      await enterCommandValue(page, valueId, '1');
      await expect(done).toBeEnabled({ timeout: 30_000 });
      await expect(chip).toContainText('1 mm');
      // Settled where the value that built puts it.
      await expect
        .poll(async () => (await handlePoints(page))[valueId]?.value)
        .toBe(1);
      const builtChip = await centre(chip);
      const builtHandle = (await handlePoints(page))[valueId]!;

      await enterCommandValue(page, valueId, '1000');
      await expect(status).toContainText(new RegExp(`^${label}: \\S`), {
        timeout: 30_000
      });
      await expect(done).toBeDisabled();
      // The chip reads what was typed, so it can be tapped to change it...
      await expect(chip).toContainText('1000 mm');
      // ...but stands where the kept 1 mm preview is: the arrow on the last
      // value that built, the chip beside it.
      await expect
        .poll(async () => (await handlePoints(page))[valueId]?.value)
        .toBe(1);
      const refusedHandle = (await handlePoints(page))[valueId]!;
      expect(apart(refusedHandle, builtHandle)).toBeLessThan(4);
      expect(apart(await centre(chip), builtChip)).toBeLessThan(40);

      // Its keypad opens on the refused value, beside the chip.
      await chip.click();
      const keypad = page.locator('.numeric-keypad');
      await expect(keypad).toBeVisible();
      await expect(keypad.locator('input')).toHaveValue('1000');
      const keypadBox = (await keypad.boundingBox())!;
      const nearest = {
        x: Math.min(
          Math.max(builtChip.x, keypadBox.x),
          keypadBox.x + keypadBox.width
        ),
        y: Math.min(
          Math.max(builtChip.y, keypadBox.y),
          keypadBox.y + keypadBox.height
        )
      };
      expect(apart(nearest, builtChip)).toBeLessThan(120);
      await keypad.locator('input').fill('1.5');
      await keypad.locator('input').press('Enter');
      await expect(keypad).toHaveCount(0);
      await expect(done).toBeEnabled({ timeout: 30_000 });
      await expect
        .poll(async () => (await handlePoints(page))[valueId]?.value)
        .toBe(1.5);
      await bar.getByRole('button', { name: 'Cancel' }).click();
      await expect(bar).toHaveCount(0);
    }
  );
}
