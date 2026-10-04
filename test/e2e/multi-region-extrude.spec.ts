import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

interface RegionHandle {
  x: number;
  y: number;
  dx: number;
  dy: number;
  pixelsPerUnit: number;
  value: number;
}

/** Serves `document` as the project the start screen's Create returns. */
async function openDocument(page: Page, document: ProjectDocument) {
  // The project export gathers archived artifacts and revisions first.
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            project: {
              projectId: document.projectId,
              name: document.name,
              revisionCount: 1,
              updatedAt: new Date().toISOString()
            },
            document
          }
        })
      : route.fulfill({ json: { projects: [] } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
}

/** Every arrow the armed region extrude draws, the armed rig's first. */
async function regionHandles(canvas: Locator): Promise<RegionHandle[]> {
  return canvas.evaluate(
    (element) =>
      JSON.parse(element.dataset.e2eRegionHandles ?? '[]') as RegionHandle[]
  );
}

/** Picks the detected profile at `index`, as a click with or without Shift. */
async function pickProfile(canvas: Locator, index: number, additive = false) {
  // A CustomEvent built in the page: Playwright's own dispatchEvent creates a
  // plain Event for an unknown type, which drops `detail`.
  await canvas.evaluate(
    (element, detail) =>
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-profile', { detail })
      ),
    { index, additive }
  );
}

async function chipAnchorWorldX(canvas: Locator): Promise<number> {
  return canvas.evaluate((element) =>
    Number(element.dataset.e2eChipAnchorWorldX)
  );
}

/** The exported project document, which is what a save would write. */
async function exportedDocument(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download', { timeout: 15_000 });
  await menu.getByRole('button', { name: /Export project/ }).click();
  const download = await pending;
  if ((await menu.getAttribute('open')) !== null) {
    await menu.locator('summary').click();
  }
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

test('Shift-picked regions extrude together from any one of their arrows', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let document = createProjectDocument(
    'Two pockets one drag',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 74, height: 53, depth: 8 }
  });
  // Two pockets drawn on the plate's top face plane.
  document = addSketchFeature(document, {
    name: 'Pockets',
    plane: 'XY',
    offset: 8,
    objects: [
      {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 20,
        centerY: 26.5
      },
      {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 54,
        centerY: 26.5
      }
    ]
  }).document;
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await expectBodyCount(page, 1);

  const editor = page.getByRole('form', { name: 'Extrude settings' });
  await pickProfile(canvas, 0);
  await expect(editor).toContainText('1 selected profile');
  await expect.poll(async () => (await regionHandles(canvas)).length).toBe(1);
  // Shift adds the second region: two profiles, two arrows.
  await pickProfile(canvas, 1, true);
  await expect(editor).toContainText('2 selected profiles');
  await expect.poll(async () => (await regionHandles(canvas)).length).toBe(2);
  // Shift on a selected region takes it back out, and adds it again.
  await pickProfile(canvas, 0, true);
  await expect(editor).toContainText('1 selected profile');
  await expect.poll(async () => (await regionHandles(canvas)).length).toBe(1);
  await pickProfile(canvas, 0, true);
  await expect(editor).toContainText('2 selected profiles');
  await expect.poll(async () => (await regionHandles(canvas)).length).toBe(2);

  // The newest pick anchors the chip; grabbing the other arrow moves it.
  const chip = page.getByTestId('direct-manipulation-value');
  await expect(chip).toHaveCount(1);
  const anchorX = await chipAnchorWorldX(canvas);
  const [, follower] = await regionHandles(canvas);
  const bounds = (await canvas.boundingBox())!;
  const start = { x: bounds.x + follower!.x, y: bounds.y + follower!.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Into the plate: against the arrow's positive (outward) direction.
  await page.mouse.move(
    start.x - follower!.dx * follower!.pixelsPerUnit * 4,
    start.y - follower!.dy * follower!.pixelsPerUnit * 4,
    { steps: 10 }
  );
  await expect(chip).toHaveText(/-\d/);
  // One chip, now beside the grabbed arrow on the other rectangle.
  await expect(chip).toHaveCount(1);
  await expect
    .poll(async () => Math.abs((await chipAnchorWorldX(canvas)) - anchorX))
    .toBeGreaterThan(20);
  // Both arrows carry the one value.
  const during = await regionHandles(canvas);
  expect(during).toHaveLength(2);
  expect(during[0]!.value).toBeLessThan(0);
  expect(during[1]!.value).toBeCloseTo(during[0]!.value, 9);
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Extrude preview · adjust the settings, then Create to save.'
  );

  await editor.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    /Extruded region by -[\d.]+ mm \(cut\)\./,
    { timeout: 30_000 }
  );
  await expectBodyCount(page, 1);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Extrude' })
  ).toHaveCount(1);

  // One feature, both profiles, one depth — and the body lost two pockets.
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).not.toContainText('Saving');
  const saved = await exportedDocument(page);
  const extrudes = listFeaturesInOrder(saved).flatMap((feature) =>
    feature.data.featureKind === 'extrude' ? [feature.data] : []
  );
  expect(extrudes).toHaveLength(1);
  const extrude = extrudes[0]!;
  expect(extrude.operation).toBe('cut');
  expect(extrude.profiles).toHaveLength(2);
  const depth = Math.abs(Number(extrude.distance));
  expect(depth).toBeGreaterThan(0);
  expect(depth).toBeLessThanOrEqual(8);

  const bodies = page.getByRole('button', { name: /^Bodies \d/ });
  if ((await bodies.getAttribute('aria-expanded')) === 'false') {
    await bodies.click();
  }
  await page.locator('.body-row:not(.consumed) .body-row-main').last().click();
  const readout = page
    .getByRole('region', { name: 'Feature inspector' })
    .getByText(/mm³/)
    .first();
  await expect(readout).toBeVisible();
  const volume = Number(
    ((await readout.textContent()) ?? '').replace(/[^\d.]/g, '')
  );
  expect(volume).toBeCloseTo(74 * 53 * 8 - 2 * 10 * 10 * depth, 0);
  expect(errors).toEqual([]);
});

test('refuses regions that would not extrude the same way', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  let document = createProjectDocument('Mixed pockets', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 74, height: 53, depth: 8 }
  });
  // One rectangle over the plate, one beside it.
  document = addSketchFeature(document, {
    name: 'Pockets',
    plane: 'XY',
    offset: 8,
    objects: [
      {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 20,
        centerY: 26.5
      },
      {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 100,
        centerY: 26.5
      }
    ]
  }).document;
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  const editor = page.getByRole('form', { name: 'Extrude settings' });
  await pickProfile(canvas, 0);
  await pickProfile(canvas, 1, true);
  await expect(editor).toContainText('2 selected profiles');

  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Height value' });
  await keypad.getByRole('textbox').fill('-4');
  await keypad.getByRole('button', { name: 'Apply height' }).click();
  // Together they would measure as one add and lose the pocket; apart one
  // cuts and one makes a new body, so the command refuses in one sentence.
  await expect(page.getByRole('contentinfo')).toContainText(
    'One selected profile would cut into the body and another would make a new body, so extrude them separately or choose an operation.',
    { timeout: 30_000 }
  );
  await expect(
    page.locator('.feature-row-main', { hasText: 'Extrude' })
  ).toHaveCount(0);
  await expectBodyCount(page, 1);
});

test('a glyph pick selects, arms and builds the whole word', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let document = createProjectDocument('Whole word', toUserId('user_e2e'));
  document = addSketchFeature(document, {
    name: 'Label',
    plane: 'XY',
    offset: 0,
    object: {
      objectKind: 'text',
      text: 'HIL',
      fontFamily: 'open-sans',
      fontStyle: 'regular',
      size: 20,
      x: 0,
      y: 0
    }
  }).document;
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  const editor = page.getByRole('form', { name: 'Extrude settings' });
  // Glyph regions exist once the font has parsed; until then the pick finds
  // nothing to select.
  await expect
    .poll(
      async () => {
        await pickProfile(canvas, 1);
        return editor.isVisible();
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  // One glyph picked; three regions selected and armed.
  await expect(editor).toContainText('3 selected profiles');
  await expect.poll(async () => (await regionHandles(canvas)).length).toBe(3);
  // Shift on another glyph of the same word drops the whole word.
  await pickProfile(canvas, 2, true);
  await expect(editor).toHaveCount(0);
  await pickProfile(canvas, 0);
  await expect(editor).toContainText('3 selected profiles');

  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Height value' });
  await keypad.getByRole('textbox').fill('2');
  await keypad.getByRole('button', { name: 'Apply height' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Extruded region by 2 mm (new-body).',
    { timeout: 30_000 }
  );
  await expectBodyCount(page, 1);
  // The body spans all three letters (about 28 mm at this size), not the one
  // glyph that was clicked (an H alone is under 15 mm).
  const detail =
    (await page
      .locator('.selection-callout-chip .selection-callout-detail')
      .textContent()) ?? '';
  const size = /([\d.]+)\s*×\s*([\d.]+)\s*×\s*([\d.]+)/.exec(detail);
  expect(size, `no size in selection chip: ${detail}`).not.toBeNull();
  expect(Number(size![1])).toBeGreaterThan(20);
  expect(Number(size![3])).toBeCloseTo(2, 1);
  expect(errors).toEqual([]);
});
