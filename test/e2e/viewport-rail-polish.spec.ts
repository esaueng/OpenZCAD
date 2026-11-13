import type { Page } from '@playwright/test';
import { expect, stubAnonymousApi, test } from './openzcad-fixtures';

/**
 * The 13 November design review's rail findings: one instrument order in
 * every mode, with Section on View's bar and X-ray in the Display menu
 * (I52); a display-mode toast that names the mode on screen however W is
 * pressed, and a saved view named in place (I54).
 */

async function openBracket(page: Page) {
  await stubAnonymousApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(
    page.getByRole('button', { name: 'Tweak', exact: true })
  ).toBeVisible({ timeout: 90_000 });
}

/** The accessible names of a rail's own buttons, in order. */
async function railNames(page: Page, toolbar: string) {
  return page
    .getByRole('toolbar', { name: toolbar })
    .locator('button:not([data-rail-flyout] button)')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label') ?? '')
    );
}

/** The instruments, in the order every rail keeps them. */
const INSTRUMENTS = [
  /^Measure$/,
  /^Fit view/,
  /^Toggle grid/,
  /^Orthographic projection/,
  /^Turntable orbit/,
  /^Section view/,
  /^Display mode/,
  /^Standard views$/
];

function instrumentOrder(names: string[]) {
  return INSTRUMENTS.map((pattern) =>
    names.findIndex((name) => pattern.test(name))
  );
}

test(
  'Build’s and View’s rails keep one order, and X-ray is in the Display menu',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await openBracket(page);

    const build = instrumentOrder(await railNames(page, 'Viewer bar'));
    expect(build.every((index) => index >= 0)).toBe(true);
    expect([...build].sort((a, b) => a - b)).toEqual(build);

    await page
      .getByRole('group', { name: 'Workspace mode' })
      .getByRole('button', { name: 'View' })
      .click();
    const bar = page.getByRole('toolbar', { name: 'View tools' });
    await expect(bar).toBeVisible();
    const names = await railNames(page, 'View tools');
    const view = instrumentOrder(names);
    expect(
      view.every((index) => index >= 0),
      names.join(' | ')
    ).toBe(true);
    expect([...view].sort((a, b) => a - b)).toEqual(view);

    // X-ray has a control on screen: the Display menu's switch.
    const display = bar.getByRole('button', { name: /^Display mode/ });
    await display.click();
    const menu = page.getByRole('group', { name: 'Display', exact: true });
    const xray = menu.getByRole('button', { name: /^X-ray/ });
    await expect(xray).toHaveAttribute('aria-pressed', 'false');
    await xray.click();
    await expect(xray).toHaveAttribute('aria-pressed', 'true');
    await expect(display).toHaveAttribute('aria-label', /X-ray$/);
    await menu.getByRole('button', { name: 'Wireframe' }).click();
    await expect(menu).toHaveCount(0);
    await expect(display).toHaveAttribute(
      'aria-label',
      /now: Wireframe · X-ray$/
    );

    // Section is on View's bar too, and its chip says the cut is on.
    const section = bar.getByRole('button', { name: /^Section view/ });
    await section.click();
    await expect(section).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByRole('group', { name: 'Section view on' })
    ).toBeVisible();
    await section.click();
    await expect(section).toHaveAttribute('aria-pressed', 'false');
  }
);

test('W names the mode the model shows, even pressed inside the toast’s dwell', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openBracket(page);
  const display = page.getByRole('button', { name: /^Display mode/ });
  const toast = page.locator('.workspace-toast:not(.hidden)');
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  // Spaced so the second press lands while the first toast holds and the
  // third after the second has taken over: paced, the toast then still
  // named the second mode while the model showed the third.
  for (let press = 0; press < 3; press += 1) {
    await page.keyboard.press('w');
    const now = /now: (.+)$/.exec(
      (await display.getAttribute('aria-label')) ?? ''
    )?.[1];
    expect(now).toBeTruthy();
    await expect(toast).toContainText(`Display: ${now}.`, { timeout: 500 });
    await page.waitForTimeout(700);
  }
});

test('a saved view is named in place, and its name never arms a tool', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openBracket(page);
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Standard views' })
    .click();
  await page.getByRole('button', { name: /Save view/ }).click();
  const name = page.getByRole('textbox', { name: /^Name View/ });
  await expect(name).toBeFocused();
  await page.keyboard.type('Side bolts');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Go to Side bolts' })
  ).toBeVisible();
  // S typed into the name armed Sketch before.
  await expect(
    page.getByText('Pick a sketch plane', { exact: true })
  ).toHaveCount(0);
  // A shortcut pressed with the flyout open puts it away.
  await page.getByRole('button', { name: 'Go to Side bolts' }).focus();
  await page.keyboard.press('g');
  await expect(
    page.getByRole('button', { name: 'Go to Side bolts' })
  ).toHaveCount(0);
});
