import type { Page } from '@playwright/test';
import { test, expect, enableFullRender, stubApi } from './openzcad-fixtures';

/**
 * E2E builds draw without antialiasing, shadows or the environment map
 * (viewer/renderProfile.ts), and render-contract specs opt back in with
 * `enableFullRender`. Antialiasing is the one choice the page can read back,
 * so it stands in for the profile: if the opt-in stopped reaching the
 * viewer, those specs would quietly test the cheap renderer instead.
 */
async function viewerAntialias(page: Page) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Render profile');
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible();
  return canvas.evaluate(
    (element) =>
      (element as HTMLCanvasElement)
        .getContext('webgl2')
        ?.getContextAttributes()?.antialias
  );
}

test('the e2e build renders the viewer without antialiasing by default', async ({
  page
}) => {
  expect(await viewerAntialias(page)).toBe(false);
});

test('enableFullRender restores the production renderer', async ({ page }) => {
  await enableFullRender(page);
  expect(await viewerAntialias(page)).toBe(true);
});
