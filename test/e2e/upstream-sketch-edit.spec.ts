import { CommandManager } from '@openzcad/command-system';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  loftedHollowDuct,
  upperDuctSectionEdit
} from '../fixtures/lofted-hollow-duct';
import {
  expect,
  test,
  stubApi,
  bodyCardFromHistory
} from './openzcad-fixtures';

/**
 * Production QA CAD-002 (2026-10-11): narrowing a shelled loft's upper section
 * from History committed, the shell lost its top opening, and the solid loft
 * was drawn, saved and exported to STEP as the design. The edit must now be
 * refused with the last valid model kept, and a document already in that
 * failed state must not offer the stand-in body for export.
 */
async function importProject(page: Page, document: ProjectDocument) {
  await page.getByLabel('Import project backup').setInputFiles({
    name: `${document.name}.openzcad`,
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

async function createProject(page: Page, name: string) {
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(name);
  // Importing over a project that is still being created races its save.
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
}

/** The card of the body the last History row built. */
async function bodyReadout(page: Page) {
  const inspector = await bodyCardFromHistory(page);
  await expect(inspector.getByText(/mm³/).first()).toBeVisible();
  return inspector;
}

async function openFileMenu(page: Page) {
  const menu = page.locator('details.file-menu');
  if ((await menu.getAttribute('open')) === null)
    await menu.locator('summary').click();
  return menu;
}

test('refuses an upstream section edit that strands a dependent shell, and keeps the hollow duct', async ({
  page
}, testInfo) => {
  test.setTimeout(150_000);
  const adapter = await createExactKernelAdapter();
  let hollow: ProjectDocument;
  try {
    hollow = (await loftedHollowDuct(adapter, { name: 'QA hollow duct' }))
      .document;
  } finally {
    adapter.dispose();
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await createProject(page, 'Upstream edit');
  await importProject(page, hollow);
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('warnings0', { timeout: 30_000 });

  let inspector = await bodyReadout(page);
  await expect(inspector).toContainText('12630.86 mm³');

  // History: the upper section's Width 40 → 30, then Apply.
  await page
    .locator('.feature-row-main', { hasText: 'Upper duct section' })
    .click();
  inspector = page.getByRole('region', { name: 'Feature inspector' });
  const width = inspector.getByLabel('Width', { exact: true });
  await expect(width).toHaveValue('40');
  await width.fill('30');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();

  // Refused, naming the feature that cannot rebuild; the card stays open
  // with the typed value so the user can change it.
  await expect(inspector.getByRole('alert')).toContainText('no longer exists', {
    timeout: 60_000
  });
  await expect(width).toHaveValue('30');
  await testInfo.attach('refused-section-edit', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  await expect(status).toContainText('warnings0');
  // History names the feature that could not rebuild and offers to open it.
  const details = page.getByRole('region', { name: 'History details' });
  await expect(details.getByRole('alert')).toContainText(
    'The previous model is intact'
  );
  await expect(
    details.getByRole('button', { name: 'Edit Open-ended duct wall' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  inspector = await bodyReadout(page);
  await expect(inspector).toContainText('12630.86 mm³');
  await expect(inspector).toContainText(/faces\s*10/);

  // Nothing reached history: a reload reopens the hollow duct.
  await page.reload();
  await expect(status).toContainText('warnings0', { timeout: 30_000 });
  inspector = await bodyReadout(page);
  await expect(inspector).toContainText('12630.86 mm³');

  // The hollow body exports; the STEP holds its ten faces, not six.
  const menu = await openFileMenu(page);
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await menu.getByRole('button', { name: /Export STEP/ }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const step = Buffer.concat(chunks).toString('utf8');
  expect(step.match(/ADVANCED_FACE\(/g)).toHaveLength(10);
  expect(errors).toEqual([]);
});

test('does not export the stand-in body of a shell that already failed', async ({
  page
}) => {
  test.setTimeout(150_000);
  const adapter = await createExactKernelAdapter();
  let failed: ProjectDocument;
  try {
    const hollow = (
      await loftedHollowDuct(adapter, { name: 'QA failed shell' })
    ).document;
    // A document saved in the failed state, as the QA run's was.
    const manager = new CommandManager(hollow);
    manager.runTransaction(
      'Edit Upper duct section',
      upperDuctSectionEdit(hollow, 30)
    );
    failed = manager.document;
  } finally {
    adapter.dispose();
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await createProject(page, 'Failed shell');
  await importProject(page, failed);
  await expect(page.getByRole('contentinfo')).toContainText('warnings1', {
    timeout: 30_000
  });

  const menu = await openFileMenu(page);
  const note = menu.getByRole('note');
  await expect(note).toContainText('not exported');
  await expect(note).toContainText('“Open-ended duct wall” failed to rebuild');
  await expect(
    menu.getByRole('button', { name: /Export STEP/ })
  ).toBeDisabled();
  await expect(
    menu.getByRole('button', { name: /Export mesh/ })
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
