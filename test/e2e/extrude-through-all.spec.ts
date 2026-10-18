import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

/**
 * F01 through-all, first slice: an existing blind cut is switched to Through
 * all in its editor, the committed body is the full-depth cut, the card
 * reopens showing what was stored, and one undo restores the blind pocket.
 */
test('switches a blind cut to through all and back through undo', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  let document = createProjectDocument(
    'Through-all pocket',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 40, depth: 10 }
  });
  const plateId = document.bodyOrder[0]!;
  const sketched = addSketchFeature(document, {
    name: 'Pocket sketch',
    plane: 'XY',
    offset: 10,
    objects: [
      {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 20,
        centerY: 20
      }
    ]
  });
  document = extrudeSketch(sketched.document, {
    name: 'Pocket',
    sketchId: sketched.sketchId,
    distance: -3,
    operation: 'cut',
    targetBodyId: plateId
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
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await expectBodyCount(page, 1);

  const pocket = page
    .locator('.feature-row-main', { hasText: 'Pocket' })
    .last();
  const panel = page.locator('.panel-body');
  await pocket.click();
  await expect(panel).toContainText('15700');

  await page.getByLabel('Extent').selectOption('through-all');
  await expect(
    page.getByRole('textbox', { name: 'Distance', exact: true })
  ).toHaveCount(0);
  await page.getByLabel('Through-all direction').selectOption('backward');
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await apply.click();
  // A successful edit closes its card; reopen it to read what was committed.
  await expect(apply).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await pocket.click();
  // 40 × 40 × 10 less a 10 × 10 hole through all 10, and the card reopens
  // on what was stored rather than the dormant distance.
  await expect(panel).toContainText('15000', { timeout: 30_000 });
  await expect(page.getByLabel('Extent')).toHaveValue('through-all');
  await expect(page.getByLabel('Through-all direction')).toHaveValue(
    'backward'
  );

  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await pocket.click();
  await expect(page.getByLabel('Extent')).toHaveValue('blind');
  await expect(panel).toContainText('15700', { timeout: 30_000 });
});
