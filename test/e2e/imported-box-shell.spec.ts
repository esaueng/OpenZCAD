import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  bodyCardFromHistory,
  createPrimitiveInPlace,
  createShellInPlace
} from './openzcad-fixtures';

/**
 * #1247 (CAD-007): the production Shell command on an independent producer's
 * STEP box (three faces written against their plane) gives the same 2 mm
 * top-open shell as the native box at the same corner, 20 x 16 x 12 mm from
 * (-10, -8, -6): 3840 mm³ less a 16 x 12 x 10 open pocket.
 */
const OCCT_BOX_STEP = readFileSync(
  new URL('../fixtures/step/occt-box-20x16x12.step', import.meta.url)
);

async function openProject(page: Page, name: string, errors: string[]) {
  await stubApi(page);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // The stubbed API has no upload service for the imported source file
    // (as in cloud-sync.spec.ts); its 404 is expected, any other error fails.
    if (message.type() !== 'error') return;
    if (
      message.location().url.endsWith('/api/uploads') &&
      message.text().includes('404 (Not Found)')
    )
      return;
    errors.push(message.text());
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
}

async function expectOpenTopShell(page: Page) {
  await createShellInPlace(page, {
    normals: [{ x: 0, y: 0, z: 1 }],
    thickness: '2'
  });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Shell' })
  ).toBeVisible();
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  const inspector = await bodyCardFromHistory(page);
  await expect(inspector).toContainText('1920 mm³');
}

for (const source of ['imported', 'native'] as const) {
  // The native box shell already has smoke coverage in modeling.spec.ts; the
  // imported representation is the #1247 regression.
  const details = source === 'imported' ? { tag: '@ci-smoke' } : {};
  test(
    `shells the ${source} 20 x 16 x 12 box open at the top with a 2 mm wall`,
    details,
    async ({ page }) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      await openProject(page, `Shell ${source} box`, errors);
      if (source === 'imported') {
        await page.getByLabel(/^Import STEP or /).setInputFiles({
          name: 'occt-box-20x16x12.step',
          mimeType: 'application/step',
          buffer: OCCT_BOX_STEP
        });
      } else {
        await createPrimitiveInPlace(page, 'box', {
          sizes: { width: '20', depth: '16', height: '12' },
          at: { x: '-10', y: '-8', z: '-6' }
        });
      }
      await expectBodyCount(page, 1);
      const sourceCard = await bodyCardFromHistory(page);
      await expect(sourceCard).toContainText('3840 mm³');
      await page.keyboard.press('Escape');
      await expect(sourceCard).toHaveCount(0);
      await expectOpenTopShell(page);
      expect(errors).toEqual([]);
    }
  );
}
