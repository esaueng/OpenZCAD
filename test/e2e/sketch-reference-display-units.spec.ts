import type { Page } from '@playwright/test';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { expect, revealModelPanel, stubApi, test } from './openzcad-fixtures';

const READY = { timeout: 30_000 };
const SAVED = /\bis-(?:local|synced)(?:\s|$)/;

/** A 50.8 mm line, measured by one saved reference distance. */
function fixture() {
  const manager = new CommandManager(
    createProjectDocument('Reference units', toUserId('user_s02f'))
  );
  const add = commandFactories.addSketch({
    name: 'Ruler',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 50.8, y2: 0 }]
  });
  manager.execute(add);
  const sketchId = add.payload.ids!.sketchId;
  const lineId = findSketch(manager.document, sketchId)!.objectIds[0]!;
  manager.execute(
    commandFactories.addSketchReferenceDimension({
      sketchId,
      data: {
        dimensionKind: 'distance',
        a: { objectId: lineId, point: 'start' },
        b: { objectId: lineId, point: 'end' }
      }
    })
  );
  return { document: manager.document, sketchId };
}

async function enter(page: Page) {
  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: 'Ruler' }).click();
  await page
    .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
    .click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible(
    READY
  );
  const toggle = page.getByRole('button', {
    name: 'Sketch palette',
    exact: true
  });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
  await expect(
    page.getByRole('group', { name: 'Reference dimensions', exact: true })
  ).toBeVisible();
}

async function open(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import project', exact: true }).click()
  ]);
  await chooser.setFiles({
    name: 'reference-units.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: [],
        sources: [],
        saveStates: []
      })
    )
  });
  await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
  await enter(page);
}

async function exportDocument(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  if ((await menu.getAttribute('open')) === null)
    await menu.locator('summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', READY),
    menu.getByRole('button', { name: /^Export project/ }).click()
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

test(
  'reference lengths switch display units without touching the document',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const f = fixture();
    await open(page, f.document);
    const panel = page.getByRole('group', {
      name: 'Reference dimensions',
      exact: true
    });
    const millimetres = page.getByRole('button', {
      name: 'Reference distance, (50.8 mm)',
      exact: true
    });
    await expect(millimetres).toBeVisible(READY);
    const before = findSketch(await exportDocument(page), f.sketchId)!;
    await panel
      .getByRole('combobox', { name: 'Show lengths in', exact: true })
      .selectOption('inch');
    const inches = page.getByRole('button', {
      name: 'Reference distance, (2 in)',
      exact: true
    });
    await expect(inches).toBeVisible();
    await expect(panel.getByRole('listitem')).toContainText('2 in · Reference');
    // Display only: the saved sketch is byte-for-byte what it was.
    const after = await exportDocument(page);
    expect(findSketch(after, f.sketchId)).toEqual(before);
    expect(after.units).toBe('mm');

    // The choice is a preference: it survives a reload.
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();
    await expect(page.locator('.save-state')).toHaveClass(SAVED, READY);
    await page.reload();
    await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
    await enter(page);
    await expect(inches).toBeVisible(READY);
    await panel
      .getByRole('combobox', { name: 'Show lengths in', exact: true })
      .selectOption('document');
    await expect(millimetres).toBeVisible();
    expect(errors).toEqual([]);
  }
);
