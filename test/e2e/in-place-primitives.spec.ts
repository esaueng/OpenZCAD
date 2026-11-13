import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  editExtrudeFromHistory,
  enterCommandValue,
  expectBodyCount,
  extrudeBar,
  finishInPlaceCommand,
  revealModelPanel,
  setInPlaceOptionValues,
  setSelectionFilter,
  waitForStillViewport,
  pressTool
} from './openzcad-fixtures';

/**
 * U09 phase 6: the primitives run in place. A press-drag on the ground or a
 * flat face draws the footprint, the height is an arrow with a chip, and no
 * card opens. Each spec ends by reading what the export stored.
 */

async function openProject(
  page: Page,
  seeded: ProjectDocument | null,
  renderedBodies = 1
) {
  const document =
    seeded ?? createProjectDocument('Drawn primitive', toUserId('user_e2e'));
  // The stub first: the routes below answer the project itself on top of it.
  await stubApi(page, { panelLayout: MODEL_ONLY });
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
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  if (seeded && renderedBodies > 0) {
    await expect(canvas).toHaveAttribute(
      'data-e2e-rendered-bodies',
      String(renderedBodies),
      { timeout: 30_000 }
    );
  }
}

function seededBox(name: string): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_e2e')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 20 }
    }
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

/** Where world points are drawn on the page, through the live camera. */
async function screenPoints(
  page: Page,
  points: [number, number, number][]
): Promise<{ x: number; y: number }[]> {
  return page.locator('.viewer-host canvas').evaluate(
    (element, at) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: at,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    points
  );
}

/** A press at one world point, dragged to another, released. */
async function dragFootprint(
  page: Page,
  from: [number, number, number],
  to: [number, number, number]
) {
  await waitForStillViewport(page);
  const [start, end] = await screenPoints(page, [from, to]);
  await page.mouse.move(start!.x, start!.y);
  await page.mouse.down();
  await page.mouse.move(end!.x, end!.y, { steps: 12 });
  await page.mouse.up();
}

/** The feature after the primitive: its placement Move, if it has one. */
function placementOf(document: ProjectDocument, name: string) {
  const features = listFeaturesInOrder(document);
  const index = features.findIndex((feature) => feature.name === name);
  const primitive = features[index]!;
  const next = features[index + 1];
  return {
    primitive: primitive.data,
    move:
      next?.data.featureKind === 'transform' ? next.data.transform : undefined
  };
}

const round = (value: unknown) => Math.round(Number(value) * 10) / 10;

test('a box is drawn corner to corner on the ground, then given its height', { tag: '@ci-smoke' }, async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, null);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const bar = page.getByRole('group', { name: 'Box command' });
  await expect(bar).toContainText('Drag a footprint on the ground or a face');
  await expect(page.locator('form.feature-form')).toHaveCount(0);

  await dragFootprint(page, [5, 5, 0], [25, 15, 0]);
  await expect(bar).toContainText('Drag the arrows');
  await expect(page.getByTestId('command-handle-width')).toContainText(
    /Width 20(\.0)? mm/
  );
  await expect(page.getByTestId('command-handle-depth')).toContainText(
    /Depth 10(\.0)? mm/
  );
  await enterCommandValue(page, 'height', '7');
  await finishInPlaceCommand(page, 'Box');

  const { primitive, move } = placementOf(await exportedDocument(page), 'Box');
  expect(primitive).toMatchObject({ featureKind: 'primitive' });
  const dimensions =
    primitive.featureKind === 'primitive' ? primitive.dimensions : {};
  expect([dimensions.width, dimensions.height, dimensions.depth].map(round)).toEqual(
    [20, 10, 7]
  );
  expect(
    [move?.translation.x, move?.translation.y, move?.translation.z].map(round)
  ).toEqual([5, 5, 0]);
  expect(move?.rotationDeg).toEqual({ x: 0, y: 0, z: 0 });
});

test('a box drawn right to left names its real lowest corner', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, null);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await dragFootprint(page, [25, 15, 0], [5, 5, 0]);
  await expect(page.getByTestId('command-handle-width')).toContainText(
    /Width 20(\.0)? mm/
  );
  // Options show where the box starts, and a typed corner moves it there.
  const bar = page.getByRole('group', { name: 'Box command' });
  await bar.locator('summary').click();
  await expect(
    bar.getByRole('textbox', { name: 'Corner X', exact: true })
  ).toHaveValue(/^5(\.0)?$/);
  await bar.locator('summary').click();
  await setInPlaceOptionValues(page, 'Box', { 'Corner X': '2' });
  await finishInPlaceCommand(page, 'Box');

  const { move } = placementOf(await exportedDocument(page), 'Box');
  expect(
    [move?.translation.x, move?.translation.y, move?.translation.z].map(round)
  ).toEqual([2, 5, 0]);
});

test('a cylinder drawn on a top face stands on it, whatever the filter', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, seededBox('Cylinder on a face'));
  // A Body filter turns face picks into bodies; the footprint still finds
  // the face it is drawn on (Codex review on #889).
  await setSelectionFilter(page, 'Body');
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await expect(page.getByRole('group', { name: 'Cylinder command' })).toBeVisible();
  await dragFootprint(page, [20, 15, 20], [26, 15, 20]);
  await expect(page.getByTestId('command-handle-radius')).toContainText(
    /Radius 6(\.0)? mm/
  );
  await finishInPlaceCommand(page, 'Cylinder');

  const { primitive, move } = placementOf(
    await exportedDocument(page),
    'Cylinder'
  );
  expect(primitive).toMatchObject({
    featureKind: 'primitive',
    primitiveKind: 'cylinder'
  });
  const dimensions =
    primitive.featureKind === 'primitive' ? primitive.dimensions : {};
  expect(round(dimensions.radius)).toBe(6);
  expect(dimensions.height).toBe(28);
  expect(
    [move?.translation.x, move?.translation.y, move?.translation.z].map(round)
  ).toEqual([20, 15, 20]);
  expect(move?.rotationDeg).toEqual({ x: 0, y: 0, z: 0 });
});

test('a cone drawn on a side face turns to stand out of it', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, seededBox('Cone on a side'));
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await pressTool(page, /^Cone/);
  await expect(page.getByRole('group', { name: 'Cone command' })).toBeVisible();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  // The front face (normal −Y) of the 40 × 30 × 20 block.
  await dragFootprint(page, [20, 0, 10], [25, 0, 10]);
  await expect(page.getByTestId('command-handle-bottomRadius')).toContainText(
    /Bottom radius 5(\.0)? mm/
  );
  await finishInPlaceCommand(page, 'Cone');

  const { primitive, move } = placementOf(await exportedDocument(page), 'Cone');
  expect(primitive).toMatchObject({
    featureKind: 'primitive',
    primitiveKind: 'cone'
  });
  expect(
    [move?.translation.x, move?.translation.y, move?.translation.z].map(round)
  ).toEqual([20, 0, 10]);
  // Its axis, the kernel's +Z, turned onto the face's −Y normal.
  expect(move?.rotationDeg).toEqual({ x: 90, y: 0, z: 0 });
});

test('Escape leaves nothing behind, and Enter alone makes the default box', { tag: '@ci-smoke' }, async ({
  page
}) => {
  await openProject(page, null);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const bar = page.getByRole('group', { name: 'Box command' });
  await dragFootprint(page, [0, 0, 0], [10, 10, 0]);
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Box canceled; nothing was added.'
  );
  await expectBodyCount(page, 0);

  await page.keyboard.press('b');
  await expect(
    bar.getByRole('button', { name: 'Done', exact: true })
  ).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 1);
  const { primitive, move } = placementOf(await exportedDocument(page), 'Box');
  expect(primitive).toMatchObject({
    primitiveKind: 'box',
    dimensions: { width: 30, height: 18, depth: 24 }
  });
  expect(move).toBeUndefined();
});

/** Which way a world axis runs on the page, in degrees, through the camera. */
async function axisAngles(page: Page): Promise<number[]> {
  const [origin, x, y, z] = await screenPoints(page, [
    [0, 0, 0],
    [40, 0, 0],
    [0, 40, 0],
    [0, 0, 40]
  ]);
  return [x!, y!, z!].map(
    (tip) =>
      (Math.atan2(tip.y - origin!.y, tip.x - origin!.x) * 180) / Math.PI
  );
}

test('typed sizes go to the box, not the camera: 100 Tab 60 Tab 6 Enter', { tag: '@ci-smoke' }, async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, null);
  await page.keyboard.press('b');
  const bar = page.getByRole('group', { name: 'Box command' });
  const done = bar.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('command-handle-width')).toContainText(
    'Width 30 mm'
  );
  await waitForStillViewport(page);
  const before = await axisAngles(page);

  // A digit opens Width (it used to be the Front and Back view shortcuts),
  // and each further key is typed into it.
  await page.keyboard.type('100');
  const keypad = page.locator('.numeric-keypad');
  const field = (name: string) =>
    keypad.getByRole('textbox', { name, exact: true });
  await expect(field('Width')).toBeFocused();
  await expect(field('Width')).toHaveValue('100');

  // Tab commits and moves on to the next size (it used to walk to the
  // unit's help, then the keypad button, then Options and Cancel).
  await page.keyboard.press('Tab');
  await expect(field('Depth')).toBeFocused();
  await expect(field('Depth')).toHaveValue('18');
  await expect(page.getByTestId('command-handle-width')).toContainText(
    'Width 100 mm'
  );
  await page.keyboard.type('60');
  await page.keyboard.press('Tab');
  await expect(field('Height')).toBeFocused();
  await expect(field('Height')).toHaveValue('24');
  await page.keyboard.type('6');

  // Enter commits the field and hands focus to the bar, where Enter is Done.
  await page.keyboard.press('Enter');
  await expect(keypad).toHaveCount(0);
  await expect(bar).toBeFocused();
  await expect(bar).toBeVisible();
  for (const [id, text] of [
    ['width', 'Width 100 mm'],
    ['depth', 'Depth 60 mm'],
    ['height', 'Height 6 mm']
  ] as const) {
    await expect(page.getByTestId(`command-handle-${id}`)).toContainText(text);
  }

  // The view kept its direction: no digit turned it to a standard view.
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await waitForStillViewport(page);
  const after = await axisAngles(page);
  for (const [index, angle] of after.entries()) {
    const turned = Math.abs(((angle - before[index]! + 540) % 360) - 180);
    expect(turned, `axis ${'XYZ'[index]} turned on screen`).toBeLessThan(12);
  }

  // The preview was reframed into the clear stage: every corner of the
  // 100 × 60 × 6 plate is left of the instrument rail, right of the tool
  // column, under the top bar and above the command's own bar.
  const corners = await screenPoints(
    page,
    [0, 100].flatMap((x) =>
      [0, 60].flatMap((y) =>
        [0, 6].map((z): [number, number, number] => [x, y, z])
      )
    )
  );
  const box = async (selector: string) =>
    (await page.locator(selector).first().boundingBox())!;
  const rail = await box('.instrument-rail');
  const column = await box('.workspace-column-float');
  const topbar = await box('.app-shell > .topbar');
  const card = (await bar.boundingBox())!;
  for (const corner of corners) {
    expect(corner.x).toBeLessThan(rail.x);
    expect(corner.x).toBeGreaterThan(column.x + column.width);
    expect(corner.y).toBeGreaterThan(topbar.y + topbar.height);
    expect(corner.y).toBeLessThan(card.y);
  }
  // And its value chips stand clear of one another.
  const chips = await Promise.all(
    ['width', 'depth', 'height'].map(
      async (id) =>
        (await page.getByTestId(`command-handle-${id}`).boundingBox())!
    )
  );
  for (const [index, a] of chips.entries()) {
    for (const b of chips.slice(index + 1)) {
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      expect(apart, 'value chips overlap').toBe(true);
    }
  }

  await page.keyboard.press('Enter');
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 1);
  const { primitive, move } = placementOf(await exportedDocument(page), 'Box');
  // The kernel's keys: width is X, height Y (the footprint's depth), depth Z.
  expect(primitive).toMatchObject({
    primitiveKind: 'box',
    dimensions: { width: 100, height: 60, depth: 6 }
  });
  expect(move).toBeUndefined();
});

test('a cylinder takes typed sizes the same way, and Escape puts a value back', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, null);
  await page.keyboard.press('c');
  const bar = page.getByRole('group', { name: 'Cylinder command' });
  const done = bar.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  const keypad = page.locator('.numeric-keypad');
  const field = (name: string) =>
    keypad.getByRole('textbox', { name, exact: true });

  await page.keyboard.type('20');
  await expect(field('Radius')).toHaveValue('20');
  await page.keyboard.press('Tab');
  await expect(field('Height')).toBeFocused();
  // Shift+Tab goes back, leaving a value that was not retyped as it was.
  await page.keyboard.press('Shift+Tab');
  await expect(field('Radius')).toHaveValue('20');
  await page.keyboard.press('Tab');
  await page.keyboard.type('50');
  await page.keyboard.press('Enter');
  await expect(keypad).toHaveCount(0);
  await expect(bar).toBeFocused();

  // A digit typed again reopens the first size; Escape restores it and
  // returns to the bar, and only the next Escape would cancel the command.
  await page.keyboard.type('7');
  await expect(field('Radius')).toHaveValue('7');
  await page.keyboard.press('Escape');
  await expect(keypad).toHaveCount(0);
  await expect(bar).toBeFocused();
  await expect(page.getByTestId('command-handle-radius')).toContainText(
    'Radius 20 mm'
  );

  await expect(done).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(bar).toHaveCount(0);
  await expectBodyCount(page, 1);
  const { primitive } = placementOf(
    await exportedDocument(page),
    'Cylinder'
  );
  expect(primitive).toMatchObject({
    primitiveKind: 'cylinder',
    dimensions: { radius: 20, height: 50 }
  });
});

/**
 * A block, and a 10 mm circle sketched on the ground clear of it: extruded,
 * the circle is a body of its own.
 */
function profileDocument(name: string) {
  return addSketchFeature(seededBox(name), {
    name: 'Profile',
    plane: 'XY',
    objects: [{ objectKind: 'circle', radius: 5, centerX: 80, centerY: 0 }]
  });
}

/** The corners of the post that circle extrudes to, `height` tall. */
const postCorners = (height: number) =>
  [75, 85].flatMap((x) =>
    [-5, 5].flatMap((y) =>
      [0, height].map((z): [number, number, number] => [x, y, z])
    )
  );

// The in-place Extrude is its own command, not the primitives' path, and a
// typed distance that took its preview out of the stage left it there: the
// post ran up under the top bar and out of the window.
test('a typed Extrude distance that leaves the stage reframes the new body', { tag: '@ci-smoke' }, async ({
  page
}) => {
  test.setTimeout(120_000);
  await openProject(page, profileDocument('Typed extrude').document);
  await waitForStillViewport(page);
  await page.keyboard.press('e');
  const bar = extrudeBar(page);
  await expect(bar).toBeVisible({ timeout: 30_000 });
  const done = bar.getByRole('button', { name: 'Done', exact: true });
  const keypad = page.locator('.numeric-keypad');
  // A digit is the distance; Enter sets it.
  const typeDistance = async (text: string) => {
    await page.keyboard.type(text);
    await expect(keypad.locator('input')).toHaveValue(text);
    await keypad.locator('input').press('Enter');
    await expect(keypad).toHaveCount(0);
    await expect(done).toBeEnabled({ timeout: 30_000 });
  };
  const stage = async () => {
    const box = async (selector: string) =>
      (await page.locator(selector).first().boundingBox())!;
    const rail = await box('.instrument-rail');
    const column = await box('.workspace-column-float');
    const topbar = await box('.app-shell > .topbar');
    const card = (await bar.boundingBox())!;
    return {
      left: column.x + column.width,
      right: rail.x,
      top: topbar.y + topbar.height,
      bottom: card.y
    };
  };
  const inside = async (height: number) => {
    const frame = await stage();
    return (await screenPoints(page, postCorners(height))).every(
      (corner) =>
        corner.x > frame.left &&
        corner.x < frame.right &&
        corner.y > frame.top &&
        corner.y < frame.bottom
    );
  };
  // A first distance, so the 400 below is a change to a preview already up
  // (the first body in an empty scene is fitted whatever asked for it).
  await typeDistance('10');
  await waitForStillViewport(page);
  // A 400 mm one does not fit: the value below has something to do.
  expect(await inside(400)).toBe(false);
  const before = await axisAngles(page);

  await typeDistance('400');

  // The preview is back in the clear stage: left of the instrument rail,
  // right of the tool column, under the top bar, above the command's bar.
  await expect.poll(() => inside(400), { timeout: 20_000 }).toBe(true);
  await waitForStillViewport(page);
  expect(await inside(400)).toBe(true);
  // Reframed, not turned: the view keeps its direction.
  const after = await axisAngles(page);
  for (const [index, angle] of after.entries()) {
    const turned = Math.abs(((angle - before[index]! + 540) % 360) - 180);
    expect(turned, `axis ${'XYZ'[index]} turned on screen`).toBeLessThan(12);
  }

  await done.click();
  await expect(bar).toHaveCount(0, { timeout: 30_000 });
  await expectBodyCount(page, 2);
});

// The other half of the rule: an extrude being edited is an edit, and a
// typed distance never moves the camera under it, however far it reaches.
test('a typed distance on an extrude being edited keeps the camera', async ({
  page
}) => {
  test.setTimeout(120_000);
  const sketched = profileDocument('Edited extrude');
  const document = extrudeSketch(sketched.document, {
    name: 'Post',
    sketchId: sketched.sketchId,
    distance: 10
  }).document;
  await openProject(page, document, 2);
  await revealModelPanel(page, 'History');
  const bar = await editExtrudeFromHistory(
    page,
    page.locator('.feature-row-main[title^="Post — "]'),
    'Post'
  );
  const done = bar.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await waitForStillViewport(page);
  const marks: [number, number, number][] = [
    [0, 0, 0],
    [40, 0, 0],
    [0, 0, 40]
  ];
  const before = await screenPoints(page, marks);

  await enterCommandValue(page, 'distance', '400');
  await expect(page.getByTestId('command-handle-distance')).toHaveText(
    '400 mm'
  );
  await expect(done).toBeEnabled({ timeout: 30_000 });
  // Long enough for a reframe to have started, had one been asked for.
  await page.waitForTimeout(800);
  await waitForStillViewport(page);
  const after = await screenPoints(page, marks);
  for (const [index, point] of after.entries()) {
    expect(Math.abs(point.x - before[index]!.x)).toBeLessThan(1);
    expect(Math.abs(point.y - before[index]!.y)).toBeLessThan(1);
  }
  await page.keyboard.press('Escape');
});
