import type { Page } from '@playwright/test';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

test('a remapped shortcut works, refuses a taken key by name and survives a reload', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'Keymap remap');
  const grid = page.getByRole('button', { name: /^Toggle grid/ });
  await expect(grid).toHaveAccessibleName('Toggle grid (G)');

  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Controls', exact: true }).click();
  const add = settings.getByRole('button', {
    name: 'Add a shortcut for Toggle the grid'
  });
  await add.click();
  // F is Fit view's: refused, with the holder named, and still listening.
  await page.keyboard.press('f');
  await expect(settings.getByRole('alert')).toHaveText(
    'F is already Fit view. Remove it there first.'
  );
  await page.keyboard.press('h');
  await settings
    .getByRole('button', { name: 'Remove G from Toggle the grid' })
    .click();
  await expect(
    settings.locator('[data-keymap-command="view-grid"] kbd')
  ).toHaveText(['H']);
  await page
    .getByRole('button', { name: /Back to workspace|Close settings/ })
    .first()
    .click();

  // Every surface that names the key names the new one.
  await expect(grid).toHaveAccessibleName('Toggle grid (H)');
  const before = await grid.getAttribute('aria-pressed');
  // G no longer toggles the grid and H does: one flip across both presses.
  await page.keyboard.press('g');
  await page.keyboard.press('h');
  await expect(grid).not.toHaveAttribute('aria-pressed', before ?? '');

  await page.reload();
  await expect(grid).toHaveAccessibleName('Toggle grid (H)', {
    timeout: 30_000
  });
  const reloaded = await grid.getAttribute('aria-pressed');
  // The command owns its key: a remap onto a chord the browser also uses
  // (Ctrl+P prints) must not do both, so the keydown is consumed.
  await page.evaluate(() => {
    window.addEventListener(
      'keydown',
      (event) => {
        (window as { lastKeyConsumed?: boolean }).lastKeyConsumed =
          event.defaultPrevented;
      },
      { once: true }
    );
  });
  await page.keyboard.press('h');
  await expect(grid).not.toHaveAttribute('aria-pressed', reloaded ?? '');
  expect(
    await page.evaluate(
      () => (window as { lastKeyConsumed?: boolean }).lastKeyConsumed
    )
  ).toBe(true);

  // The shortcut reference shows the live binding.
  await page.keyboard.press('?');
  const reference = page.getByRole('dialog', { name: 'Controls' });
  await expect(
    reference.locator('.shortcut-row', { hasText: 'Toggle the grid' })
  ).toContainText('H');
});

async function selectCylinderCap(page: Page, name: string) {
  await stubApi(page);
  await createProject(page, name);
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  const cylinder = page.locator('.feature-row-main', { hasText: 'Cylinder' });
  await expect(cylinder).toBeVisible();
  await cylinder.click();
  await page.locator('.viewer-host canvas').evaluate((element) => {
    element.dispatchEvent(
      new CustomEvent('openzcad:e2e-select-cylinder', {
        detail: { surface: 'cap' }
      })
    );
  });
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toBeVisible();
}

test('a second key for Normal to face works while a button has focus', async ({
  page
}) => {
  // Space yields to a focused button, which presses on it; a remapped key
  // has no such claim and must still turn the view.
  await page.addInitScript(() => {
    if (localStorage.getItem('openzcad-app-settings:v1')) return;
    localStorage.setItem(
      'openzcad-app-settings:v1',
      JSON.stringify({
        settings: {
          keymap: { overrides: { 'view-normal-to-face': ['Space', 'N'] } }
        },
        syncedRevision: null
      })
    );
  });
  await selectCylinderCap(page, 'Keymap normal');
  await page.getByRole('button', { name: /^Fit view/ }).focus();
  await page.keyboard.press('n');
  await expect(page.getByRole('contentinfo')).toContainText(
    'viewing normal to face'
  );
});

test('Space turns to the face from a number field that keeps focus', async ({
  page
}) => {
  // A number or expression field takes no spaces, so Space still reaches
  // Normal to face; only controls that use Space keep it.
  await selectCylinderCap(page, 'Keymap numeric');
  // No such field stays up after a face pick today, so one stands in: the
  // contract is the handler's, whichever field holds focus.
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'number';
    input.setAttribute('aria-label', 'Stand-in number field');
    document.body.append(input);
  });
  const field = page.getByRole('spinbutton', { name: 'Stand-in number field' });
  await field.focus();
  await expect(field).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('contentinfo')).toContainText(
    'viewing normal to face'
  );
});

test('Space bound to another command yields to a focused button', async ({
  page
}) => {
  // One key press, one action: with a button focused, Space presses it and
  // runs nothing else, whichever command the keymap gives Space to.
  await page.addInitScript(() => {
    if (localStorage.getItem('openzcad-app-settings:v1')) return;
    localStorage.setItem(
      'openzcad-app-settings:v1',
      JSON.stringify({
        settings: {
          keymap: {
            overrides: { 'view-normal-to-face': [], 'view-grid': ['Space'] }
          }
        },
        syncedRevision: null
      })
    );
  });
  await stubApi(page);
  await createProject(page, 'Keymap space');
  const grid = page.getByRole('button', { name: /^Toggle grid/ });
  await expect(grid).toHaveAccessibleName('Toggle grid (Space)');

  const before = await grid.getAttribute('aria-pressed');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('Space');
  await expect(grid).not.toHaveAttribute('aria-pressed', before ?? '');

  // Focused on the grid button itself: Space presses it once, so the grid
  // flips back exactly once rather than twice.
  const after = await grid.getAttribute('aria-pressed');
  await grid.focus();
  await page.keyboard.press('Space');
  await expect(grid).not.toHaveAttribute('aria-pressed', after ?? '');
});
