import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type BoundingBox,
  type ProjectDocument
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  clickWorldPoint,
  enterCommandValue,
  expectBodyCount,
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M16 slice 3: Sheet metal makes a flat sheet from a sketch cell, and Bend
 * folds it along a line clicked on it. The blank is the specification's L
 * bracket: 96.5239 long, T = R = 2, K = 0.44, a centre-line bend at 48.262
 * folds it to 50 × 50 outside.
 */

const NAME = 'Sheet metal tools';
const X0 = 10;
const LENGTH = 96.5239;
const LINE_X = X0 + 48.262;
const WIDTH = 40;
const READ = { timeout: 120_000 };

function blankDocument(): ProjectDocument {
  // A marker body, so the viewer has something drawn before the sheet.
  let document = addPrimitiveFeature(
    createProjectDocument(NAME, toUserId('user_e2e')),
    {
      name: 'Marker',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 2, depth: 2 }
    }
  );
  document = addSketchFeature(document, {
    name: 'Blank',
    plane: 'XY',
    offset: 0,
    objects: [
      {
        objectKind: 'rectangle',
        width: LENGTH,
        height: WIDTH,
        centerX: X0 + LENGTH / 2,
        centerY: WIDTH / 2
      },
      {
        objectKind: 'line',
        x1: LINE_X,
        y1: 0,
        x2: LINE_X,
        y2: WIDTH,
        construction: true
      }
    ]
  }).document;
  return document;
}

async function openDocument(page: Page, document: ProjectDocument) {
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
  await page.getByRole('button', { name: 'New project' }).click();
}

async function startTool(page: Page, tool: RegExp) {
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: tool }).click();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
}

async function pickProfile(canvas: Locator, index: number) {
  await canvas.evaluate(
    (element, detail) =>
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-profile', { detail })
      ),
    { index, additive: false }
  );
}

/** The project as the workspace last saved it, derived state included. */
async function stored(page: Page): Promise<ProjectDocument | null> {
  return page.evaluate(
    (name) =>
      new Promise<ProjectDocument | null>((resolve) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const database = request.result;
          const read = database
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          read.onerror = () => {
            database.close();
            resolve(null);
          };
          read.onsuccess = () => {
            database.close();
            resolve(
              (read.result as ProjectDocument[]).find(
                (item) => item.name === name
              ) ?? null
            );
          };
        };
      }),
    NAME
  );
}

/** The sheet body's box, rounded to 0.01, with its bend count. */
async function sheetBox(page: Page) {
  const document = await stored(page);
  if (!document) return null;
  const feature = listFeaturesInOrder(document).find(
    (entry) => entry.data.featureKind === 'sheet-metal'
  );
  if (!feature?.bodyId || feature.data.featureKind !== 'sheet-metal') {
    return null;
  }
  const box: BoundingBox | undefined =
    document.derived.bodyRepresentations[feature.bodyId]?.bbox;
  if (!box) return null;
  const r = (value: number) => Math.round(value * 100) / 100;
  return {
    bends: feature.data.bends.map((bend) => bend.direction),
    min: [r(box.min.x), r(box.min.y), r(box.min.z)],
    max: [r(box.max.x), r(box.max.y), r(box.max.z)]
  };
}

const FLAT = {
  bends: [],
  min: [X0, 0, 0],
  max: [X0 + LENGTH, WIDTH, 2].map((value) => Math.round(value * 100) / 100)
};
const UP = { bends: ['up'], min: [X0, 0, 0], max: [X0 + 50, WIDTH, 50] };
const DOWN = { bends: ['down'], min: [X0, 0, -48], max: [X0 + 50, WIDTH, 2] };

test(
  'Sheet metal and Bend in place: a blank and a line fold to an L',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(240_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await openDocument(page, blankDocument());
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
      timeout: 30_000
    });
    await page.keyboard.press('f');
    await waitForStillViewport(page);

    // Sheet metal: the blank's cell, then the thickness on its chip.
    await startTool(page, /^Sheet metal\b/);
    const sheet = page.getByRole('group', { name: 'Sheet metal command' });
    await expect(sheet).toContainText('Click the sketch cells');
    await expect
      .poll(async () => {
        await pickProfile(canvas, 0);
        return sheet.textContent();
      })
      .toContain('1 cell');
    // Framed on the sheet, so its thickness chip stands in view.
    await page
      .getByRole('button', { name: 'Fit view (F)', exact: true })
      .click();
    await waitForStillViewport(page);
    await expect(page.getByTestId('command-handle-thickness')).toBeVisible(
      READ
    );
    await enterCommandValue(page, 'thickness', '2');
    const done = sheet.getByRole('button', { name: /Done/ });
    await expect(done).toBeEnabled(READ);
    await done.click();
    await expect(sheet).toHaveCount(0, READ);
    await expectBodyCount(page, 2, 60_000);
    await expect.poll(() => sheetBox(page), READ).toEqual(FLAT);

    // Bend: a click on the sheet names it, a click on the line bends it.
    await page.keyboard.press('f');
    await waitForStillViewport(page);
    await startTool(page, /^Bend\b/);
    const bend = page.getByRole('group', {
      name: 'Edit Sheet metal command'
    });
    if (!(await bend.isVisible())) {
      await expect(page.locator('.in-place-command')).toContainText(
        'Click a sheet-metal body'
      );
      await clickWorldPoint(page, [X0 + 20, WIDTH / 2, 2]);
    }
    await expect(bend).toBeVisible(READ);
    const table = bend.getByRole('region', { name: 'Bend table' });
    await expect(table).toContainText('No bends');
    await expect(table.getByLabel('Fold preview')).toHaveValue('0');
    // The blank's one line is offered, then clicked.
    await expect(canvas).toHaveAttribute('data-e2e-curve-picker', '1', READ);
    await clickWorldPoint(page, [LINE_X, WIDTH / 2, 0]);
    await expect(table).toContainText('1 bend');
    await expect(table.getByLabel('Bend 1 angle')).toHaveValue('90');
    await expect(
      table.getByRole('button', { name: 'Up', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    // The fold slider only moves the view.
    await table.getByLabel('Fold preview').fill('50');
    await expect(table).toContainText('50 %');
    const apply = bend.getByRole('button', { name: /Done/ });
    await expect(apply).toBeEnabled(READ);
    await apply.click();
    await expect(bend).toHaveCount(0, READ);
    await expect.poll(() => sheetBox(page), READ).toEqual(UP);

    // Reopened from History, its bend is turned down.
    await revealModelPanel(page, 'History');
    await page
      .locator('.feature-row', { hasText: 'Sheet metal' })
      .locator('.feature-row-main')
      .click();
    await expect(bend).toBeVisible(READ);
    await expect(table.getByLabel('Bend 1 angle')).toHaveValue('90');
    await table.getByRole('button', { name: 'Down', exact: true }).click();
    await expect(
      table.getByRole('button', { name: 'Down', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(apply).toBeEnabled(READ);
    await apply.click();
    await expect(bend).toHaveCount(0, READ);
    await expect.poll(() => sheetBox(page), READ).toEqual(DOWN);

    // One undo step each way.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => sheetBox(page), READ).toEqual(UP);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(() => sheetBox(page), READ).toEqual(DOWN);
  }
);
