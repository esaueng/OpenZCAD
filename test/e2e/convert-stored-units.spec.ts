import type { Page } from '@playwright/test';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  createPrimitiveInPlace,
  expect,
  keepMeasurement,
  locateEdge,
  revealModelPanel,
  setSelectionFilter,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * I03 phase 6 (plan §6, browser): converting a project's stored units from
 * File › Units. One conversion, one undo step and a safety checkpoint that
 * survives a reload and puts the millimetres back.
 */

const READY = { timeout: 30_000 };
/** Preparation rebuilds the model three times in a worker. */
const CHECKED = { timeout: 90_000 };
const SAVED = /\bis-(?:local|synced)(?:\s|$)/;
const CHECKPOINT = 'Before unit conversion (mm → in)';

/** A 50.8 mm line, measured by one saved reference distance. */
function fixture() {
  const manager = new CommandManager(
    createProjectDocument('Unit conversion', toUserId('user_i03p6'))
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

async function open(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import project', exact: true }).click()
  ]);
  await chooser.setFiles({
    name: 'unit-conversion.openzcad',
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
}

function fileMenu(page: Page) {
  return page.locator('details.file-menu');
}

async function withFileMenu<T>(page: Page, run: () => Promise<T>) {
  const menu = fileMenu(page);
  if ((await menu.getAttribute('open')) === null)
    await menu.locator('summary').click();
  const result = await run();
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  return result;
}

/** The File menu's Units note: how lengths read now. */
async function expectShownIn(page: Page, text: string) {
  await withFileMenu(page, () =>
    expect(fileMenu(page).locator('.topbar-units-note')).toHaveText(text)
  );
}

async function exportDocument(page: Page): Promise<ProjectDocument> {
  return withFileMenu(page, async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download', READY),
      fileMenu(page)
        .getByRole('button', { name: /^Export project/ })
        .click()
    ]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return (
      JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        document: ProjectDocument;
      }
    ).document;
  });
}

async function openConversion(page: Page) {
  const menu = fileMenu(page);
  if ((await menu.getAttribute('open')) === null)
    await menu.locator('summary').click();
  await menu.getByRole('button', { name: /^Convert stored units…/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Convert stored units' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('radio', { name: 'Inches (in)' })
  ).toBeChecked();
  await expect(
    dialog.getByRole('status', { name: 'What converting changes' })
  ).toContainText('stored value', CHECKED);
  return dialog;
}

async function enterSketch(page: Page) {
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
}

test(
  'converts stored units to inches, undoes, redoes, reloads and restores the safety checkpoint',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const f = fixture();
    await open(page, f.document);
    await expectShownIn(page, 'Lengths are shown and typed in mm.');

    const dialog = await openConversion(page);
    await expect(dialog).toContainText(
      'Lengths will be shown in inches, the new stored unit.'
    );
    await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText(
      `“${CHECKPOINT}” was saved first`,
      READY
    );
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).toContainText(
      'Converted stored units to inches.'
    );

    // The read-outs are in inches, and the 50.8 mm line is stored as 2 in.
    await expectShownIn(page, 'Lengths are shown and typed in in.');
    const converted = await exportDocument(page);
    expect(converted.units).toBe('inch');
    expect(converted.displayUnits).toBeUndefined();
    expect(
      converted.checkpoints.map((checkpoint) => checkpoint.reason)
    ).toContain(CHECKPOINT);
    await enterSketch(page);
    await expect(
      page.getByRole('button', {
        name: 'Reference distance, (2 in)',
        exact: true
      })
    ).toBeVisible(READY);
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();

    // One undo step puts millimetres back; redo converts again.
    await page.keyboard.press('ControlOrMeta+z');
    await expectShownIn(page, 'Lengths are shown and typed in mm.');
    expect((await exportDocument(page)).units).toBe('mm');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expectShownIn(page, 'Lengths are shown and typed in in.');
    expect((await exportDocument(page)).units).toBe('inch');

    // The conversion and its checkpoint survive a reload.
    await expect(page.locator('.save-state')).toHaveClass(SAVED, READY);
    await page.reload();
    await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
    await expectShownIn(page, 'Lengths are shown and typed in in.');

    // Restoring the safety checkpoint brings the millimetre model back.
    await revealModelPanel(page, 'Revisions');
    const row = page.locator('.revision-row', {
      has: page.locator('.revision-reason', { hasText: CHECKPOINT })
    });
    await expect(row).toBeVisible(READY);
    await row.hover();
    await row.getByRole('button', { name: `Restore ${CHECKPOINT}` }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      `Restored “${CHECKPOINT}”`,
      READY
    );
    await expectShownIn(page, 'Lengths are shown and typed in mm.');
    const restored = await exportDocument(page);
    expect(restored.units).toBe('mm');
    const line = findSketch(restored, f.sketchId)!;
    expect(line.referenceDimensions).toEqual(
      findSketch(f.document, f.sketchId)!.referenceDimensions
    );
    expect(errors).toEqual([]);
  }
);

test('converts a copy and leaves the original in millimeters', async ({
  page
}) => {
  test.setTimeout(240_000);
  const f = fixture();
  await open(page, f.document);
  const original = await exportDocument(page);
  const dialog = await openConversion(page);
  await dialog.getByRole('button', { name: 'Convert a copy' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    'Unit conversion is unchanged.',
    CHECKED
  );
  // The original has a save point, so the copy names it: no lineage caveat.
  await expect(dialog.getByRole('status')).not.toContainText(
    'does not record that it came from'
  );
  await dialog.getByRole('button', { name: 'Done' }).click();
  // The copy is open, converted; the original still stores millimeters.
  const copy = await exportDocument(page);
  expect(copy.projectId).not.toBe(original.projectId);
  expect(copy.name).not.toBe(original.name);
  expect(copy.units).toBe('inch');
  // The copy names the project it was made from (plan §5.3).
  expect(copy.branchedFrom).toMatchObject({
    projectId: original.projectId,
    projectName: original.name,
    checkpointReason: 'Copied to convert to inches'
  });
  await expectShownIn(page, 'Lengths are shown and typed in in.');

  // Reopened, the original was never converted: still millimeters, its
  // 50.8 mm line and reference distance exactly as imported.
  await page.getByTitle('Back to projects').click();
  await page
    .locator('.start-tile-open', { hasText: original.name })
    .filter({ hasNotText: copy.name })
    .click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
  await expectShownIn(page, 'Lengths are shown and typed in mm.');
  const reopened = await exportDocument(page);
  expect(reopened.projectId).toBe(original.projectId);
  expect(reopened.units).toBe('mm');
  expect(reopened.version).toBe(original.version);
  expect(
    reopened.checkpoints.map((checkpoint) => checkpoint.reason)
  ).not.toContain(CHECKPOINT);
  expect(findSketch(reopened, f.sketchId)!.referenceDimensions).toEqual(
    findSketch(f.document, f.sketchId)!.referenceDimensions
  );
  expect(reopened.nodes).toEqual(original.nodes);
  await enterSketch(page);
  await expect(
    page.getByRole('button', {
      name: 'Reference distance, (50.8 mm)',
      exact: true
    })
  ).toBeVisible(READY);
});

async function switchWorkspace(page: Page, to: 'View' | 'Build') {
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: to })
    .click();
}

/** The one kept measurement's value, with Measure armed in View. */
async function keptReading(page: Page, unit: 'mm' | 'in') {
  await switchWorkspace(page, 'View');
  const workbench = page.getByLabel('Measurement workbench');
  if (!(await workbench.isVisible()))
    await page
      .getByRole('toolbar', { name: 'View tools' })
      .getByRole('button', { name: 'Measure' })
      .click();
  const row = workbench.getByRole('listitem');
  await expect(row).toHaveCount(1, READY);
  const pattern = new RegExp(`(\\d+\\.\\d+)\\s*${unit}\\b`);
  await expect(row).toContainText(pattern, READY);
  return Number(pattern.exec((await row.textContent()) ?? '')![1]);
}

async function cameraDistance(page: Page) {
  return Number(
    await page
      .locator('.viewer-host canvas')
      .getAttribute('data-e2e-camera-distance')
  );
}

test('a kept measurement and the camera follow the conversion, its undo and a reload', async ({
  page
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Kept measurement');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled(
    READY
  );

  // Keep one edge's length, in millimetres.
  await switchWorkspace(page, 'View');
  await page
    .getByRole('toolbar', { name: 'View tools' })
    .getByRole('button', { name: 'Measure' })
    .click();
  await setSelectionFilter(page, 'Edge');
  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);
  await keepMeasurement(page);
  const millimetres = await keptReading(page, 'mm');
  expect([18, 24, 30]).toContain(millimetres);
  const inches = (millimetres / 25.4).toFixed(2);
  // The list is written back debounced.
  await page.waitForTimeout(700);

  await switchWorkspace(page, 'Build');
  await expect.poll(() => cameraDistance(page)).toBeGreaterThan(0);
  const distance = await cameraDistance(page);
  const dialog = await openConversion(page);
  await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText(
    `“${CHECKPOINT}” was saved first: restore it from Revisions`,
    READY
  );
  await dialog.getByRole('button', { name: 'Done' }).click();

  // The camera keeps the view: every length it holds scaled by 1 / 25.4.
  await expect
    .poll(async () => (await cameraDistance(page)) / distance, READY)
    .toBeCloseTo(1 / 25.4, 4);
  // 18 mm reads 0.71 in, not 18 read as millimetres and divided again.
  expect((await keptReading(page, 'in')).toFixed(2)).toBe(inches);

  // Undo puts the millimetres, the reading and the camera back.
  await switchWorkspace(page, 'Build');
  await page.keyboard.press('ControlOrMeta+z');
  await expectShownIn(page, 'Lengths are shown and typed in mm.');
  await expect
    .poll(async () => (await cameraDistance(page)) / distance, READY)
    .toBeCloseTo(1, 4);
  expect(await keptReading(page, 'mm')).toBe(millimetres);

  // Redo, then a reload: still inches, and still the same edge.
  await switchWorkspace(page, 'Build');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expectShownIn(page, 'Lengths are shown and typed in in.');
  expect((await keptReading(page, 'in')).toFixed(2)).toBe(inches);
  await page.waitForTimeout(700);
  await expect(page.locator('.save-state')).toHaveClass(SAVED, READY);
  await page.reload();
  await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
  expect((await keptReading(page, 'in')).toFixed(2)).toBe(inches);
  // This device's remembered view was rewritten in inches too, so the
  // reload comes back to the same view rather than 25.4 times too far.
  expect(
    await page.evaluate(() =>
      Object.values(
        (
          JSON.parse(
            localStorage.getItem('openzcad-workspace-session:v1') ?? '{}'
          ) as { views?: Record<string, { units?: string }> }
        ).views ?? {}
      ).map((view) => view.units)
    )
  ).toEqual(['inch']);
  await expect
    .poll(async () => (await cameraDistance(page)) / distance, READY)
    .toBeCloseTo(1 / 25.4, 3);
  expect(errors).toEqual([]);
});

test('an undo or a reload straight after converting keeps the same view', async ({
  page
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Straight after');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled(
    READY
  );
  await expect.poll(() => cameraDistance(page)).toBeGreaterThan(0);
  const distance = await cameraDistance(page);
  const dialog = await openConversion(page);
  await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText(
    `“${CHECKPOINT}” was saved first`,
    READY
  );
  await dialog.getByRole('button', { name: 'Done' }).click();
  // No wait for the camera: the undo comes at once. The camera lands on the
  // converted view in one step, so there is no glide frame for the undo to
  // scale back by 25.4.
  await page.keyboard.press('ControlOrMeta+z');
  await expectShownIn(page, 'Lengths are shown and typed in mm.');
  await expect
    .poll(async () => (await cameraDistance(page)) / distance, READY)
    .toBeCloseTo(1, 4);

  // Redo, then reload as soon as the document is saved.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expectShownIn(page, 'Lengths are shown and typed in in.');
  await expect(page.locator('.save-state')).toHaveClass(SAVED, READY);
  await page.reload();
  await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
  await expectShownIn(page, 'Lengths are shown and typed in in.');

  await expect
    .poll(async () => (await cameraDistance(page)) / distance, READY)
    .toBeCloseTo(1 / 25.4, 3);
  expect(errors).toEqual([]);
});

test('the review lists each fact beside its marker at phone width', async ({
  page
}) => {
  test.setTimeout(240_000);
  await open(page, fixture().document);
  const dialog = await openConversion(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const facts = dialog.locator('.convert-units-facts li');
  await expect(facts.first()).toBeVisible();
  for (const fact of await facts.all()) {
    // The marker hangs beside the first line of its own text.
    const { marker, text } = await fact.evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      const range = document.createRange();
      range.selectNodeContents(element);
      const first = range.getClientRects()[0]!;
      return {
        marker: {
          position: style.position,
          display: getComputedStyle(element).display
        },
        text: { top: first.top, item: element.getBoundingClientRect().top }
      };
    });
    expect(marker.position).toBe('absolute');
    expect(marker.display).toBe('block');
    expect(Math.abs(text.top - text.item)).toBeLessThan(4);
  }
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
});

/** Model length per CSS pixel the scale rule reads, in its shown unit. */
async function scalePerPixel(page: Page, unit: 'mm' | 'in') {
  const indicator = page.getByTestId('viewport-scale-indicator');
  const pattern = new RegExp(`: (\\d+(?:\\.\\d+)?) ${unit}$`);
  await expect(indicator).toHaveAttribute('aria-label', pattern, READY);
  const value = Number(
    pattern.exec((await indicator.getAttribute('aria-label')) ?? '')![1]
  );
  const length = await page
    .getByTestId('viewport-scale-rule')
    .evaluate((element) =>
      parseFloat(
        (element as HTMLElement).style.getPropertyValue(
          '--viewport-scale-length'
        )
      )
    );
  expect(length).toBeGreaterThan(0);
  return value / length;
}

async function fitView(page: Page) {
  await page.getByRole('button', { name: 'Fit view (F)' }).click();
  await expect.poll(() => cameraDistance(page), READY).toBeGreaterThan(0);
  // Let the framing settle before the rule is read.
  let previous = -1;
  await expect
    .poll(async () => {
      const now = await cameraDistance(page);
      const settled = Math.abs(now - previous) < 1e-9;
      previous = now;
      return settled;
    }, READY)
    .toBe(true);
}

test(
  'a version saved before the conversion previews, reads and cuts in its own unit, without the project’s pins',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    // #2365: the checkpoint stores millimetres while the project stores
    // inches, so a viewport sized by the project's unit reads 25.4 times
    // too large, and pins taken on the project float off the version.
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.route('**/api/session', (route) =>
      route.fulfill({ status: 401, json: { error: 'Not signed in' } })
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Preview units');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled(
      READY
    );

    // One kept edge length, pinned on the model once Measure is off.
    await switchWorkspace(page, 'View');
    const measure = page
      .getByRole('toolbar', { name: 'View tools' })
      .getByRole('button', { name: 'Measure' });
    await measure.click();
    await setSelectionFilter(page, 'Edge');
    const edge = await locateEdge(page);
    await page.mouse.click(edge.x, edge.y);
    await keepMeasurement(page);
    await measure.click();
    await expect(page.getByLabel('Measurement workbench')).toHaveCount(0);
    const pins = page.locator('.measurement-callout');
    await expect(pins).toHaveCount(1, READY);
    await page.waitForTimeout(700);

    await switchWorkspace(page, 'Build');
    const dialog = await openConversion(page);
    await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText(
      `“${CHECKPOINT}” was saved first`,
      READY
    );
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expectShownIn(page, 'Lengths are shown and typed in in.');

    await fitView(page);
    const live = await scalePerPixel(page, 'in');
    await expect(pins).toHaveCount(1);

    await revealModelPanel(page, 'Revisions');
    const row = page.locator('.revision-row', {
      has: page.locator('.revision-reason', { hasText: CHECKPOINT })
    });
    await expect(row).toBeVisible(READY);
    await row.hover();
    await row.getByRole('button', { name: `Preview ${CHECKPOINT}` }).click();
    const notice = page.getByRole('region', { name: 'Save preview' });
    await expect(notice).toContainText(`Previewing “${CHECKPOINT}”`, READY);

    // The pin was taken on the project's geometry: not drawn over the
    // version's.
    await expect(pins).toHaveCount(0);
    // The same box, fitted the same way, reads the same scale: its
    // millimetre coordinates are not read as inches.
    await fitView(page);
    const previewed = await scalePerPixel(page, 'in');
    expect(previewed / live).toBeGreaterThan(0.5);
    expect(previewed / live).toBeLessThan(2);
    await expect(notice).toBeVisible();

    // #2422: an edge picked on the version reads its millimetres in the
    // project's inches: about 1 in for a box edge, not its mm number.
    await setSelectionFilter(page, 'Edge');
    const picked = await locateEdge(page);
    await page.mouse.click(picked.x, picked.y);
    const readout = page.locator('.selection-readout');
    await expect(readout).toContainText(/\d in/, READY);
    const length = Number(
      /(\d+(?:\.\d+)?) in/.exec(await readout.innerText())![1]
    );
    expect(length).toBeGreaterThan(0.1);
    expect(length).toBeLessThan(5);

    // #2422: a cut moved over the version is in its millimetres on screen,
    // and stays where it was put once the preview closes: 5 mm is 0.197 in,
    // not 5 in.
    await page.getByRole('button', { name: /^Section view — now:/ }).click();
    const cut = page.getByLabel('Cut position');
    await expect(cut).toBeEnabled();
    await cut.fill('5');
    await cut.press('Enter');
    await expect(cut).toHaveValue('5');

    await notice.getByRole('button', { name: 'Close preview' }).click();
    await expect(notice).toHaveCount(0);
    await expect(pins).toHaveCount(1, READY);
    await expect(cut).toHaveValue(/^0\.19685/);
    expect(errors).toEqual([]);
  }
);
