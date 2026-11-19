import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  setInPlaceOptionValues,
  editExtrudeFromHistory,
  extrudeBar
} from './openzcad-fixtures';

/**
 * U11 one command contract, Extrude: the bar reads out the outcome and the
 * body it acts on before Done, a value the kernel refuses is said in the bar
 * after the input that must change, and the History edit reads out the same
 * outcome from the stored values.
 */
test(
  'Extrude bar names a refused draft angle and reads its outcome back from History',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    let document = createProjectDocument('Refused draft', toUserId('user_e2e'));
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 74, height: 53, depth: 8 }
    });
    document = addSketchFeature(document, {
      name: 'Bore layout',
      plane: 'XY',
      offset: 8,
      objects: [{ objectKind: 'circle', radius: 2.5, centerX: 17, centerY: 20 }]
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
    await page.locator('.feature-row-main', { hasText: 'Bore layout' }).click();
    await page.keyboard.press('e');

    const bar = extrudeBar(page);
    const status = bar.getByRole('status');
    await setInPlaceOptionValues(page, 'Extrude', { Distance: '-4' });
    await expect(status).toContainText('Preview: Cut · Plate Body', {
      timeout: 30_000
    });

    // A 40° draft closes a 2.5 mm bore within its 4 mm depth: the kernel
    // refuses it, and the bar says so after the input to change.
    await bar.locator('details.in-place-command-options summary').click();
    await bar.getByRole('button', { name: 'Draft angle', exact: true }).click();
    const keypad = page.locator('.numeric-keypad');
    await expect(keypad).toBeVisible();
    await keypad.locator('input').fill('40');
    await expect(status).toContainText(/^Draft angle: \S/, { timeout: 30_000 });
    await expect(status).not.toContainText('Preview: Cut');

    // Back to a value that builds: the refusal goes, the outcome returns.
    await keypad.locator('input').fill('0');
    await expect(status).toContainText('Preview: Cut · Plate Body', {
      timeout: 30_000
    });
    await expect(status).not.toContainText('Draft angle:');
    await keypad.locator('input').press('Enter');
    await expect(keypad).toHaveCount(0);

    await bar.getByRole('button', { name: 'Done' }).click();
    await expect(bar).toHaveCount(0, { timeout: 30_000 });

    // Reopened from History, the stored operation and target read the same.
    const extrusion = page.locator('.feature-row-main', { hasText: 'Extrude' });
    const edit = await editExtrudeFromHistory(page, extrusion.last());
    await expect(edit.getByRole('status')).toContainText(
      /^Cut · Plate Body · /
    );
  }
);
