import type { Page } from '@playwright/test';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  toUserId,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import { expect, revealModelPanel, stubApi, test } from './openzcad-fixtures';

const READY = { timeout: 30_000 };
const SAVED = /\bis-(?:local|synced)(?:\s|$)/;

function fixture(kind: 'rectangle' | 'polygon', extruded = true) {
  const sourceData: SketchObjectData =
    kind === 'rectangle'
      ? {
          objectKind: 'rectangle',
          width: 20,
          height: 12,
          centerX: 0,
          centerY: 0
        }
      : { objectKind: 'polygon', sides: 6, radius: 10, centerX: 0, centerY: 0 };
  const manager = new CommandManager(
    createProjectDocument('Explicit conversion', toUserId('user_conversion'))
  );
  const add = commandFactories.addSketch({
    name: 'Legacy outline',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [sourceData, { objectKind: 'line', x1: 25, y1: 0, x2: 35, y2: 0 }]
  });
  manager.execute(add);
  const sketchId = add.payload.ids!.sketchId;
  const sketch = findSketch(manager.document, sketchId)!;
  const sourceObjectId = sketch.objectIds[0]!;
  manager.execute(
    commandFactories.addSketchConstraint({
      sketchId,
      constraint: {
        constraintKind: 'horizontal',
        objectId: sketch.objectIds[1]!
      }
    })
  );
  const userConstraints = structuredClone(
    findSketch(manager.document, sketchId)!.constraints!
  );
  if (extruded) {
    const [region] = computeSketchRegions(
      [{ id: sourceObjectId, data: sourceData }],
      Number
    );
    manager.execute(
      commandFactories.extrudeSketch({
        name: 'Legacy extrusion',
        bodyName: 'Conversion solid',
        sketchId,
        distance: 5,
        profile: {
          profileId: region!.profileId,
          regionFingerprint: region!.regionFingerprint,
          sourceArea: region!.area,
          samplePoint: region!.samplePoint,
          sourceEntityIds: [sourceObjectId]
        }
      })
    );
  }
  return { manager, sketchId, sourceObjectId, sourceData, userConstraints };
}

async function enter(page: Page) {
  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row-main', { hasText: 'Legacy outline' })
    .click();
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
    page.getByRole('button', { name: 'Import project…', exact: true }).click()
  ]);
  await chooser.setFiles({
    name: 'composite-targets.openzcad',
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

async function volume(page: Page) {
  await revealModelPanel(page, 'Objects');
  await page
    .locator('.body-row:not(.consumed) .body-row-main', {
      hasText: 'Conversion solid'
    })
    .click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  const value = inspector
    .locator('.kv-grid b', { hasText: /^volume$/ })
    .locator('xpath=following-sibling::span[1]');
  await expect(value).toContainText('mm³', READY);
  return (await value.innerText()).trim();
}

for (const kind of ['rectangle', 'polygon'] as const) {
  test(`explicit ${kind} conversion preserves its extrusion through undo, redo and reopen`, async ({
    page
  }, testInfo) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const f = fixture(kind);
    await open(page, f.manager.document);
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();
    const beforeVolume = await volume(page);
    await enter(page);
    const selected = page
      .getByRole('region', { name: 'Sketch overview' })
      .getByLabel('Selected geometry');
    await selected.selectOption(f.sourceObjectId);
    const form = page.getByRole('form', { name: `Edit ${kind}`, exact: true });
    const convert = form.getByRole('button', {
      name: 'Convert to editable edges',
      exact: true
    });
    const field = form.getByLabel(kind === 'rectangle' ? 'Width' : 'Radius', {
      exact: true
    });
    const initial = await field.inputValue();
    await field.fill('30');
    await expect(convert).toBeDisabled();
    await field.fill(initial);
    await expect(convert).toBeEnabled();
    await convert.click();
    const line = page.getByRole('form', { name: 'Edit line', exact: true });
    await expect(line).toBeVisible(READY);
    await expect(line).toContainText(`converted ${kind}`);
    await expect(page.locator('.sketch-entity-constraints')).toHaveCount(0);
    const converted = await exportDocument(page);
    const sketch = findSketch(converted, f.sketchId)!;
    const promotion = sketch.promotions![0]!;
    expect(promotion.sourceObjectId).toBe(f.sourceObjectId);
    expect(promotion.sourceData).toEqual(f.sourceData);
    expect(converted.nodes[f.sourceObjectId]).toBeUndefined();
    expect(sketch.constraints!.slice(0, f.userConstraints.length)).toEqual(
      f.userConstraints
    );
    expect(
      sketch
        .constraints!.filter((c) => c.origin === 'promotion-structure')
        .map((c) => c.constraintId)
    ).toEqual(promotion.structureConstraintIds);
    const extrude = Object.values(converted.nodes).find(
      (n) => n.kind === 'feature' && n.data.featureKind === 'extrude'
    );
    if (
      extrude?.kind !== 'feature' ||
      extrude.data.featureKind !== 'extrude' ||
      !extrude.data.profile ||
      extrude.data.profile.all === true
    )
      throw new Error('Missing explicit extrusion reference');
    expect(extrude.data.profile.sourceBoundaryLoops?.outer).toHaveLength(
      kind === 'rectangle' ? 4 : 6
    );
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await selected.selectOption(f.sourceObjectId);
    await expect(
      page.getByRole('form', { name: `Edit ${kind}`, exact: true })
    ).toBeVisible();
    const undone = await exportDocument(page);
    expect(undone.nodes[f.sourceObjectId]).toMatchObject({
      data: f.sourceData
    });
    expect(findSketch(undone, f.sketchId)!.promotions).toBeUndefined();
    expect(findSketch(undone, f.sketchId)!.constraints).toEqual(
      f.userConstraints
    );
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    // Undo restores the old selection; choose the same persisted generated edge after redo.
    await selected.selectOption(promotion.edgeIds[0]!);
    await expect(line).toBeVisible();
    expect(
      findSketch(await exportDocument(page), f.sketchId)!.promotions
    ).toEqual(sketch.promotions);
    await testInfo.attach(`conversion-${kind}-desktop`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`conversion-${kind}-desktop.png`)
      }),
      contentType: 'image/png'
    });
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();
    await expect(page.locator('.save-state')).toHaveClass(SAVED, READY);
    expect(await volume(page)).toBe(beforeVolume);
    await page.reload();
    await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
    expect(await volume(page)).toBe(beforeVolume);
    await enter(page);
    await selected.selectOption(promotion.edgeIds[0]!);
    const reopened = findSketch(await exportDocument(page), f.sketchId)!;
    expect(reopened.promotions).toEqual(sketch.promotions);
    await page.setViewportSize({ width: 390, height: 844 });
    const release = line.getByRole('button', {
      name: 'Release shape constraints',
      exact: true
    });
    await release.scrollIntoViewIfNeeded();
    await expect(release).toBeInViewport({ ratio: 1 });
    expect(
      await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    ).toBe(true);
    await testInfo.attach(`conversion-${kind}-phone`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`conversion-${kind}-phone.png`)
      }),
      contentType: 'image/png'
    });
    await release.click();
    await expect(release).toHaveCount(0);
    const released = findSketch(await exportDocument(page), f.sketchId)!;
    expect(released.constraints).toEqual(f.userConstraints);
    expect(released.promotions![0]!.structureConstraintIds).toEqual([]);
    expect(released.promotions![0]!.aliases).toEqual(promotion.aliases);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(release).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('released polygon edges accept a free edit without dropping an unrelated user constraint', async ({
  page
}) => {
  const f = fixture('polygon', false);
  await open(page, f.manager.document);
  await page
    .getByRole('region', { name: 'Sketch overview' })
    .getByLabel('Selected geometry')
    .selectOption(f.sourceObjectId);
  await page
    .getByRole('button', { name: 'Convert to editable edges', exact: true })
    .click();
  const line = page.getByRole('form', { name: 'Edit line', exact: true });
  await expect(line).toBeVisible(READY);
  await line
    .getByRole('button', { name: 'Release shape constraints', exact: true })
    .click();
  const before = findSketch(await exportDocument(page), f.sketchId)!;
  const edge = before.promotions![0]!.edgeIds[0]!;
  const value = line.getByLabel('End X', { exact: true });
  const requested = Number(await value.inputValue()) + 2;
  await value.fill(String(requested));
  await line.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Updated line geometry.'
  );
  const after = await exportDocument(page);
  expect(after.nodes[edge]).toMatchObject({ data: { x2: requested } });
  expect(findSketch(after, f.sketchId)!.constraints).toEqual(f.userConstraints);
  expect(findSketch(after, f.sketchId)!.promotions).toEqual(before.promotions);
});

test('a stale boundary witness refuses conversion without saving a partial graph', async ({
  page
}) => {
  const f = fixture('rectangle');
  const document = structuredClone(f.manager.document);
  const feature = Object.values(document.nodes).find(
    (n) => n.kind === 'feature' && n.data.featureKind === 'extrude'
  );
  if (
    feature?.kind !== 'feature' ||
    feature.data.featureKind !== 'extrude' ||
    !feature.data.profile ||
    feature.data.profile.all === true
  )
    throw new Error('Missing fixture extrusion');
  const outer = Array.from(
    { length: 4 },
    (_, i) => `b1/${f.sourceObjectId}/rectangle/1/4/e/${i}`
  );
  feature.data.profile.sourceBoundaryLoops = {
    outer: [...outer, outer[0]!],
    holes: []
  };
  await open(page, document);
  await page
    .getByRole('region', { name: 'Sketch overview' })
    .getByLabel('Selected geometry')
    .selectOption(f.sourceObjectId);
  const form = page.getByRole('form', { name: 'Edit rectangle', exact: true });
  const before = await exportDocument(page);
  await form
    .getByRole('button', { name: 'Convert to editable edges', exact: true })
    .click();
  await expect(form.getByRole('alert')).toContainText(
    /boundary|topology|profile/i,
    READY
  );
  const after = await exportDocument(page);
  expect(after.nodes).toEqual(before.nodes);
  expect(after.commandLog).toEqual(before.commandLog);
  expect(after.editHistory).toEqual(before.editHistory);
  expect(after.version).toBe(before.version);
  expect(findSketch(after, f.sketchId)!.promotions).toBeUndefined();
});
