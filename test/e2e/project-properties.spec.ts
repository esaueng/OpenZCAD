import {
  test,
  expect,
  createProject,
  expectBodyCount,
  stubApi
} from './openzcad-fixtures';
import type { Page } from '@playwright/test';

async function savedDocument(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openzcad-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('Local storage read failed.'));
    });
    try {
      return await new Promise<string>((resolve, reject) => {
        const request = db
          .transaction('projects')
          .objectStore('projects')
          .getAll();
        request.onsuccess = () => resolve(JSON.stringify(request.result));
        request.onerror = () =>
          reject(request.error ?? new Error('Local storage read failed.'));
      });
    } finally {
      db.close();
    }
  });
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`properties reports a saved model without opening or modifying it at ${viewport.width}px`, async ({
    page
  }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await createProject(page, 'Properties bracket');
    await page.getByRole('button', { name: /^Box \(B\)/ }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();
    await expectBodyCount(page, 1);
    await page.getByTitle('Back to projects').click();
    const before = await savedDocument(page);
    const actions = page.getByRole('button', {
      name: 'Actions for Properties bracket'
    });
    await actions.click();
    await page
      .getByRole('menuitem', { name: 'Properties', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Project properties' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText('Loading project details…')
    ).not.toBeVisible();
    await expect(
      dialog.getByText('Project data size', { exact: true }).locator('..')
    ).toContainText(/\d.*(?:B|KiB|MiB)/);
    await expect(
      dialog.getByText('Bodies', { exact: true }).locator('..')
    ).toContainText('1');
    await expect(
      dialog.getByText('Features', { exact: true }).locator('..')
    ).toContainText('1');
    await expect(
      dialog.getByText('First recorded save', { exact: true }).locator('..')
    ).not.toContainText('Not recorded');
    await expect(dialog.getByText('Millimeters (mm)')).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await page.title()).toContain('OpenZCAD');
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(await savedDocument(page)).toBe(before);
    await page.keyboard.press('Tab');
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement)
      )
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(actions).toBeFocused();
    await expect(page.locator('.start-screen')).toBeVisible();
    expect(errors).toEqual([]);
  });
}
