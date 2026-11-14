import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

test(
  'offers supported CAD formats and refuses a removed archive format without changing the model',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    const errors: string[] = [];
    const converterRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/occt|freecad/i.test(new URL(request.url()).pathname)) {
        converterRequests.push(request.url());
      }
    });
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveTitle(/OpenZCAD/);
    await page.getByLabel('Project name').fill('Supported import formats');
    await page.getByRole('button', { name: 'New project' }).click();
    await expectBodyCount(page, 0);
    const picker = page.getByLabel('Import STEP or a mesh file…');
    const pickers = page.locator('input[type="file"][accept*=".step"]');
    await expect(pickers).toHaveCount(2);
    for (const input of await pickers.all()) {
      await expect(input).toHaveAttribute(
        'accept',
        '.shapr,.stl,.step,.stp,.3mf,.obj,.glb,.ply,.dxf'
      );
    }
    await picker.setInputFiles({
      name: 'unsupported.FCStd',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('unsupported archive')
    });
    await expect(page.getByRole('contentinfo')).toContainText(
      'OpenZCAD can’t import .FCStd files.'
    );
    // The import card says it too, with the formats and FreeCAD's way out,
    // instead of holding an earlier run's failure.
    const card = page.locator('.activity-pill');
    await expect(card).toContainText('Not imported');
    await expect(card).toContainText('unsupported.FCStd');
    await expect(card).toContainText('save it as STEP first');
    await expectBodyCount(page, 0);
    await expect(page.locator('.feature-row')).toHaveCount(0);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(converterRequests).toEqual([]);
    if (process.env.OZ_IMPORT_FORMATS_SCREENSHOT) {
      await page.screenshot({ path: process.env.OZ_IMPORT_FORMATS_SCREENSHOT });
    }
  }
);
