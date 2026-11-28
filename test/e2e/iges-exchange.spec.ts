import { readFileSync } from 'node:fs';
import type { Download, Page } from '@playwright/test';
import type { ProjectDocument } from '@openzcad/shared';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

/**
 * I06 end to end: Import CAD files reads an independent IGES B-rep (a cube
 * with a spherical cavity, in inches) as one exact body, and File › Export
 * IGES writes the shown body back as a type 186 solid in the export unit.
 * A trimmed-surface IGES model is refused by name.
 */
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/iges/${name}`, import.meta.url));

async function downloadText(download: Download): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface Backup {
  document: ProjectDocument;
  sources: {
    sha256: string;
    base64: string;
    contentType?: string;
    translatedFrom?: { format: string; sourceName: string };
  }[];
}

async function exportBackup(
  page: Page
): Promise<{ text: string; backup: Backup }> {
  const fileMenu = page.locator('details.file-menu');
  // A restore from inside the menu can leave it open.
  if ((await fileMenu.getAttribute('open')) === null) {
    await fileMenu.locator('summary').click();
  }
  const pending = page.waitForEvent('download');
  await fileMenu.getByRole('button', { name: /^Export project/ }).click();
  const text = await downloadText(await pending);
  if ((await fileMenu.getAttribute('open')) !== null) {
    await fileMenu.locator('summary').click();
  }
  return { text, backup: JSON.parse(text) as Backup };
}

/** The one imported exact feature and the backup source it rebuilds from. */
function importedSource(backup: Backup) {
  const feature = Object.values(backup.document.nodes).find(
    (node) =>
      node.kind === 'feature' && node.data.featureKind === 'imported-step'
  );
  if (
    feature?.kind !== 'feature' ||
    feature.data.featureKind !== 'imported-step'
  )
    throw new Error('No imported STEP feature in the backup.');
  const ref = feature.data.stepSourceRef;
  const source = backup.sources.find(
    (entry) => entry.sha256 === ref?.checksumSha256
  );
  if (!source) throw new Error('The backup has no source for the import.');
  return { data: feature.data, source };
}

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
    // Named as the IGES it was, saying what is kept (#2103, #2380).
    await expect(page.getByRole('contentinfo')).toContainText(
      'Imported editable IGES solid from cavity.igs'
    );
    await expect(page.getByRole('contentinfo')).toContainText(
      'The original IGES file is not stored'
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

test('backs an IGES import up as its labelled STEP translation and restores the same import', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubApi(page);
  // A complete backup of an account project lists its archived files.
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('IGES backup');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Import STEP or a mesh file…').setInputFiles({
    name: 'cavity.igs',
    mimeType: 'model/iges',
    buffer: fixture('cavity-brep-in.igs')
  });
  await expectBodyCount(page, 1);

  // #2381: the menu lists IGES beside the formats its picker takes.
  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  const importItem = fileMenu.getByRole('button', {
    name: 'Import CAD files…'
  });
  await expect(importItem).toContainText('STEP · IGES · STL');
  await expect(importItem).toHaveAttribute('title', /IGES/);
  await fileMenu.locator('summary').click();

  const first = await exportBackup(page);
  const { data, source } = importedSource(first.backup);
  // The feature names the file the user chose; the bytes it rebuilds from are
  // STEP, and the backup says so instead of leaving them behind an IGES name.
  expect(data.sourceName).toBe('cavity.igs');
  expect(Buffer.from(source.base64, 'base64').toString('utf8')).toMatch(
    /^ISO-10303-21;/
  );
  expect(source.contentType).toBe('model/step');
  expect(source.translatedFrom).toEqual({
    format: 'iges',
    sourceName: 'cavity.igs'
  });
  await expect(page.getByRole('contentinfo')).toContainText(
    'cavity.igs is included as its exact STEP translation; the original IGES file is not stored.'
  );

  await fileMenu.locator('summary').click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'iges-backup.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(first.text)
  });
  // The restore opens its copy as a new project; export only once it has.
  await expect(page.getByRole('contentinfo')).toContainText(
    'Imported IGES backup as a separate local project.',
    { timeout: 30_000 }
  );
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '1',
    { timeout: 30_000 }
  );
  await expectBodyCount(page, 1);
  const restored = importedSource((await exportBackup(page)).backup);
  expect(restored.data.sourceName).toBe(data.sourceName);
  expect(restored.data.stepSourceRef).toEqual(data.stepSourceRef);
  expect(restored.data.solidIndices).toEqual(data.solidIndices);
  expect(restored.source.base64).toBe(source.base64);
  expect(restored.source.translatedFrom).toEqual(source.translatedFrom);
});
