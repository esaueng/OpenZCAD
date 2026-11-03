import { withoutDerivedProjection } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { chamferRoundedEdgeFixture } from '../fixtures/chamfer-rounded-edge';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import {
  test,
  expect,
  stubApi,
  clickWorldPoint,
  expectBodyCount,
  enableFullRender,
  setSelectionFilter,
  waitForStillViewport
} from './openzcad-fixtures';

test(
  'chamfers one edge ending on an earlier round, then undoes, redoes and reloads',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const adapter = await createExactKernelAdapter();
    let backup: Buffer;
    try {
      const fixture = await chamferRoundedEdgeFixture(adapter);
      backup = Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: withoutDerivedProjection(fixture.document),
          files: []
        })
      );
    } finally {
      adapter.dispose();
    }
    const errors: string[] = [];
    const failedRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) =>
      failedRequests.push(
        `${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`
      )
    );
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await enableFullRender(page);
    await stubApi(page, { panelLayout: null });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Import project', exact: true })
      .click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'rounded-edge.openzcad',
      mimeType: 'application/json',
      buffer: backup
    });
    const status = page.getByRole('contentinfo');
    await page
      .getByRole('button', { name: 'History panel', exact: true })
      .waitFor({ state: 'visible', timeout: 60_000 });
    await expectBodyCount(page, 1);
    await page
      .getByRole('button', { name: 'History panel', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'History 2' })
    ).toBeVisible();
    await expect(status).toContainText('warnings0');
    await page.getByRole('button', { name: 'Front view', exact: true }).click();
    await page.getByRole('button', { name: 'Fit view (F)' }).click();
    await waitForStillViewport(page);
    await setSelectionFilter(page, 'Edge');
    await clickWorldPoint(page, [17.5, 0, 0]);
    const chip = page.locator('.selection-callout-chip');
    await expect(chip).toHaveAttribute('aria-label', 'Fillet operation');
    await chip
      .getByRole('button', { name: 'Selection: Chamfer', exact: true })
      .click();
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Distance value' });
    await keypad.getByRole('textbox').fill('2.1');
    await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
      'C 2.1 mm'
    );
    await expect(status).not.toContainText('could not be created');
    await keypad.getByRole('button', { name: 'Apply distance' }).click();
    await expect(
      page.getByRole('heading', { name: 'History 3' })
    ).toBeVisible();
    await expect(status).toContainText('warnings0');
    await page.screenshot({
      path: testInfo.outputPath('single-edge-chamfer-applied.png')
    });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'History 2' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'History 3' })
    ).toBeVisible();
    await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'History 3' })).toBeVisible({
      timeout: 30_000
    });
    const file = page.locator('details.file-menu');
    await file.locator('summary').click();
    await expect(
      file.getByRole('button', { name: /^Export STEP/ })
    ).toBeEnabled({ timeout: 120_000 });
    const downloaded = page.waitForEvent('download');
    await file.getByRole('button', { name: /^Export STEP/ }).click();
    const download = await downloaded;
    await download.saveAs(testInfo.outputPath('single-edge-chamfer.step'));
    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream()) {
      chunks.push(chunk as Buffer);
    }
    const kernel = new RemusKernel();
    try {
      const io = await loadRemusTranslators();
      const solids = kernel.deserializeSolids(
        io.importStep(Buffer.concat(chunks))
      );
      expect(solids).toHaveLength(1);
      expect(kernel.validateSolidRelaxed(solids[0]!)).toBe(0);
      expect(kernel.volume(solids[0]!, 0.001)).toBeCloseTo(
        16890.08688644507,
        2
      );
      expect(
        Array.from(kernel.getSolidFaces(solids[0]!)).filter(
          (face) => kernel.getSurfaceType(face) === 'cylinder'
        )
      ).toHaveLength(2);
    } finally {
      kernel.free();
    }
    await page.keyboard.press('Escape');
    await expect(status).toContainText('warnings0');
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Bottom front left isometric view',
        exact: true
      })
      .click();
    await page.getByRole('button', { name: 'Fit view (F)' }).click();
    await waitForStillViewport(page);
    await page.screenshot({
      path: testInfo.outputPath('single-edge-chamfer-reloaded.png')
    });
    expect(errors).toEqual([]);
    expect(failedRequests).toEqual([]);
  }
);
