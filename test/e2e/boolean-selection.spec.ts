import type { Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  expect,
  test,
  stubApi,
  clickWorldPoint,
  expectFeatureMeasurement,
  finishInPlaceCommand,
  pickObjectsBody,
  pressTool,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U11: a boolean is picked in the model alone. Each body it takes wears its
 * role where it stands, Base from the first click and Tool after, the same
 * names Options lists, and the canvas reports the order the command will
 * submit. Before, the bodies wore their pick numbers, and one pick wore
 * only its name.
 */
async function openSeeded(page: Page, document: ProjectDocument) {
  await stubApi(page);
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

test(
  'names the bodies a boolean picks in the model Base and Tool where they stand',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    // Two 10 mm cubes from the origin, Right moved 5 along X and Y: they
    // overlap in a 5 × 5 × 10 column.
    let document = createProjectDocument('Picked roles', toUserId('user_e2e'));
    for (const name of ['Left', 'Right']) {
      document = addPrimitiveFeature(document, {
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
    }
    document = transformBody(document, {
      name: 'Offset Right',
      targetBodyId: document.bodyOrder[1]!,
      translation: { x: 5, y: 5, z: 0 }
    }).document;
    await openSeeded(page, document);
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
      timeout: 30_000
    });
    await page.keyboard.press('f');
    await waitForStillViewport(page);

    await pressTool(page, /^Subtract \(X\)/);
    const bar = page.getByRole('group', { name: 'Subtract command' });
    await expect(bar).toContainText('cut from');
    const callouts = page.locator('.body-order-callout');
    const role = (name: string) =>
      callouts.filter({ hasText: name }).locator('.callout-order');

    // Left's top, clear of Right: the body to cut from is the Base at once.
    await clickWorldPoint(page, [2, 2, 10]);
    await expect(callouts).toHaveCount(1);
    await expect(role('Left')).toHaveText('Base');
    await expect(bar).toContainText('cut away');

    // Right's top near a corner, clear of Left: it is the Tool.
    await clickWorldPoint(page, [14, 6, 10]);
    await expect(callouts).toHaveCount(2);
    await expect(role('Left')).toHaveText('Base');
    await expect(role('Right')).toHaveText('Tool');
    const order = await canvas.getAttribute('data-e2e-selected-bodies');
    expect(order?.split(',')).toHaveLength(2);
    // Options names them the same way, in the same order.
    const options = bar.getByLabel('Subtract options');
    await options.click();
    const operands = bar.getByRole('list', { name: 'Boolean operands' });
    await expect(operands.getByRole('listitem')).toHaveText([
      /Base · Left/,
      /Tool · Right/
    ]);
    // Taken back out there (the preview stands where Right did), the Base
    // keeps its role in the model.
    await operands
      .getByRole('button', { name: /Remove 2 Tool · Right/ })
      .click();
    await options.click();
    await expect(callouts).toHaveCount(1);
    await expect(role('Left')).toHaveText('Base');
    await expect(canvas).toHaveAttribute(
      'data-e2e-selected-bodies',
      order!.split(',')[0]!
    );
    // Back on screen, Right is picked in the model again as the Tool.
    await waitForStillViewport(page);
    await clickWorldPoint(page, [14, 6, 10]);
    await expect(callouts).toHaveCount(2);
    await expect(role('Right')).toHaveText('Tool');
    // The subtract's preview has consumed Right; it is still named where it
    // was picked.
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
      timeout: 30_000
    });
    await expect(role('Right')).toHaveText('Tool');
    await expect(role('Left')).toHaveText('Base');

    // Right's column cut out of Left: 1000 − 250.
    await finishInPlaceCommand(page, 'Subtract');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
      timeout: 30_000
    });
    await expect(callouts).toHaveCount(0);
    const feature = page
      .locator('.feature-row-main', { hasText: 'Subtract' })
      .last();
    await expectFeatureMeasurement(
      page,
      page.locator('.feature-row', { has: feature }),
      '750'
    );
  }
);

test('one label reads both roles where a tool stands inside its base', async ({
  page
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  // A 4 mm core centred in a 10 mm plate, both from Z = 0: their labels
  // would stand on the same spot, before the preview and after it cuts the
  // core through and consumes it (review).
  let document = createProjectDocument('Centred core', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Core',
    primitiveKind: 'box',
    dimensions: { width: 4, height: 4, depth: 10 }
  });
  document = transformBody(document, {
    name: 'Centre Core',
    targetBodyId: document.bodyOrder[1]!,
    translation: { x: 3, y: 3, z: 0 }
  }).document;
  await openSeeded(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  await pressTool(page, /^Subtract \(X\)/);
  await pickObjectsBody(page, 'Plate');
  await pickObjectsBody(page, 'Core');
  const callouts = page.locator('.body-order-callout');
  // The preview cuts the hole: only the plate is drawn, and one label names
  // both picks, Base first.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await expect(callouts).toHaveCount(1);
  await expect(callouts.locator('.callout-order')).toHaveText(['Base', 'Tool']);
  await expect(callouts).toContainText('Plate');
  await expect(callouts).toContainText('Core');
});
