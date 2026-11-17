import type { ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  LOWER_RADIUS,
  OFFSET,
  UPPER_RADIUS,
  circle,
  stackedLoft
} from '../fixtures/stacked-loft';
import { expect, test, stubApi } from './openzcad-fixtures';

/**
 * OpenZCAD #1253: two laterally offset circles now loft exactly (one curved
 * wall between two circle rims), so the app says nothing about them. Section
 * stacks the pinned kernel still rebuilds from chords — Smooth through three
 * circles here — are named in Diagnostics, as faceted sweeps are.
 */
async function openProject(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Loft faceting');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Loft faceting');
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'loft.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: []
      })
    )
  });
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(document.name);
}

test('an offset two-circle loft is exact and raises no faceting advisory', async ({
  page
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { document } = stackedLoft(
    'smooth',
    [circle(LOWER_RADIUS), circle(UPPER_RADIUS, OFFSET)],
    'Offset circle loft'
  );
  await openProject(page, document);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Loft' })
  ).toBeVisible({
    timeout: 30_000
  });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 30_000
  });
  await expect(page.locator('.diagnostic-row')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('discloses a Smooth three-circle loft as chords in Diagnostics', async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { document } = stackedLoft(
    'smooth',
    [circle(LOWER_RADIUS), circle(UPPER_RADIUS, OFFSET), circle(20)],
    'Smooth circle stack'
  );
  await openProject(page, document);

  await expect(page.getByRole('contentinfo')).toContainText('warnings1', {
    timeout: 30_000
  });
  const row = page.locator('.diagnostic-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('This loft is a faceted approximation');
  await expect(row).toContainText('straight chords');
  await expect(row).toContainText('Its 34 faces');
  await expect(row).toContainText('Ruled keeps these circles exact');
  await testInfo.attach('faceted-loft-diagnostics', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  expect(errors).toEqual([]);
});
