import type { Locator, Page } from '@playwright/test';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  createSketchCompositeCornerTarget,
  createSketchCompositeSideTarget,
  toUserId,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import {
  compositeCommands,
  cornerRectangleShape
} from '../../apps/web/src/lib/sketch/composites';
import { expect, revealModelPanel, stubApi, test } from './openzcad-fixtures';

const READY = { timeout: 30_000 };
const SAVED = /\bis-(?:local|synced)(?:\s|$)/;

function fixture(units: UnitSystem = 'mm') {
  const width = units === 'inch' ? 1 : 20;
  const height = units === 'inch' ? 0.5 : 12;
  const manager = new CommandManager(
    createProjectDocument('Composite targets', toUserId('user_s04'), units)
  );
  const commit = compositeCommands(
    cornerRectangleShape({ x: 0, y: 0 }, { x: width, y: height })!,
    {
      kind: 'new-sketch',
      name: 'Named outline',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 }
    }
  );
  manager.execute(composeCommands(commit.label, commit.commands));
  const sketch = findSketch(manager.document, commit.sketchId)!;
  return { manager, sketch, composite: sketch.composites![0]!, width, height };
}

async function enter(page: Page) {
  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: 'Named outline' }).click();
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

for (const units of ['mm', 'inch'] as const) {
  test(`named composite targets in ${units} survive resize, undo and saved reopen`, async ({
    page
  }, testInfo) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const f = fixture(units);
    await open(page, f.manager.document);
    const panel = page.getByRole('group', {
      name: 'Reference dimensions',
      exact: true
    });
    await panel
      .getByRole('combobox', { name: 'Distance type', exact: true })
      .selectOption('horizontal');
    await choose(panel, 'Rectangle 1 · Corner 1', 'Rectangle 1 · Corner 3');
    const unit = units === 'inch' ? 'in' : 'mm';
    const horizontal = page.getByRole('button', {
      name: `Reference horizontal distance, (H ${f.width} ${unit})`,
      exact: true
    });
    await expect(horizontal).toBeVisible(READY);
    await testInfo.attach(`composite-${units}-initial`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`composite-${units}-initial.png`)
      }),
      contentType: 'image/png'
    });
    await horizontal.click();
    await horizontal.press('Enter');
    await horizontal.press('ArrowRight');
    await expect(
      page.getByRole('dialog', { name: 'Distance value' })
    ).toHaveCount(0);
    await panel
      .getByRole('combobox', { name: 'Reference type', exact: true })
      .selectOption('angle');
    await choose(panel, 'Rectangle 1 · Side 1', 'Rectangle 1 · Side 2');
    await expect(
      page.getByRole('button', { name: 'Reference angle, (90°)', exact: true })
    ).toBeVisible();
    const stored = findSketch(await exportDocument(page), f.sketch.sketchId)!;
    expect(
      stored.referenceDimensions!.map((reference) => reference.data)
    ).toEqual([
      {
        dimensionKind: 'distance',
        distanceMode: 'horizontal',
        a: createSketchCompositeCornerTarget(f.composite, 0),
        b: createSketchCompositeCornerTarget(f.composite, 2)
      },
      {
        dimensionKind: 'angle',
        a: createSketchCompositeSideTarget(f.composite, 0),
        b: createSketchCompositeSideTarget(f.composite, 1)
      }
    ]);
    expect(
      stored.dimensionLabelPositions?.[
        stored.referenceDimensions![0]!.annotationId
      ]
    ).toEqual({ x: 1, y: 0 });
    await page
      .getByRole('region', { name: 'Sketch overview' })
      .getByLabel('Selected geometry')
      .selectOption(f.composite.edgeIds[2]!);
    const resize = page.getByRole('form', {
      name: 'Resize rectangle',
      exact: true
    });
    await resize.getByLabel('Width', { exact: true }).fill(String(f.width * 2));
    await resize.getByRole('button', { name: 'Resize', exact: true }).click();
    const resized = page.getByRole('button', {
      name: `Reference horizontal distance, (H ${f.width * 2} ${unit})`,
      exact: true
    });
    await expect(resized).toBeVisible(READY);
    const after = findSketch(await exportDocument(page), f.sketch.sketchId)!;
    expect(after.referenceDimensions).toEqual(stored.referenceDimensions);
    expect(after.composites).toEqual(stored.composites);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(horizontal).toBeVisible();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(resized).toBeVisible();
    const line = page.getByRole('form', { name: 'Edit line', exact: true });
    await line.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(
      page.getByText(/Delete the reference dimensions first/).first()
    ).toBeVisible();
    expect(
      findSketch(await exportDocument(page), f.sketch.sketchId)!.composites
    ).toEqual(stored.composites);
    await testInfo.attach(`composite-${units}`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`composite-${units}.png`)
      }),
      contentType: 'image/png'
    });
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();
    await expect(page.locator('.save-state')).toHaveClass(SAVED, READY);
    await page.reload();
    await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
    await enter(page);
    await expect(resized).toBeVisible();
    const reopened = findSketch(await exportDocument(page), f.sketch.sketchId)!;
    expect(reopened.referenceDimensions).toEqual(stored.referenceDimensions);
    expect(reopened.dimensionLabelPositions).toEqual(
      stored.dimensionLabelPositions
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const remove = panel.getByRole('button', {
      name: /^Delete Reference angle/
    });
    await remove.scrollIntoViewIfNeeded();
    await expect(remove).toBeInViewport({ ratio: 1 });
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1
      )
    ).toBe(true);
    await testInfo.attach(`composite-${units}-phone`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`composite-${units}-phone.png`)
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

test('a missing composite stays unresolved and removable without converting a legacy rectangle', async ({
  page
}) => {
  test.setTimeout(90_000);
  const f = fixture();
  f.manager.execute(
    commandFactories.addSketchReferenceDimension({
      sketchId: f.sketch.sketchId,
      data: {
        dimensionKind: 'distance',
        a: createSketchCompositeCornerTarget(f.composite, 0),
        b: createSketchCompositeCornerTarget(f.composite, 2)
      }
    })
  );
  const add = commandFactories.addSketchObjects({
    sketchId: f.sketch.sketchId,
    objects: [
      {
        objectKind: 'rectangle',
        width: 10,
        height: 6,
        centerX: 40,
        centerY: 0
      }
    ]
  });
  f.manager.execute(add);
  const document = structuredClone(f.manager.document);
  const sketch = findSketch(document, f.sketch.sketchId)!;
  const legacyId = sketch.objectIds.at(-1)!;
  const legacy = structuredClone(document.nodes[legacyId]);
  sketch.composites = [];
  await open(page, document);
  const panel = page.getByRole('group', {
    name: 'Reference dimensions',
    exact: true
  });
  await expect(panel.getByRole('listitem')).toContainText(
    'Unresolved · Reference'
  );
  await expect(
    panel.getByRole('option', { name: /Rectangle 1 · Corner/ })
  ).toHaveCount(0);
  await expect(page.locator('[data-dimension-role="reference"]')).toHaveCount(
    0
  );
  const remove = panel.getByRole('button', { name: /^Delete Reference/ });
  await remove.click();
  await expect(panel.getByRole('listitem')).toHaveCount(0);
  const exported = await exportDocument(page);
  expect(exported.nodes[legacyId]).toEqual(legacy);
  expect(findSketch(exported, f.sketch.sketchId)!.objectIds).toEqual(
    sketch.objectIds
  );
});
