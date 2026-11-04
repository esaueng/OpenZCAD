import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { GeometryBodyRepresentation } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { roundedBlockDocument } from '../fixtures/chamfer-rounded-block';
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

function visibleFaceCounts(page: Page): Promise<number[]> {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              resolve: ({ bodies }: { bodies: GeometryBodyRepresentation[] }) =>
                resolve(
                  bodies
                    .filter((body) => !body.consumed)
                    .map((body) => body.faceCount)
                )
            }
          })
        );
      })
  );
}

for (const all of [false, true]) {
  test(
    `chamfers ${all ? 'all sharp edges' : 'an edge ending on a round'} and reopens the result`,
    { tag: '@ci-smoke' },
    async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const adapter = await createExactKernelAdapter();
      let backup: Buffer;
      try {
        const model = await roundedBlockDocument(adapter);
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
      await page
        .getByRole('button', { name: 'Import project', exact: true })
        .click();
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'rounded-block.openzcad',
        mimeType: 'application/json',
        buffer: backup
      });
      await expectBodyCount(page, 1);
      await expect.poll(() => visibleFaceCounts(page)).toEqual([13]);
      await page
        .getByRole('button', { name: 'History panel', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'History 3' })
      ).toBeVisible();
      await page
        .getByRole('button', {
          name: 'Top front left isometric view',
          exact: true
        })
        .click();
      await waitForStillViewport(page);
      await page
        .getByRole('button', {
          name: 'Top back left isometric view',
          exact: true
        })
        .click();
      await page.getByRole('button', { name: 'Fit view (F)' }).click();
      await waitForStillViewport(page);
      await setSelectionFilter(page, 'Edge');
      await clickWorldPoint(page, [0, 28, 10]);
      await expect(page.locator('.selection-readout')).toContainText('21');
      const chip = page.locator('.selection-callout-chip');
      await chip
        .getByRole('button', { name: 'Selection: Chamfer', exact: true })
        .click();
      const selectAll = chip.getByRole('button', {
        name: 'Select all 11 edges',
        exact: true
      });
      await expect(selectAll).toBeVisible();
      if (all) {
        await selectAll.click();
        await expect(page.locator('.selection-readout')).toContainText(
          '11 edges'
        );
      }
      await page.getByTestId('direct-manipulation-value').click();
      const keypad = page.getByRole('dialog', { name: 'Distance value' });
      await keypad.getByRole('textbox').fill('1');
      await expect
        .poll(() => visibleFaceCounts(page), { timeout: 60_000 })
        .toEqual([all ? 26 : 14]);
      await expect(
        keypad.getByRole('button', { name: 'Apply distance' })
      ).toBeEnabled({ timeout: 60_000 });
      await page.screenshot({
        path: testInfo.outputPath('chamfer-preview.png')
      });
      await keypad.getByRole('button', { name: 'Apply distance' }).click();
      await expect(
        page.getByRole('heading', { name: 'History 4' })
      ).toBeVisible();
      const status = page.getByRole('contentinfo');
      await expect(status).toContainText(
        all ? 'Chamfered 11 edges at 1 mm.' : 'Chamfered 1 edge at 1 mm.'
      );
      await expect(status).toContainText('warnings0');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(() => visibleFaceCounts(page)).toEqual([13]);
      await expect(
        page.getByRole('heading', { name: 'History 3' })
      ).toBeVisible();
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect.poll(() => visibleFaceCounts(page)).toEqual([all ? 26 : 14]);
      await expect(
        page.getByRole('heading', { name: 'History 4' })
      ).toBeVisible();
      await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/);
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'History 4' })
      ).toBeVisible({ timeout: 60_000 });
      await expect(status).toContainText('warnings0');
      await expect.poll(() => visibleFaceCounts(page)).toEqual([all ? 26 : 14]);
      await waitForStillViewport(page);
      await page.screenshot({
        path: testInfo.outputPath('chamfer-reopened.png')
      });
      expect(errors.filter((message) => !message.includes('404'))).toEqual([]);
    }
  );
}
