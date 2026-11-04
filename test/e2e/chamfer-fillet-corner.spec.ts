import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { GeometryBodyRepresentation } from '@openzcad/shared';
import {
  filletedCornerDocument,
  CORNER_CHAMFER_VOLUME
} from '../fixtures/chamfer-fillet-corner';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import {
  clickWorldPoint,
  enableFullRender,
  expect,
  expectBodyCount,
  setSelectionFilter,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

test(
  'three corner edges chamfer after earlier fillets through preview, Apply and saved replay',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const adapter = await createExactKernelAdapter();
    let backup: Buffer;
    try {
      const model = await filletedCornerDocument(adapter);
      backup = Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: model.document,
          files: []
        })
      );
    } finally {
      adapter.dispose();
    }
    await enableFullRender(page);
    await stubApi(page, { panelLayout: null });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Import project', exact: true })
      .click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'corner.openzcad',
      mimeType: 'application/json',
      buffer: backup
    });
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
    await page
      .getByRole('button', {
        name: 'Top front left isometric view',
        exact: true
      })
      .click();
    await page.getByRole('button', { name: 'Fit view (F)' }).click();
    await waitForStillViewport(page);
    await setSelectionFilter(page, 'Edge');
    await clickWorldPoint(page, [17.5, 0, 11.5]);
    await page.keyboard.down('Shift');
    try {
      await clickWorldPoint(page, [0, 20, 11.5]);
      await clickWorldPoint(page, [0, 0, 5.75]);
    } finally {
      await page.keyboard.up('Shift');
    }
    await expect(page.locator('.selection-readout')).toContainText('3 edges');
    await expect(page.locator('.selection-readout')).toContainText('86.5');
    const chip = page.locator('.selection-callout-chip');
    await chip
      .getByRole('button', { name: 'Selection: Chamfer', exact: true })
      .click();
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Distance value' });
    await keypad.getByRole('textbox').fill('1.0');
    const canvas = page.locator('.viewer-host canvas');
    await expect
      .poll(
        () =>
          canvas.evaluate(
            (element) =>
              new Promise<{ faces: number; cylinders: number }[]>((resolve) => {
                element.dispatchEvent(
                  new CustomEvent('openzcad:e2e-render-policy', {
                    detail: {
                      includeBodies: true,
                      resolve: ({
                        bodies
                      }: {
                        bodies: GeometryBodyRepresentation[];
                      }) =>
                        resolve(
                          bodies
                            .filter((body) => !body.consumed)
                            .map((body) => ({
                              faces: body.faceCount,
                              cylinders:
                                body.topology?.faces.filter(
                                  (face) =>
                                    face.geometry?.surfaceType === 'cylinder'
                                ).length ?? 0
                            }))
                        )
                    }
                  })
                );
              })
          ),
        { timeout: 60_000 }
      )
      .toEqual([{ faces: 12, cylinders: 2 }]);
    await expect(
      page.getByRole('heading', { name: 'History 2' })
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('corner-preview.png') });
    await keypad.getByRole('button', { name: 'Apply distance' }).click();
    const status = page.getByRole('contentinfo');
    await expect(status).toContainText('Chamfered 3 edges at 1 mm.');
    await expect(
      page.getByRole('heading', { name: 'History 3' })
    ).toBeVisible();
    await expect(status).toContainText('warnings0');
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
      timeout: 60_000
    });
    await expect(status).toContainText('warnings0');
    await waitForStillViewport(page);
    await page.screenshot({ path: testInfo.outputPath('corner-reopened.png') });
    const file = page.locator('details.file-menu');
    await file.locator('summary').click();
    const downloadPromise = page.waitForEvent('download');
    await file.getByRole('button', { name: /STEP/ }).click();
    const download = await downloadPromise;
    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream())
      chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    expect(bytes.toString()).toContain('CLOSED_SHELL');
    const kernel = new RemusKernel();
    try {
      const io = await loadRemusTranslators();
      const solids = kernel.deserializeSolids(io.importStep(bytes));
      expect(solids).toHaveLength(1);
      expect(kernel.validateSolidRelaxed(solids[0]!)).toBe(0);
      expect(kernel.volume(solids[0]!, 0.001)).toBeCloseTo(
        CORNER_CHAMFER_VOLUME,
        2
      );
    } finally {
      kernel.free();
    }
    expect(errors.filter((message) => !message.includes('404'))).toEqual([]);
  }
);
