import {
  createProject,
  expect,
  modelPanel,
  railPanelButton,
  stubApi,
  test,
  type PanelTitle,
  type SeedPanelLayout
} from './openzcad-fixtures';
import type { Locator, Page } from '@playwright/test';

/*
  The model panels' drag and drop, the left dock and the dock cap (U08
  slice 4). A panel moves by its header or out of its rail button: it
  shrinks to a chip beside the cursor and a slot previews where it lands —
  a column at a slot, a new column past either rail (the rail sliding over
  while that target is hovered), or a window on the model. The Move menu,
  Alt+↑/↓ and the gaps' arrow keys do the same from the keyboard. The docks'
  whole footprint keeps the model 40% of the stage, parking columns past it,
  and a phone-width stage shows one panel by recency. Floating windows have
  their own spec, `panel-float.spec.ts`.
*/

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

async function box(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

function centre(bounds: Box): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** The panels docked on one side, edge column first, top to bottom. */
function dockedTitles(page: Page, side: 'left' | 'right') {
  return page
    .locator(`.panel-column[data-side="${side}"]`)
    .evaluateAll((columns) =>
      columns.map((column) =>
        [...column.querySelectorAll('.model-panel')].map(
          (panel) => panel.getAttribute('aria-label') ?? ''
        )
      )
    );
}

async function storedLayout(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('openzcad-panel-layout:v1');
    return raw
      ? (JSON.parse(raw) as {
          left: string[][];
          right: string[][];
          floats: Array<{ id: string; panels: string[] }>;
          unpinned: string | null;
        })
      : null;
  });
}

async function openWorkspace(
  page: Page,
  name: string,
  panelLayout: SeedPanelLayout,
  viewport = { width: 1440, height: 900 }
) {
  await page.setViewportSize(viewport);
  await stubApi(page, { panelLayout });
  await createProject(page, name);
  await expect(page.getByRole('toolbar', { name: 'Model panels' })).toBeVisible(
    { timeout: 30_000 }
  );
}

/** Presses a panel's header (its title) and moves past the 4px threshold. */
async function pickUp(page: Page, title: PanelTitle) {
  const heading = await box(
    modelPanel(page, title).locator('.model-panel-title')
  );
  const start = { x: heading.x + 24, y: heading.y + heading.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 3 });
  await expect(page.locator('.panel-drag-chip')).toHaveText(title);
  return start;
}

/** The verb rail's island, on the left dock's inner edge. */
const verbRail = (page: Page) => page.locator('.workspace-column-float');
const instrumentRail = (page: Page) => page.locator('.instrument-rail');

test('a header drag stacks a panel at the slot it previews, and the emptied left column holds until the drop', async ({
  page
}) => {
  await openWorkspace(page, 'Drag to a column', {
    left: [['bodies']],
    right: [['parameters', 'history']]
  });
  // The left dock: Objects against the edge, the verb rail on its inner
  // edge, and the bottom lane starting past both.
  const left = await box(page.locator('.panel-column[data-side="left"]'));
  expect(left.x).toBeCloseTo(10, 0);
  await expect
    .poll(async () => (await box(verbRail(page))).x - (left.x + left.width))
    .toBeCloseTo(10, 0);
  const lane = await box(page.locator('.command-bar-lane'));
  expect(lane.x).toBeGreaterThan(left.x + left.width);
  expect(
    await page
      .locator('.workspace')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--left-dock-w').trim()
      )
  ).toBe('306px');

  const railBefore = await box(verbRail(page));
  const historyBefore = await box(modelPanel(page, 'History'));
  await pickUp(page, 'Objects');
  // Lifted out: the panel is a chip now, and its column keeps its place.
  await expect(modelPanel(page, 'Objects')).toHaveCount(0);
  // Over the top of History: the slot lands between the two.
  await page.mouse.move(
    historyBefore.x + historyBefore.width / 2,
    historyBefore.y + 20,
    { steps: 10 }
  );
  const slot = page.locator(
    '.panel-column[data-side="right"] .panel-drop-slot'
  );
  await expect(slot).toBeVisible();
  const [parameters, preview, history] = [
    await box(modelPanel(page, 'Parameters')),
    await box(slot),
    await box(modelPanel(page, 'History'))
  ];
  expect(parameters.y + parameters.height).toBeLessThan(preview.y);
  expect(preview.y + preview.height).toBeLessThan(history.y);
  // The neighbours moved apart to make room.
  expect(history.y).toBeGreaterThan(historyBefore.y + 20);
  // Nothing else moved: the verb rail stays beside the emptied column.
  expect((await box(verbRail(page))).x).toBeCloseTo(railBefore.x, 0);
  await page.mouse.up();

  await expect(page.locator('.panel-drag-chip')).toHaveCount(0);
  expect(await dockedTitles(page, 'right')).toEqual([
    ['Parameters', 'Objects', 'History']
  ]);
  expect(await dockedTitles(page, 'left')).toEqual([]);
  // Dropped, the empty column goes and the rail returns to the edge.
  await expect
    .poll(async () => (await box(verbRail(page))).x)
    .toBeCloseTo(10, 0);
  expect(await storedLayout(page)).toMatchObject({
    left: [],
    right: [['parameters', 'bodies', 'history']]
  });
});

test('a drag past either rail makes a new column, the rail sliding over while it is hovered', async ({
  page
}) => {
  await openWorkspace(page, 'Drag to a new column', {
    right: [['parameters', 'history']]
  });
  const step = 306;

  // Left: just past the verb rail, at the screen's edge.
  const verbBefore = await box(verbRail(page));
  await pickUp(page, 'History');
  await page.mouse.move(160, 400, { steps: 12 });
  await expect(
    page.locator('.panel-column[data-side="left"] .panel-drop-slot')
  ).toBeVisible();
  await expect
    .poll(async () => (await box(verbRail(page))).x - verbBefore.x)
    .toBeCloseTo(step, 0);
  // Still the same target where the rail now stands: no flicker.
  await page.mouse.move(verbBefore.x + step + 20, 420, { steps: 4 });
  await expect(
    page.locator('.panel-column[data-side="left"] .panel-drop-slot')
  ).toBeVisible();
  await page.mouse.up();
  expect(await dockedTitles(page, 'left')).toEqual([['History']]);
  expect(await dockedTitles(page, 'right')).toEqual([['Parameters']]);

  // Right: just inside the instrument rail.
  const instrumentsBefore = await box(instrumentRail(page));
  await pickUp(page, 'History');
  await page.mouse.move(instrumentsBefore.x - 120, 400, { steps: 12 });
  const slot = page.locator(
    '.panel-column[data-side="right"] .panel-drop-slot'
  );
  await expect(slot).toBeVisible();
  await expect
    .poll(async () => instrumentsBefore.x - (await box(instrumentRail(page))).x)
    .toBeCloseTo(step, 0);
  // The new column stands next to the rail, inside the existing one.
  const parameters = await box(modelPanel(page, 'Parameters'));
  expect((await box(slot)).x + (await box(slot)).width).toBeLessThan(
    parameters.x
  );
  await page.mouse.up();
  expect(await dockedTitles(page, 'right')).toEqual([
    ['Parameters'],
    ['History']
  ]);
  expect(await dockedTitles(page, 'left')).toEqual([]);
  expect(await storedLayout(page)).toMatchObject({
    left: [],
    right: [['parameters'], ['history']]
  });
});

test('a drop on the model floats the panel where it lands, and a rail drag-out opens one in place', async ({
  page
}) => {
  await openWorkspace(page, 'Drag to float', { right: [['parameters']] });
  await pickUp(page, 'Parameters');
  const drop = { x: 640, y: 380 };
  await page.mouse.move(drop.x, drop.y, { steps: 10 });
  // The slot is the window it will become, under the cursor.
  const ghost = page.locator('.panel-float.is-slot');
  await expect(ghost).toBeVisible();
  const shadow = await box(ghost);
  expect(drop.x).toBeGreaterThan(shadow.x);
  expect(drop.x).toBeLessThan(shadow.x + shadow.width);
  await page.mouse.up();
  const window = page.locator('.panel-float').filter({
    has: modelPanel(page, 'Parameters')
  });
  await expect(window).toBeVisible();
  await expect(modelPanel(page, 'Parameters')).toHaveClass(/is-floating/);
  // Held where it was taken: the grabbed point of the header is still under
  // the cursor.
  const header = await box(
    modelPanel(page, 'Parameters').locator('.model-panel-header')
  );
  expect(drop.y).toBeGreaterThanOrEqual(header.y);
  expect(drop.y).toBeLessThanOrEqual(header.y + header.height);
  expect(await dockedTitles(page, 'right')).toEqual([]);
  expect((await storedLayout(page))!.floats).toMatchObject([
    { panels: ['parameters'] }
  ]);

  // Out of the rail: within 60px of the press nothing takes the drop, so a
  // short drag leaves the closed panel closed.
  const revisions = railPanelButton(page, 'Revisions');
  const button = centre(await box(revisions));
  await page.mouse.move(button.x, button.y);
  await page.mouse.down();
  await page.mouse.move(button.x - 30, button.y, { steps: 6 });
  await expect(page.locator('.panel-drag-chip')).toHaveText('Revisions');
  await expect(page.locator('.panel-drop-slot')).toHaveCount(0);
  await page.mouse.up();
  await expect(revisions).toHaveAttribute('aria-pressed', 'false');
  await expect(modelPanel(page, 'Revisions')).toHaveCount(0);
  // Dragged clear of the rail, it opens where it is dropped.
  await page.mouse.move(button.x, button.y);
  await page.mouse.down();
  await page.mouse.move(button.x - 80, button.y, { steps: 6 });
  await page.mouse.move(160, 400, { steps: 12 });
  await expect(
    page.locator('.panel-column[data-side="left"] .panel-drop-slot')
  ).toBeVisible();
  await page.mouse.up();
  expect(await dockedTitles(page, 'left')).toEqual([['Revisions']]);
  await expect(revisions).toHaveAttribute('aria-pressed', 'true');
  // A press that does not move is still a click.
  await railPanelButton(page, 'History').click();
  await expect(modelPanel(page, 'History')).toHaveClass(/is-unpinned/);
});

test('a drag the page loses ends as a cancel and leaves the layout as it was', async ({
  page
}) => {
  await openWorkspace(page, 'Lost drag', {
    right: [['parameters', 'history']]
  });
  const arrangement = async () => {
    const stored = await storedLayout(page);
    return { left: stored!.left, right: stored!.right, floats: stored!.floats };
  };
  const before = await arrangement();
  const layer = page.locator('.panel-dock-layer');
  const lost = [
    // The window losing focus mid-drag: no release may ever arrive.
    () => page.evaluate(() => window.dispatchEvent(new Event('blur'))),
    // The pointer taken from the layer that holds it.
    () =>
      layer.evaluate((element) =>
        element.dispatchEvent(
          new PointerEvent('lostpointercapture', { pointerId: 1 })
        )
      )
  ];
  for (const lose of lost) {
    await pickUp(page, 'History');
    await page.mouse.move(160, 400, { steps: 8 });
    await expect(page.locator('.panel-drop-slot')).toBeVisible();
    // The layer holds the pointer, so a release outside the window reaches it.
    expect(
      await layer.evaluate((element) => element.hasPointerCapture(1))
    ).toBe(true);
    await lose();
    await expect(page.locator('.panel-drag-chip')).toHaveCount(0);
    await expect(page.locator('.panel-drag-shield')).toHaveCount(0);
    await expect(modelPanel(page, 'History')).toHaveClass(/is-docked/);
    expect(
      await layer.evaluate((element) => element.hasPointerCapture(1))
    ).toBe(false);
    // The release that follows does nothing.
    await page.mouse.up();
    expect(await dockedTitles(page, 'right')).toEqual([
      ['Parameters', 'History']
    ]);
    expect(await dockedTitles(page, 'left')).toEqual([]);
    expect(await arrangement()).toEqual(before);
  }
  // Nothing is left holding the stage: the model takes the pointer again.
  expect(
    await page.evaluate(
      () => document.elementFromPoint(700, 400)?.tagName ?? null
    )
  ).toBe('CANVAS');
});

/** Opens a panel's Move menu from its grip and picks an item, by keys. */
async function moveByKeys(page: Page, title: PanelTitle, item: string) {
  const grip = modelPanel(page, title).getByRole('button', {
    name: `Move ${title}`
  });
  await grip.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: `Move ${title}` });
  await expect(menu).toBeVisible();
  // An item's name carries its shortcut too ("Move up Alt+↑").
  const target = menu.getByRole('menuitem', { name: item });
  await expect(target).toBeEnabled();
  for (let k = 0; k < 20; k++) {
    await page.keyboard.press('ArrowDown');
    if (await target.evaluate((element) => element === document.activeElement))
      break;
  }
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  // The grip keeps the focus in the panel's new place.
  await expect(
    modelPanel(page, title).getByRole('button', { name: `Move ${title}` })
  ).toBeFocused();
}

test('the Move menu places a panel by keyboard: new columns, a named column and slot, a window, Float', async ({
  page
}) => {
  await openWorkspace(page, 'Move by keys', {
    right: [['parameters', 'history']]
  });
  await moveByKeys(page, 'History', 'New column left');
  expect(await dockedTitles(page, 'left')).toEqual([['History']]);
  await moveByKeys(page, 'History', 'New column right');
  expect(await dockedTitles(page, 'left')).toEqual([]);
  expect(await dockedTitles(page, 'right')).toEqual([
    ['Parameters'],
    ['History']
  ]);
  // Into a named column, at its end, then up a slot.
  await moveByKeys(page, 'History', 'Move to Right 1: Parameters');
  expect(await dockedTitles(page, 'right')).toEqual([
    ['Parameters', 'History']
  ]);
  await moveByKeys(page, 'History', 'Move up');
  expect(await dockedTitles(page, 'right')).toEqual([
    ['History', 'Parameters']
  ]);
  // The same moves on Alt+↑/↓ while the grip has focus.
  await page.keyboard.press('Alt+ArrowDown');
  expect(await dockedTitles(page, 'right')).toEqual([
    ['Parameters', 'History']
  ]);
  await expect(
    modelPanel(page, 'History').getByRole('button', { name: 'Move History' })
  ).toBeFocused();
  await page.keyboard.press('Alt+ArrowUp');
  expect(await dockedTitles(page, 'right')).toEqual([
    ['History', 'Parameters']
  ]);
  // Float, then stack another panel into that window.
  await moveByKeys(page, 'Parameters', 'Float');
  await expect(modelPanel(page, 'Parameters')).toHaveClass(/is-floating/);
  await moveByKeys(page, 'History', 'Move to Window: Parameters');
  const window = page.locator('.panel-float');
  await expect(window).toHaveCount(1);
  await expect(window.locator('.model-panel')).toHaveCount(2);
  expect(await storedLayout(page)).toMatchObject({
    left: [],
    right: [],
    floats: [{ panels: ['parameters', 'history'] }]
  });
  // Dock right puts it at the end of the first right column.
  await moveByKeys(page, 'History', 'Dock right');
  expect(await dockedTitles(page, 'right')).toEqual([['History']]);
  await moveByKeys(page, 'Parameters', 'Dock left');
  expect(await dockedTitles(page, 'left')).toEqual([['Parameters']]);
});

test('a gap resizes from its arrow keys and Home splits it evenly', async ({
  page
}) => {
  // Panels that fill their shares: an empty project's all hug their content.
  await openWorkspace(page, 'Gap keys', {
    right: [['history', 'parameters']],
    options: { fit: false }
  });
  const gap = page.getByRole('separator', {
    name: 'Resize History and Parameters'
  });
  await expect(gap).toHaveAttribute('aria-valuenow', '50');
  const before = await box(modelPanel(page, 'History'));
  await gap.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => (await box(modelPanel(page, 'History'))).height)
    .toBeCloseTo(before.height + 20, 0);
  expect(Number(await gap.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () => (await box(modelPanel(page, 'History'))).height)
    .toBeCloseTo(before.height + 10, 0);
  await page.keyboard.press('Home');
  await expect(gap).toHaveAttribute('aria-valuenow', '50');
  await expect(gap).toBeFocused();
});

test('the viewer does not re-render while a panel is dragged', async ({
  page
}) => {
  await page.addInitScript(() => {
    (window as { __ozRenderCounts?: Record<string, number> }).__ozRenderCounts =
      {};
  });
  await openWorkspace(page, 'Drag renders', {
    left: [['bodies']],
    right: [['parameters', 'history']]
  });
  await page.waitForTimeout(1000);
  const renders = () =>
    page.evaluate(
      () =>
        (window as { __ozRenderCounts?: Record<string, number> })
          .__ozRenderCounts?.ModelViewer ?? 0
    );
  expect(await renders()).toBeGreaterThan(0);
  await pickUp(page, 'History');
  // Let the press itself (which makes History the most recent) settle.
  await page.waitForTimeout(300);
  const during = await renders();
  // Across every kind of target: the model, a new column on each side
  // (which slides a rail), another column and back.
  for (const point of [
    { x: 700, y: 400 },
    { x: 160, y: 400 },
    { x: 900, y: 400 },
    { x: 1280, y: 200 },
    { x: 700, y: 500 }
  ]) {
    await page.mouse.move(point.x, point.y, { steps: 8 });
    await expect(page.locator('.panel-drag-chip')).toBeVisible();
  }
  expect(await renders()).toBe(during);
  await page.mouse.up();
  await expect(modelPanel(page, 'History')).toHaveClass(/is-floating/);
  // The drop commits once, which the viewer does see.
  expect(await renders()).toBeGreaterThan(during);
});

/** Each footprint width the docks can take, from the stage's own tokens. */
async function capWidths(page: Page) {
  const tokens = await page.locator('.workspace').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      rail: parseFloat(style.getPropertyValue('--rail-w')),
      gap: parseFloat(style.getPropertyValue('--island-gap'))
    };
  });
  const column = (await box(page.locator('.panel-column').first())).width;
  const side = tokens.gap + tokens.rail + tokens.gap;
  const fitting = (columns: number) =>
    Math.ceil((side * 2 + columns * (column + tokens.gap)) / 0.6);
  return {
    essentials: fitting(2),
    // At or below 720px nothing docks at all.
    one: Math.max(721, fitting(1))
  };
}

/**
 * The model's share of the stage left between the docks: from the inner
 * edge of the left dock's rail to the right one's, measured from what is
 * drawn.
 */
async function modelShare(page: Page) {
  return page.evaluate(() => {
    const stage = document
      .querySelector('.panel-dock-layer')!
      .getBoundingClientRect();
    const rects = (selector: string) =>
      [...document.querySelectorAll(selector)]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0);
    const leftEdge = Math.max(
      stage.left,
      ...rects(
        '.panel-column[data-side="left"], nav[aria-label="Feature tools"]'
      ).map((rect) => rect.right)
    );
    const rightEdge = Math.min(
      stage.right,
      ...rects('.panel-column[data-side="right"], .instrument-rail').map(
        (rect) => rect.left
      )
    );
    return (rightEdge - leftEdge) / stage.width;
  });
}

test('the docks keep the model 40% of the stage, parking the left column first, at widths from the tokens', async ({
  page
}) => {
  await openWorkspace(page, 'Dock cap', {
    left: [['bodies']],
    right: [['parameters']]
  });
  const widths = await capWidths(page);
  // Today's tokens: 40px rails, 10px gaps and 296px columns.
  expect(widths).toEqual({ essentials: 1220, one: 721 });
  const height = 900;

  await page.setViewportSize({ width: widths.essentials, height });
  await expect
    .poll(async () => (await box(page.locator('.panel-dock-layer'))).width)
    .toBe(widths.essentials);
  expect(await dockedTitles(page, 'left')).toEqual([['Objects']]);
  expect(await dockedTitles(page, 'right')).toEqual([['Parameters']]);
  expect(await modelShare(page)).toBeGreaterThanOrEqual(0.4);

  await page.setViewportSize({ width: widths.essentials - 1, height });
  await expect(page.locator('.panel-column[data-side="left"]')).toHaveCount(0);
  expect(await dockedTitles(page, 'right')).toEqual([['Parameters']]);
  expect(await modelShare(page)).toBeGreaterThanOrEqual(0.4);
  const objects = railPanelButton(page, 'Objects');
  await expect(objects).toHaveClass(/parked/);
  // A parked panel opens from its rail button in the unpinned slot, and the
  // same button closes it, giving the model its space back.
  await objects.click();
  await expect(page.locator('.panel-unpinned.is-revealed')).toBeVisible();
  await expect(modelPanel(page, 'Objects')).toHaveClass(/is-revealed/);
  await objects.click();
  await expect(modelPanel(page, 'Objects')).toHaveCount(0);
  expect(await modelShare(page)).toBeGreaterThanOrEqual(0.4);
  // Shown in the slot, then widened: it is drawn docked, once.
  await objects.click();
  await expect(modelPanel(page, 'Objects')).toHaveClass(/is-revealed/);
  await page.setViewportSize({ width: widths.essentials, height });
  await expect(page.locator('.panel-unpinned')).toHaveCount(0);
  await expect(modelPanel(page, 'Objects')).toHaveCount(1);
  await expect(modelPanel(page, 'Objects')).toHaveClass(/is-docked/);
  expect(await dockedTitles(page, 'left')).toEqual([['Objects']]);
  // The stored layout never changed.
  expect(await storedLayout(page)).toMatchObject({
    left: [['bodies']],
    right: [['parameters']],
    unpinned: null
  });

  // One column still docks at the narrowest docking width.
  await page.setViewportSize({ width: widths.one, height });
  await expect(page.locator('.panel-column')).toHaveCount(1);
  expect(await dockedTitles(page, 'right')).toEqual([['Parameters']]);
  expect(await modelShare(page)).toBeGreaterThanOrEqual(0.4);
});

test('a pin past the cap docks nothing and says so', async ({ page }) => {
  await openWorkspace(
    page,
    'Pin past cap',
    { left: [['bodies']] },
    { width: 1000, height: 800 }
  );
  await railPanelButton(page, 'History').click();
  const history = modelPanel(page, 'History');
  await expect(history).toHaveClass(/is-unpinned/);
  await history.getByRole('button', { name: 'Pin History' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'The docks are full at this width.'
  );
  await expect(history).toHaveClass(/is-unpinned/);
  await expect(page.locator('.panel-column[data-side="right"]')).toHaveCount(0);
  // A drop that would add a column is refused the same way.
  await pickUp(page, 'History');
  await page.mouse.move(700, 400, { steps: 6 });
  const rail = await box(instrumentRail(page));
  await page.mouse.move(rail.x - 100, 400, { steps: 8 });
  await expect(page.locator('.panel-drag-chip')).toHaveClass(/is-refused/);
  await expect(page.locator('.panel-drop-slot')).toHaveCount(0);
  await page.mouse.up();
  await expect(history).toHaveClass(/is-unpinned/);
  expect(await storedLayout(page)).toMatchObject({
    left: [['bodies']],
    right: [],
    unpinned: 'history'
  });
});

for (const [label, recent, head] of [
  ['a docked panel', ['history', 'revisions', 'bodies'], 'History'],
  ['the unpinned panel', ['revisions', 'history', 'bodies'], 'Revisions']
] as const) {
  test(`at 720px the lane shows the most recent open panel when it is ${label}, and 1440px restores every place`, async ({
    page
  }) => {
    await openWorkspace(
      page,
      'Phone recency',
      {
        left: [['bodies']],
        right: [['parameters', 'history']],
        unpinned: 'revisions',
        recent: [...recent]
      },
      { width: 720, height: 800 }
    );
    const lane = page.locator('.stage-right > .panel-lane-float');
    await expect(lane.getByRole('region', { name: head })).toBeVisible();
    await expect(page.locator('.model-panel')).toHaveCount(1);
    await page.reload();
    await expect(lane.getByRole('region', { name: head })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.locator('.model-panel')).toHaveCount(1);
    await expect(
      lane.getByRole('button', { name: `Pop out ${head}` })
    ).toHaveCount(0);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.panel-lane-float')).toHaveCount(0);
    expect(await dockedTitles(page, 'left')).toEqual([['Objects']]);
    expect(await dockedTitles(page, 'right')).toEqual([
      ['Parameters', 'History']
    ]);
    await expect(modelPanel(page, 'Revisions')).toHaveClass(/is-unpinned/);
  });
}
