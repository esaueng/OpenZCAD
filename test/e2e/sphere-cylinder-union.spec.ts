import {
  listFeaturesInOrder,
  withoutDerivedProjection
} from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { sphereCylinderUnionInputs } from '../support/sphere-cylinder-union';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  pickObjectsBody,
  finishInPlaceCommand
} from './openzcad-fixtures';

test(
  'unions an off-axis cylinder and sphere, then undoes, reopens and exports',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const { document } = sphereCylinderUnionInputs();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    await page.getByLabel('Project name').fill(document.name);
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'sphere-cylinder.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: withoutDerivedProjection(document),
          files: []
        })
      )
    });
    await expectBodyCount(page, 2);
    await page.getByRole('button', { name: /^Union \(U\)/ }).click();
    await pickObjectsBody(page, 'Sphere 1');
    await pickObjectsBody(page, 'Cylinder 1');
    const command = page.getByRole('group', { name: 'Union command' });
    await expect(command.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 30_000
    });
    await finishInPlaceCommand(page, 'Union');
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await page.screenshot({
      path: testInfo.outputPath('sphere-cylinder-union.png')
    });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectBodyCount(page, 2);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectBodyCount(page, 1);

    const menu = page.locator('details.file-menu');
    await menu.locator('summary').click();
    const backupPending = page.waitForEvent('download');
    await menu.getByRole('button', { name: /Export project/ }).click();
    const backup = await backupPending;
    const backupChunks: Buffer[] = [];
    for await (const chunk of await backup.createReadStream())
      backupChunks.push(chunk as Buffer);
    const saved = JSON.parse(Buffer.concat(backupChunks).toString('utf8')) as {
      document: ProjectDocument;
    };
    expect(listFeaturesInOrder(saved.document)).toHaveLength(6);
    expect(listFeaturesInOrder(saved.document).at(-1)?.featureKind).toBe(
      'boolean'
    );
    if ((await menu.getAttribute('open')) !== null)
      await menu.locator('summary').click();
    // Import the actual downloaded native backup, rather than only rebuilding
    // a synthetic in-memory document, and then check persistent restoration.
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'union-reopened.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.concat(backupChunks)
    });
    await expectBodyCount(page, 1);
    await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/);
    await page.reload();
    await expectBodyCount(page, 1);
    await menu.locator('summary').click();
    await expect(
      menu.getByRole('button', { name: /^Export STEP/ })
    ).toBeEnabled({ timeout: 120_000 });
    const stepPending = page.waitForEvent('download');
    await menu.getByRole('button', { name: /^Export STEP/ }).click();
    const download = await stepPending;
    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream())
      chunks.push(chunk as Buffer);
    const adapter = await createExactKernelAdapter();
    try {
      const inspection = await adapter.inspectStep(
        Buffer.concat(chunks).toString('utf8')
      );
      expect(inspection).toMatchObject({ solid: true, valid: true });
      expect(Math.abs(inspection.volume - 1669254.0582059103)).toBeLessThan(
        0.05
      );
    } finally {
      adapter.dispose();
    }
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    expect(errors).toEqual([]);
  }
);
