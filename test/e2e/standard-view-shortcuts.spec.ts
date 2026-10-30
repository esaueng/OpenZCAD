import type { Locator, Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

async function createViewProject(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('toolbar', { name: 'Viewer bar' })).toBeVisible({
    timeout: 30_000
  });
}

interface CameraPose {
  position: number[];
  target: number[];
}

async function expectDirection(
  canvas: Locator,
  expected: readonly [number, number, number]
) {
  await expect
    .poll(async () => {
      const camera = await canvas.evaluate(
        (element) =>
          new Promise<CameraPose>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-input-state', {
                detail: {
                  resolve: (state: { camera: CameraPose }) =>
                    resolve(state.camera)
                }
              })
            );
          })
      );
      const offset = camera.position.map(
        (coordinate, axis) => coordinate - camera.target[axis]!
      );
      return (
        offset.reduce(
          (dot, coordinate, axis) => dot + coordinate * expected[axis]!,
          0
        ) /
        (Math.hypot(...offset) * Math.hypot(...expected))
      );
    })
    .toBeGreaterThan(0.999_999);
}

const STANDARD_VIEWS = [
  { key: '1', label: 'Front view', direction: [0, -1, 0] },
  { key: '2', label: 'Top view', direction: [0, -0.0001, 1] },
  { key: '3', label: 'Right view', direction: [1, 0, 0] },
  { key: '4', label: 'Isometric view', direction: [1, -1, 0.9] },
  { key: '5', label: 'Back view', direction: [0, 1, 0] },
  { key: '6', label: 'Bottom view', direction: [0, 0.0001, -1] },
  { key: '7', label: 'Left view', direction: [-1, 0, 0] }
] as const;

test('all seven standard views agree between keyboard and command palette', async ({
  page
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await stubApi(page);
  await createViewProject(page, 'Seven standard views');
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-camera-distance', /.+/, {
    timeout: 30_000
  });
  const prompt = page.getByRole('combobox', { name: 'Search commands' });

  for (const view of STANDARD_VIEWS) {
    // Put the camera elsewhere first so every shortcut proves a change,
    // including the initial default Isometric direction.
    await page.keyboard.press(view.key === '1' ? '4' : '1');
    await expectDirection(canvas, view.key === '1' ? [1, -1, 0.9] : [0, -1, 0]);
    await page.keyboard.press(view.key);
    await expectDirection(canvas, view.direction);

    // The same named command advertises its live key and reaches the same
    // camera direction. Focused text keeps number keys as text entry.
    await page.keyboard.press(view.key === '1' ? '4' : '1');
    await expectDirection(canvas, view.key === '1' ? [1, -1, 0.9] : [0, -1, 0]);
    await prompt.fill(`/${view.label}`);
    const command = page.getByRole('option', {
      name: new RegExp(`^${view.label}`)
    });
    await expect(command.locator('kbd')).toHaveText(view.key);
    await command.click();
    await expectDirection(canvas, view.direction);
    await expect(prompt).not.toBeFocused();
  }

  await page
    .getByRole('button', { name: 'Standard views', exact: true })
    .click();
  const flyout = page.getByRole('group', {
    name: 'Standard views',
    exact: true
  });
  for (const view of STANDARD_VIEWS) {
    await expect(
      flyout.getByRole('button', {
        name: `${view.label} (${view.key})`,
        exact: true
      })
    ).toBeVisible();
  }
  await page.keyboard.press('Escape');

  await page.keyboard.press('?');
  const controls = page.getByRole('dialog', { name: 'Controls' });
  for (const view of STANDARD_VIEWS) {
    await expect(
      controls.locator('.shortcut-row', { hasText: view.label }).locator('kbd')
    ).toHaveText(view.key);
  }
  expect(errors).toEqual([]);
});

test('a remapped back-view key reaches the same view after reopen', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createViewProject(page, 'Remapped standard view');
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-camera-distance', /.+/, {
    timeout: 30_000
  });
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Controls', exact: true }).click();
  await settings
    .getByRole('button', { name: 'Add a shortcut for Back view' })
    .click();
  await page.keyboard.press('8');
  await settings
    .getByRole('button', { name: 'Remove 5 from Back view' })
    .click();
  await page
    .getByRole('button', { name: /Back to workspace|Close settings/ })
    .first()
    .click();

  await page.keyboard.press('1');
  await expectDirection(canvas, [0, -1, 0]);
  await page.keyboard.press('8');
  await expectDirection(canvas, [0, 1, 0]);

  await page.reload();
  await expect(canvas).toHaveAttribute('data-e2e-camera-distance', /.+/, {
    timeout: 30_000
  });
  // The canvas prepares offscreen before the coordinated workspace reveal.
  await expect(canvas).toBeVisible();
  await page.keyboard.press('1');
  await expectDirection(canvas, [0, -1, 0]);
  await page.keyboard.press('8');
  await expectDirection(canvas, [0, 1, 0]);

  const prompt = page.getByRole('combobox', { name: 'Search commands' });
  await page
    .getByRole('button', { name: 'Standard views', exact: true })
    .click();
  const backTile = page
    .getByRole('group', { name: 'Standard views', exact: true })
    .getByRole('button', { name: 'Back view (8)', exact: true });
  await expect(backTile).toBeVisible();
  await backTile.click();
  await expectDirection(canvas, [0, 1, 0]);

  await prompt.fill('/Back view');
  await expect(
    page.getByRole('option', { name: /^Back view/ }).locator('kbd')
  ).toHaveText('8');
  await prompt.press('Escape');
  await page.keyboard.press('?');
  await expect(
    page
      .getByRole('dialog', { name: 'Controls' })
      .locator('.shortcut-row', { hasText: 'Back view' })
      .locator('kbd')
  ).toHaveText('8');
});

test('saved shortcuts keep keys claimed by newly added standard views', async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem(
      'openzcad-app-settings:v1',
      JSON.stringify({
        settings: {
          keymap: { overrides: { 'view-grid': ['5'], 'tool-extrude': ['6'] } }
        },
        syncedRevision: null
      })
    );
  });
  await stubApi(page);
  await createViewProject(page, 'Existing saved shortcuts');
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-camera-distance', /.+/, {
    timeout: 30_000
  });
  const grid = page.getByRole('button', {
    name: 'Toggle grid (5)',
    exact: true
  });
  const before = await grid.getAttribute('aria-pressed');
  await page.keyboard.press('5');
  await expect(grid).not.toHaveAttribute('aria-pressed', before ?? '');
  await expectDirection(canvas, [1, -1, 0.9]);

  await page
    .getByRole('button', { name: 'Standard views', exact: true })
    .click();
  const flyout = page.getByRole('group', {
    name: 'Standard views',
    exact: true
  });
  await expect(
    flyout
      .getByRole('button', { name: 'Back view', exact: true })
      .locator('kbd')
  ).toHaveCount(0);
  await expect(
    flyout
      .getByRole('button', { name: 'Bottom view', exact: true })
      .locator('kbd')
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  const prompt = page.getByRole('combobox', { name: 'Search commands' });
  await prompt.fill('/Back view');
  await expect(
    page.getByRole('option', { name: /^Back view/ }).locator('kbd')
  ).toHaveCount(0);
});
