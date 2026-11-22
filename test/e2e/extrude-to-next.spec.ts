import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { commandFactories } from '@openzcad/command-system';
import { toUserId } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  chooseBarOption,
  expectBarChoice,
  editExtrudeFromHistory,
  expectFeatureMeasurement
} from './openzcad-fixtures';

/**
 * F01 (schema v130): a blind pocket in the roof of a hollow box is switched
 * to Up to next in its editor. The cut stops at the cavity's roof (through
 * all would take the floor too), the editor reopens on what was stored, and
 * one undo restores the blind pocket.
 */
test(
  'switches a blind cut to up to next and back through undo',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    let document = createProjectDocument('Up to next', toUserId('user_e2e'));
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 40, depth: 20 }
    });
    const outer = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Void',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 30, depth: 10 }
    });
    const inner = document.bodyOrder.at(-1)!;
    document = commandFactories
      .transformBody({
        name: 'Place void',
        targetBodyId: inner,
        translation: { x: 5, y: 5, z: 5 }
      })
      .apply(document);
    document = commandFactories
      .booleanBodies({
        name: 'Hollow',
        operation: 'subtract',
        targetBodyIds: [outer, inner]
      })
      .apply(document);
    const hollowId = document.bodyOrder.at(-1)!;
    const sketched = addSketchFeature(document, {
      name: 'Pocket sketch',
      plane: 'XY',
      offset: 20,
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
      targetBodyId: hollowId
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
    await expectBodyCount(page, 1);

    const pocket = page
      .locator('.feature-row-main', { hasText: 'Pocket' })
      .last();
    const pocketRow = page.locator('.feature-row:not(.is-sketch)', {
      has: pocket
    });
    // 40 × 40 × 20 less the 30 × 30 × 10 void (23000), less 10 × 10 × 3.
    await expectFeatureMeasurement(page, pocketRow, '22700');
    let edit = await editExtrudeFromHistory(page, pocket);
    await chooseBarOption(edit, 'Extent', 'Up to next');
    // Up to next takes no distance.
    await expect(
      edit.getByRole('button', {
        name: 'Distance',
        exact: true,
        includeHidden: true
      })
    ).toHaveCount(0);
    await edit.getByRole('button', { name: 'Done' }).click();
    await expect(edit).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expect(pocketRow).toContainText('Up to next');
    // Down to the void's roof at z = 15: 10 × 10 × 5.
    await expectFeatureMeasurement(page, pocketRow, '22500');
    edit = await editExtrudeFromHistory(page, pocket);
    await expectBarChoice(edit, 'Extent', 'Up to next');
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(pocketRow).not.toContainText('Up to next');
    await expectFeatureMeasurement(page, pocketRow, '22700');
    expect(errors).toEqual([]);
  }
);
