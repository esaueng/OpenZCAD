import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import { expectReachable } from './compactHelpers';
import {
  expect,
  locateEdge,
  modelPanel,
  pickPlanarFace,
  pressTool,
  revealModelPanel,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * A running command on an upright phone, in the regular workspace (390 × 844,
 * touch): what the command says and the rows it asks to be picked stay on
 * top, and a tap on a small face at Fit View picks it.
 *
 * Fixtures are synthetic boxes, in mm, each with a corner at the origin.
 */
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true
});

/** Opens `document` as a new project, once its `bodies` live bodies draw. */
async function openSeeded(
  page: Page,
  document: ProjectDocument,
  bodies = document.bodyOrder.length
) {
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
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    String(bodies),
    { timeout: 60_000 }
  );
}

function boxDocument(name: string, size = 20): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_e2e')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: size, height: size, depth: size }
    }
  );
}

/** Where the world point `at` is drawn, in page pixels. */
async function projected(page: Page, at: [number, number, number]) {
  const [point] = await page.locator('.viewer-host canvas').evaluate(
    (element, points) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    [at]
  );
  return point!;
}

/** The handle each command value's arrow stands on, in page pixels. */
async function commandHandles(page: Page) {
  const raw = await page
    .locator('.viewer-host canvas')
    .getAttribute('data-e2e-command-handles');
  return JSON.parse(raw ?? '{}') as Record<
    string,
    { x: number; y: number; value: number }
  >;
}

/**
 * Whether `element` is drawn whole on top: at its middle and at each corner,
 * a little inside, the topmost element is it or inside it.
 */
function onTop(locator: Locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const inset = Math.min(4, box.width / 4, box.height / 4);
    return [
      [box.x + box.width / 2, box.y + box.height / 2],
      [box.left + inset, box.top + inset],
      [box.right - inset, box.top + inset],
      [box.left + inset, box.bottom - inset],
      [box.right - inset, box.bottom - inset]
    ].every(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return hit !== null && element.contains(hit);
    });
  });
}

/** Types `value` into the open value's field and presses Enter. */
async function typeIntoKeypad(page: Page, value: string) {
  const keypad = page.locator('.numeric-keypad');
  await expect(keypad).toBeVisible();
  await expect(keypad).toHaveAttribute('data-placement', 'sheet');
  await keypad.locator('input').fill(value);
  await keypad.locator('input').press('Enter');
  return keypad;
}

/**
 * The refused value's field keeps its own line, and the command's bar,
 * which stands on the keypad's sheet, keeps its sentence in view.
 */
async function expectRefusalReadable(
  page: Page,
  bar: Locator,
  keypad: Locator,
  sentence: RegExp
) {
  const hint = bar.locator('.in-place-command-hint');
  await expect(hint).toHaveText(sentence, { timeout: 30_000 });
  await expect(bar.getByRole('button', { name: /Done/ })).toBeDisabled();
  // The keypad stays open on the value, its own reason under the field.
  await expect(keypad).toBeVisible();
  await expect(keypad).toContainText(/must be/);
  await expect(hint).toBeInViewport({ ratio: 1 });
  await expect.poll(() => onTop(hint)).toBe(true);
  const [hintBox, keypadBox] = await Promise.all([
    hint.boundingBox(),
    keypad.boundingBox()
  ]);
  expect(hintBox!.y + hintBox!.height).toBeLessThanOrEqual(keypadBox!.y);
  // Cancel and Done stay a tap away above the sheet.
  await expectReachable(bar.getByRole('button', { name: 'Cancel' }));
}

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test('a refused Solid offset keeps the bar’s sentence above the open value', async ({
      page
    }) => {
      test.setTimeout(120_000);
      await openSeeded(page, boxDocument('Phone offset refusal'));
      await pressTool(page, /^Solid offset/);
      const bar = page.getByRole('group', { name: 'Solid offset command' });
      await page.getByTestId('command-handle-distance').click();
      const keypad = await typeIntoKeypad(page, '-1');
      await expectRefusalReadable(page, bar, keypad, /more than 0/);
      // A value that builds closes the sheet; the bar goes back to its foot.
      await keypad.locator('input').fill('1');
      await keypad.locator('input').press('Enter');
      await expect(keypad).toHaveCount(0);
      await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
        timeout: 30_000
      });
      const lane = await page.locator('.command-bar-lane').boundingBox();
      expect(lane!.y + lane!.height).toBeGreaterThan(844 - 20);
    });
  });
}

test('a refused Draft angle keeps the bar’s sentence above the open value', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openSeeded(page, boxDocument('Phone draft refusal'));
  await pressTool(page, /^Draft/);
  const bar = page.getByRole('group', { name: 'Draft command' });
  await expect
    .poll(() => pickPlanarFace(page, { x: 1, y: 0, z: 0 }), {
      timeout: 60_000
    })
    .not.toBeNull();
  await page.getByTestId('command-handle-angle').click();
  const keypad = await typeIntoKeypad(page, '90');
  await expectRefusalReadable(page, bar, keypad, /less than 90/);
});

test('a refused Gear tooth count keeps the bar’s sentence above the open value', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openSeeded(page, boxDocument('Phone gear refusal', 40));
  await pressTool(page, /^Gear(?! teeth)/);
  const bar = page.getByRole('group', { name: 'Gear command' });
  await expect
    .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }), {
      timeout: 60_000
    })
    .not.toBeNull();
  await page.getByTestId('command-handle-teeth').click();
  const keypad = await typeIntoKeypad(page, '0');
  await expectRefusalReadable(page, bar, keypad, /\S/);
});

test('the Select other list stands over the Objects panel', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openSeeded(page, boxDocument('Phone select other'));
  await revealModelPanel(page, 'Objects');
  await waitForStillViewport(page);
  const edge = await locateEdge(page);
  // A long press arrives as a touch contextmenu, which takes the top target
  // and leads its menu with Select other.
  await page.locator('.viewer-host canvas').evaluate(
    (element, point) =>
      element.dispatchEvent(
        new PointerEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
          pointerType: 'touch'
        })
      ),
    edge
  );
  const actions = page.locator('.context-menu');
  await actions.getByRole('menuitem', { name: /^Select other/ }).click();
  const list = page.getByTestId('topology-pick-list');
  await expect(list).toBeVisible();
  const rows = list.getByRole('menuitem');
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  await expect(list).toBeInViewport({ ratio: 1 });
  await expect.poll(() => onTop(list)).toBe(true);
  for (const row of await rows.all()) await expectReachable(row);
  // A row taken by a tap selects what it names.
  await rows.last().tap();
  await expect(list).toBeHidden();
});

test('Edit Subtract’s restored Objects rows stand clear of the command bar', async ({
  page
}) => {
  test.setTimeout(150_000);
  // Block 20 × 10 × 10 and Post 10 × 10 × 30 moved to overlap it; Block − Post.
  let document = createProjectDocument(
    'Phone edit subtract',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 10 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 30 }
  });
  const [block, post] = document.bodyOrder as [BodyId, BodyId];
  document = transformBody(document, {
    name: 'Place Post',
    targetBodyId: post,
    translation: { x: 15, y: 5, z: 0 }
  }).document;
  document = booleanBodies(document, {
    name: 'Subtract',
    operation: 'subtract',
    targetBodyIds: [block, post]
  }).document;
  await openSeeded(page, document, 1);
  const canvas = page.locator('.viewer-host canvas');

  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row-main', { hasText: 'Subtract' })
    .last()
    .click();
  const edit = page.getByRole('group', { name: 'Edit Subtract command' });
  await expect(edit).toBeVisible();
  const done = edit.getByRole('button', { name: 'Done' });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await edit.locator('summary').click();
  const operands = edit.getByRole('list', { name: 'Boolean operands' });
  await operands.getByRole('button', { name: /Remove 1 Base · Block/ }).click();
  await edit.locator('summary').click();
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', post);

  await revealModelPanel(page, 'Objects');
  const objects = modelPanel(page, 'Objects');
  const row = (bodyId: BodyId) =>
    objects.locator(`.body-row-main[data-body-row="${bodyId}"]`);
  await expect(row(block)).toBeVisible();
  await expect(row(post)).toBeVisible();
  // The panel ends above the bar: both rows are whole and on top.
  const [panelBox, barBox] = await Promise.all([
    objects.boundingBox(),
    edit.boundingBox()
  ]);
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(barBox!.y);
  for (const bodyId of [block, post]) await expectReachable(row(bodyId));
  // A tap on Block's row takes it back, as the Tool: the roles reverse.
  await row(block).tap();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${post},${block}`
  );
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await edit.getByRole('button', { name: 'Cancel' }).tap();
  await expect(edit).toHaveCount(0);
});

test('Hole takes a tap on a small face at Fit View', async ({ page }) => {
  test.setTimeout(150_000);
  // Large 40 mm box at the origin; Small 6 mm box set apart on +X.
  let document = createProjectDocument(
    'Phone small face hole',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Large',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 40, depth: 40 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Small',
    primitiveKind: 'box',
    dimensions: { width: 6, height: 6, depth: 6 }
  });
  const small = document.bodyOrder[1] as BodyId;
  document = transformBody(document, {
    name: 'Place Small',
    targetBodyId: small,
    translation: { x: 50, y: 0, z: 0 }
  }).document;
  await openSeeded(page, document);
  await page.keyboard.press('f');
  await waitForStillViewport(page);

  await pressTool(page, /^Hole/);
  const bar = page.getByRole('group', { name: 'Hole command' });
  await expect(bar).toContainText('Click a flat face');
  await waitForStillViewport(page);
  const large = await projected(page, [20, 20, 40]);
  await page.touchscreen.tap(large.x, large.y);
  await expect(bar).toContainText('drag the diameter', { timeout: 30_000 });
  await page.getByTestId('command-handle-diameter').click();
  const keypad = await typeIntoKeypad(page, '3');
  await expect(keypad).toHaveCount(0);
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  const onLarge = (await commandHandles(page)).diameter!;
  expect(Math.hypot(onLarge.x - large.x, onLarge.y - large.y)).toBeLessThan(40);

  // The small box's top is a few dozen pixels across at this scale, inside
  // a finger's edge band all over: the tap still takes the face.
  const corners = await Promise.all(
    (
      [
        [50, 0, 6],
        [56, 0, 6],
        [56, 6, 6],
        [50, 6, 6]
      ] as [number, number, number][]
    ).map((at) => projected(page, at))
  );
  const across = Math.max(
    ...corners.flatMap((a) =>
      corners.map((b) => Math.hypot(a.x - b.x, a.y - b.y))
    )
  );
  expect(across).toBeLessThan(60);

  // Just past the small box's outline, on bare stage, a tap moves nothing:
  // the band never hands it to a face that is not under the finger.
  const below = await projected(page, [53, -2, 0]);
  const outside = await projected(page, [53, 0, 0]);
  await page.touchscreen.tap(
    outside.x + (below.x - outside.x) * 0.5,
    outside.y + Math.max(6, (below.y - outside.y) * 0.5)
  );
  await page.waitForTimeout(500);
  const stayed = (await commandHandles(page)).diameter!;
  expect(Math.hypot(stayed.x - onLarge.x, stayed.y - onLarge.y)).toBeLessThan(
    1
  );

  const top = await projected(page, [53, 3, 6]);
  await page.touchscreen.tap(top.x, top.y);
  await expect
    .poll(
      async () => {
        const handle = (await commandHandles(page)).diameter;
        return handle ? Math.hypot(handle.x - top.x, handle.y - top.y) : null;
      },
      { timeout: 30_000 }
    )
    .toBeLessThan(25);
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
});
