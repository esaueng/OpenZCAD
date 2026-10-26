import { DEFAULT_APP_SETTINGS } from '@openzcad/shared';
import {
  ALL_PANELS_DOCKED,
  createPrimitiveInPlace,
  createProject,
  expect,
  expectBodyCount,
  MODEL_ONLY,
  modelPanel,
  promptField,
  railPanelButton,
  revealModelPanel,
  stubApi,
  test,
  type PanelTitle,
  type SeedPanelLayout
} from './openzcad-fixtures';
import type { Locator, Page } from '@playwright/test';

/*
  The model panels (U08 slice 3). Parameters, Objects, History, Revisions
  and Diagnostics are independent panels: a rail press opens one unpinned
  beside the instrument rail, Pin docks it in the right dock against the
  screen edge, and the rail stands on the dock's inner edge. Every other
  spec runs with all five docked; this one covers how they open, dock,
  stack, resize, step aside for a sketch (not a drag), migrate and fall back
  to one panel at a time on a phone-width stage. Dragging, the left dock and floating windows
  (slice 4) are `panel-drag.spec.ts` and `panel-float.spec.ts`.
*/

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box) {
  return (
    Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + 0.5 &&
    Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + 0.5
  );
}

async function box(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

/** Whether two locators' boxes overlap; null while either is not laid out. */
async function boxesOverlap(a: Locator, b: Locator) {
  const [first, second] = [await a.boundingBox(), await b.boundingBox()];
  return first && second ? overlaps(first, second) : null;
}

/** The panels docked in a dock, edge column first, top to bottom. */
function dockedTitles(page: Page, side: 'left' | 'right' = 'right') {
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
          right: string[][];
          unpinned: string | null;
          weights: Record<string, number>;
          homes: Record<string, unknown>;
        })
      : null;
  });
}

async function openWorkspace(
  page: Page,
  name: string,
  panelLayout: SeedPanelLayout | null,
  viewport = { width: 1440, height: 900 },
  { commandFoldClosed = false } = {}
) {
  await page.setViewportSize(viewport);
  await stubApi(page, { panelLayout, commandFoldClosed });
  await createProject(page, name);
  await expect(page.getByRole('toolbar', { name: 'Model panels' })).toBeVisible(
    { timeout: 30_000 }
  );
}

async function addBox(page: Page) {
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
}

async function findFacePoint(page: Page) {
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await box(canvas);
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: bounds.x + bounds.width * xRatio,
        y: bounds.y + bounds.height * yRatio
      };
      // A point under a panel is not on the model, whatever cursor the
      // canvas last showed.
      const onCanvas = await canvas.evaluate(
        (element, point) =>
          document.elementFromPoint(point.x, point.y) === element,
        candidate
      );
      if (!onCanvas) continue;
      await page.mouse.move(candidate.x, candidate.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) === 'grab'
      ) {
        return candidate;
      }
    }
  }
  throw new Error('no selectable face found');
}

/** Whether a control's centre is its own: nothing paints over it. */
function ownsItsCentre(control: Locator) {
  return control.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2
    );
    return hit !== null && element.contains(hit);
  });
}

test('a rail press opens a panel unpinned, and clicks on the model leave it open', async ({
  page
}) => {
  await openWorkspace(page, 'Unpinned check', MODEL_ONLY);
  await addBox(page);
  await expect(page.locator('.model-panel')).toHaveCount(0);

  const history = railPanelButton(page, 'History');
  await history.click();
  const panel = modelPanel(page, 'History');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/is-unpinned/);
  await expect(history).toHaveAttribute('aria-pressed', 'true');
  await expect(
    panel.getByText('Unpinned — the next panel you open replaces it')
  ).toBeVisible();
  // Beside the rail's inner edge, not in a dock.
  await expect(page.locator('.panel-column')).toHaveCount(0);
  const rail = await box(page.locator('.rail-panels'));
  const peek = await box(panel);
  expect(peek.x + peek.width).toBeLessThanOrEqual(rail.x);

  // Clicking the model (the body itself, and empty space above it) does
  // not close it.
  const face = await findFacePoint(page);
  await page.mouse.click(face.x, face.y);
  await expect(page.locator('.selection-callout-chip')).toBeVisible();
  const canvas = await box(page.locator('.viewer-host canvas'));
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + 110);
  await expect(page.locator('.selection-callout-chip')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(history).toHaveAttribute('aria-pressed', 'true');

  // Opening another replaces it: one unpinned panel at a time.
  await railPanelButton(page, 'Parameters').click();
  await expect(modelPanel(page, 'Parameters')).toHaveClass(/is-unpinned/);
  await expect(modelPanel(page, 'History')).toHaveCount(0);
  await expect(history).toHaveAttribute('aria-pressed', 'false');

  // Its own rail button closes it.
  await railPanelButton(page, 'Parameters').click();
  await expect(page.locator('.model-panel')).toHaveCount(0);
});

test('Pin docks, two pinned panels stack, and a closed panel reopens at home', async ({
  page
}) => {
  await openWorkspace(page, 'Pin check', MODEL_ONLY);
  const dockWidth = () =>
    page
      .locator('.workspace')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--right-dock-w').trim()
      );
  expect(await dockWidth()).toBe('0px');
  // With nothing docked the rail stands a gap in from the screen's edge.
  const viewport = page.viewportSize()!;
  await expect
    .poll(async () => {
      const rail = await box(page.locator('.instrument-rail'));
      return viewport.width - (rail.x + rail.width);
    })
    .toBeCloseTo(10, 0);

  await railPanelButton(page, 'History').click();
  await modelPanel(page, 'History')
    .getByRole('button', { name: 'Pin History' })
    .click();
  await expect(modelPanel(page, 'History')).toHaveClass(/is-docked/);
  await expect(
    modelPanel(page, 'History').getByRole('button', { name: 'Pin History' })
  ).toHaveAttribute('aria-pressed', 'true');
  expect(await dockedTitles(page)).toEqual([['History']]);
  // The rail moved to the dock's inner edge: a dock gap from the column,
  // which stands an island gap from the screen's edge.
  expect(await dockWidth()).toBe('300px');
  const column = await box(page.locator('.panel-column'));
  expect(viewport.width - (column.x + column.width)).toBeCloseTo(10, 0);
  await expect
    .poll(async () => {
      const rail = await box(page.locator('.instrument-rail'));
      return column.x - (rail.x + rail.width);
    })
    .toBeCloseTo(4, 0);

  // A second pin stacks under it in the same column, from the footer's Pin.
  await railPanelButton(page, 'Parameters').click();
  await modelPanel(page, 'Parameters')
    .getByRole('button', { name: 'Pin', exact: true })
    .click();
  expect(await dockedTitles(page)).toEqual([['History', 'Parameters']]);
  const [top, bottom] = [
    await box(modelPanel(page, 'History')),
    await box(modelPanel(page, 'Parameters'))
  ];
  expect(top.x).toBe(bottom.x);
  expect(top.y + top.height).toBeLessThan(bottom.y);
  await expect(page.locator('.panel-unpinned')).toHaveCount(0);

  // Close remembers the place; the rail button reopens the panel there.
  await modelPanel(page, 'History')
    .getByRole('button', { name: 'Close History' })
    .click();
  expect(await dockedTitles(page)).toEqual([['Parameters']]);
  await expect(railPanelButton(page, 'History')).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await railPanelButton(page, 'History').click();
  expect(await dockedTitles(page)).toEqual([['History', 'Parameters']]);
  await expect(modelPanel(page, 'History')).toHaveClass(/is-docked/);

  // Unpinning a docked panel makes it the unpinned one.
  await modelPanel(page, 'Parameters')
    .getByRole('button', { name: 'Pin Parameters' })
    .click();
  await expect(modelPanel(page, 'Parameters')).toHaveClass(/is-unpinned/);
  expect(await dockedTitles(page)).toEqual([['History']]);

  // The layout is the device's: a reload keeps it.
  await page.reload();
  await expect(modelPanel(page, 'History')).toBeVisible({ timeout: 30_000 });
  expect(await dockedTitles(page)).toEqual([['History']]);
  await expect(modelPanel(page, 'Parameters')).toHaveClass(/is-unpinned/);
});

test('the gap between stacked panels resizes them, and a double-click splits them evenly', async ({
  page
}) => {
  await openWorkspace(page, 'Gap check', {
    right: [['history', 'parameters']]
  });
  const history = modelPanel(page, 'History');
  const parameters = modelPanel(page, 'Parameters');
  await expect(history).toBeVisible();
  const before = [await box(history), await box(parameters)];
  expect(Math.abs(before[0]!.height - before[1]!.height)).toBeLessThan(1);

  const gap = page.getByRole('separator', {
    name: 'Resize History and Parameters'
  });
  await expect(gap).toHaveAttribute('aria-valuenow', '50');
  const handle = await box(gap);
  const start = { x: handle.x + handle.width / 2, y: handle.y + 4 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 40, { steps: 4 });
  await page.mouse.move(start.x, start.y + 80, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => (await box(history)).height - before[0]!.height)
    .toBeCloseTo(80, 0);
  const after = [await box(history), await box(parameters)];
  expect(after[0]!.height + after[1]!.height).toBeCloseTo(
    before[0]!.height + before[1]!.height,
    0
  );
  // Committed once, on release, to the stored weights.
  const stored = await storedLayout(page);
  expect(stored!.weights.history).toBeGreaterThan(stored!.weights.parameters!);

  // A drag can never squeeze a panel under its 90px minimum.
  const moved = await box(gap);
  await page.mouse.move(moved.x + moved.width / 2, moved.y + 4);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width / 2, moved.y + 2000, {
    steps: 6
  });
  await page.mouse.up();
  await expect.poll(async () => (await box(parameters)).height).toBe(90);

  await gap.dblclick();
  await expect
    .poll(async () =>
      Math.abs((await box(history)).height - (await box(parameters)).height)
    )
    .toBeLessThan(1);
  await expect(gap).toHaveAttribute('aria-valuenow', '50');
});

test('a docked column fills the dock, its foot shortens it, and a second panel fills it again', async ({
  page
}) => {
  await openWorkspace(page, 'Column foot', { right: [['bodies']] });
  const objects = modelPanel(page, 'Objects');
  await expect(objects).toBeVisible();
  const column = page.locator('.panel-column[data-side="right"]');
  // Filled to the dock's foot: an island gap above the window's foot.
  const viewport = page.viewportSize()!;
  const full = await box(objects);
  expect(viewport.height - (full.y + full.height)).toBeCloseTo(10, 0);

  const foot = page.getByRole('separator', {
    name: 'Resize the Objects column'
  });
  await expect(foot).toHaveAttribute('aria-valuenow', '100');
  const handle = await box(foot);
  const start = { x: handle.x + handle.width / 2, y: handle.y + 4 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y - 150, { steps: 4 });
  await page.mouse.move(start.x, start.y - 300, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => full.height - (await box(objects)).height)
    .toBeCloseTo(300, 0);
  expect((await box(column)).height).toBeCloseTo(full.height - 300, 0);
  // The foot follows the column's end, and the height is the device's.
  expect((await box(foot)).y).toBeCloseTo(handle.y - 300, 0);
  await page.reload();
  await expect(objects).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await box(objects)).height)
    .toBeCloseTo(full.height - 300, 0);

  // Another panel docked in the column fills the dock again, both sharing it.
  await railPanelButton(page, 'History').click();
  await modelPanel(page, 'History')
    .getByRole('button', { name: 'Pin History' })
    .click();
  await expect.poll(() => dockedTitles(page)).toHaveLength(1);
  expect((await dockedTitles(page))[0]!.sort()).toEqual(['History', 'Objects']);
  await expect
    .poll(async () => (await box(column)).height)
    .toBeCloseTo(full.height, 0);

  // Back on its own, Objects returns to the height it was given; a
  // double-click on the foot fills the dock.
  await modelPanel(page, 'History')
    .getByRole('button', { name: 'Close History' })
    .click();
  await expect
    .poll(async () => (await box(objects)).height)
    .toBeCloseTo(full.height - 300, 0);
  await foot.dblclick();
  await expect
    .poll(async () => (await box(objects)).height)
    .toBeCloseTo(full.height, 0);
  await expect(foot).toHaveAttribute('aria-valuenow', '100');

  // From the keyboard too: a step up from full shortens it by exactly 10px,
  // and End fills the dock again.
  await foot.focus();
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () => (await box(objects)).height)
    .toBeCloseTo(full.height - 10, 0);
  await page.keyboard.press('End');
  await expect
    .poll(async () => (await box(objects)).height)
    .toBeCloseTo(full.height, 0);
});

test('a locked shortened column’s foot is no control and passes the pointer to the model', async ({
  page
}) => {
  await openWorkspace(page, 'Locked foot', {
    right: [['bodies']],
    columnHeights: { bodies: 360 },
    options: { locked: true }
  });
  const objects = modelPanel(page, 'Objects');
  await expect(objects).toBeVisible();
  await expect.poll(async () => (await box(objects)).height).toBe(360);
  const foot = page.getByRole('separator', {
    name: 'Resize the Objects column'
  });
  await expect(foot).toHaveAttribute('aria-disabled', 'true');
  await expect(foot).toHaveAttribute('tabindex', '-1');
  // The strip it stands in belongs to whatever is under it, not the foot.
  const strip = await box(foot);
  const hit = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('.panel-column-foot') !== null,
    { x: strip.x + strip.width / 2, y: strip.y + strip.height / 2 }
  );
  expect(hit).toBe(false);
});

test('a divider announces where it is drawn while its panels hug their content', async ({
  page
}) => {
  // With Fit panels to content on, an empty project's panels are drawn at
  // their content's height, not their equal stored weights.
  await openWorkspace(page, 'Fitted divider', {
    right: [['history', 'revisions', 'parameters']],
    options: { hug: true }
  });
  const history = modelPanel(page, 'History');
  const revisions = modelPanel(page, 'Revisions');
  await expect(revisions).toBeVisible();
  const gap = page.getByRole('separator', {
    name: 'Resize History and Revisions'
  });
  await expect
    .poll(async () => {
      const above = (await box(history)).height;
      const below = (await box(revisions)).height;
      return (
        Number(await gap.getAttribute('aria-valuenow')) -
        Math.round((100 * above) / (above + below))
      );
    })
    .toBe(0);
  const min = Number(await gap.getAttribute('aria-valuemin'));
  const max = Number(await gap.getAttribute('aria-valuemax'));
  const now = Number(await gap.getAttribute('aria-valuenow'));
  expect(min).toBeLessThanOrEqual(now);
  expect(max).toBeGreaterThanOrEqual(now);
});

test('a double-click split leaves the rest of the stack its height when a neighbour sat at its minimum', async ({
  page
}) => {
  await openWorkspace(page, 'Split check', {
    right: [['history', 'parameters', 'revisions']]
  });
  const history = modelPanel(page, 'History');
  const parameters = modelPanel(page, 'Parameters');
  const revisions = modelPanel(page, 'Revisions');
  await expect(revisions).toBeVisible();

  const gap = page.getByRole('separator', {
    name: 'Resize History and Parameters'
  });
  const handle = await box(gap);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 2000, {
    steps: 6
  });
  await page.mouse.up();
  await expect.poll(async () => (await box(parameters)).height).toBe(90);
  // A shorter window draws the stack at a smaller scale; Parameters' share
  // is then under 90px, and it is held at its minimum.
  const tall = await box(revisions);
  await page.setViewportSize({ width: 1440, height: 720 });
  await expect
    .poll(async () => (await box(revisions)).height)
    .toBeLessThan(tall.height - 1);
  await expect.poll(async () => (await box(parameters)).height).toBe(90);
  const revisionsHeight = (await box(revisions)).height;

  // Splitting the two evenly at the scale the stack is drawn at: weights
  // split alone redrew the whole stack at another scale, Revisions with it.
  await gap.dblclick();
  await expect
    .poll(async () =>
      Math.abs((await box(history)).height - (await box(parameters)).height)
    )
    .toBeLessThan(1);
  expect(
    Math.abs((await box(revisions)).height - revisionsHeight)
  ).toBeLessThan(1);
});

test('headers carry the Move grip, Pin, Pop out and Close, and no fold', async ({
  page
}) => {
  await openWorkspace(page, 'Header check', ALL_PANELS_DOCKED);
  const titles: PanelTitle[] = [
    'Parameters',
    'Objects',
    'History',
    'Revisions',
    'Diagnostics'
  ];
  for (const title of titles) {
    const panel = modelPanel(page, title);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: title })).toBeVisible();
    await expect(
      panel.getByRole('button', { name: `Pin ${title}` })
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: `Close ${title}` })
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: `Move ${title}` })
    ).toBeVisible();
    await expect(
      panel.getByRole('button', { name: `Pop out ${title}` })
    ).toBeVisible();
    await expect(
      panel.locator('.model-panel-header [aria-expanded]')
    ).toHaveCount(0);
  }
  // The count is part of the heading: "Revisions 1" for the new project's
  // first save point.
  await expect(
    modelPanel(page, 'Revisions').getByRole('heading', { name: 'Revisions 1' })
  ).toBeVisible();
});

test('the inspector and the right lane stay clear of the dock, inside the rail', async ({
  page
}) => {
  await openWorkspace(page, 'Lane check', ALL_PANELS_DOCKED, {
    width: 1280,
    height: 720
  });
  // A new box runs in place (U09); its History edit card takes the lane.
  await createPrimitiveInPlace(page, 'box');
  await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
  await revealModelPanel(page, 'History');
  const inspector = page.locator('.stage-right > .inspector-float');
  await expect(inspector).toBeVisible();
  const lane = await box(inspector);
  const rail = await box(page.locator('.rail-panels'));
  const column = await box(page.locator('.panel-column'));
  expect(lane.x + lane.width).toBeLessThanOrEqual(rail.x);
  expect(rail.x + rail.width).toBeLessThanOrEqual(column.x);
  expect(overlaps(lane, column)).toBe(false);

  // An unpinned panel takes the place beside the rail; the lane steps past
  // it rather than sharing it.
  await modelPanel(page, 'History')
    .getByRole('button', { name: 'Pin History' })
    .click();
  const peek = await box(page.locator('.panel-unpinned'));
  const shifted = await box(inspector);
  expect(overlaps(shifted, peek)).toBe(false);
  expect(shifted.x + shifted.width).toBeLessThanOrEqual(peek.x);
});

test('on a stage too narrow for both, an unpinned panel covers the lane instead of squeezing it', async ({
  page
}) => {
  await openWorkspace(page, 'Narrow lane', ALL_PANELS_DOCKED, {
    width: 900,
    height: 720
  });
  // A new box runs in place (U09); its History edit card takes the lane.
  await createPrimitiveInPlace(page, 'box');
  await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
  await revealModelPanel(page, 'History');
  const inspector = page.locator('.stage-right > .inspector-float');
  await expect(inspector).toBeVisible();
  const full = await box(inspector);
  await modelPanel(page, 'History')
    .getByRole('button', { name: 'Pin History' })
    .click();
  const peek = page.locator('.panel-unpinned');
  await expect(peek).toBeVisible();
  // Reserving the slot here would have left the inspector a sliver; it keeps
  // its width and the unpinned panel stands over it until it closes.
  const kept = await box(inspector);
  expect(Math.abs(kept.width - full.width)).toBeLessThan(1);
  const slot = await box(peek);
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('.panel-unpinned') !== null,
      { x: slot.x + slot.width / 2, y: slot.y + 60 }
    )
  ).toBe(true);
  await railPanelButton(page, 'History').click();
  await expect(peek).toHaveCount(0);
  await expect(inspector).toBeVisible();
});

test('a sketch hides the dock and an open unpinned panel and restores both', async ({
  page
}) => {
  await openWorkspace(page, 'Suspend check', {
    right: [['parameters']],
    unpinned: 'history'
  });
  const docked = modelPanel(page, 'Parameters');
  const unpinned = modelPanel(page, 'History');
  await expect(docked).toHaveClass(/is-docked/);
  await expect(unpinned).toHaveClass(/is-unpinned/);
  const rail = page.locator('.instrument-rail');
  const stageWidth = page.viewportSize()!.width;
  // At the dock's inner edge: the column and its dock gap in from the edge.
  await expect
    .poll(async () => (await box(rail)).x)
    .toBeLessThan(stageWidth - 10 - 40 - 299);

  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(sketchTools).toBeVisible();
  await expect(page.locator('.model-panel')).toHaveCount(0);
  // Nothing is left behind as an obstacle, and the rail gives the stage back.
  await expect(
    page.locator('.panel-column, .panel-unpinned, .panel-lane-float')
  ).toHaveCount(0);
  // The rail slides back to the screen's edge once its transition lands.
  await expect
    .poll(async () => (await box(rail)).x)
    .toBeCloseTo(stageWidth - 10 - 40, 0);
  // Suspension is not a preference: the stored layout keeps both.
  expect(await storedLayout(page)).toMatchObject({
    right: [['parameters']],
    unpinned: 'history'
  });

  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(sketchTools).toHaveCount(0);
  await expect(docked).toBeVisible();
  await expect(unpinned).toBeVisible();
  await expect(unpinned).toHaveClass(/is-unpinned/);

  // A rail press while sketching is the user asking for them back.
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(page.locator('.model-panel')).toHaveCount(0);
  await railPanelButton(page, 'Parameters').click();
  await expect(docked).toBeVisible();
  await expect(unpinned).toBeVisible();
  await expect(railPanelButton(page, 'Parameters')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(docked).toBeVisible();
});

test('a drag on the model keeps the dock and an open unpinned panel where they are', async ({
  page
}) => {
  // Wide enough that the inspector, past the dock and the unpinned panel,
  // stays clear of the face the drag starts on.
  await openWorkspace(
    page,
    'Drag keeps panels check',
    { right: [['parameters']], unpinned: 'history' },
    { width: 1920, height: 1000 }
  );
  const docked = modelPanel(page, 'Parameters');
  const unpinned = modelPanel(page, 'History');
  await addBox(page);
  await expect(docked).toBeVisible();
  await expect(unpinned).toBeVisible();
  const face = await findFacePoint(page);
  await page.mouse.click(face.x, face.y);
  await expect(page.locator('.selection-callout-chip').first()).toBeVisible();
  await page.mouse.move(face.x, face.y);
  await page.mouse.down();
  await page.mouse.move(face.x + 30, face.y - 20, { steps: 3 });
  await expect(
    page.locator('.selection-callout-phase-dot[aria-label="Dragging"]')
  ).toBeVisible();
  // The docks sit beside the model, not over it: hiding them mid-drag only
  // made them vanish and the rail jump until the release validated.
  const rail = page.locator('.instrument-rail');
  const railBefore = await rail.boundingBox();
  await page.mouse.move(face.x + 40, face.y - 30, { steps: 2 });
  await expect(docked).toBeVisible();
  await expect(unpinned).toBeVisible();
  expect(await rail.boundingBox()).toEqual(railBefore);
  await page.mouse.up();
  await expect(docked).toBeVisible();
  await expect(unpinned).toBeVisible();
  await expect(unpinned).toHaveClass(/is-unpinned/);
  expect(await rail.boundingBox()).toEqual(railBefore);
});

test('⌘K opens a parameter unpinned and focuses it, and reveals a panel mid-sketch', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 120_000
  });
  await expectBodyCount(page, 1);
  await expect(page.locator('.model-panel')).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(promptField(page)).toBeFocused();
  await page.keyboard.type('/plate_t');
  await page
    .getByRole('option')
    .filter({ hasText: 'plate_t' })
    .filter({ hasText: 'Parameter' })
    .click();
  const parameters = modelPanel(page, 'Parameters');
  await expect(parameters).toBeVisible();
  await expect(parameters).toHaveClass(/is-unpinned/);
  await expect(
    page.getByRole('textbox', { name: 'Expression for plate_t' })
  ).toBeFocused();

  // An open panel stays where it is: dock Parameters, then search again.
  await parameters.getByRole('button', { name: 'Pin Parameters' }).click();
  await expect(parameters).toHaveClass(/is-docked/);
  await page.keyboard.press('Escape');
  await promptField(page).fill('/plate_t');
  await page
    .getByRole('option')
    .filter({ hasText: 'plate_t' })
    .filter({ hasText: 'Parameter' })
    .click();
  await expect(parameters).toHaveClass(/is-docked/);
  await expect(
    page.getByRole('textbox', { name: 'Expression for plate_t' })
  ).toBeFocused();

  // Mid-sketch, naming a feature brings the panels back for the sketch.
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(sketchTools).toBeVisible();
  await expect(page.locator('.model-panel')).toHaveCount(0);
  await promptField(page).fill('/base');
  await page.getByRole('option').filter({ hasText: 'Feature' }).first().click();
  await expect(modelPanel(page, 'History')).toBeVisible();
  await expect(modelPanel(page, 'History')).toHaveClass(/is-unpinned/);
  await expect(parameters).toBeVisible();
  await expect(sketchTools).toBeVisible();
});

for (const [label, layout] of [
  ['all five panels docked', ALL_PANELS_DOCKED],
  ['no panel open', MODEL_ONLY]
] as const) {
  test(`the rail is reachable at 1280×720 with ${label}`, async ({ page }) => {
    await openWorkspace(page, 'Rail reach', layout, {
      width: 1280,
      height: 720
    });
    // The rail slides in 16px from the right as the workspace enters
    // (`mode-in-right`); read at the slide's start, a button's right edge
    // was 1281px instead of the 1265px it lands at. Measure once it has
    // landed: two reads in a row agree.
    const rail = page.locator('.instrument-rail');
    let landed = '';
    await expect
      .poll(async () => {
        const at = JSON.stringify(await rail.boundingBox());
        const settled = at === landed;
        landed = at;
        return settled;
      })
      .toBe(true);
    const buttons = page.locator('.instrument-rail button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(10);
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      if (!(await button.isVisible())) continue;
      const bounds = await box(button);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
      expect(
        await ownsItsCentre(button),
        (await button.getAttribute('aria-label')) ?? `rail button ${index}`
      ).toBe(true);
    }
    for (const title of [
      'Objects',
      'History',
      'Parameters',
      'Revisions',
      'Diagnostics'
    ] as const) {
      await expect(railPanelButton(page, title)).toBeVisible();
    }
    // The bottom-right corner stays the cube's, clear of the dock.
    const cube = await box(page.locator('.viewer-rail-stack'));
    for (const column of await page.locator('.panel-column').all()) {
      expect(overlaps(await box(column), cube)).toBe(false);
    }
  });
}

test('a five-panel column at a 390px window scrolls and keeps every header control reachable', async ({
  page
}) => {
  // Each at its 90px minimum.
  await openWorkspace(page, 'Short check', ALL_PANELS_DOCKED, {
    width: 1280,
    height: 390
  });
  const column = page.locator('.panel-column');
  await expect(column).toHaveClass(/is-scrolling/);
  const stage = await box(column);
  expect(stage.y).toBeGreaterThanOrEqual(60);
  expect(stage.y + stage.height).toBeLessThanOrEqual(390);
  // Every panel holds its 90px minimum; the gaps are off while it scrolls.
  for (const panel of await page.locator('.model-panel').all()) {
    expect((await box(panel)).height).toBeCloseTo(90, 0);
  }
  await expect(page.locator('.panel-gap.is-off')).toHaveCount(4);

  for (const title of [
    'Parameters',
    'Objects',
    'History',
    'Revisions',
    'Diagnostics'
  ] as const) {
    const panel = modelPanel(page, title);
    for (const control of [
      panel.getByRole('heading', { name: title }),
      panel.getByRole('button', { name: `Pin ${title}` }),
      panel.getByRole('button', { name: `Close ${title}` })
    ]) {
      await control.scrollIntoViewIfNeeded();
      const bounds = await box(control);
      const visible = await box(column);
      expect(bounds.y, title).toBeGreaterThanOrEqual(visible.y - 0.5);
      expect(bounds.y + bounds.height, title).toBeLessThanOrEqual(
        visible.y + visible.height + 0.5
      );
      expect(bounds.y + bounds.height, title).toBeLessThanOrEqual(390);
      expect(await ownsItsCentre(control), title).toBe(true);
    }
  }
  // The last header's Close works from there.
  await modelPanel(page, 'Diagnostics')
    .getByRole('button', { name: 'Close Diagnostics' })
    .click();
  await expect(modelPanel(page, 'Diagnostics')).toHaveCount(0);
  // Stored weights are untouched: a taller window gets the split back.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(column).not.toHaveClass(/is-scrolling/);
  await expect(page.locator('.panel-gap.is-off')).toHaveCount(0);
});

async function seedV1Drawer(
  page: Page,
  state: { drawerOpen: boolean; sidebarSections?: Record<string, boolean> }
) {
  await page.addInitScript((seed) => {
    const key = 'openzcad-panel-state:v1';
    const raw = window.localStorage.getItem(key);
    const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (typeof current.drawerOpen !== 'boolean') {
      window.localStorage.setItem(key, JSON.stringify({ ...current, ...seed }));
    }
  }, state);
}

async function storedV1(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('openzcad-panel-state:v1');
    return raw
      ? (JSON.parse(raw) as {
          drawerOpen: boolean;
          sidebarSections: Record<string, boolean>;
        })
      : null;
  });
}

test('a device whose drawer was open migrates to a right column of its open sections', async ({
  page
}) => {
  const sections = {
    parameters: true,
    bodies: false,
    history: true,
    revisions: false,
    diagnostics: true
  };
  await seedV1Drawer(page, { drawerOpen: true, sidebarSections: sections });
  await openWorkspace(page, 'Migrate open', null);
  expect(await dockedTitles(page)).toEqual([
    ['Parameters', 'History', 'Diagnostics']
  ]);
  expect(await storedLayout(page)).toMatchObject({
    right: [['parameters', 'history', 'diagnostics']]
  });
  // The v1 key is left as it was, so a rollback finds the drawer.
  expect(await storedV1(page)).toMatchObject({
    drawerOpen: true,
    sidebarSections: sections
  });

  // A reload after migration keeps the new layout, changes included.
  await modelPanel(page, 'Diagnostics')
    .getByRole('button', { name: 'Close Diagnostics' })
    .click();
  await page.reload();
  await expect(modelPanel(page, 'Parameters')).toBeVisible({
    timeout: 30_000
  });
  expect(await dockedTitles(page)).toEqual([['Parameters', 'History']]);
  expect(await storedV1(page)).toMatchObject({ drawerOpen: true });
});

test('a device whose drawer was closed migrates to the model alone', async ({
  page
}) => {
  await seedV1Drawer(page, { drawerOpen: false });
  await openWorkspace(page, 'Migrate closed', null);
  await expect(page.locator('.model-panel')).toHaveCount(0);
  expect(await storedLayout(page)).toMatchObject({ right: [] });
  await page.reload();
  await expect(page.getByRole('toolbar', { name: 'Model panels' })).toBeVisible(
    { timeout: 30_000 }
  );
  await expect(page.locator('.model-panel')).toHaveCount(0);
  expect(await storedV1(page)).toMatchObject({ drawerOpen: false });
});

test('a new device opens in the two-sided Essentials: Objects left, Parameters right', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Nothing seeded at all: no v1 state and no layout.
  await stubApi(page, {
    panelLayout: null,
    workspaceTour: true,
    commandFoldClosed: true
  });
  await createProject(page, 'New device');
  await expect(modelPanel(page, 'Objects')).toBeVisible({ timeout: 30_000 });
  expect(await dockedTitles(page, 'left')).toEqual([['Objects']]);
  expect(await dockedTitles(page, 'right')).toEqual([['Parameters']]);
  await page.reload();
  await expect(modelPanel(page, 'Objects')).toBeVisible({ timeout: 30_000 });
  expect(await dockedTitles(page, 'left')).toEqual([['Objects']]);
  expect(await dockedTitles(page, 'right')).toEqual([['Parameters']]);
});

for (const viewport of [
  { width: 600, height: 800 },
  { width: 720, height: 800 }
]) {
  test(`at a ${viewport.width}px stage nothing docks and a rail press shows one panel in the phone lane`, async ({
    page
  }) => {
    await openWorkspace(page, `Phone ${viewport.width}`, MODEL_ONLY, viewport);
    await expect(page.locator('.panel-column')).toHaveCount(0);
    await railPanelButton(page, 'History').click();
    const lane = page.locator('.stage-right > .panel-lane-float');
    await expect(lane.getByRole('region', { name: 'History' })).toBeVisible();
    await expect(page.locator('.model-panel')).toHaveCount(1);
    await expect(page.locator('.panel-column, .panel-unpinned')).toHaveCount(0);
    // Another press shows that one instead: one panel at a time.
    await railPanelButton(page, 'Parameters').click();
    await expect(
      lane.getByRole('region', { name: 'Parameters' })
    ).toBeVisible();
    await expect(page.locator('.model-panel')).toHaveCount(1);
    // Pin does not dock here; the status line says so.
    await lane.getByRole('button', { name: 'Pin Parameters' }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Panels do not dock at this width'
    );
    await expect(page.locator('.panel-column')).toHaveCount(0);
    await railPanelButton(page, 'Parameters').click();
    await expect(page.locator('.model-panel')).toHaveCount(0);
  });
}

test('a stored dock shows one panel in the lane at a 720px stage and docks at 721px', async ({
  page
}) => {
  await openWorkspace(
    page,
    'Phone dock',
    { right: [['history', 'parameters']] },
    { width: 720, height: 800 }
  );
  await expect(page.locator('.panel-lane-float')).toBeVisible();
  await expect(page.locator('.model-panel')).toHaveCount(1);
  await expect(page.locator('.panel-column')).toHaveCount(0);
  // An open panel the lane is not showing comes into it on its press.
  const shown = await page
    .locator('.panel-lane-float .model-panel')
    .getAttribute('aria-label');
  const other = shown === 'History' ? 'Parameters' : 'History';
  await railPanelButton(page, other).click();
  const laneRegion = page
    .locator('.panel-lane-float')
    .getByRole('region', { name: other });
  await expect(laneRegion).toBeVisible();
  // Its saved dock stands: the lane's Pin reads unpinned, and a press is
  // refused rather than unpinning it out of the column.
  const pin = laneRegion.getByRole('button', { name: `Pin ${other}` });
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Panels do not dock at this width'
  );
  await page.setViewportSize({ width: 721, height: 800 });
  await expect(page.locator('.panel-column')).toBeVisible();
  expect(await dockedTitles(page)).toEqual([['History', 'Parameters']]);
  await expect(page.locator('.panel-lane-float')).toHaveCount(0);
});

test('with a panel open unpinned or in the phone lane, the keypad and the selection chip stay clear of it and Fit frames what is left', async ({
  page
}) => {
  // The command fold stays closed so the left column never stands over
  // the value chip of a model framed into what the panel leaves.
  await openWorkspace(
    page,
    'Obstacle check',
    MODEL_ONLY,
    { width: 1024, height: 768 },
    { commandFoldClosed: true }
  );
  await addBox(page);
  const canvas = page.locator('.viewer-host canvas');

  /** The camera after a Fit from the front view, once it has stopped. */
  const fitFront = async () => {
    await page.getByRole('button', { name: 'Standard views' }).click();
    await page.getByRole('button', { name: 'Front view (1)' }).click();
    await page.keyboard.press('f');
    let last = '';
    await expect
      .poll(
        async () => {
          const current = await canvas.evaluate((element) =>
            JSON.stringify(
              (element as HTMLElement).dataset.e2eCameraDistance ?? ''
            )
          );
          const still = current === last;
          last = current;
          return still;
        },
        { intervals: [400] }
      )
      .toBe(true);
    return canvas.evaluate(
      (element) =>
        new Promise<number[]>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-bodies-in-view', {
              detail: {
                resolve: (state: { camera: number[] }) => resolve(state.camera)
              }
            })
          );
        })
    );
  };
  const open = await fitFront();

  // Unpinned: the panel stands where the model's right half was.
  await railPanelButton(page, 'History').click();
  const peek = page.locator('.panel-unpinned');
  await expect(peek).toBeVisible();
  const covered = await fitFront();
  // Framed into the room left of the panel: the camera moves right in world
  // X, so the part sits further left on screen.
  expect(covered[0]! - open[0]!).toBeGreaterThan(1);

  const face = await findFacePoint(page);
  await page.mouse.click(face.x, face.y);
  const chip = page.locator('.selection-callout-chip').first();
  await expect(chip).toBeVisible();
  await expect.poll(() => boxesOverlap(chip, peek)).toBe(false);
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.locator('.numeric-keypad');
  await expect(keypad).toBeVisible();
  expect(overlaps(await box(keypad), await box(peek))).toBe(false);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Closed, it leaves no stale obstacle: Fit frames the whole stage again.
  await railPanelButton(page, 'History').click();
  await expect(peek).toHaveCount(0);
  const reopened = await fitFront();
  expect(Math.abs(reopened[0]! - open[0]!)).toBeLessThan(0.5);

  // Suspended by a sketch, it leaves none either.
  await railPanelButton(page, 'History').click();
  await expect(peek).toBeVisible();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await expect(
    page.locator('.panel-column, .panel-unpinned, .panel-lane-float')
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(peek).toBeVisible();
  await railPanelButton(page, 'History').click();
  await expect(peek).toHaveCount(0);

  // The phone lane is an obstacle the same way. At 720px the selection's
  // inspector shares the lane and still leaves the keypad room beside it;
  // narrower, nothing fits and the keypad keeps to the window instead.
  await page.setViewportSize({ width: 720, height: 800 });
  const phoneOpen = await fitFront();
  await railPanelButton(page, 'History').click();
  const lane = page.locator('.panel-lane-float');
  await expect(lane).toBeVisible();
  const phoneCovered = await fitFront();
  expect(phoneCovered[0]! - phoneOpen[0]!).toBeGreaterThan(1);
  const phoneFace = await findFacePoint(page);
  await page.mouse.click(phoneFace.x, phoneFace.y);
  await expect(chip).toBeVisible();
  await expect.poll(() => boxesOverlap(chip, lane)).toBe(false);
  await page.getByTestId('direct-manipulation-value').click();
  await expect(keypad).toBeVisible();
  expect(overlaps(await box(keypad), await box(lane))).toBe(false);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await railPanelButton(page, 'History').click();
  await expect(lane).toHaveCount(0);
  const phoneClosed = await fitFront();
  expect(Math.abs(phoneClosed[0]! - phoneOpen[0]!)).toBeLessThan(0.5);
});

test('a command card heads the right lane, and a tool card keeps its actions in view beside the dock', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await stubApi(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 120_000
  });
  await expect(page.locator('.panel-column')).toBeVisible();

  // A tool card: every Build tool now runs in place (U09) and opens none,
  // so a Box's edit card, opened from its History row, stands in.
  await createPrimitiveInPlace(page, 'box');
  await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
  await revealModelPanel(page, 'History');
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  const submit = inspector.getByRole('button', { name: 'Apply', exact: true });
  await expect(submit).toBeVisible();
  const layout = await page.evaluate(() => {
    const rect = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect();
    const lane = rect('.stage-right');
    const card = rect('.stage-right > .inspector-float');
    const body = rect('.stage-right .inspector .panel-body');
    const actions = rect('.stage-right .inspector .form-actions');
    const cube = rect('.viewer-rail-stack');
    const column = rect('.panel-column');
    return {
      laneTop: lane.top,
      cardTop: card.top,
      laneHeight: lane.height,
      cardHeight: card.height,
      cardBottom: card.bottom,
      cardRight: card.right,
      columnLeft: column.left,
      cubeTop: cube.top,
      bodyTop: body.top,
      bodyBottom: body.bottom,
      actionsTop: actions.top,
      actionsBottom: actions.bottom,
      actionsInside: actions.top >= body.top && actions.bottom <= body.bottom
    };
  });
  // The card heads the lane and fits in it; the dock is never in it.
  expect(layout.cardTop - layout.laneTop).toBeLessThanOrEqual(8);
  expect(layout.cardHeight).toBeLessThanOrEqual(layout.laneHeight);
  expect(layout.actionsInside).toBe(true);
  expect(layout.cardBottom).toBeLessThanOrEqual(layout.cubeTop);
  expect(layout.cardRight).toBeLessThanOrEqual(layout.columnLeft);
  await expect(submit).toBeInViewport();
  await inspector.getByRole('button', { name: 'Cancel' }).click();

  // A Move is no card (U09): its bar takes the command row over the search
  // bar, as every in-place command's does, and the lane holds nothing.
  await page.locator('.body-row:not(.consumed) .body-row-main').first().click();
  await page.keyboard.press('Escape');
  await page.locator('.body-row:not(.consumed) .body-row-main').first().click();
  await page.keyboard.press('m');
  const move = page.getByRole('form', { name: 'Move controls' });
  await expect(move).toBeVisible();
  await revealModelPanel(page, 'History');
  await expect(
    page
      .locator('.command-bar-lane')
      .getByRole('form', { name: 'Move controls' })
  ).toBeVisible();
  await expect(page.locator('.stage-right > .command-float')).toHaveCount(0);
  expect(
    overlaps(await box(move), await box(page.locator('.panel-column')))
  ).toBe(false);
  await move.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(move).toHaveCount(0);
});

// EDGE-02's successor: the header controls are real 24px targets that own
// every point of their box, docked and in the phone lane, in both themes.
for (const theme of ['dark', 'light'] as const) {
  test(`panel header targets own their area in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await stubApi(page, {
      panelLayout: { right: [['history', 'bodies']] }
    });
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.appearance = {
      theme,
      density: theme === 'dark' ? 'comfortable' : 'compact',
      reducedMotion: true
    };
    await page.addInitScript((value) => {
      window.localStorage.setItem(
        'openzcad-app-settings:v1',
        JSON.stringify(value)
      );
    }, settings);
    await createProject(page, 'Header targets');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await addBox(page);
    await page.keyboard.press('Escape');

    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 }
    ]) {
      await page.setViewportSize(viewport);
      // Docked at 1280px, alone in the phone lane at 390px.
      const host = viewport.width > 720 ? '.panel-column' : '.panel-lane-float';
      const header = page.locator(`${host} .model-panel-header`).first();
      await expect(header).toBeVisible();
      const controls = header.locator('button');
      await expect.poll(() => controls.count()).toBeGreaterThanOrEqual(2);
      // The phone lane slides in: hit-test where the panel comes to rest,
      // not a frame of its arrival.
      await header.evaluate(
        (element, selector) =>
          Promise.all(
            (element.closest(selector) as HTMLElement)
              .getAnimations({ subtree: true })
              .map((animation) => animation.finished)
          ),
        host
      );
      for (const control of await controls.all()) {
        const target = await control.evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          const misses: { x: number; y: number; hit: string }[] = [];
          const points = [0.5, bounds.width / 2, bounds.width - 0.5].flatMap(
            (x) =>
              [0.5, bounds.height / 2, bounds.height - 0.5].map((y) => {
                const hit = document.elementFromPoint(
                  bounds.left + x,
                  bounds.top + y
                );
                const owns = hit !== null && button.contains(hit);
                if (!owns)
                  misses.push({
                    x,
                    y,
                    hit: hit?.tagName + '.' + hit?.getAttribute('class')
                  });
                return owns;
              })
          );
          return {
            name: button.getAttribute('aria-label') ?? '',
            width: bounds.width,
            height: bounds.height,
            ownsEveryPoint: points.every(Boolean),
            misses
          };
        });
        expect(target.width, target.name).toBeGreaterThanOrEqual(24);
        expect(target.height, target.name).toBeGreaterThanOrEqual(24);
        expect(target.ownsEveryPoint, JSON.stringify(target)).toBe(true);
      }
    }
  });
}

test('Diagnostics counts warnings on its rail button and never opens by itself', async ({
  page
}) => {
  // Every model update reports these two advisories, as staged geometry
  // analysis would (staged-geometry.spec.ts overrides warnings the same way).
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Worker.prototype,
      'onmessage'
    )!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      ...descriptor,
      set(listener: (event: MessageEvent) => void) {
        descriptor.set!.call(this, (event: MessageEvent) => {
          const result = event.data as {
            type?: string;
            packet?: { state?: { warnings?: string[] } };
          };
          if (result.type === 'projection-delta' && result.packet?.state) {
            result.packet.state.warnings = [
              'First geometry advisory.',
              'Second geometry advisory.'
            ];
          }
          listener.call(this, event);
        });
      }
    });
  });
  await openWorkspace(page, 'Diagnostics badge', MODEL_ONLY);
  await addBox(page);
  const diagnostics = railPanelButton(page, 'Diagnostics');
  await expect(diagnostics.locator('.rail-badge')).toHaveText('2');
  await expect(diagnostics).toHaveAttribute(
    'title',
    'Diagnostics · 2 warnings'
  );
  // The badge is not part of the button's name.
  await expect(diagnostics).toHaveAccessibleName('Diagnostics panel');
  await expect(diagnostics).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.model-panel')).toHaveCount(0);

  await diagnostics.click();
  const panel = modelPanel(page, 'Diagnostics');
  await expect(
    panel.getByRole('heading', { name: 'Diagnostics 2' })
  ).toBeVisible();
  await expect(panel.locator('.diagnostic-row')).toHaveCount(2);
});
