import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  revealModelPanel,
  chooseInPlaceOption,
  extrudeBar,
  enterCommandValue,
  setInPlaceOptionValues,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U09: Extrude runs in place. The region's arrow sets the distance, a second
 * arrow out of the back face the back distance, and a rig hinged on a side
 * wall the draft; each chip opens the keypad, and everything the card held is
 * under the bar's Options. No form opens.
 */

type Handles = Record<string, { x: number; y: number; value: number }>;

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

/** Where each world point is drawn, in page pixels. */
async function projected(
  canvas: Locator,
  points: [number, number, number][]
): Promise<{ x: number; y: number }[]> {
  return canvas.evaluate(
    (element, list) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: list,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    points
  );
}

async function handles(canvas: Locator): Promise<Handles> {
  return canvas.evaluate((element) =>
    element.dataset.e2eCommandHandles
      ? (JSON.parse(element.dataset.e2eCommandHandles) as Handles)
      : {}
  );
}

/** A 20 × 10 plate profile on Top, well clear of the marker. */
function plateDocument(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Marker',
    primitiveKind: 'box',
    dimensions: { width: 4, height: 4, depth: 4 }
  });
  return addSketchFeature(document, {
    name: 'Plate sketch',
    plane: 'XY',
    offset: 0,
    objects: [
      {
        objectKind: 'rectangle',
        width: 20,
        height: 10,
        centerX: 40,
        centerY: 0
      }
    ]
  }).document;
}

async function startExtrude(page: Page, canvas: Locator) {
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  // A region click arms Extrude in place.
  const bar = extrudeBar(page);
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-profile', {
            detail: { index: 0, additive: false }
          })
        )
      );
      return bar.count();
    })
    .toBe(1);
  await expect(page.locator('form.feature-form')).toHaveCount(0);
  // Done waits for a distance.
  await expect(bar.getByRole('button', { name: 'Done' })).toBeDisabled();
  await setInPlaceOptionValues(page, 'Extrude', { Distance: '10' });
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  return bar;
}

test('Extrude in place: a draft dragged on its wall, typed on its chip, refused beside a back distance', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubApi(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openDocument(page, plateDocument('In-place extrude draft'));
  const canvas = page.locator('.viewer-host canvas');
  const bar = await startExtrude(page, canvas);

  // The draft rig stands on a long side's foot, its ball above it. Find
  // which side from where the ball is drawn, then drag it a little inward.
  await expect
    .poll(async () => (await handles(canvas)).draftAngle !== undefined)
    .toBe(true);
  const grip = (await handles(canvas)).draftAngle!;
  // The rig's radius is a third of the profile's size (√(20² + 10²) · 0.3).
  const radius = Math.hypot(20, 10) * 0.3;
  const sides = [-5, 5] as const;
  const balls = await projected(
    canvas,
    sides.map((y) => [40, y, radius] as [number, number, number])
  );
  const side =
    Math.hypot(balls[0]!.x - grip.x, balls[0]!.y - grip.y) <
    Math.hypot(balls[1]!.x - grip.x, balls[1]!.y - grip.y)
      ? sides[0]
      : sides[1];
  const inward = side < 0 ? 1 : -1;
  const lean = (12 * Math.PI) / 180;
  const [target] = await projected(canvas, [
    [40, side + inward * radius * Math.sin(lean), radius * Math.cos(lean)]
  ]);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(target!.x, target!.y, { steps: 12 });
  await page.mouse.up();
  const chip = page.getByTestId('command-handle-draftAngle');
  await expect(chip).toHaveText(/^Draft (\d+)°$/);
  const dragged = Number((await chip.textContent())!.match(/\d+/)![0]);
  expect(dragged).toBeGreaterThan(5);
  expect(dragged).toBeLessThan(20);

  // Its chip opens the keypad: an exact 3°.
  await enterCommandValue(page, 'draftAngle', '3');
  await expect(chip).toHaveText('Draft 3°');
  // The bar's Options read the same value.
  const options = bar.locator('details.in-place-command-options');
  await options.locator('summary').click();
  await expect(
    bar.getByRole('button', { name: 'Draft angle', exact: true })
  ).toContainText('3°');
  await options.locator('summary').click();

  // A back distance beside it is refused by name, as the card refused it,
  // and Done waits until it is cleared.
  await enterCommandValue(page, 'backDistance', '2');
  await expect(bar).toContainText(
    'Draft tapers a one-sided extrusion; clear Back distance to draft it.'
  );
  await expect(bar.getByRole('button', { name: 'Done' })).toBeDisabled();
  await enterCommandValue(page, 'backDistance', '0');
  await expect(bar.getByRole('button', { name: 'Done' })).toBeEnabled({
    timeout: 30_000
  });

  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toHaveCount(0, { timeout: 30_000 });
  await revealModelPanel(page, 'History');
  const row = page.locator('.feature-row', { hasText: 'Extrude' }).last();
  await expect(row).toContainText('3° draft');
  expect(errors).toEqual([]);
});

test('Extrude in place: the back arrow, Symmetric under Options, and Enter to finish', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubApi(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openDocument(page, plateDocument('In-place extrude back'));
  const canvas = page.locator('.viewer-host canvas');
  const bar = await startExtrude(page, canvas);

  // An entry that does not evaluate holds Done, rather than leaving it to
  // create the last valid distance; Escape restores that distance.
  const options = bar.locator('details.in-place-command-options');
  await options.locator('summary').click();
  await bar.getByRole('button', { name: 'Distance', exact: true }).click();
  const keypad = page.locator('.numeric-keypad');
  await keypad.locator('input').fill('10+');
  await expect(bar.getByRole('button', { name: 'Done' })).toBeDisabled();
  await expect(bar).toContainText('Distance:');
  await keypad.locator('input').press('Escape');
  await expect(keypad).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Done' })).toBeEnabled();
  await options.locator('summary').click();

  // The back arrow leaves the profile's middle the other way: drag it down.
  await expect
    .poll(async () => (await handles(canvas)).backDistance !== undefined)
    .toBe(true);
  const grip = (await handles(canvas)).backDistance!;
  const [plane, below] = await projected(canvas, [
    [40, 0, 0],
    [40, 0, -4]
  ]);
  // At zero its chip sits just past the head, down the screen: press the
  // head's upper half, which the chip leaves clear.
  const press = { x: grip.x, y: grip.y - 6 };
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(
    press.x + below!.x - plane!.x,
    press.y + below!.y - plane!.y,
    { steps: 12 }
  );
  await page.mouse.up();
  const chip = page.getByTestId('command-handle-backDistance');
  await expect(chip).toHaveText(/^Back [1-9][\d.]* mm$/);
  // Exact on the keypad.
  await enterCommandValue(page, 'backDistance', '4');
  await expect(chip).toHaveText('Back 4 mm');

  // Symmetric is one-sided's opposite: it takes the back arrow away, and
  // One side brings it back with the value it had.
  await chooseInPlaceOption(page, 'Extrude', 'Sides', 'Symmetric');
  await expect(chip).toHaveCount(0);
  await chooseInPlaceOption(page, 'Extrude', 'Sides', 'One side');
  await expect(chip).toHaveText('Back 4 mm');

  // Enter finishes, as Done does.
  await expect(bar.getByRole('button', { name: 'Done' })).toBeEnabled({
    timeout: 30_000
  });
  // Off the bar's own controls (Enter on Options would open them).
  await page.locator(':focus').blur();
  await page.keyboard.press('Enter');
  await expect(bar).toHaveCount(0, { timeout: 30_000 });
  await revealModelPanel(page, 'History');
  const row = page.locator('.feature-row', { hasText: 'Extrude' }).last();
  await expect(row).toContainText('10 + 4 mm');
  expect(errors).toEqual([]);
});
