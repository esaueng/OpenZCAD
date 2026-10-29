import { readFile } from 'node:fs/promises';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

test.use({ screenshot: 'on' });

for (const width of [1440, 390]) {
  test(`downloads available projects and lists excluded cloud copies at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await stubApi(page);
    const owner = toUserId('user_e2e');
    const broken = createProjectDocument('Needs manual backup', owner);
    const good = createProjectDocument('Included project', owner);
    await page.route('**/api/account/export', (route) =>
      route.fulfill({ json: { profile: { userId: owner }, records: {} } })
    );
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        json: {
          projects: [broken, good].map((doc) => ({
            projectId: doc.projectId,
            name: doc.name,
            revisionCount: 0,
            updatedAt: new Date().toISOString()
          }))
        }
      })
    );
    await page.route(`**/api/projects/${broken.projectId}`, (route) =>
      route.fulfill({
        status: 503,
        json: { error: 'Project source file is unavailable.' }
      })
    );
    await page.route(`**/api/projects/${good.projectId}`, (route) =>
      route.fulfill({ json: good })
    );
    await page.route('**/api/projects/*/artifacts', (route) =>
      route.fulfill({ json: { artifacts: [] } })
    );
    await page.route('**/api/projects/*/revisions', (route) =>
      route.fulfill({ json: { revisions: [], maxRevisions: 50 } })
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page
      .getByRole('button', { name: 'Privacy & data', exact: true })
      .click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download all data' }).click();
    const download = await downloaded;
    const bytes = await readFile(await download.path());
    expect(
      bytes.includes(Buffer.from('projects/cloud/2/project.openzcad'))
    ).toBe(true);
    expect(
      bytes.includes(Buffer.from('projects/cloud/1/project.openzcad'))
    ).toBe(false);
    expect(bytes.includes(Buffer.from('NOT-INCLUDED.txt'))).toBe(true);
    expect(bytes.includes(Buffer.from(broken.name))).toBe(true);
    const list = page.getByRole('list', {
      name: 'Project backups not included'
    });
    await expect(list).toContainText(broken.name);
    await expect(list).toContainText(broken.projectId);
    await expect(list).toContainText('Project source file is unavailable.');
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: '1 project backup included; 1 skipped' })
    ).toBeVisible();
    await expect(page.getByText(/File → Export project/)).toBeVisible();
    await page.locator('.data-download').scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    expect(errors).toEqual([]);
  });

  test(`downloads local project data from Privacy & data at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await stubApi(page);
    // Signed-out exports must work without any account endpoints.
    await page.route('**/api/session', (route) =>
      route.fulfill({ status: 401, json: { error: 'Sign in required.' } })
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await createProject(page, 'Portable test project');
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page
      .getByRole('button', { name: 'Privacy & data', exact: true })
      .click();
    const originals = page.getByRole('checkbox', {
      name: 'Include original import files'
    });
    const recovery = page.getByRole('checkbox', {
      name: 'Include extra device recovery data'
    });
    await expect(originals).not.toBeChecked();
    await expect(recovery).toBeChecked();
    await recovery.uncheck();
    const button = page.getByRole('button', { name: 'Download all data' });
    await expect(button).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Privacy & data' })
    ).toBeVisible();
    const downloaded = page.waitForEvent('download');
    await button.click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toMatch(
      /^openzcad-data-\d{4}-\d{2}-\d{2}\.zip$/
    );
    const bytes = await readFile(await download.path());
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    // The archive uses ZIP stored entries; the full unzip/checksum/restore
    // assertions live in dataExport.test.ts.
    expect(bytes.includes(Buffer.from('projects/local/1.openzcad'))).toBe(true);
    expect(bytes.includes(Buffer.from('Portable test project'))).toBe(true);
    expect(bytes.includes(Buffer.from('"cloudIncluded":false'))).toBe(true);
    expect(bytes.includes(Buffer.from('device/database/'))).toBe(false);
    expect(bytes.includes(Buffer.from('"deviceSnapshotRequested":false'))).toBe(
      true
    );
    await expect(
      page.getByRole('status').filter({ hasText: 'download is ready' })
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}
