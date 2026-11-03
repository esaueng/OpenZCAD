import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { rotationalSleeveStep } from '../support/rotational-sleeve';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  clickWorldPoint
} from './openzcad-fixtures';

async function selectWall(canvas: Locator, radius: number) {
  await canvas.evaluate(
    (element, radius) =>
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: { surface: 'wall', radius }
        })
      ),
    radius
  );
}

async function featureCount(page: Page, count: number) {
  await expect(
    page
      .getByRole('group', { name: 'Workspace status' })
      .getByLabel(new RegExp(` · ${count} features? · 1 body\\. Sync `))
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
}

test(
  'rotational wall drags and exact entries preserve the whole profile through cancel, undo and reload',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { document } = importStepBody(
      createProjectDocument('Rotational sleeve', toUserId('user_test')),
      {
        name: 'Sleeve',
        sourceName: 'rotational-sleeve.step',
        artifactId: 'sleeve',
        stepText: new TextDecoder().decode(await rotationalSleeveStep())
      }
    );
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Import project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'sleeve.openzcad',
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
    const canvas = page.locator('.viewer-host canvas');
    await featureCount(page, 1);
    const chip = page.getByTestId('direct-manipulation-value');
    await expect
      .poll(async () => {
        await selectWall(canvas, 11.5);
        return chip.innerText().catch(() => '');
      })
      .toContain('23');

    // Cancel a real drag, then repeat it and commit. Its exact preview must
    // resolve before release; the same selected wall keeps its handle.
    for (const cancel of [true, false]) {
      await selectWall(canvas, 11.5);
      await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
      const handle = await canvas.evaluate((element) => ({
        x: Number(element.dataset.e2eHandleX),
        y: Number(element.dataset.e2eHandleY),
        dx: Number(element.dataset.e2eHandleDx),
        dy: Number(element.dataset.e2eHandleDy),
        scale: Number(element.dataset.e2eHandlePixelsPerUnit)
      }));
      const rect = (await canvas.boundingBox())!;
      await page.mouse.move(rect.x + handle.x, rect.y + handle.y);
      await page.mouse.down();
      await page.keyboard.down('Shift');
      await page.mouse.move(
        rect.x + handle.x - 0.5 * handle.dx * handle.scale,
        rect.y + handle.y - 0.5 * handle.dy * handle.scale,
        { steps: 8 }
      );
      await expect
        .poll(async () =>
          parseFloat(
            await chip.getByRole('button', { name: /^Diameter / }).innerText()
          )
        )
        .toBeCloseTo(22, 2);
      await expect(chip).toHaveAttribute('aria-busy', 'false', {
        timeout: 30_000
      });
      await expect(chip).not.toHaveAttribute('data-state', 'warning');
      if (cancel) await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await featureCount(page, cancel ? 1 : 2);
    }
    for (const [radius, diameter, count] of [
      [11, 24, 2],
      [20, 39, 3],
      [16.5, 32, 4]
    ]) {
      await expect
        .poll(async () => {
          await selectWall(canvas, radius!);
          return chip.innerText().catch(() => '');
        })
        .toContain(String(radius! * 2));
      await chip.click();
      const pad = page.getByRole('dialog', { name: 'Diameter value' });
      await pad
        .getByRole('textbox', { name: 'Diameter', exact: true })
        .fill(String(diameter));
      await expect(chip).toHaveAttribute('aria-busy', 'false', {
        timeout: 30_000
      });
      await expect(chip).not.toHaveAttribute('data-state', 'warning');
      await pad.getByRole('button', { name: 'Apply diameter' }).click();
      await featureCount(page, count!);
    }

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Section view/ }).click();
    await page
      .getByRole('button', { name: 'Front (XZ plane)', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Flip cut direction', exact: true })
      .click();
    await expect
      .poll(async () => {
        await clickWorldPoint(page, [0, 0, 16.5]);
        return chip.innerText().catch(() => '');
      })
      .toContain('16.5');
    await chip.click();
    let pad = page.getByRole('dialog', { name: 'Total value' });
    await pad.getByRole('textbox').fill('30.5');
    await expect(chip).toHaveAttribute('aria-busy', 'false', {
      timeout: 30_000
    });
    await expect(chip).not.toHaveAttribute('data-state', 'warning');
    await pad.getByRole('button', { name: 'Apply total' }).click();
    await featureCount(page, 5);
    await page.keyboard.press('Escape');
    await canvas.evaluate((element) =>
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-planar-face', {
          detail: { normal: { x: 0, y: 0, z: -1 } }
        })
      )
    );
    await chip.click();
    pad = page.getByRole('dialog', { name: 'Total value' });
    // Total measures from the nearest opposing plane, the raised bore floor.
    await expect(pad).toBeVisible();
    await expect(pad.getByRole('textbox')).toHaveValue('30.5');
    await pad.getByRole('textbox').fill('31.5');
    await expect(chip).toHaveAttribute('aria-busy', 'false', {
      timeout: 30_000
    });
    await expect(chip).not.toHaveAttribute('data-state', 'warning');
    await pad.getByRole('button', { name: 'Apply total' }).click();
    await featureCount(page, 6);
    await chip.click();
    pad = page.getByRole('dialog', { name: 'Total value' });
    await pad.getByRole('textbox').fill('47.5');
    await expect(chip).toHaveAttribute('aria-busy', 'false', {
      timeout: 30_000
    });
    await expect(chip).toHaveAttribute('data-state', 'warning');
    await expect(
      page
        .getByText(
          'The conical end would collapse at that distance. Try a smaller offset.',
          { exact: true }
        )
        .first()
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await featureCount(page, 6);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await featureCount(page, 5);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await featureCount(page, 6);
    await expect(
      page.getByRole('group', { name: 'Workspace status' })
    ).not.toContainText('Saving');
    await page.reload();
    await featureCount(page, 6);

    const menu = page.locator('details.file-menu');
    await menu.locator('summary').click();
    const step = menu.getByRole('button', { name: /Export STEP/ });
    await expect(step).toBeEnabled({ timeout: 60_000 });
    const downloading = page.waitForEvent('download');
    await step.click();
    const download = await downloading;
    const kernel = new RemusKernel();
    try {
      const io = await loadRemusTranslators();
      const [solid] = kernel.deserializeSolids(
        io.importStep(await readFile(await download.path()))
      );
      expect(kernel.validateSolid(solid!)).toBe(0);
      expect(kernel.getSolidFaces(solid!).length).toBe(13);
      expect(kernel.getSolidEdges(solid!).length).toBe(22);
      expect(kernel.getSolidVertices(solid!).length).toBe(12);
      const cylinders = [...kernel.getSolidFaces(solid!)].filter(
        (face) => kernel.getSurfaceType(face) === 'cylinder'
      );
      expect(
        cylinders
          .map(
            (face) =>
              (
                JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
                  radius: number;
                }
              ).radius
          )
          .sort((a, b) => a - b)
      ).toEqual([12, 16, 19.5]);
      expect(kernel.boundingBox(solid!)[2]).toBeCloseTo(-1, 5);
    } finally {
      kernel.free();
    }
    expect(errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('rotational-edits.png')
    });
  }
);
