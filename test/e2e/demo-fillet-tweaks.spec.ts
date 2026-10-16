import type { Page } from '@playwright/test';
import type { ProjectDocument } from '@openzcad/shared';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';

async function savedExpression(page: Page, name: string) {
  return page.evaluate(async (parameterName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openzcad-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB request failed'));
    });
    try {
      const documents = await new Promise<ProjectDocument[]>(
        (resolve, reject) => {
          const request = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          request.onsuccess = () =>
            resolve(request.result as ProjectDocument[]);
          request.onerror = () =>
            reject(request.error ?? new Error('IndexedDB request failed'));
        }
      );
      const bracket = documents.find(
        (document) => document.projectId === 'proj_demo_mounting_bracket'
      );
      const node = Object.values(bracket?.nodes ?? {}).find(
        (candidate) =>
          candidate.kind === 'parameter' && candidate.name === parameterName
      );
      return node?.kind === 'parameter' ? node.expression : undefined;
    } finally {
      db.close();
    }
  }, name);
}

for (const [name, value, original] of [
  ['wall_h', '26', '32'],
  ['boss_r', '14', '10']
]) {
  test(`the bracket keeps its radius-3 fillets with ${name} = ${value}`, async ({
    page
  }, testInfo) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/');
    await page
      .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
      .click();
    await expectBodyCount(page, 1);
    await page.getByRole('button', { name: 'Tweak', exact: true }).click();
    const input = page.getByLabel(`Expression for ${name}`, { exact: true });
    await input.fill(value!);
    await input.press('Enter');
    await expect
      .poll(() => savedExpression(page, name!), { timeout: 30_000 })
      .toBe(value);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Export STEP/ })
    ).toBeEnabled();

    await page.reload();
    await expect(input).toHaveValue(value!);
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
      timeout: 30_000
    });
    await page.getByRole('button', { name: 'Build', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(input).toHaveValue(original!);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(input).toHaveValue(value!);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');

    await page
      .locator('.feature-row-main', { hasText: 'Wall top edge break' })
      .click();
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    await expect(inspector.locator('.selection-summary')).toContainText(
      '2 edges selected'
    );
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
      'fillet_r'
    );
    await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
      'data-e2e-focus-faces',
      '2',
      { timeout: 30_000 }
    );
    await expect(page).toHaveTitle(/OpenZCAD/);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await testInfo.attach(`${name}-fillets`, {
      body: await page.screenshot(),
      contentType: 'image/png'
    });
    expect(errors).toEqual([]);
  });
}
