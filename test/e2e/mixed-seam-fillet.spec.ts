import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { mixedSeamFixture } from '../fixtures/mixed-seam';
import {
  clickWorldPoint,
  expect,
  revealModelPanel,
  setSelectionFilter,
  stubApi,
  test
} from './openzcad-fixtures';

test(
  'three adjoining mixed seam edges fillet with one history entry and one undo',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const adapter = await createExactKernelAdapter();
    const fixture = await mixedSeamFixture(adapter);
    adapter.dispose();
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    await page.getByLabel('Project name').fill('Mixed edge test');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'mixed-seam.openzcad',
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
    ).toContainText('Mixed seam fillet');
    await revealModelPanel(page, 'History');
    await expect(page.locator('.feature-row')).toHaveCount(4);
    const status = page.getByRole('contentinfo');
    await expect(status).not.toContainText(
      /Preparing model|Loading exact|Rebuilding|Waiting for exact/i,
      { timeout: 30_000 }
    );
    await setSelectionFilter(page, 'Edge');
    await clickWorldPoint(page, [
      6 * Math.cos(Math.PI / 12),
      6 * Math.sin(Math.PI / 12),
      26
    ]);
    await page.keyboard.down('Shift');
    await clickWorldPoint(page, [6, 0, 13]);
    await clickWorldPoint(page, [18, 0, 26]);
    await page.keyboard.up('Shift');
    await expect(
      page.getByRole('region', { name: 'Fillet operation' })
    ).toBeVisible();
    const chip = page.getByTestId('direct-manipulation-value');
    await expect(chip).toHaveText('R 0 mm');
    await chip.click();
    const keypad = page.getByRole('dialog', { name: 'Radius value' });
    await keypad.getByRole('textbox').fill('1');
    await keypad.getByRole('button', { name: 'Apply radius' }).click();
    await expect(status).toContainText('Filleted 3 edges at 1 mm.');
    await expect(status).not.toContainText(
      /Rebuilding|Waiting for exact|Loading exact/i,
      { timeout: 30_000 }
    );
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await revealModelPanel(page, 'History');
    await expect(page.locator('.feature-row')).toHaveCount(5);
    await expect(page.locator('.feature-row').last()).toContainText('Fillet');
    await expect(
      page.getByRole('alert').filter({ hasText: /could not|cannot/i })
    ).toHaveCount(0);
    await test.info().attach('three-edge-fillet', {
      body: await page.screenshot(),
      contentType: 'image/png'
    });
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.feature-row')).toHaveCount(4);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.locator('.feature-row')).toHaveCount(5);
    expect(errors).toEqual([]);
  }
);
