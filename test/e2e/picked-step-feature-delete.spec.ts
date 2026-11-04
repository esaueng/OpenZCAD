import type { Page } from '@playwright/test';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { importedDetail } from '../fixtures/imported-detail';
import {
  expect,
  expectBodyCount,
  revealModelPanel,
  setSelectionFilter,
  stubAnonymousApi,
  test
} from './openzcad-fixtures';

async function openStep(page: Page, step: string) {
  await stubAnonymousApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('STEP removal');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel(/^Import STEP or /).setInputFiles({
    name: 'detail.step',
    mimeType: 'model/step',
    buffer: Buffer.from(step)
  });
  await expect(
    page
      .getByRole('group', { name: 'Workspace status' })
      .getByLabel(/ · \d+ features? · 1 body\. Sync /)
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Preparing model|Loading exact Remus kernel|Rebuilding|Starting geometry worker/,
    { timeout: 30_000 }
  );
  await revealModelPanel(page, 'History');
  await setSelectionFilter(page, 'Face');
}

test.describe('picked imported STEP deletion', { tag: '@ci-smoke' }, () => {
  for (const kind of ['hole', 'chamfer', 'fillet'] as const) {
    test(`Delete heals an imported ${kind} and preserves Undo, Redo and reload`, async ({
      page
    }, testInfo) => {
      test.setTimeout(120_000);
      const adapter = await createExactKernelAdapter();
      try {
        const fixture = await importedDetail(adapter, kind);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await openStep(page, fixture.step);
        const canvas = page.locator('.viewer-host canvas');
        await expect
          .poll(
            () =>
              canvas.evaluate(
                (element, detail) =>
                  new Promise<boolean>((resolve) => {
                    element.dispatchEvent(
                      new CustomEvent(detail.event, {
                        detail: {
                          ...detail.target,
                          resolve: (face: unknown) => resolve(face !== null)
                        }
                      })
                    );
                  }),
                kind === 'fillet'
                  ? {
                      event: 'openzcad:e2e-select-blend',
                      target: { select: true }
                    }
                  : kind === 'hole'
                    ? {
                        event: 'openzcad:e2e-select-cylinder',
                        target: { surface: 'wall', radius: 3 }
                      }
                    : {
                        event: 'openzcad:e2e-select-planar-face',
                        target: { normal: fixture.face.geometry!.normal }
                      }
              ),
            { timeout: 30_000 }
          )
          .toBe(true);
        await expect(
          page.getByRole('region', { name: /operation$/ })
        ).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath(`${kind}-selected.png`)
        });
        await page.keyboard.press(kind === 'chamfer' ? 'Backspace' : 'Delete');
        await expect(page.locator('.toast')).toContainText(
          'Removed the selected imported'
        );
        await expect(
          page.getByRole('heading', { name: 'History 2', exact: true })
        ).toBeVisible();
        await expectBodyCount(page, 1);
        await expect(page.locator('.feature-row').first()).not.toHaveClass(
          /failed/
        );
        await page.screenshot({
          path: testInfo.outputPath(`${kind}-removed.png`)
        });
        // Measure the actual UI download, independently of the visible toast.
        await page.locator('details.file-menu > summary').click();
        const download = page.waitForEvent('download');
        await page
          .getByRole('button', { name: 'Export STEP all bodies', exact: true })
          .click();
        const file = await download;
        const path = testInfo.outputPath(`${kind}-removed.step`);
        await file.saveAs(path);
        const { readFile } = await import('node:fs/promises');
        const exported = await adapter.inspectStep(
          await readFile(path, 'utf8')
        );
        expect(exported.valid).toBe(true);
        expect(exported.solid).toBe(true);
        expect(exported.volume).toBeCloseTo(12960, 5);
        await page.keyboard.press('ControlOrMeta+z');
        await expect(
          page.getByRole('heading', { name: 'History 1', exact: true })
        ).toBeVisible();
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect(
          page.getByRole('heading', { name: 'History 2', exact: true })
        ).toBeVisible();
        await page.keyboard.press('ControlOrMeta+s');
        await expect(
          page.getByRole('group', { name: 'Workspace status' })
        ).not.toContainText('Saving');
        await page.reload();
        await expectBodyCount(page, 1);
        await revealModelPanel(page, 'History');
        await expect(
          page.getByRole('heading', { name: 'History 2', exact: true })
        ).toBeVisible();
        expect(errors).toEqual([]);
      } finally {
        adapter.dispose();
      }
    });
  }

  test('Delete refuses an unsupported face without removing its STEP import', async ({
    page
  }) => {
    test.setTimeout(120_000);
    const adapter = await createExactKernelAdapter();
    const { step } = await importedDetail(adapter, 'hole');
    adapter.dispose();
    await openStep(page, step);
    const canvas = page.locator('.viewer-host canvas');
    await expect
      .poll(() =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-planar-face', {
                  detail: {
                    normal: { x: 0, y: 0, z: 1 },
                    resolve: (face: unknown) => resolve(face !== null)
                  }
                })
              );
            })
        )
      )
      .toBe(true);
    await expect(
      page.getByRole('region', { name: /operation$/ })
    ).toBeVisible();
    await page.keyboard.press('Delete');
    await expect(page.locator('.toast')).toContainText(
      /Removing|remove|only supports/
    );
    await expect(
      page.getByRole('heading', { name: 'History 1', exact: true })
    ).toBeVisible();
    await expectBodyCount(page, 1);
  });
});
