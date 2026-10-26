import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY,
  waitForStillViewport,
  openMoveOptions
} from './openzcad-fixtures';

/**
 * U09 phase 1: Revolve runs in place. No card opens: the profile is a region
 * click, the axis is a click on one of the lines the viewport draws, and the
 * angle is a drag of the handle or an entry in the keypad its chip opens.
 * Nothing in this spec types into a form field except that keypad.
 */

/** Serves `document` as the project the start screen's Create returns. */
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
  await page.getByRole('button', { name: 'Create project' }).click();
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

/** Where `point` is drawn, in page pixels. */
async function projected(
  canvas: Locator,
  point: [number, number, number]
): Promise<{ x: number; y: number }> {
  return canvas.evaluate(
    (element, points) =>
      new Promise<{ x: number; y: number }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points[0]!)
            }
          })
        );
      }),
    [point]
  );
}

async function commandHandle(
  canvas: Locator
): Promise<{ x: number; y: number; value: number } | null> {
  return canvas.evaluate((element) =>
    element.dataset.e2eCommandHandles
      ? ((
          JSON.parse(element.dataset.e2eCommandHandles) as Record<
            string,
            { x: number; y: number; value: number }
          >
        ).angle ?? null)
      : null
  );
}

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

test('Revolve runs in place: region, axis line, angle drag, keypad, Done', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  let document = createProjectDocument(
    'In-place revolve',
    toUserId('user_e2e')
  );
  // A body far off to one side, so the viewer has something rendered to
  // report before the revolve exists.
  document = addPrimitiveFeature(document, {
    name: 'Marker',
    primitiveKind: 'box',
    dimensions: { width: 6, height: 6, depth: 6 }
  });
  // An annulus profile on Front (XZ), r = 10..20, z = 0..10, drawn as four
  // separate edges exactly as the Rectangle tool draws one.
  document = addSketchFeature(document, {
    name: 'Profile',
    plane: 'XZ',
    offset: 0,
    objects: [
      { objectKind: 'line', x1: -10, y1: 0, x2: -20, y2: 0 },
      { objectKind: 'line', x1: -20, y1: 0, x2: -20, y2: 10 },
      { objectKind: 'line', x1: -20, y1: 10, x2: -10, y2: 10 },
      { objectKind: 'line', x1: -10, y1: 10, x2: -10, y2: 0 }
    ]
  }).document;
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });

  // Frame the sketch as well as the marker, so its axis is on screen, and
  // fold the extra tools away: their flyout stands over the left of the stage.
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }

  // Revolve opens no card: its bar takes the guidance row.
  await page.keyboard.press('r');
  const bar = page.getByRole('group', { name: 'Revolve command' });
  await expect(bar).toContainText('Pick a sketch profile');
  await expect(page.locator('form.feature-form')).toHaveCount(0);
  await expect(bar.getByRole('button', { name: /Done/ })).toBeDisabled();

  await expect
    .poll(async () => {
      await pickProfile(canvas, 0);
      return bar.textContent();
    })
    .toContain('Pick the axis');

  // The sketch's vertical axis is world Z on Front. Click it above the
  // profile: below it, the line can run under the command bar.
  const onAxis = await projected(canvas, [0, 0, 16]);
  await page.mouse.click(onAxis.x, onAxis.y);
  await expect(bar).toContainText('Drag the angle');
  // The exact preview lands before Done is offered.
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  const chip = page.getByTestId('command-handle-angle');
  await expect(chip).toHaveText('360°');

  // Drag the ball a quarter turn round the circle: centred on the axis at the
  // profile's mid height, radius just outside its outer edge.
  const handle = (await commandHandle(canvas))!;
  const quarter = await projected(canvas, [0, -23, 5]);
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(quarter.x, quarter.y, { steps: 16 });
  await page.mouse.up();
  await expect(chip).not.toHaveText('360°');
  await expect
    .poll(async () => (await commandHandle(canvas))?.value ?? 0)
    .toBeGreaterThan(30);
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });

  // The chip opens the keypad; an exact angle replaces the dragged one.
  await chip.click();
  const keypad = page.locator('.numeric-keypad');
  await expect(keypad).toBeVisible();
  await keypad.locator('input').fill('270');
  await keypad.locator('input').press('Enter');
  await expect(keypad).toHaveCount(0);
  await expect(chip).toHaveText('270°');
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });

  await bar.getByRole('button', { name: /Done/ }).click();
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 2);

  const saved = await exportedDocument(page);
  const revolves = listFeaturesInOrder(saved).flatMap((feature) =>
    feature.data.featureKind === 'revolve' ? [feature.data] : []
  );
  expect(revolves).toHaveLength(1);
  expect(revolves[0]).toMatchObject({
    axis: 'vertical',
    angleDeg: 270,
    profile: expect.any(Object)
  });
  expect(errors).toEqual([]);
});

test('Escape leaves an in-place Revolve with nothing added', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  let document = createProjectDocument('Revolve escape', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Marker',
    primitiveKind: 'box',
    dimensions: { width: 6, height: 6, depth: 6 }
  });
  document = addSketchFeature(document, {
    name: 'Profile',
    plane: 'XZ',
    offset: 0,
    object: {
      objectKind: 'rectangle',
      width: 10,
      height: 10,
      centerX: -15,
      centerY: 5
    }
  }).document;
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  await page.keyboard.press('r');
  const bar = page.getByRole('group', { name: 'Revolve command' });
  await expect
    .poll(async () => {
      await pickProfile(canvas, 0);
      return bar.textContent();
    })
    .toContain('Pick the axis');
  const onAxis = await projected(canvas, [0, 0, 16]);
  await page.mouse.click(onAxis.x, onAxis.y);
  await expect(bar).toContainText('Drag the angle');
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 1);
});

test('an unapplied Move is asked about before Revolve starts', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  let document = createProjectDocument(
    'Revolve after Move',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Marker',
    primitiveKind: 'box',
    dimensions: { width: 6, height: 6, depth: 6 }
  });
  document = addSketchFeature(document, {
    name: 'Profile',
    plane: 'XZ',
    offset: 0,
    object: {
      objectKind: 'rectangle',
      width: 10,
      height: 10,
      centerX: -15,
      centerY: 5
    }
  }).document;
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const move = page.getByRole('form', { name: 'Move controls' });
  await openMoveOptions(move);
  await move.getByLabel('Move X in mm').fill('5');

  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: /^Revolve \(R\)/ }).click();
  const ask = page.getByRole('alertdialog', { name: 'Apply the Move first?' });
  await expect(ask).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Revolve command' })
  ).toHaveCount(0);
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(
    page.getByRole('group', { name: 'Revolve command' })
  ).toBeVisible();
  await expect(move).toHaveCount(0);
});

test('switching workspace ends an in-place Revolve', async ({ page }) => {
  test.setTimeout(90_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  let document = createProjectDocument(
    'Revolve then View',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Marker',
    primitiveKind: 'box',
    dimensions: { width: 6, height: 6, depth: 6 }
  });
  // Revolve needs a closed profile to be available at all.
  document = addSketchFeature(document, {
    name: 'Profile',
    plane: 'XZ',
    offset: 0,
    object: {
      objectKind: 'rectangle',
      width: 10,
      height: 10,
      centerX: -15,
      centerY: 5
    }
  }).document;
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('r');
  const bar = page.getByRole('group', { name: 'Revolve command' });
  await expect(bar).toBeVisible();
  const modes = page.getByRole('group', { name: 'Workspace mode' });
  await modes.getByRole('button', { name: 'View', exact: true }).click();
  await expect(bar).toHaveCount(0);
  await modes.getByRole('button', { name: 'Build', exact: true }).click();
  await expect(bar).toHaveCount(0);
});
