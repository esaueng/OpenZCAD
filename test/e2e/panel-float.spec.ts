import {
  createPrimitiveInPlace,
  createProject,
  expect,
  expectBodyCount,
  modelPanel,
  promptField,
  railPanelButton,
  selectBodyFromObjects,
  stubApi,
  test,
  type SeedPanelLayout
} from './openzcad-fixtures';
import type { Locator, Page } from '@playwright/test';

/*
  Floating model panels (U08 slice 4). Pop out floats a panel in a window
  over the model; the window moves by its header and resizes from its
  corner within 260–600px wide and from 160px tall, by pointer or by keys.
  A panel dropped on a window stacks in it, the window grows, and a grip on
  its frame moves the stack. Windows keep a stored z-order: pressing,
  focusing or activating a covered one brings it to the front, and a reload
  keeps the order. At 720px and below a window shows in the phone lane
  instead.
*/

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  // A handle re-arm can hide its HUD for one render frame, including just
  // after a visibility assertion. Measure within the existing expect budget.
  let bounds: Box | null = null;
  await expect
    .poll(async () => {
      bounds = await locator.boundingBox();
      return bounds;
    })
    .not.toBeNull();
  return bounds!;
}

async function storedFloats(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('openzcad-panel-layout:v1');
    return raw
      ? (
          JSON.parse(raw) as {
            floats: Array<{
              id: string;
              x: number;
              y: number;
              w: number;
              h: number;
              panels: string[];
            }>;
          }
        ).floats
      : [];
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

/** The window a panel floats in. */
function windowOf(page: Page, title: 'Parameters' | 'History' | 'Objects') {
  return page.locator('.panel-float').filter({ has: modelPanel(page, title) });
}

/** Presses, moves past the threshold and on by `dx, dy`, and releases. */
async function dragBy(page: Page, from: Locator, dx: number, dy: number) {
  const start = await box(from);
  const x = start.x + Math.min(24, start.width / 2);
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.sign(dx || 1) * 8, y + Math.sign(dy) * 8, {
    steps: 2
  });
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

const LONE_WINDOW = {
  floats: [
    {
      id: 'float-1',
      x: 400,
      y: 100,
      w: 300,
      h: 300,
      panels: ['parameters' as const]
    }
  ]
};

test('Pop out floats a panel that moves by its header and resizes from its corner within bounds', async ({
  page
}) => {
  await openWorkspace(page, 'Pop out', { right: [['parameters']] });
  const parameters = modelPanel(page, 'Parameters');
  await parameters.getByRole('button', { name: 'Pop out Parameters' }).click();
  await expect(parameters).toHaveClass(/is-floating/);
  await expect(page.locator('.panel-column')).toHaveCount(0);
  // Alone in its window it has nothing to pop out of; Pin docks it back.
  await expect(
    parameters.getByRole('button', { name: 'Pop out Parameters' })
  ).toHaveCount(0);
  await expect(
    parameters.getByRole('button', { name: 'Move Parameters' })
  ).toBeFocused();
  const window = windowOf(page, 'Parameters');
  const before = await box(window);

  await dragBy(page, parameters.locator('.model-panel-title'), -200, 60);
  await expect
    .poll(async () => (await box(window)).x - before.x)
    .toBeCloseTo(-200, 0);
  expect((await box(window)).y - before.y).toBeCloseTo(60, 0);
  expect((await box(window)).width).toBeCloseTo(before.width, 0);

  const corner = window.getByRole('button', {
    name: 'Resize Parameters window'
  });
  await dragBy(page, corner, 500, 120);
  await expect.poll(async () => (await box(window)).width).toBe(600);
  const tall = await box(window);
  expect(tall.height).toBeCloseTo(before.height + 120, 0);
  await dragBy(page, corner, -1000, -1000);
  await expect.poll(async () => (await box(window)).width).toBe(260);
  expect((await box(window)).height).toBe(160);
  expect(await storedFloats(page)).toMatchObject([
    { w: 260, h: 160, panels: ['parameters'] }
  ]);

  await parameters.getByRole('button', { name: 'Pin Parameters' }).click();
  await expect(parameters).toHaveClass(/is-docked/);
  await expect(page.locator('.panel-float')).toHaveCount(0);
});

test('a panel dropped on a window stacks in it, the window grows, and its frame grip moves the stack', async ({
  page
}) => {
  await openWorkspace(page, 'Stack windows', {
    ...LONE_WINDOW,
    right: [['history']]
  });
  const window = windowOf(page, 'Parameters');
  const before = await box(window);
  const heading = await box(
    modelPanel(page, 'History').locator('.model-panel-title')
  );
  await page.mouse.move(heading.x + 24, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.move(heading.x + 10, heading.y + 30, { steps: 3 });
  await page.mouse.move(
    before.x + before.width / 2,
    before.y + before.height - 30,
    {
      steps: 12
    }
  );
  // The window shows grown, with the slot under Parameters.
  const slot = page.locator('.panel-float .panel-drop-slot');
  await expect(slot).toBeVisible();
  await expect
    .poll(async () => (await box(page.locator('.panel-float'))).height)
    .toBeCloseTo(before.height + 240, 0);
  expect((await box(slot)).y).toBeGreaterThan(
    (await box(modelPanel(page, 'Parameters'))).y
  );
  await page.mouse.up();

  await expect(window.locator('.model-panel')).toHaveCount(2);
  const stacked = await box(window);
  expect(stacked.height).toBeCloseTo(before.height + 240, 0);
  expect(await storedFloats(page)).toMatchObject([
    { panels: ['parameters', 'history'] }
  ]);
  await expect(page.locator('.panel-column')).toHaveCount(0);

  // The grip on the frame moves the whole stack.
  const grip = window.locator('.panel-float-grip');
  await expect(grip).toBeVisible();
  await dragBy(page, grip, 120, 40);
  await expect
    .poll(async () => (await box(window)).x - stacked.x)
    .toBeCloseTo(120, 0);
  expect((await box(window)).y - stacked.y).toBeCloseTo(40, 0);
  await expect(window.locator('.model-panel')).toHaveCount(2);

  // The gap between them resizes as a docked column's does.
  const gap = window.getByRole('separator', {
    name: 'Resize Parameters and History'
  });
  const top = await box(modelPanel(page, 'Parameters'));
  const handle = await box(gap);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 60, {
    steps: 6
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await box(modelPanel(page, 'Parameters'))).height)
    .toBeCloseTo(top.height + 56, 0);
});

test('a window may stand over the top bar and takes the pointer there', async ({
  page
}) => {
  // Over the mode switch, at the stage's very top: the viewer area is no
  // stacking context of its own, so the window out-ranks the top islands.
  await openWorkspace(page, 'Window over the bar', {
    floats: [
      {
        id: 'float-1',
        x: 560,
        y: 0,
        w: 320,
        h: 300,
        panels: ['parameters']
      }
    ]
  });
  const window = windowOf(page, 'Parameters');
  await expect(window).toBeVisible();
  expect((await box(window)).y).toBeCloseTo(0, 0);
  const modeSwitch = await box(page.locator('.topbar .mode-switch'));
  const covered = await page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit?.closest('.panel-float') !== null;
    },
    { x: modeSwitch.x + modeSwitch.width / 2, y: modeSwitch.y + 10 }
  );
  expect(covered).toBe(true);
  // A menu the bar opens still stands over the window.
  await page.locator('.file-menu > summary').click();
  const menu = page.locator('.file-menu .topbar-menu-panel');
  await expect(menu).toBeVisible();
  const menuBox = await box(menu);
  const menuOnTop = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('.topbar') !== null,
    { x: menuBox.x + 20, y: menuBox.y + 20 }
  );
  expect(menuOnTop).toBe(true);
});

test('a floating window moves on its grip’s arrow keys and resizes with Shift or from its corner control, stopping at the bounds', async ({
  page
}) => {
  await openWorkspace(page, 'Window keys', LONE_WINDOW);
  const window = windowOf(page, 'Parameters');
  const start = await box(window);
  const layer = await box(page.locator('.panel-dock-layer'));
  const grip = modelPanel(page, 'Parameters').getByRole('button', {
    name: 'Move Parameters'
  });
  await grip.focus();
  for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => (await box(window)).x - start.x)
    .toBeCloseTo(30, 0);
  expect((await box(window)).y - start.y).toBeCloseTo(10, 0);
  await expect(grip).toBeFocused();

  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect
    .poll(async () => (await box(window)).width)
    .toBeCloseTo(start.width + 10, 0);
  expect((await box(window)).height).toBeCloseTo(start.height + 10, 0);
  // Narrowed past its minimum, it stops at 260px.
  for (let k = 0; k < 10; k++) await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await box(window)).width).toBe(260);
  // Moved past the stage's edge, it stops at it: a window may go anywhere
  // on the stage, as long as all of it stays on screen.
  for (let k = 0; k < 50; k++) await page.keyboard.press('ArrowLeft');
  await expect
    .poll(async () => (await box(window)).x - layer.x)
    .toBeCloseTo(0, 0);

  const corner = window.getByRole('button', {
    name: 'Resize Parameters window'
  });
  await corner.focus();
  for (let k = 0; k < 40; k++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await box(window)).width).toBe(600);
  for (let k = 0; k < 30; k++) await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await box(window)).height).toBe(160);
  await expect(corner).toBeFocused();
  expect(await storedFloats(page)).toMatchObject([
    { x: 0, w: 600, h: 160, panels: ['parameters'] }
  ]);
});

test('a gap drag or a window resize the page loses is cancelled, and the next one works', async ({
  page
}) => {
  await openWorkspace(page, 'Lost gestures', {
    ...LONE_WINDOW,
    right: [['history', 'bodies']]
  });
  const stored = () =>
    page.evaluate(() => {
      const raw = window.localStorage.getItem('openzcad-panel-layout:v1');
      const layout = JSON.parse(raw ?? '{}') as {
        weights: Record<string, number>;
        floats: unknown[];
      };
      return { weights: layout.weights, floats: layout.floats };
    });
  const before = await stored();
  const history = modelPanel(page, 'History');
  const floating = windowOf(page, 'Parameters');
  const gap = page.getByRole('separator', {
    name: 'Resize History and Objects'
  });
  const corner = floating.getByRole('button', {
    name: 'Resize Parameters window'
  });
  const heights = async () => (await box(history)).height;
  const width = async () => (await box(floating)).width;
  const startHeight = await heights();
  const startWidth = await width();

  // Each gesture is pressed and moved, then the page loses its pointer
  // (capture taken from the element holding it, or the window's blur).
  const gestures = [
    { control: gap, dx: 0, dy: 60, read: heights, rest: startHeight },
    { control: corner, dx: 80, dy: 0, read: width, rest: startWidth }
  ];
  const losses = [
    (control: Locator) =>
      control.evaluate((element) =>
        element.dispatchEvent(
          new PointerEvent('lostpointercapture', { pointerId: 1 })
        )
      ),
    () => page.evaluate(() => globalThis.dispatchEvent(new Event('blur')))
  ];
  for (const gesture of gestures) {
    for (const lose of losses) {
      const handle = await box(gesture.control);
      const from = {
        x: handle.x + handle.width / 2,
        y: handle.y + handle.height / 2
      };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + gesture.dx, from.y + gesture.dy, {
        steps: 6
      });
      await expect.poll(gesture.read).toBeGreaterThan(gesture.rest + 20);
      await lose(gesture.control);
      // Back as it was, and the release that follows commits nothing.
      await expect.poll(gesture.read).toBeCloseTo(gesture.rest, 0);
      await page.mouse.up();
      expect(await gesture.read()).toBeCloseTo(gesture.rest, 0);
      expect(await stored()).toEqual(before);
    }
  }

  // Nothing is left holding a gesture: the next ones resize and commit.
  for (const gesture of gestures) {
    const handle = await box(gesture.control);
    const from = {
      x: handle.x + handle.width / 2,
      y: handle.y + handle.height / 2
    };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + gesture.dx, from.y + gesture.dy, {
      steps: 6
    });
    await page.mouse.up();
    await expect.poll(gesture.read).toBeGreaterThan(gesture.rest + 20);
  }
  expect(await stored()).not.toEqual(before);
});

/** The panels' windows from the bottom of the stack to the top. */
function zOrder(page: Page) {
  return page.locator('.panel-float').evaluateAll((windows) =>
    windows
      .map((element) => ({
        // Computed: the inline value is the stage's base plus the z-order.
        z: Number(getComputedStyle(element).zIndex),
        panel: element.querySelector('.model-panel')?.getAttribute('aria-label')
      }))
      .sort((a, b) => a.z - b.z)
      .map((entry) => entry.panel)
  );
}

test('a covered window comes to the front on a press, on focus, from the rail and from ⌘K, and keeps its place after a reload', async ({
  page
}) => {
  await openWorkspace(page, 'Window order', {
    floats: [
      { id: 'float-1', x: 300, y: 100, w: 320, h: 360, panels: ['history'] },
      {
        id: 'float-2',
        x: 420,
        y: 160,
        w: 320,
        h: 360,
        panels: ['parameters']
      }
    ]
  });
  // A feature for ⌘K to find.
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await page.keyboard.press('Escape');
  await expect.poll(() => zOrder(page)).toEqual(['History', 'Parameters']);

  const history = await box(windowOf(page, 'History'));
  const parameters = await box(windowOf(page, 'Parameters'));
  /** A point on Parameters' window that History's never covers. */
  const parametersOnly = {
    x: parameters.x + parameters.width - 20,
    y: parameters.y + parameters.height - 40
  };
  const lowerParameters = async () => {
    await page.mouse.click(parametersOnly.x, parametersOnly.y);
    await expect.poll(() => zOrder(page)).toEqual(['History', 'Parameters']);
  };

  // Pressed where it shows.
  await page.mouse.click(history.x + 40, history.y + 80);
  await expect.poll(() => zOrder(page)).toEqual(['Parameters', 'History']);
  // Focus moving into it.
  await lowerParameters();
  await modelPanel(page, 'History')
    .getByRole('button', { name: 'Move History' })
    .focus();
  await expect.poll(() => zOrder(page)).toEqual(['Parameters', 'History']);
  // Its rail button brings it forward rather than closing it.
  await lowerParameters();
  await railPanelButton(page, 'History').click();
  await expect.poll(() => zOrder(page)).toEqual(['Parameters', 'History']);
  await expect(modelPanel(page, 'History')).toBeVisible();
  await expect(railPanelButton(page, 'History')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  // A feature picked in ⌘K.
  await lowerParameters();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(promptField(page)).toBeFocused();
  await page.keyboard.type('/Box');
  await page.getByRole('option').filter({ hasText: 'Feature' }).first().click();
  await expect.poll(() => zOrder(page)).toEqual(['Parameters', 'History']);

  // The order is the device's.
  expect((await storedFloats(page)).map((group) => group.panels[0])).toEqual([
    'parameters',
    'history'
  ]);
  await page.reload();
  await expect(modelPanel(page, 'History')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => zOrder(page)).toEqual(['Parameters', 'History']);
});

test('at 720px a stored floating layout shows one panel in the phone lane with no Pop out, and widening restores the windows', async ({
  page
}) => {
  await openWorkspace(
    page,
    'Phone windows',
    {
      floats: [
        { id: 'float-1', x: 300, y: 100, w: 320, h: 300, panels: ['history'] },
        {
          id: 'float-2',
          x: 700,
          y: 160,
          w: 320,
          h: 300,
          panels: ['parameters', 'bodies']
        }
      ],
      recent: ['bodies', 'history']
    },
    { width: 720, height: 800 }
  );
  const lane = page.locator('.stage-right > .panel-lane-float');
  await expect(lane.getByRole('region', { name: 'Objects' })).toBeVisible();
  await expect(page.locator('.model-panel')).toHaveCount(1);
  await expect(page.locator('.panel-float')).toHaveCount(0);
  await expect(lane.getByRole('button', { name: /^Pop out/ })).toHaveCount(0);
  await expect(lane.getByRole('button', { name: /^Move / })).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.panel-float')).toHaveCount(2);
  await expect(page.locator('.panel-lane-float')).toHaveCount(0);
  await expect(windowOf(page, 'Objects').locator('.model-panel')).toHaveCount(
    2
  );
  await expect(modelPanel(page, 'History')).toHaveClass(/is-floating/);
  // Untouched by the narrow stage.
  expect(await storedFloats(page)).toMatchObject([
    { x: 300, y: 100, w: 320, h: 300, panels: ['history'] },
    { x: 700, y: 160, w: 320, h: 300, panels: ['parameters', 'bodies'] }
  ]);
});

/** A point on the box's face the canvas owns, where a click selects it. */
async function findFacePoint(page: Page) {
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await box(canvas);
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: bounds.x + bounds.width * xRatio,
        y: bounds.y + bounds.height * yRatio
      };
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

function overlaps(a: Box, b: Box) {
  return (
    Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + 0.5 &&
    Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + 0.5
  );
}

test('a window floated over a live handle leaves its value chip clear and reachable', async ({
  page
}) => {
  await openWorkspace(page, 'Chip clear', { right: [] });
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await page.keyboard.press('Escape');
  const face = await findFacePoint(page);
  await page.mouse.click(face.x, face.y);
  const chip = page.locator('.handle-value-chip');
  await expect(chip).toBeVisible();
  const before = await box(chip);

  // Parameters popped out, then dragged by its header until its window
  // stands over the chip.
  await railPanelButton(page, 'Parameters').click();
  await modelPanel(page, 'Parameters')
    .getByRole('button', { name: 'Pop out Parameters' })
    .click();
  const window = windowOf(page, 'Parameters');
  await expect(window).toBeVisible();
  const heading = await box(
    modelPanel(page, 'Parameters').locator('.model-panel-title')
  );
  const centre = {
    x: before.x + before.width / 2,
    y: before.y + before.height / 2
  };
  await page.mouse.move(heading.x + 24, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.move(heading.x + 40, heading.y + 30, { steps: 3 });
  await page.mouse.move(centre.x - 60, centre.y - 120, { steps: 12 });
  await page.mouse.up();
  const shown = await box(window);
  // The window now stands where the chip was.
  expect(overlaps(shown, before)).toBe(true);
  await expect(chip).toBeVisible();
  await expect
    .poll(async () => overlaps(await box(chip), await box(window)))
    .toBe(false);
  // Its own: a press on it reaches the chip, not the window.
  const after = await box(chip);
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('.handle-value-chip') !== null,
      { x: after.x + after.width / 2, y: after.y + after.height / 2 }
    )
  ).toBe(true);
});

test('a window floating over the Selection card leaves its verbs pressable', async ({
  page
}) => {
  // A window over the left of the stage, clear of the rail but across the
  // card that hangs above it.
  await openWorkspace(page, 'Card over window', {
    right: [],
    floats: [
      { id: 'over-card', x: 80, y: 0, w: 560, h: 600, panels: ['history'] }
    ]
  });
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await page.keyboard.press('Escape');
  await selectBodyFromObjects(page);
  const card = page.locator('.selection-card');
  const move = card.getByRole('button', { name: 'Selection: Move' });
  await expect(move).toBeVisible();
  const window = windowOf(page, 'History');
  await expect(window).toBeVisible();
  // The window covers the card's place; the card, which carries the pick's
  // only verbs, stays on top of it and takes its own presses.
  expect(overlaps(await box(window), await box(card))).toBe(true);
  const owned = await move.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    return Boolean(hit && button.contains(hit));
  });
  expect(owned).toBe(true);
  await move.click();
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
});
