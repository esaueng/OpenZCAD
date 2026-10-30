import {
  addSketchConstraint,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  renameNode
} from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchObjectData
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import { expect, revealModelPanel, stubApi, test } from './openzcad-fixtures';

/**
 * S03: diagnostics lead from the actual GCS result to a stored constraint and
 * its editable geometry. Inspection and rejected solves must stay read-only;
 * deleting a constraint is the one undoable document change in this flow.
 * Only the preview server's account API is stubbed; the solver is real.
 */
const READ_TIMEOUT = { timeout: 30_000 };
const SAVED_ON_DEVICE = /\bis-(?:local|synced)(?:\s|$)/;
const SKETCH_NAME = 'Constraint inspection outline';
const OBJECT_NAME = 'Driven edge';
const DISTANCE_10 = `Distance 10 · ${OBJECT_NAME}.start ↔ ${OBJECT_NAME}.end`;
const DISTANCE_20 = `Distance 20 · ${OBJECT_NAME}.start ↔ ${OBJECT_NAME}.end`;

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

function fixture(kind: 'conflicting-distances' | 'refused-collapse') {
  const added = addSketchFeature(
    createProjectDocument(`QA S03 ${kind}`, toUserId('user_e2e')),
    {
      name: SKETCH_NAME,
      plane: 'XY',
      objects:
        kind === 'conflicting-distances'
          ? [{ objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]
          : [
              { objectKind: 'line', x1: -37, y1: 14, x2: -10, y2: 14 },
              { objectKind: 'line', x1: 4, y1: -14, x2: 32, y2: -14 }
            ]
    }
  );
  const objectId = findSketch(added.document, added.sketchId)!.objectIds[0]!;
  let document = renameNode(added.document, {
    nodeId: objectId,
    name: OBJECT_NAME
  });
  const constraints: SketchConstraintData[] =
    kind === 'conflicting-distances'
      ? [10, 20].map((value) => ({
          constraintKind: 'distance',
          a: { objectId, point: 'start' },
          b: { objectId, point: 'end' },
          value
        }))
      : [
          {
            constraintKind: 'perpendicular',
            a: objectId,
            b: findSketch(document, added.sketchId)!.objectIds[1]!
          }
        ];
  for (const constraint of constraints) {
    document = addSketchConstraint(document, {
      sketchId: added.sketchId,
      constraint
    }).document;
  }
  return { document, objectId };
}

async function openFixture(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible(READ_TIMEOUT);
  await enterSketch(
    page,
    canvas,
    findSketch(document, document.sketchOrder[0]!)!.objectIds.length
  );
  return canvas;
}

async function enterSketch(page: Page, canvas: Locator, objectCount = 1) {
  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: SKETCH_NAME }).click();
  await page
    .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
    .click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await expect
    .poll(async () => (await sketchObjects(canvas)).length)
    .toBe(objectCount);
}

async function expectReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(
    await control.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2
      );
      return hit === element || element.contains(hit);
    })
  ).toBe(true);
}

test('inspects a real conflicting dimension and recovers with one undoable deletion across reopen', async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const { document, objectId } = fixture('conflicting-distances');
  const canvas = await openFixture(page, document);
  const baseline = await sketchObjects(canvas);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  const solve = page.getByRole('button', { name: 'Solve', exact: true });
  await expect(undo).toBeDisabled();

  await solve.click();
  const review = page.getByRole('button', {
    name: 'Review constraints',
    exact: true
  });
  await expect(review).toBeVisible(READ_TIMEOUT);
  await expect(
    page
      .getByRole('region', { name: 'Constraint feedback' })
      .getByRole('status')
  ).toHaveText('Constraints conflict');
  expect(await sketchObjects(canvas)).toEqual(baseline);
  await expect(undo).toBeDisabled();

  // The warning opens the existing palette, with no document command.
  await review.click();
  const palette = page.locator('.sketch-palette');
  const constraints = palette.getByRole('group', {
    name: 'Constraints',
    exact: true
  });
  await expect(constraints).toBeVisible();
  await expect(constraints).toBeFocused();
  await expect(
    constraints.getByText('Constraints conflict', { exact: true })
  ).toBeVisible();
  await expect(
    constraints.getByRole('listitem', {
      name: `${DISTANCE_20} · solver residual; edit or delete this constraint`,
      exact: true
    })
  ).toHaveAttribute('data-conflicted', 'true');
  const inspect = constraints.getByRole('button', {
    name: `Show geometry for constraint: ${DISTANCE_20}`,
    exact: true
  });
  await inspect.click();
  await expect(inspect).toHaveAttribute('aria-expanded', 'true');
  const target = constraints.getByRole('button', {
    name: `Select geometry: ${OBJECT_NAME}`,
    exact: true
  });
  // Both endpoint references resolve to one live entity, not two fake picks.
  await expect(target).toHaveCount(1);
  await expectReachable(target);
  await testInfo.attach('constraint-referenced-geometry', {
    body: await page.screenshot({
      path: testInfo.outputPath('constraint-referenced-geometry.png')
    }),
    contentType: 'image/png'
  });
  await target.click();
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page
      .getByRole('region', { name: 'Sketch overview' })
      .getByLabel('Selected geometry')
  ).toHaveValue(objectId);
  const entity = page.getByRole('form', { name: 'Edit line', exact: true });
  await expect(entity).toBeVisible();
  await expect(
    entity.getByRole('textbox', { name: 'Start X', exact: true })
  ).toHaveValue('0');
  await expect(
    entity.getByRole('textbox', { name: 'End X', exact: true })
  ).toHaveValue('10');
  expect(await sketchObjects(canvas)).toEqual(baseline);
  await expect(undo).toBeDisabled();
  await review.click();
  await expectReachable(target);
  await testInfo.attach('constraint-conflict-inspection', {
    body: await page.screenshot({
      path: testInfo.outputPath('constraint-conflict-inspection.png')
    }),
    contentType: 'image/png'
  });

  // The warning must wrap at the narrowest supported phone width. Its
  // recovery action and the shared scroll path must still reach real controls.
  await page.setViewportSize({ width: 320, height: 568 });
  const feedback = page.getByRole('region', { name: 'Constraint feedback' });
  await expectReachable(review);
  await expect(
    page.locator('.sketch-relations .sketch-relation-name:visible')
  ).toHaveCount(0);
  expect(
    await review.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [
        bounds.left + 2,
        bounds.left + bounds.width / 2,
        bounds.right - 2
      ].every((x) => {
        const hit = globalThis.document.elementFromPoint(
          x,
          bounds.top + bounds.height / 2
        );
        return hit === element || element.contains(hit);
      });
    })
  ).toBe(true);
  expect(
    await feedback.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1
    )
  ).toBe(true);
  await page.mouse.move(1, 1);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await testInfo.attach('constraint-warning-phone', {
    body: await page.screenshot({
      path: testInfo.outputPath('constraint-warning-phone.png')
    }),
    contentType: 'image/png'
  });
  await expectReachable(
    entity.getByRole('button', { name: 'Apply', exact: true })
  );
  await expectReachable(
    entity.getByRole('button', { name: 'Close entity editor', exact: true })
  );
  await expectReachable(target);
  const phoneDelete = constraints.getByRole('button', {
    name: `Delete constraint: ${DISTANCE_20}`,
    exact: true
  });
  await expectReachable(phoneDelete);
  await expect(phoneDelete).toHaveCSS('opacity', '1');
  expect(
    await page
      .locator('.sketch-flyouts')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await testInfo.attach('constraint-inspection-phone', {
    body: await page.screenshot({
      path: testInfo.outputPath('constraint-inspection-phone.png')
    }),
    contentType: 'image/png'
  });

  // All three flyouts share the sketch lane. Short desktop windows must let
  // a user reach the feedback, entity editor and palette through vertical
  // scrolling, without a hidden horizontal strip swallowing the actions.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expectReachable(review);
  await expectReachable(
    entity.getByRole('button', { name: 'Apply', exact: true })
  );
  await expectReachable(
    entity.getByRole('button', { name: 'Close entity editor', exact: true })
  );
  await entity
    .getByRole('button', { name: 'Close entity editor', exact: true })
    .click();
  await expect(entity).toHaveCount(0);
  await expectReachable(target);
  await target.click();
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  const compactDelete = constraints.getByRole('button', {
    name: `Delete constraint: ${DISTANCE_20}`,
    exact: true
  });
  await expect(compactDelete).toHaveCSS('opacity', '1');
  await expectReachable(compactDelete);
  expect(
    await page
      .locator('.sketch-flyouts')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
  ).toBe(true);
  expect(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await expect(undo).toBeDisabled();
  expect(await sketchObjects(canvas)).toEqual(baseline);
  await testInfo.attach('constraint-inspection-compact', {
    body: await page.screenshot({
      path: testInfo.outputPath('constraint-inspection-compact.png')
    }),
    contentType: 'image/png'
  });

  // Use the palette's existing delete action, not a document test hook.
  const delete20 = constraints.getByRole('button', {
    name: `Delete constraint: ${DISTANCE_20}`,
    exact: true
  });
  await delete20.click();
  await expect(delete20).toHaveCount(0);
  await expect(constraints.locator('.sketch-constraint-list > li')).toHaveCount(
    1
  );
  await solve.click();
  await expect(page.locator('.sketch-solve-pill')).toHaveText(
    '3 DOF remaining',
    READ_TIMEOUT
  );
  await expect(review).toHaveCount(0);
  expect(await sketchObjects(canvas)).toEqual(baseline);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // If inspection or the rejected solve added an entry, this Undo would not
  // restore the deleted dimension, and a second Undo would remain available.
  await undo.click();
  await expect(delete20).toBeVisible();
  await expect(constraints.locator('.sketch-constraint-list > li')).toHaveCount(
    2
  );
  await expect(undo).toBeDisabled();
  expect(await sketchObjects(canvas)).toEqual(baseline);
  await redo.click();
  await expect(delete20).toHaveCount(0);
  await solve.click();
  await expect(page.locator('.sketch-solve-pill')).toHaveText(
    '3 DOF remaining',
    READ_TIMEOUT
  );

  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(page.locator('.save-state')).toHaveClass(
    SAVED_ON_DEVICE,
    READ_TIMEOUT
  );
  await page.reload();
  await expect(canvas).toBeVisible(READ_TIMEOUT);
  await enterSketch(page, canvas);
  const paletteButton = page.getByRole('button', {
    name: 'Sketch palette',
    exact: true
  });
  if ((await paletteButton.getAttribute('aria-expanded')) !== 'true')
    await paletteButton.click();
  await expect(constraints.locator('.sketch-constraint-list > li')).toHaveCount(
    1
  );
  await expect(delete20).toHaveCount(0);
  await constraints
    .getByRole('button', {
      name: `Edit constraint: ${DISTANCE_10}`,
      exact: true
    })
    .click();
  const keypad = page.getByRole('dialog', { name: 'Distance value' });
  const dimensionValue = keypad.getByRole('textbox', {
    name: 'Distance',
    exact: true
  });
  await expect(dimensionValue).toHaveValue('10');
  await dimensionValue.press('Escape');
  await expect(keypad).toHaveCount(0);
  await solve.click();
  await expect(page.locator('.sketch-solve-pill')).toHaveText(
    '3 DOF remaining',
    READ_TIMEOUT
  );
  expect(await sketchObjects(canvas)).toEqual(baseline);
  await testInfo.attach('constraint-recovery-reopened', {
    body: await page.screenshot({
      path: testInfo.outputPath('constraint-recovery-reopened.png')
    }),
    contentType: 'image/png'
  });
  expect(errors).toEqual([]);
});

test('explains a refused solver collapse without inventing a conflicting row', async ({
  page
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  // This is the actual GCS zero-vector perpendicular case protected by the
  // kernel conformance suite. The adapter refuses its collapsed geometry;
  // an exception carries no per-constraint residual that the UI can blame.
  const { document } = fixture('refused-collapse');
  const canvas = await openFixture(page, document);
  const baseline = await sketchObjects(canvas);
  await page.getByRole('button', { name: 'Solve', exact: true }).click();
  const review = page.getByRole('button', {
    name: 'Review constraints',
    exact: true
  });
  await expect(review).toBeVisible(READ_TIMEOUT);
  await expect(
    page
      .getByRole('region', { name: 'Constraint feedback' })
      .getByRole('status')
  ).toHaveText('Solve failed');
  await review.click();
  const constraints = page.locator('.sketch-palette').getByRole('group', {
    name: 'Constraints',
    exact: true
  });
  await expect(
    constraints.getByText('Solve failed', { exact: true })
  ).toBeVisible();
  await expect(
    constraints.getByText(
      'The solver did not identify a conflicting constraint.',
      { exact: false }
    )
  ).toBeVisible();
  await expect(constraints.locator('.sketch-constraint-list > li')).toHaveCount(
    1
  );
  await expect(constraints.locator('[data-conflicted="true"]')).toHaveCount(0);
  expect(await sketchObjects(canvas)).toEqual(baseline);
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true })
  ).toBeDisabled();
  await testInfo.attach('constraint-failure-unknown-attribution', {
    body: await page.screenshot({
      path: testInfo.outputPath('constraint-failure-unknown.png')
    }),
    contentType: 'image/png'
  });
  expect(errors).toEqual([]);
});
