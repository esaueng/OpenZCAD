import {
  addSketchFeature,
  addSketchConstraint,
  createProjectDocument,
  findSketch,
  renameNode
} from '@openzcad/document-core';
import {
  toSketchReferenceAnnotationId,
  toUserId,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import { expect, revealModelPanel, stubApi, test } from './openzcad-fixtures';

const READ_TIMEOUT = { timeout: 30_000 };
const SAVED = /\bis-(?:local|synced)(?:\s|$)/;

function fixture(units: UnitSystem) {
  const scale = units === 'inch' ? 25.4 : units === 'cm' ? 10 : 1;
  const added = addSketchFeature(
    createProjectDocument(`QA S02 ${units}`, toUserId('user_e2e'), units),
    {
      name: 'Reference outline',
      plane: 'XY',
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: '25.4 mm', y2: 0 },
        { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 12.7 / scale },
        {
          objectKind: 'circle',
          centerX: 38.1 / scale,
          centerY: 12.7 / scale,
          radius: '6.35 mm'
        }
      ]
    }
  );
  const ids = findSketch(added.document, added.sketchId)!.objectIds;
  let document = added.document;
  document = addSketchConstraint(document, {
    sketchId: added.sketchId,
    constraint: { constraintKind: 'horizontal', objectId: ids[0]! }
  }).document;
  for (const [i, name] of ['Baseline', 'Upright', 'Circle'].entries())
    document = renameNode(document, { nodeId: ids[i]!, name });
  return { document, ids, scale };
}

async function open(page: Page, document: ProjectDocument) {
  page.setDefaultTimeout(15_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Native local import/export and persistence are real. Only the unavailable
  // account API of the static preview is stubbed, as in the rest of the suite.
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import project', exact: true }).click()
  ]);
  await chooser.setFiles({
    name: 'QA-S02.openzcad',
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
  await expect(page.locator('.viewer-host canvas')).toBeVisible(READ_TIMEOUT);
  await enter(page);
}

async function enter(page: Page) {
  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row-main', { hasText: 'Reference outline' })
    .click();
  await page
    .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
    .click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  const palette = page.getByRole('button', {
    name: 'Sketch palette',
    exact: true
  });
  if ((await palette.getAttribute('aria-expanded')) !== 'true')
    await palette.click();
  await expect(
    page.getByRole('group', { name: 'Reference dimensions', exact: true })
  ).toBeVisible();
}

async function exportDocument(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  if ((await menu.getAttribute('open')) === null)
    await menu.locator('summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', READ_TIMEOUT),
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

async function addDistance(panel: Locator, objectId: string) {
  await panel
    .getByRole('combobox', { name: 'Reference from', exact: true })
    .selectOption(JSON.stringify({ objectId, point: 'start' }));
  await panel
    .getByRole('combobox', { name: 'Reference to', exact: true })
    .selectOption(JSON.stringify({ objectId, point: 'end' }));
  await panel
    .getByRole('button', { name: 'Add reference', exact: true })
    .click();
}

for (const [units, initial, changed] of [
  ['mm', '25.4 mm', '50.8 mm'],
  ['inch', '1 in', '2 in']
] as const) {
  test(`projected references in ${units} preserve modes, zero values and identity through edit, undo and reopen`, async ({
    page
  }, testInfo) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const f = fixture(units);
    await open(page, f.document);
    const panel = page.getByRole('group', {
      name: 'Reference dimensions',
      exact: true
    });
    const mode = panel.getByRole('combobox', {
      name: 'Distance type',
      exact: true
    });
    await expect(
      panel
        .getByRole('combobox', { name: 'Reference type', exact: true })
        .locator('option:checked')
    ).toHaveText('Distance');
    await mode.selectOption('horizontal');
    await addDistance(panel, f.ids[0]!);
    await mode.selectOption('vertical');
    await addDistance(panel, f.ids[0]!);
    await expect(panel.getByRole('listitem')).toHaveCount(2);
    await expect(panel.getByRole('listitem').first()).toContainText(
      initial + ' · Reference'
    );
    await expect(panel.getByRole('listitem').last()).toContainText(
      `0 ${units === 'inch' ? 'in' : units} · Reference`
    );
    const horizontal = page.getByRole('button', {
      name: `Reference horizontal distance, (H ${initial})`,
      exact: true
    });
    await horizontal.click();
    await horizontal.press('Enter');
    await expect(
      page.getByRole('dialog', { name: 'Distance value' })
    ).toHaveCount(0);
    await horizontal.press('ArrowRight');
    const stored = findSketch(
      await exportDocument(page),
      f.document.sketchOrder[0]!
    )!;
    expect(stored.referenceDimensions!.map((r) => r.data)).toEqual(
      ['horizontal', 'vertical'].map((distanceMode) => ({
        dimensionKind: 'distance',
        distanceMode,
        a: { objectId: f.ids[0], point: 'start' },
        b: { objectId: f.ids[0], point: 'end' }
      }))
    );
    expect(
      stored.dimensionLabelPositions?.[
        stored.referenceDimensions![0]!.annotationId
      ]
    ).toEqual({ x: 1, y: 0 });
    await page
      .getByRole('region', { name: 'Sketch overview' })
      .getByLabel('Selected geometry')
      .selectOption(f.ids[0]!);
    const editor = page.getByRole('form', { name: 'Edit line', exact: true });
    await editor
      .getByRole('textbox', { name: 'End X', exact: true })
      .fill('50.8 mm');
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(horizontal).toHaveCount(0);
    const changedLabel = page.getByRole('button', {
      name: `Reference horizontal distance, (H ${changed})`,
      exact: true
    });
    await expect(changedLabel).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(horizontal).toBeVisible();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(changedLabel).toBeVisible();
    await panel.getByRole('listitem').last().scrollIntoViewIfNeeded();
    await testInfo.attach(`projected-${units}`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`projected-${units}.png`)
      }),
      contentType: 'image/png'
    });
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();
    await expect(page.locator('.save-state')).toHaveClass(SAVED, READ_TIMEOUT);
    await page.reload();
    await expect(page.locator('.viewer-host canvas')).toBeVisible(READ_TIMEOUT);
    await enter(page);
    await expect(changedLabel).toBeVisible();
    const reopened = findSketch(
      await exportDocument(page),
      f.document.sketchOrder[0]!
    )!;
    expect(reopened.referenceDimensions).toEqual(stored.referenceDimensions);
    expect(reopened.dimensionLabelPositions).toEqual(
      stored.dimensionLabelPositions
    );
    await page.setViewportSize({ width: 320, height: 568 });
    const remove = panel.getByRole('button', {
      name: /^Delete Reference vertical distance/
    });
    await remove.scrollIntoViewIfNeeded();
    await expect(remove).toBeInViewport({ ratio: 1 });
    expect(
      await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)
    ).toBe(true);
    await testInfo.attach(`projected-${units}-phone`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`projected-${units}-phone.png`)
      }),
      contentType: 'image/png'
    });
    await remove.click();
    await expect(panel.getByRole('listitem')).toHaveCount(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(panel.getByRole('listitem')).toHaveCount(2);
    expect(errors).toEqual([]);
  });
}

for (const [units, distance] of [
  ['mm', '25.4 mm'],
  ['cm', '2.54 cm'],
  ['inch', '1 in']
] as const) {
  test(`read-only reference distance in ${units}: placement, geometry edit, deletion, undo/redo and reopen`, async ({
    page
  }, testInfo) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const f = fixture(units);
    await open(page, f.document);
    const sketchId = f.document.sketchOrder[0]!;
    const panel = page.getByRole('group', {
      name: 'Reference dimensions',
      exact: true
    });
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    const solve = page.getByRole('button', { name: 'Solve', exact: true });
    const solveStatus = page.locator('.sketch-solve-pill');
    await solve.click();
    // The solve runs in the geometry worker, so the pill is still empty when
    // the click returns. Wait for its settled label (two lines and a circle,
    // one horizontal constraint: 11 - 1 DOF) and for the solve to finish, so
    // the reference is added to a solved sketch rather than racing the solve.
    await expect(solveStatus).toHaveText('10 DOF remaining', READ_TIMEOUT);
    await expect(solve).toBeEnabled();
    const baseline = await exportDocument(page);
    await addDistance(panel, f.ids[0]!);
    await expect(panel.getByRole('listitem')).toHaveCount(1);
    await expect(panel.getByRole('listitem')).toContainText(
      distance + ' · Reference'
    );
    // A read-only reference is not solve evidence: the status must survive it.
    await expect(solveStatus).toHaveText('10 DOF remaining');
    const label = page.getByRole('button', {
      name: `Reference distance, (${distance})`,
      exact: true
    });
    await label.click();
    await label.press('Enter');
    await label.press('Space');
    await expect(
      page.getByRole('dialog', { name: 'Distance value' })
    ).toHaveCount(0);
    const added = await exportDocument(page);
    expect(added.commandLog.length).toBe(baseline.commandLog.length + 1);
    const sketch = findSketch(added, sketchId)!;
    expect(sketch.constraints ?? []).toEqual(
      findSketch(baseline, sketchId)!.constraints ?? []
    );
    for (const id of f.ids) expect(added.nodes[id]).toEqual(baseline.nodes[id]);
    const reference = sketch.referenceDimensions![0]!;
    await label.press('ArrowRight');
    await expect(label).toBeFocused();
    const moved = findSketch(await exportDocument(page), sketchId)!;
    expect(moved.dimensionLabelPositions?.[reference.annotationId]).toEqual({
      x: 1,
      y: 0
    });
    expect(moved.referenceDimensions).toEqual(sketch.referenceDimensions);
    await undo.click();
    expect(
      findSketch(await exportDocument(page), sketchId)!
        .dimensionLabelPositions?.[reference.annotationId]
    ).toBeUndefined();
    await redo.click();
    expect(
      findSketch(await exportDocument(page), sketchId)!
        .dimensionLabelPositions?.[reference.annotationId]
    ).toEqual({ x: 1, y: 0 });
    // Real pointer drag takes the same tagged presentation command.
    const bounds = await label.boundingBox();
    await page.mouse.move(
      bounds!.x + bounds!.width / 2,
      bounds!.y + bounds!.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds!.x + bounds!.width / 2 + 65,
      bounds!.y + bounds!.height / 2 - 50,
      { steps: 8 }
    );
    await page.mouse.up();
    const dragged = findSketch(await exportDocument(page), sketchId)!;
    expect(
      dragged.dimensionLabelPositions?.[reference.annotationId]
    ).not.toEqual({ x: 1, y: 0 });
    expect(dragged.referenceDimensions).toEqual(sketch.referenceDimensions);
    await testInfo.attach(`reference-${units}`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`reference-${units}.png`)
      }),
      contentType: 'image/png'
    });
    await page
      .getByRole('region', { name: 'Sketch overview' })
      .getByLabel('Selected geometry')
      .selectOption(f.ids[0]!);
    const editor = page.getByRole('form', { name: 'Edit line', exact: true });
    await editor
      .getByRole('textbox', { name: 'End X', exact: true })
      .fill('50.8 mm');
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    const changed =
      units === 'mm' ? '50.8 mm' : units === 'cm' ? '5.08 cm' : '2 in';
    await expect(panel.getByRole('listitem')).toContainText(
      changed + ' · Reference',
      READ_TIMEOUT
    );
    await editor.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(
      page.getByText(/Delete the reference dimensions first/).first()
    ).toBeVisible();
    expect(
      findSketch(await exportDocument(page), sketchId)!.referenceDimensions![0]
    ).toEqual(reference);
    await undo.click();
    await expect(panel.getByRole('listitem')).toContainText(
      distance + ' · Reference'
    );
    await redo.click();
    await expect(panel.getByRole('listitem')).toContainText(
      changed + ' · Reference'
    );
    await panel
      .getByRole('button', { name: /^Delete Reference distance/ })
      .click();
    await expect(panel.getByRole('listitem')).toHaveCount(0);
    await editor.getByRole('button', { name: 'Delete', exact: true }).click();
    expect(
      findSketch(await exportDocument(page), sketchId)!.objectIds
    ).not.toContain(f.ids[0]!);
    await undo.click();
    expect(
      findSketch(await exportDocument(page), sketchId)!.objectIds
    ).toContain(f.ids[0]!);
    await undo.click();
    await expect(panel.getByRole('listitem')).toHaveCount(1);
    await redo.click();
    await expect(panel.getByRole('listitem')).toHaveCount(0);
    await redo.click();
    expect(
      findSketch(await exportDocument(page), sketchId)!.objectIds
    ).not.toContain(f.ids[0]!);
    await undo.click();
    await undo.click();
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();
    await expect(page.locator('.save-state')).toHaveClass(SAVED, READ_TIMEOUT);
    await page.reload();
    await expect(page.locator('.viewer-host canvas')).toBeVisible(READ_TIMEOUT);
    await enter(page);
    await expect(panel.getByRole('listitem')).toContainText(
      changed + ' · Reference'
    );
    const reopened = findSketch(await exportDocument(page), sketchId)!;
    expect(reopened.referenceDimensions![0]).toEqual(reference);
    expect(reopened.dimensionLabelPositions).toEqual(
      dragged.dimensionLabelPositions
    );
    await panel.getByRole('listitem').scrollIntoViewIfNeeded();
    await testInfo.attach(`reference-${units}-reopened`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`reference-${units}-reopened.png`)
      }),
      contentType: 'image/png'
    });
    expect(errors).toEqual([]);
  });
}

test('radius and angle references remain read-only and their controls fit a phone viewport', async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  const f = fixture('mm');
  await open(page, f.document);
  const panel = page.getByRole('group', {
    name: 'Reference dimensions',
    exact: true
  });
  await panel
    .getByRole('combobox', { name: 'Reference type', exact: true })
    .selectOption('radius');
  await panel
    .getByRole('combobox', { name: 'Reference geometry', exact: true })
    .selectOption({ label: 'Circle' });
  await panel
    .getByRole('button', { name: 'Add reference', exact: true })
    .click();
  await expect(panel.getByRole('listitem')).toContainText(
    '6.35 mm · Reference'
  );
  await page
    .getByRole('button', { name: 'Reference radius, (R 6.35 mm)', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Radius value' })).toHaveCount(
    0
  );
  await panel
    .getByRole('combobox', { name: 'Reference type', exact: true })
    .selectOption('angle');
  await panel
    .getByRole('combobox', { name: 'Reference from', exact: true })
    .selectOption({ label: 'Baseline' });
  await panel
    .getByRole('combobox', { name: 'Reference to', exact: true })
    .selectOption({ label: 'Upright' });
  await panel
    .getByRole('button', { name: 'Add reference', exact: true })
    .click();
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Reference angle, (90°)', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Angle value' })).toHaveCount(
    0
  );
  await panel.getByRole('listitem').last().scrollIntoViewIfNeeded();
  await testInfo.attach('reference-radius-angle', {
    body: await page.screenshot({
      path: testInfo.outputPath('reference-radius-angle.png')
    }),
    contentType: 'image/png'
  });
  await page.setViewportSize({ width: 320, height: 568 });
  const remove = panel.getByRole('button', { name: /^Delete Reference angle/ });
  await remove.scrollIntoViewIfNeeded();
  await expect(remove).toBeInViewport({ ratio: 1 });
  expect(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true
  );
  await testInfo.attach('reference-phone', {
    body: await page.screenshot({
      path: testInfo.outputPath('reference-phone.png')
    }),
    contentType: 'image/png'
  });
  await remove.click();
  await expect(panel.getByRole('listitem')).toHaveCount(1);
});

test('unresolved saved targets remain explicit and removable across reopen', async ({
  page
}, testInfo) => {
  const f = fixture('mm');
  const sketchId = f.document.sketchOrder[0]!;
  findSketch(f.document, sketchId)!.referenceDimensions = [
    {
      annotationId: toSketchReferenceAnnotationId('sref_missing_target'),
      data: { dimensionKind: 'radius', objectId: 'ent_missing_target' as never }
    }
  ];
  await open(page, f.document);
  const panel = page.getByRole('group', {
    name: 'Reference dimensions',
    exact: true
  });
  await expect(panel.getByRole('listitem')).toContainText(
    'Unresolved · Reference'
  );
  await expect(panel.getByText(/not part of this sketch/)).toBeVisible();
  await expect(
    page.locator('[data-annotation-id="sref_missing_target"]')
  ).toHaveCount(0);
  await panel.getByRole('listitem').scrollIntoViewIfNeeded();
  await testInfo.attach('reference-unresolved', {
    body: await page.screenshot({
      path: testInfo.outputPath('reference-unresolved.png')
    }),
    contentType: 'image/png'
  });
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(page.locator('.save-state')).toHaveClass(SAVED, READ_TIMEOUT);
  await page.reload();
  await expect(page.locator('.viewer-host canvas')).toBeVisible(READ_TIMEOUT);
  await enter(page);
  await expect(panel.getByRole('listitem')).toContainText(
    'Unresolved · Reference'
  );
  await panel.getByRole('button', { name: /^Delete Reference radius/ }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.getByRole('listitem')).toContainText(
    'Unresolved · Reference'
  );
});
