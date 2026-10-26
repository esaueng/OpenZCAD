import {
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type SketchObjectData,
  type UnitSystem
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  expect,
  stubApi,
  test,
  setInPlaceOptionValues,
  editExtrudeFromHistory,
  extrudeBar
} from './openzcad-fixtures';

/**
 * F05/U01: the viewport and History sketch editors, both extrusion distances,
 * and the History summary must interpret a length in the document's units.
 * These are the same physical plate in three documents. The viewer hook reads
 * the real preview/replayed mesh; the sketch hook reads the authored expression.
 */
const READ_TIMEOUT = { timeout: 30_000 };
// The API fixture reopens its device copy as local-only. Both stable states
// mean the device write finished; saving and device-failed must not pass.
const SAVED_ON_DEVICE = /\bis-(?:local|synced)(?:\s|$)/;
const WIDTH = '5.4 mm + 2 cm';
// Expressions, so the in-place Extrude's keypad keeps them as typed (a bare
// quantity such as `12.7 mm` it converts into the document's unit).
const DISTANCE = '10 mm + 2.7 mm';
const BACK = '2 mm + 0.54 mm';

async function sketchObjects(canvas: Locator) {
  return canvas.evaluate(
    (element) =>
      new Promise<{ id: string; data: SketchObjectData }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: {
              resolve: (
                state: {
                  objects: { id: string; data: SketchObjectData }[];
                } | null
              ) => resolve(state?.objects ?? [])
            }
          })
        );
      })
  );
}

async function renderedBounds(canvas: Locator) {
  return canvas.evaluate(
    (element) =>
      new Promise<{ min: number[]; max: number[] } | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                bodyFaces: { bounds?: { min: number[]; max: number[] } }[];
              }) => resolve(state.bodyFaces[0]?.bounds ?? null)
            }
          })
        );
      })
  );
}

async function expectPlate(canvas: Locator, mmPerUnit: number) {
  for (const [axis, extent] of [25.4, 12.7, 15.24].entries()) {
    await expect
      .poll(async () => {
        const bounds = await renderedBounds(canvas);
        return bounds
          ? (bounds.max[axis]! - bounds.min[axis]!) * mmPerUnit
          : null;
      }, READ_TIMEOUT)
      .toBeCloseTo(extent, 4);
  }
  await expect
    .poll(async () => (await renderedBounds(canvas))?.min[2], READ_TIMEOUT)
    .toBeCloseTo(-2.54 / mmPerUnit, 5);
}

async function editSketch(page: Page, canvas: Locator) {
  await page.locator('.feature-row-main', { hasText: 'Plate outline' }).click();
  await page
    .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
    .click();
  const overview = page.getByRole('region', { name: 'Sketch overview' });
  const palette = page.getByRole('button', {
    name: 'Sketch palette',
    exact: true
  });
  await expect(palette).toBeVisible();
  // The overview is lazy-loaded; a briefly absent section does not mean the
  // palette is closed. Its own state avoids toggling an open palette shut.
  if ((await palette.getAttribute('aria-expanded')) !== 'true')
    await palette.click();
  await expect(overview).toBeVisible();
  await expect.poll(async () => (await sketchObjects(canvas)).length).toBe(1);
  const object = (await sketchObjects(canvas))[0]!;
  await overview.getByLabel('Selected geometry').selectOption(object.id);
  return page.getByRole('form', { name: 'Edit rectangle' });
}

for (const [units, mmPerUnit] of [
  ['mm', 1],
  ['cm', 10],
  ['inch', 25.4]
] as const satisfies readonly (readonly [UnitSystem, number])[]) {
  test(`sketch and extrusion unit expressions survive preview, commit, undo/redo and reopen in ${units}`, async ({
    page
  }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const document = addSketchFeature(
      createProjectDocument(
        `QA sketch extrude units ${units}`,
        toUserId('user_e2e'),
        units
      ),
      {
        name: 'Plate outline',
        plane: 'XY',
        objects: [
          {
            objectKind: 'rectangle',
            width: 12.7 / mmPerUnit,
            height: 12.7 / mmPerUnit,
            centerX: 0,
            centerY: 0
          }
        ]
      }
    ).document;
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
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.getByLabel('Project name').fill(document.name);
    await page.getByRole('button', { name: 'Create project' }).click();
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toBeVisible(READ_TIMEOUT);
    let sketch = await editSketch(page, canvas);
    let width = sketch.getByRole('textbox', { name: 'Width', exact: true });

    // A dimension mismatch cannot mutate the sketch, including Enter on a
    // refused field. The valid expression preview resolves in document units.
    await width.fill('30 deg');
    await expect(width).toHaveAttribute('aria-invalid', 'true');
    await expect(
      sketch.getByRole('button', { name: 'Apply', exact: true })
    ).toBeDisabled();
    await width.press('Enter');
    expect((await sketchObjects(canvas))[0]!.data).toMatchObject({
      width: 12.7 / mmPerUnit
    });
    await width.fill(WIDTH);
    await expect(width).not.toHaveAttribute('aria-invalid');
    await expect(width).toHaveAccessibleDescription(`= ${25.4 / mmPerUnit}`);
    expect((await sketchObjects(canvas))[0]!.data).toMatchObject({
      width: 12.7 / mmPerUnit
    });
    await width.press('Enter');
    await expect
      .poll(async () => (await sketchObjects(canvas))[0]?.data, READ_TIMEOUT)
      .toMatchObject({ width: WIDTH, height: 12.7 / mmPerUnit });

    // One edit is one undo step, even when the expression resolves to another
    // unit system; redo restores the original expression, not a sampled value.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(width).toHaveValue(String(12.7 / mmPerUnit));
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(width).toHaveValue(WIDTH);
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();

    // History owns a different sketch form. A unit expression authored in the
    // viewport must remain valid there, even for an unrelated name edit.
    const outline = page.locator('.feature-row-main', {
      hasText: 'Plate outline'
    });
    const outlineName = outline.locator('.feature-name');
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    const historyWidth = inspector.getByRole('textbox', {
      name: 'Width',
      exact: true
    });
    const historyName = inspector.getByRole('textbox', {
      name: 'Name',
      exact: true
    });
    const renamed = 'Plate outline reviewed';
    await outline.click();
    await expect(historyWidth).toHaveValue(WIDTH);
    await expect(historyWidth).not.toHaveAttribute('aria-invalid');
    await expect(historyWidth).toHaveAccessibleDescription(
      `= ${25.4 / mmPerUnit}`
    );
    await historyName.fill(renamed);
    await expect(
      inspector.getByRole('button', { name: 'Apply', exact: true })
    ).toBeEnabled();
    await testInfo.attach(`${units}-history-sketch-expression`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`${units}-history-sketch.png`)
      }),
      contentType: 'image/png'
    });
    await historyName.press('Enter');
    await expect(historyWidth).toHaveCount(0);
    await expect(outlineName).toHaveText(renamed);

    // The rename and unchanged expression are one History transaction. Undo
    // returns to the original name, and Redo/reopen retain the authored width.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(outlineName).toHaveText('Plate outline');
    await outline.click();
    await expect(historyWidth).toHaveValue(WIDTH);
    await expect(historyWidth).not.toHaveAttribute('aria-invalid');
    await historyWidth.press('Escape');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(outlineName).toHaveText(renamed);
    await expect(page.locator('.save-state')).toHaveClass(SAVED_ON_DEVICE);
    await page.reload();
    await outline.click();
    await expect(historyName).toHaveValue(renamed);
    await expect(historyWidth).toHaveValue(WIDTH);
    await expect(historyWidth).toHaveAccessibleDescription(
      `= ${25.4 / mmPerUnit}`
    );
    await expect(
      inspector.getByRole('button', { name: 'Apply', exact: true })
    ).toBeEnabled();
    await historyWidth.press('Escape');

    await outline.click();
    await page.keyboard.press('e');
    // Typed on the bar's keypad, each unit expression is kept as typed.
    const bar = extrudeBar(page);
    await setInPlaceOptionValues(page, 'Extrude', {
      Distance: DISTANCE,
      'Back distance': BACK
    });
    await expect(bar.getByRole('button', { name: 'Done' })).toBeEnabled();
    // Reopened from History, the edit shows both as they were typed, with
    // its Options open on them.
    const expectStoredValues = async (edit: Locator) => {
      await edit.locator('details.in-place-command-options summary').click();
      await expect(
        edit.getByRole('button', { name: 'Distance', exact: true })
      ).toHaveText(DISTANCE);
      await expect(
        edit.getByRole('button', { name: 'Back distance', exact: true })
      ).toHaveText(BACK);
    };
    await expectPlate(canvas, mmPerUnit);
    const extrusion = page.locator('.feature-row-main', { hasText: 'Extrude' });
    const extrusionSummary = page
      .locator('.feature-row', { has: extrusion })
      .locator('.history-row-value');
    const expectedSummary = `${12.7 / mmPerUnit} + ${2.54 / mmPerUnit} ${units === 'inch' ? 'in' : units}`;
    await expect(extrusion).toHaveCount(0);
    await testInfo.attach(`${units}-unit-expression-preview`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`${units}-preview.png`)
      }),
      contentType: 'image/png'
    });
    await page.keyboard.press('Enter');
    await expect(extrusion).toHaveCount(1);
    await expect(extrusionSummary).toHaveText(expectedSummary);
    await expect(bar).toHaveCount(0);
    await expectPlate(canvas, mmPerUnit);

    // Editing refuses a mismatched dimension without replacing the last valid
    // body. Escape drops the refused draft and adds no undo entry.
    let edit = await editExtrudeFromHistory(page, extrusion);
    await expectStoredValues(edit);
    await edit.getByRole('button', { name: 'Distance', exact: true }).click();
    const keypad = page.locator('.numeric-keypad');
    await keypad.locator('input').fill('30 deg');
    await expect(edit.getByRole('button', { name: 'Done' })).toBeDisabled();
    await keypad.locator('input').press('Enter');
    await expectPlate(canvas, mmPerUnit);
    await keypad.locator('input').press('Escape');
    await expect(keypad).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(edit).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(extrusion).toHaveCount(0);
    await expect(canvas).toHaveAttribute(
      'data-e2e-rendered-bodies',
      '0',
      READ_TIMEOUT
    );
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(extrusion).toHaveCount(1);
    await expect(extrusionSummary).toHaveText(expectedSummary);
    await expectPlate(canvas, mmPerUnit);

    await expect(page.locator('.save-state')).toHaveClass(SAVED_ON_DEVICE);
    await page.reload();
    await expectPlate(canvas, mmPerUnit);
    await expect(extrusionSummary).toHaveText(expectedSummary);
    edit = await editExtrudeFromHistory(page, extrusion);
    await expectStoredValues(edit);
    await testInfo.attach(`${units}-unit-expression-reopen`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`${units}-reopened.png`)
      }),
      contentType: 'image/png'
    });
    await page.keyboard.press('Escape');
    await expect(edit).toHaveCount(0);
    sketch = await editSketch(page, canvas);
    width = sketch.getByRole('textbox', { name: 'Width', exact: true });
    await expect(width).toHaveValue(WIDTH);
    await expect
      .poll(async () => (await sketchObjects(canvas))[0]?.data, READ_TIMEOUT)
      .toMatchObject({ width: WIDTH, height: 12.7 / mmPerUnit });
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();
    await expectPlate(canvas, mmPerUnit);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    expect(errors).toEqual([]);
  });
}
