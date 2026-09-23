import { expect, test } from '@playwright/test';
import { createProject, stubApi } from './openzcad-fixtures';

/*
  The quiet stage keeps the model browser (parameters, bodies, history) in a
  drawer on the right, closed until the instrument rail opens it. Every other
  spec runs with the drawer seeded open; this one covers the default and the
  rail's three buttons.
*/
test('the model drawer starts closed and opens from the rail on the named section', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, { modelDrawer: false });
  await createProject(page, 'Drawer check');

  const panels = page.getByRole('toolbar', { name: 'Model panels' });
  await expect(panels).toBeVisible({ timeout: 30_000 });
  const drawer = page.locator('.model-drawer-float');
  await expect(drawer).toHaveCount(0);

  // History opens the drawer on History, with the tree above it folded.
  const history = panels.getByRole('button', { name: 'History panel' });
  await history.click();
  await expect(drawer).toBeVisible();
  await expect(history).toHaveAttribute('aria-pressed', 'true');
  await expect(
    drawer.locator('.section-title', { hasText: 'History' })
  ).toHaveAttribute('aria-expanded', 'true');

  // Parameters on an open drawer switches the section instead of closing.
  const parameters = panels.getByRole('button', { name: 'Parameters panel' });
  await parameters.click();
  await expect(drawer).toBeVisible();
  await expect(parameters).toHaveAttribute('aria-pressed', 'true');
  await expect(history).toHaveAttribute('aria-pressed', 'false');
  await expect(
    drawer.getByRole('button', { name: 'Add parameter' })
  ).toBeVisible();

  // The drawer stops above the bottom-right corner: the cube stays reachable.
  const drawerBox = await drawer.boundingBox();
  const cubeBox = await page.locator('.viewer-rail-stack').boundingBox();
  expect(drawerBox!.y + drawerBox!.height).toBeLessThanOrEqual(cubeBox!.y);

  // Remembered per device, like every other chrome habit.
  await page.reload();
  await expect(page.locator('.model-drawer-float')).toBeVisible({
    timeout: 30_000
  });

  // The pressed button again closes it.
  await page
    .getByRole('toolbar', { name: 'Model panels' })
    .getByRole('button', { name: 'Parameters panel' })
    .click();
  await expect(page.locator('.model-drawer-float')).toHaveCount(0);
});
