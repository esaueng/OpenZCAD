import { withoutDerivedProjection } from '@openzcad/document-core';
import {
  UNION_VOLUME,
  USABLE_UNION_STEP,
  inspectUnionStep,
  unionDocument,
  type Order
} from '../support/cad-004-union';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

/**
 * #1243 (CAD-004): the STEP file the app downloads for the Union of two
 * overlapping cylinders, in both union orders, committed and after a reload.
 *
 * `test/cylinder-union-step-seam.test.ts` holds the same property on the
 * adapter's export. This drives the real path a user's file takes: the
 * project is rebuilt from its history in the page's geometry worker and
 * File → Export STEP writes the download. Each download is kept in the
 * test's output folder, so it can be re-read in an outside STEP consumer.
 */
for (const order of ['AB', 'BA'] as const satisfies readonly Order[]) {
  test(`downloads a usable STEP of the ${order} cylinder Union, committed and reloaded`, async ({
    page
  }, testInfo) => {
    test.setTimeout(240_000);
    const { document } = unionDocument(order);
    const backup = Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: withoutDerivedProjection(document),
        files: []
      })
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page, { panelLayout: null });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    await page
      .getByRole('button', { name: 'Import project', exact: true })
      .click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: `union-${order}.openzcad`,
      mimeType: 'application/json',
      buffer: backup
    });
    const status = page.getByRole('contentinfo');
    await page
      .getByRole('button', { name: 'History panel', exact: true })
      .waitFor({ state: 'visible', timeout: 60_000 });
    // Two imported cylinders consumed by one Union: one body on screen.
    await expectBodyCount(page, 1);
    await expect(status).toContainText('warnings0');

    const download = async (name: string) => {
      const file = page.locator('details.file-menu');
      await file.locator('summary').click();
      const exportStep = file.getByRole('button', { name: /^Export STEP/ });
      await expect(exportStep).toBeEnabled({ timeout: 120_000 });
      const downloaded = page.waitForEvent('download');
      await exportStep.click();
      const saved = await downloaded;
      await saved.saveAs(testInfo.outputPath(name));
      const chunks: Buffer[] = [];
      for await (const chunk of await saved.createReadStream()) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString('utf8');
    };

    const committed = await download(`union-${order}-committed.step`);
    await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/);
    await page.reload();
    await page
      .getByRole('button', { name: 'History panel', exact: true })
      .waitFor({ state: 'visible', timeout: 60_000 });
    await expectBodyCount(page, 1);
    await expect(status).toContainText('warnings0');
    const reloaded = await download(`union-${order}-reloaded.step`);

    for (const step of [committed, reloaded]) {
      const inspection = await inspectUnionStep(step);
      expect(inspection).toMatchObject(USABLE_UNION_STEP);
      expect(inspection.volume).toBeCloseTo(UNION_VOLUME, 3);
    }
    expect(errors).toEqual([]);
  });
}
