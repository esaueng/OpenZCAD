import { readFileSync } from 'node:fs';
import { parseStl, writeAsciiStl } from '@openzcad/io-stl';
import { coincidentBoxSoup } from '../support/mesh-import-fixtures';
import {
  test,
  expect,
  stubApi,
  seedUnitlessImportUnits,
  createProject,
  expectBodyCount,
  bodyCardFromHistory
} from './openzcad-fixtures';

const soup = coincidentBoxSoup();
const cases = [
  { name: 'Non-manifold facets', mesh: soup, reference: true },
  {
    name: 'Single triangle',
    mesh: { vertices: [0, 0, 0, 20, 0, 0, 0, 20, 0], indices: [0, 1, 2] },
    reference: false
  },
  {
    name: 'Tiny closed edges',
    mesh: {
      vertices: soup.vertices
        .slice(0, 24)
        .map(
          (value, i) =>
            value * (i % 3 === 0 ? 85 : i % 3 === 2 ? 1.52587890625e-5 / 4 : 1)
        ),
      indices: soup.indices.slice(0, 36)
    },
    reference: false
  }
];

for (const fixture of cases) {
  test(
    `STL compatibility: ${fixture.name} imports, undoes, redoes and reopens`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(90_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await stubApi(page);
      await seedUnitlessImportUnits(page);
      await page.route('**/api/session', (route) =>
        route.fulfill({ json: null })
      );
      await createProject(page, fixture.name);
      await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
        name: 'mesh.stl',
        mimeType: 'model/stl',
        buffer: Buffer.from(
          writeAsciiStl('mesh', [{ name: 'mesh', ...fixture.mesh }])
        )
      });
      await expectBodyCount(page, 1);
      await expect(page.locator('.feature-row')).toHaveCount(1);
      await expect(page.locator('.activity-pill.error')).toHaveCount(0);
      if (fixture.reference) {
        const inspector = await bodyCardFromHistory(page);
        await expect(inspector).toContainText('Unavailable for mesh reference');
        await page.keyboard.press('Escape');
        const menu = page.locator('details.file-menu');
        await menu.locator('summary').click();
        await menu.getByRole('button', { name: /Export mesh/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Export mesh' });
        await expect(
          dialog.getByRole('radio', { name: 'STL (binary)' })
        ).toBeChecked();
        const pending = page.waitForEvent('download');
        await dialog
          .getByRole('button', { name: 'Export STL', exact: true })
          .click();
        const downloaded = await pending;
        const bytes = readFileSync(await downloaded.path());
        expect(
          parseStl(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            ),
            'roundtrip.stl'
          ).triangleCount
        ).toBe(24);
      }
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expectBodyCount(page, 0);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expectBodyCount(page, 1);
      // Reload only once the redone state is saved on this device, as a
      // person closing the tab would; otherwise the reload can race the
      // write and reopen the undone document.
      await expect(page.locator('.save-state')).toHaveClass(
        /\bis-(?:local|local-source|synced)(?:\s|$)/
      );
      await page.reload();
      await expectBodyCount(page, 1);
      await expect(
        page.getByRole('region', { name: '3D viewport' })
      ).toBeVisible();
      expect(errors).toEqual([]);
    }
  );
}

test('private STL imports through the browser file picker', async ({
  page
}) => {
  test.skip(
    !process.env.OZ_PRIVATE_STL,
    'Private local qualification fixture is opt-in.'
  );
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await seedUnitlessImportUnits(page);
  await page.route('**/api/session', (route) => route.fulfill({ json: null }));
  await createProject(page, 'STL qualification');
  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
    name: 'private.stl',
    mimeType: 'model/stl',
    buffer: readFileSync(process.env.OZ_PRIVATE_STL!)
  });
  // The optional real fixture has thousands of facets; wait for its geometry
  // job instead of applying the small-fixture five-second default.
  await expect(
    page
      .getByRole('group', { name: 'Workspace status' })
      .getByLabel(/ · \d+ features? · 1 body\. Sync /)
  ).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.activity-pill.error')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
  if (process.env.OZ_STL_SCREENSHOT) {
    await page.screenshot({ path: process.env.OZ_STL_SCREENSHOT });
  }
  expect(errors).toEqual([]);
});
