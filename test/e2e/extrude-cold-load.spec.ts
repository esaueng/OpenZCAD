import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page, Route } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY,
  extrudeBar
} from './openzcad-fixtures';

// The in-place Extrude's bar loads on demand. These hold its chunk back, as a
// cold load does (Save-Data, or a pick that beats the idle warm-up), and
// check that nothing the region offers acts before the bar can answer it.

interface RegionHandle {
  x: number;
  y: number;
  value: number;
}

/** Holds every request for the Extrude bar's chunk until `release`. */
async function holdExtrudeBar(page: Page) {
  const held: Route[] = [];
  let released = false;
  await page.route('**/assets/ExtrudeCommand-*.js', async (route) => {
    if (released) return route.continue();
    held.push(route);
  });
  return {
    async release() {
      released = true;
      for (const route of held.splice(0)) await route.continue();
    }
  };
}

/** A plate with two pockets sketched on its top face: two regions. */
async function openTwoRegions(page: Page) {
  let document: ProjectDocument = createProjectDocument(
    'Cold extrude',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 74, height: 53, depth: 8 }
  });
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
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await expectBodyCount(page, 1);
  return canvas;
}

async function regionHandles(canvas: Locator): Promise<RegionHandle[]> {
  return canvas.evaluate(
    (element) =>
      JSON.parse(element.dataset.e2eRegionHandles ?? '[]') as RegionHandle[]
  );
}

async function pickProfile(canvas: Locator, index: number) {
  await canvas.evaluate(
    (element, detail) =>
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-profile', { detail })
      ),
    { index, additive: false }
  );
  // Long enough for the arrow to draw, were it going to before the bar.
  await canvas.page().waitForTimeout(750);
}

const keypad = (page: Page) => page.locator('.numeric-keypad');
const chip = (page: Page) => page.getByTestId('direct-manipulation-value');

test.beforeEach(async ({ page }) => {
  await stubApi(page, { panelLayout: MODEL_ONLY });
});

test('a region picked while the bar loads offers no arrow, and the next region opens clean @ci-smoke', async ({
  page
}) => {
  test.setTimeout(90_000);
  const bar = await holdExtrudeBar(page);
  const canvas = await openTwoRegions(page);
  await pickProfile(canvas, 0);
  // Nothing to drag: a distance set now would have no bar, and holding it
  // let it land on whichever region was picked next.
  expect(await regionHandles(canvas)).toEqual([]);
  await expect(chip(page)).toBeHidden();
  await pickProfile(canvas, 1);
  await bar.release();
  const editor = extrudeBar(page);
  await expect(editor).toBeVisible();
  await expect.poll(async () => (await regionHandles(canvas)).length).toBe(1);
  expect((await regionHandles(canvas))[0]!.value).toBe(0);
  await expect(editor.getByRole('button', { name: 'Done' })).toBeDisabled();
});

test('Escape after Enter while the bar loads closes the waiting entry and keeps the region @ci-smoke', async ({
  page
}) => {
  test.setTimeout(90_000);
  const bar = await holdExtrudeBar(page);
  const canvas = await openTwoRegions(page);
  await pickProfile(canvas, 0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await bar.release();
  // The region is still armed: its bar opens, and no entry with it.
  const editor = extrudeBar(page);
  await expect(editor).toBeVisible();
  await expect.poll(async () => (await regionHandles(canvas)).length).toBe(1);
  await expect(keypad(page)).toHaveCount(0);
  // The next Escape is the command's, as with the bar loaded.
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
});

test('Enter while the bar loads opens the distance entry once it is ready', async ({
  page
}) => {
  test.setTimeout(90_000);
  const bar = await holdExtrudeBar(page);
  const canvas = await openTwoRegions(page);
  await pickProfile(canvas, 0);
  await page.keyboard.press('Enter');
  await expect(keypad(page)).toHaveCount(0);
  await bar.release();
  await expect(extrudeBar(page)).toBeVisible();
  await expect(keypad(page)).toBeVisible();
});

test('the distance chip is not offered until the bar is ready, then opens its entry @ci-smoke', async ({
  page
}) => {
  test.setTimeout(90_000);
  const bar = await holdExtrudeBar(page);
  const canvas = await openTwoRegions(page);
  await pickProfile(canvas, 0);
  // No chip to tap while loading, so no tap is silently dropped.
  await expect(chip(page)).toBeHidden();
  await bar.release();
  await expect(extrudeBar(page)).toBeVisible();
  await expect(chip(page)).toBeVisible();
  await chip(page).click();
  await expect(keypad(page)).toBeVisible();
});
