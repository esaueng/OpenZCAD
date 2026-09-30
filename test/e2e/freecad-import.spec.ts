import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

test('imports FreeCAD final solids through the picker with undo, visibility and reload', async ({
  page
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('FreeCAD solids');
  await page.getByRole('button', { name: 'Create project' }).click();
  const picker = page.getByLabel('Import FreeCAD, STEP or a mesh file…');
  await expect(picker).toHaveAttribute('accept', /\.fcstd/);
  await picker.setInputFiles('test/fixtures/freecad/two-solids.FCStd');
  await expect(page.locator('.body-row')).toHaveCount(2, { timeout: 30000 });
  await expectBodyCount(page, 2);
  await expect(page.getByRole('contentinfo')).toContainText(
    'FreeCAD sketches and feature history were not transferred.'
  );
  await expect(page.locator('.body-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 2);
  await page
    .locator('.body-row')
    .first()
    .getByRole('button', { name: /^Hide body / })
    .click();
  await expect(page.locator('.body-row.hidden-body')).toHaveCount(1);
  await page
    .locator('.body-row')
    .first()
    .getByRole('button', { name: /^Show body / })
    .click();
  await expect(page.locator('.save-state')).toHaveClass(
    /is-synced|is-local-source/
  );
  await page.reload();
  await expectBodyCount(page, 2);
  await expect(
    page.locator('.feature-row').getByTitle('Feature failed to build')
  ).toHaveCount(0);
  await expect(page).toHaveTitle(/OpenZCAD/);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(
    page.getByText('Loading 3D viewport…', { exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByText(
      /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Rebuilding geometry/
    )
  ).toHaveCount(0, { timeout: 30000 });
  await expect(page.locator('canvas[data-engine]')).toBeVisible();
  await expect(page.locator('canvas[data-engine]')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '2'
  );
  expect(errors).toEqual([]);
  if (process.env.OZ_FREECAD_SCREENSHOT)
    await page.screenshot({ path: process.env.OZ_FREECAD_SCREENSHOT });
});

test('refuses a corrupt FreeCAD file without adding a body', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Bad FreeCAD archive');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('Import FreeCAD, STEP or a mesh file…').setInputFiles({
    name: 'bad.FCStd',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('not a ZIP')
  });
  await expect(page.getByRole('contentinfo')).toContainText(
    'FreeCAD archive is truncated',
    { timeout: 30000 }
  );
  await expectBodyCount(page, 0);
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true })
  ).toBeDisabled();
});
