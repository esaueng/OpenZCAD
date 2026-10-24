import type { ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { elbowPath, roundProfile, sweptAlong } from '../fixtures/swept-elbow';
import {
  expect,
  test,
  stubApi,
  bodyCardFromHistory
} from './openzcad-fixtures';

/**
 * Production QA CAD-003 (2026-10-11): a round profile swept 270° along an arc
 * came back as 902 flat facets, in Standard and Smooth alike, and the UI
 * showed no warnings. The body is unchanged; Diagnostics now names it a
 * faceted approximation with the measured cap shortfall, and the Sweep card
 * says what Smooth does and does not do.
 */
async function openProject(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('QA sweep facets');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('QA sweep facets');
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'swept-elbow.openzcad',
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

test('discloses a faceted round sweep in Diagnostics and explains Smooth', async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { document } = sweptAlong(
    roundProfile(3),
    elbowPath,
    'smooth',
    'QA swept elbow'
  );
  await openProject(page, document);

  await expect(page.getByRole('contentinfo')).toContainText('warnings1', {
    timeout: 30_000
  });
  const row = page.locator('.diagnostic-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('This sweep is a faceted approximation');
  await expect(row).toContainText('straight chords');
  await expect(row).not.toContainText('end caps measure');
  await expect(row).toContainText('Its 902 faces');
  await expect(row).toContainText('this path is built from 3 edges');
  await testInfo.attach('faceted-sweep-diagnostics', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });

  // Disclosure only: the body is still the one the QA run measured.
  const inspector = await bodyCardFromHistory(page);
  await expect(inspector).toContainText('3910.71 mm³');
  await page.keyboard.press('Escape');

  // The Sweep card says what Smooth does.
  await page.locator('.feature-row-main', { hasText: 'Bend' }).click();
  await expect(inspector.getByLabel('Surface mode')).toHaveValue('smooth');
  await expect(inspector).toContainText(
    'It does not make exact curved surfaces'
  );
  expect(errors).toEqual([]);
});
