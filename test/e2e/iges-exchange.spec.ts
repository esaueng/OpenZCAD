import { readFileSync } from 'node:fs';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

/**
 * I06 end to end: Import CAD files reads an independent IGES B-rep (a cube
 * with a spherical cavity, in inches) as one exact body, and File › Export
 * IGES writes the shown body back as a type 186 solid in the export unit.
 * A trimmed-surface IGES model is refused by name.
 */
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/iges/${name}`, import.meta.url));

test(
  'imports an IGES B-rep solid and exports it as IGES',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('IGES exchange');
    await page.getByRole('button', { name: 'New project' }).click();
    const input = page.getByLabel('Import STEP or a mesh file…');
    await input.setInputFiles({
      name: 'surfaces.igs',
      mimeType: 'model/iges',
      buffer: fixture('holed-plate-faces-mm.igs')
    });
    // The refusal shows in the status bar and on the import card; read the
    // status bar, as import-formats.spec.ts does.
    await expect(page.getByRole('contentinfo')).toContainText(
      /IGES surface model \(7 trimmed surfaces/
    );
    await expectBodyCount(page, 0);
    await input.setInputFiles({
      name: 'cavity.igs',
      mimeType: 'model/iges',
      buffer: fixture('cavity-brep-in.igs')
    });
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).toContainText(
      'Imported editable STEP solid from cavity.igs'
    );
    const fileMenu = page.locator('details.file-menu');
    await fileMenu.locator('summary').click();
    const downloadPromise = page.waitForEvent('download');
    await fileMenu.getByRole('button', { name: /Export IGES/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.igs$/);
    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream()) {
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text.split('\n').every((line) => !line || line.length === 80)).toBe(
      true
    );
    expect(text).toMatch(/^186,/m);
    expect(text).toMatch(/^196,/m);
    expect(text).toContain('2HMM');
  }
);
