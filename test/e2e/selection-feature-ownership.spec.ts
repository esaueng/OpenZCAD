import type { Locator } from '@playwright/test';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { twoFilletCylinder } from '../fixtures/two-fillet-cylinder';
import { expect, test, stubApi, setSelectionFilter } from './openzcad-fixtures';
import { DEFAULT_APP_SETTINGS } from '@openzcad/shared';

function blend(canvas: Locator, radius: number, pixel = false) {
  return canvas.evaluate(
    (element, request) =>
      new Promise<{
        topologyId: string;
        blendRadius: number;
        producingFeatureId?: string;
        x?: number;
        y?: number;
      } | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-blend', {
            detail: {
              blendRadius: request.radius,
              inspectOnly: !request.pixel,
              select: false,
              resolve
            }
          })
        );
      }),
    { radius, pixel }
  );
}

for (const filter of ['Face', 'Any'] as const) {
  test(`clicking either blend with ${filter} selection edits its feature and preserves the other rim`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const adapter = await createExactKernelAdapter();
    const fixture = await twoFilletCylinder(adapter);
    adapter.dispose();
    await stubApi(page);
    await page.addInitScript((defaults) => {
      localStorage.setItem(
        'openzcad-app-settings:v1',
        JSON.stringify({
          ...defaults,
          experiments: { ...defaults.experiments, directManipulation: false }
        })
      );
    }, DEFAULT_APP_SETTINGS);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByLabel('Project name').fill('Selection fixture');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Selection fixture');
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'two-rims.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: fixture.document,
          files: []
        })
      )
    });
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Two rim fillets');
    const canvas = page.locator('.viewer-host canvas');
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    await expect
      .poll(async () => (await blend(canvas, 3))?.blendRadius, {
        timeout: 30_000
      })
      .toBe(3);
    await setSelectionFilter(page, filter);
    const topOwner = (await blend(canvas, 3))?.producingFeatureId;
    const bottomOwner = (await blend(canvas, 4))?.producingFeatureId;
    expect(topOwner).toBeTruthy();
    expect(bottomOwner).toBeTruthy();
    expect(topOwner).not.toBe(bottomOwner);
    async function clickBlend(
      radius: number,
      button: 'left' | 'right' = 'left'
    ) {
      const point = await blend(canvas, radius, true);
      expect(point?.x).toBeDefined();
      const bounds = await canvas.boundingBox();
      await page.mouse.click(bounds!.x + point!.x!, bounds!.y + point!.y!, {
        button
      });
    }
    await clickBlend(3);
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
      '3'
    );
    await expect(page.locator('.feature-row').nth(1)).toHaveClass(/selected/);
    if (filter === 'Face')
      await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
    await page.screenshot({
      path: `/tmp/openzcad-selection-top-${filter}.png`
    });
    await inspector.getByLabel('Radius', { exact: true }).fill('2');
    await inspector.getByRole('button', { name: /^Apply/ }).click();
    await expect
      .poll(async () => (await blend(canvas, 2))?.producingFeatureId, {
        timeout: 30_000
      })
      .toBe(topOwner);
    expect((await blend(canvas, 4))?.producingFeatureId).toBe(bottomOwner);
    await clickBlend(4);
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
      '4'
    );
    await expect(page.locator('.feature-row').nth(2)).toHaveClass(/selected/);
    await inspector.getByLabel('Radius', { exact: true }).fill('5');
    await inspector.getByRole('button', { name: /^Apply/ }).click();
    await expect
      .poll(async () => (await blend(canvas, 5))?.producingFeatureId, {
        timeout: 30_000
      })
      .toBe(bottomOwner);
    expect((await blend(canvas, 2))?.producingFeatureId).toBe(topOwner);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(async () => (await blend(canvas, 4))?.producingFeatureId)
      .toBe(bottomOwner);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect
      .poll(async () => (await blend(canvas, 5))?.producingFeatureId)
      .toBe(bottomOwner);
    await clickBlend(2);
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
      '2'
    );
    await page.screenshot({ path: '/tmp/openzcad-selection-top-fillet.png' });
    await clickBlend(5, 'right');
    await page.getByRole('menuitem', { name: /Delete Fillet edges/ }).click();
    await expect(page.locator('.feature-row')).toHaveCount(2);
    await expect
      .poll(async () => (await blend(canvas, 2))?.producingFeatureId)
      .toBe(topOwner);
    expect(await blend(canvas, 5)).toBeNull();
    expect(errors).toEqual([]);
  });
}
