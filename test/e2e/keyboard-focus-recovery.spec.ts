import type { Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * Keyboard recovery found by production QA (2026-10-29):
 * - F004: drawing on the sketch canvas left focus on the toolbar tile last
 *   tabbed to, so Enter pressed that tile and switched the sketch tool.
 * - F012: Escape did not close the Controls sheet, though the sheet itself
 *   lists Escape as "Close the active dialog".
 * - F010: command search could turn a section cut on in View mode, which
 *   has no instrument rail, leaving nothing that showed or ended the cut.
 */

async function createProject(page: Page, name: string) {
  page.setDefaultTimeout(15_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('button', { name: /^Sketch \(S\)/ })
  ).toBeVisible();
}

test('a canvas press takes focus off a tabbed-to sketch tile, so Enter keeps the tool', { tag: '@ci-smoke' }, async ({
  page
}) => {
  await createProject(page, 'Sketch focus');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const tools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(tools).toBeVisible();
  const line = tools.getByRole('button', { name: 'Line', exact: true });
  const arc = tools.getByRole('button', { name: 'Arc', exact: true });
  await expect(line).toHaveAttribute('aria-pressed', 'true');

  // Keyboard focus parked on another tile, as Tab leaves it.
  await arc.focus();
  await expect(arc).toBeFocused();

  const bounds = (await page.locator('.viewer-host canvas').boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width * 0.4,
    bounds.y + bounds.height * 0.5
  );
  await expect(arc).not.toBeFocused();
  await page.mouse.click(
    bounds.x + bounds.width * 0.55,
    bounds.y + bounds.height * 0.5
  );
  await page.keyboard.press('Enter');

  await expect(line).toHaveAttribute('aria-pressed', 'true');
  await expect(arc).not.toHaveAttribute('aria-pressed', 'true');
});

test('Escape closes the Controls sheet, with focus on Close or in the list', { tag: '@ci-smoke' }, async ({
  page
}) => {
  await createProject(page, 'Controls sheet');
  const controls = page.getByRole('dialog', { name: 'Controls', exact: true });

  await page.keyboard.press('?');
  await expect(controls).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(controls).toHaveCount(0);

  // Focus inside the sheet, as Tab leaves it, still closes on Escape.
  await page.keyboard.press('?');
  await expect(controls).toBeVisible();
  await controls.getByRole('region', { name: 'Controls list' }).focus();
  await page.keyboard.press('Escape');
  await expect(controls).toHaveCount(0);
});

test('a cut turned on from command search in View mode shows there and turns off', { tag: '@ci-smoke' }, async ({
  page
}) => {
  await createProject(page, 'View section');
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: 'View' })
    .click();

  const section = page.getByRole('group', { name: 'Section view' });
  await expect(section).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Search commands' })
    .fill('/Section view');
  await page.keyboard.press('Enter');
  await expect(section).toBeVisible();
  await expect(section).toContainText('XY plane');

  await section.getByRole('button', { name: 'Turn off' }).click();
  await expect(section).toHaveCount(0);
});
