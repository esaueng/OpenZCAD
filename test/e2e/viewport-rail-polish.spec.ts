import type { Page } from '@playwright/test';
import { expect, stubApi, stubAnonymousApi, test } from './openzcad-fixtures';

/**
 * The 13 November design review's rail findings: one instrument order in
 * every mode with X-ray on View's bar (I52), a phone that does not reopen
 * the Tools drawer across its stage (I51), and a display-mode toast that
 * names the mode on screen however fast W is pressed (I54).
 */

async function openBracket(page: Page) {
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(
    page.getByRole('button', { name: 'Tweak', exact: true })
  ).toBeVisible({ timeout: 90_000 });
}

test('View’s bar keeps Build’s order and has an X-ray button', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubAnonymousApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBracket(page);
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: 'View' })
    .click();
  const bar = page.getByRole('toolbar', { name: 'View tools' });
  await expect(bar).toBeVisible();
  const names = await bar
    .locator(':scope > * button, :scope > button')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label') ?? '')
    );
  const order = [
    /^Measure$/,
    /^Fit view/,
    /^Toggle grid/,
    /^Orthographic projection/,
    /^Turntable orbit/,
    /^Display mode/,
    /^X-ray/,
    /^Standard views$/
  ];
  const positions = order.map((pattern) =>
    names.findIndex((name) => pattern.test(name))
  );
  expect(positions.every((position) => position >= 0), names.join(' | ')).toBe(
    true
  );
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);

  const xray = bar.getByRole('button', { name: /^X-ray/ });
  await expect(xray).toHaveAttribute('aria-pressed', 'false');
  await xray.click();
  await expect(xray).toHaveAttribute('aria-pressed', 'true');
  await expect(
    bar.getByRole('button', { name: /^Display mode.*X-ray/ })
  ).toBeVisible();
});

test('W pressed quickly names the mode the model shows', async ({ page }) => {
  test.setTimeout(120_000);
  await stubAnonymousApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBracket(page);
  await page.locator('.viewer-host canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Escape');
  for (let press = 0; press < 3; press += 1) await page.keyboard.press('w');
  const display = page.getByRole('button', { name: /^Display mode/ });
  const now = /now: (.+)$/.exec(
    (await display.getAttribute('aria-label')) ?? ''
  )?.[1];
  expect(now).toBeTruthy();
  await expect(page.locator('.workspace-toast')).toContainText(
    `Display: ${now}.`
  );
});

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('the Tools drawer left open does not come back across the stage', async ({
    page
  }) => {
    test.setTimeout(120_000);
    // The suite's seed stores the drawer open, as a wider window left it.
    await stubApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openBracket(page);
    const more = page.getByRole('button', { name: /^More tools/ });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('group', { name: 'Tools drawer' })).toHaveCount(
      0
    );
    // Opened on the phone, it still opens.
    await more.tap();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
  });
});
