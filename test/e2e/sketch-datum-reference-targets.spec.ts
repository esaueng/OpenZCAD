import type { Locator, Page } from '@playwright/test';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { expect, revealModelPanel, stubApi, test } from './openzcad-fixtures';

const READY = { timeout: 30_000 };
const SAVED = /\bis-(?:local|synced)(?:\s|$)/;

/** One line from (3, 4) to (6, 7): 5 from the origin, 45° to the X axis. */
function fixture() {
  const manager = new CommandManager(
    createProjectDocument('Datum targets', toUserId('user_s02d'))
  );
  const add = commandFactories.addSketch({
    name: 'Datum sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [{ objectKind: 'line', x1: 3, y1: 4, x2: 6, y2: 7 }]
  });
  manager.execute(add);
  const sketchId = add.payload.ids!.sketchId;
  return {
    document: manager.document,
    sketchId,
    lineId: findSketch(manager.document, sketchId)!.objectIds[0]!
  };
}

async function enter(page: Page) {
  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: 'Datum sketch' }).click();
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
    name: 'datum-targets.openzcad',
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

async function choose(panel: Locator, from: string, to: string) {
  await panel
    .getByRole('combobox', { name: 'Reference from', exact: true })
    .selectOption({ label: from });
  await panel
    .getByRole('combobox', { name: 'Reference to', exact: true })
    .selectOption({ label: to });
  await panel
    .getByRole('button', { name: 'Add reference', exact: true })
    .click();
}

test(
  'references measure from the sketch origin and against its axes',
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
    await choose(panel, 'Sketch origin', 'Start of Line');
    const distance = page.getByRole('button', {
      name: 'Reference distance, (5 mm)',
      exact: true
    });
    await expect(distance).toBeVisible(READY);
    await panel
      .getByRole('combobox', { name: 'Reference type', exact: true })
      .selectOption('angle');
    await choose(panel, 'Sketch X axis', 'Line');
    const angle = page.getByRole('button', {
      name: 'Reference angle, (45°)',
      exact: true
    });
    await expect(angle).toBeVisible();
    await expect(panel.getByRole('listitem').nth(1)).toContainText(
      'Sketch X axis ∠ Line'
    );
    const stored = findSketch(await exportDocument(page), f.sketchId)!;
    expect(
      stored.referenceDimensions!.map((reference) => reference.data)
    ).toEqual([
      {
        dimensionKind: 'distance',
        a: { kind: 'sketch-origin' },
        b: { objectId: f.lineId, point: 'start' }
      },
      {
        dimensionKind: 'angle',
        a: { kind: 'sketch-axis', axis: 'x' },
        b: f.lineId
      }
    ]);
    expect(stored.constraints ?? []).toEqual([]);

    // Pick: the angle to the axis is read-only. Drag: only its label moves.
    await angle.click();
    await angle.press('Enter');
    await expect(page.getByRole('dialog', { name: /value/i })).toHaveCount(0);
    const bounds = (await angle.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width / 2 - 55,
      bounds.y + bounds.height / 2 + 40,
      { steps: 8 }
    );
    await page.mouse.up();
    const dragged = findSketch(await exportDocument(page), f.sketchId)!;
    const annotationId = stored.referenceDimensions![1]!.annotationId;
    expect(dragged.dimensionLabelPositions?.[annotationId]).toBeDefined();
    expect(dragged.referenceDimensions).toEqual(stored.referenceDimensions);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(async () =>
        Boolean(
          findSketch(await exportDocument(page), f.sketchId)!
            .dimensionLabelPositions?.[annotationId]
        )
      )
      .toBe(false);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(angle).toHaveCount(0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(angle).toBeVisible();
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();
    await expect(page.locator('.save-state')).toHaveClass(SAVED, READY);
    await page.reload();
    await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
    await enter(page);
    await expect(distance).toBeVisible(READY);
    await expect(angle).toBeVisible();
    expect(errors).toEqual([]);
  }
);
