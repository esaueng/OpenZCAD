import type { Locator, Page } from '@playwright/test';
import { COMPACT_ENTRIES } from '../../apps/web/src/lib/actions/registry';
import {
  expectCompactWorkspace,
  expectReachable,
  preferCompact,
  smallTargets
} from './compactHelpers';
import { expect, MODEL_ONLY, stubApi, test } from './openzcad-fixtures';

/**
 * The sketch in the compact workspace (U12 slice 6): it takes over the
 * shell. The header names the sketch with its solve state and Finish, the
 * mode tabs go, the tray is the draw tools, the relations that fit the pick
 * stand as chips on the stage and everything else is on the sheet's pages.
 * Driven by taps only, at the phone sizes the compact frame is built for:
 * no key, hover, right button or double-click reaches a control here.
 */
const SIZES = [
  { width: 390, height: 844 },
  { width: 360, height: 640 },
  { width: 844, height: 390 }
] as const;

type Size = (typeof SIZES)[number];

async function openCompact(page: Page, size: Size, name: string) {
  // No model panel shown: the sheet at rest is the tray alone.
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await preferCompact(page);
  await page.setViewportSize(size);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).tap();
  await expectCompactWorkspace(page);
}

function sheet(page: Page) {
  return page.locator('.compact-sheet');
}

function sketchTools(page: Page) {
  return page.getByRole('toolbar', { name: 'Sketch tools' });
}

function finish(page: Page) {
  return page.getByRole('button', { name: 'Finish Sketch', exact: true });
}

function status(page: Page) {
  return page.locator('[role="contentinfo"]');
}

/** Sketch from All tools on the Top plane, by taps. */
async function sketchOnTop(page: Page) {
  await page
    .getByRole('group', { name: 'Build tray' })
    .getByRole('button', { name: 'All tools' })
    .tap();
  await sheet(page)
    .getByRole('region', { name: 'Create' })
    .getByRole('button', { name: 'Sketch', exact: true })
    .tap();
  await sheet(page).getByRole('button', { name: 'Top (XY)' }).tap();
  await expect(sketchTools(page)).toBeVisible({ timeout: 30_000 });
}

interface SketchState {
  objects: { id: string; data: { objectKind: string } }[];
  screen: { x: number; y: number }[];
}

/** The open sketch's entities, and `points` on its plane in client pixels. */
async function sketchState(
  page: Page,
  points: [number, number][] = []
): Promise<SketchState> {
  return page.locator('.viewer-host canvas').evaluate(
    (element, project) =>
      new Promise<SketchState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: {
              project: project.map(([x, y]) => ({ x, y })),
              resolve: (state: SketchState | null) =>
                resolve(state ?? { objects: [], screen: [] })
            }
          })
        );
      }),
    points
  );
}

async function entityCount(page: Page) {
  return (await sketchState(page)).objects.length;
}

/**
 * Taps each plane point in turn, as a finger would. Each must land on the
 * canvas: not under the sheet, a chip or the header.
 */
async function tapPlane(page: Page, points: [number, number][]) {
  const { screen } = await sketchState(page, points);
  for (const point of screen) {
    const onCanvas = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('.viewer-host') !== null,
      point
    );
    expect(onCanvas, `(${point.x}, ${point.y}) is on the canvas`).toBe(true);
    await page.touchscreen.tap(point.x, point.y);
  }
}

/** A tool in the tray, scrolled into its row's view first. */
async function tapTool(page: Page, name: string | RegExp) {
  const tool = sketchTools(page).getByRole('button', { name, exact: true });
  await tool.scrollIntoViewIfNeeded();
  await expectReachable(tool);
  await tool.tap();
  return tool;
}

async function openAllSketchTools(page: Page) {
  const heading = sheet(page).getByRole('heading', {
    name: 'Sketch',
    exact: true
  });
  if (await heading.isVisible()) return;
  const all = sketchTools(page).getByRole('button', {
    name: 'All sketch tools'
  });
  await all.tap();
  await expect(
    sheet(page).getByRole('heading', { name: 'Sketch' })
  ).toBeVisible();
}

/** A control on the All sketch tools page, scrolled into the sheet's view. */
async function pageControl(page: Page, name: string, within?: Locator) {
  const control = (within ?? sheet(page)).getByRole('button', {
    name,
    exact: true
  });
  await control.scrollIntoViewIfNeeded();
  await expectReachable(control);
  return control;
}

/** Every target in the compact frame at least 44 px either way. */
async function expectLargeTargets(page: Page) {
  expect(
    await smallTargets(
      page,
      '.app-shell[data-shell="compact"] :is(.compact-header, .compact-stage-controls, .compact-sheet:not([hidden]))'
    )
  ).toEqual([]);
}

/**
 * The share of the clear stage's width the canvas takes taps across, read
 * along its middle: no rail stands on it. The plan's floor is 90%.
 */
async function canvasShare(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.querySelector('.viewer-host')!;
    const stage = document
      .querySelector('.app-shell[data-shell="compact"] .viewer-area')!
      .getBoundingClientRect();
    const header = document
      .querySelector('.compact-header')!
      .getBoundingClientRect();
    const chips = document.querySelector('.compact-stage-controls');
    const sheetBox = document.querySelector('.compact-sheet');
    const top = Math.max(stage.top, header.bottom);
    let bottom = stage.bottom;
    for (const element of [chips, sheetBox]) {
      const box = element?.getBoundingClientRect();
      // A side sheet stands beside the stage, not under it.
      if (box && box.width > stage.width * 0.75) {
        bottom = Math.min(bottom, box.top);
      }
    }
    const y = (top + bottom) / 2;
    let hits = 0;
    const samples = 200;
    for (let i = 0; i < samples; i += 1) {
      const x = stage.left + ((i + 0.5) / samples) * stage.width;
      const hit = document.elementFromPoint(x, y);
      if (hit && host.contains(hit)) hits += 1;
    }
    return hits / samples;
  });
}

/** Types `digits` on the keypad by its keys, then applies. */
async function keypadEntry(page: Page, keypad: Locator, digits: string) {
  const toggle = keypad.locator('.keypad-grid-toggle');
  if (
    (await toggle.count()) > 0 &&
    (await toggle.getAttribute('aria-expanded')) === 'false'
  ) {
    await toggle.tap();
  }
  const field = keypad.getByRole('textbox').first();
  const backspace = keypad.getByRole('button', { name: 'Backspace' });
  for (let i = (await field.inputValue()).length; i > 0; i -= 1) {
    await backspace.tap();
  }
  for (const digit of digits) {
    await keypad
      .locator('.keypad-key')
      .filter({ hasText: new RegExp(`^${digit}$`) })
      .tap();
  }
  await expect(field).toHaveValue(digits);
  await keypad.getByRole('button', { name: /^Apply/ }).tap();
  await expect(keypad).toHaveCount(0);
}

/** Waits for the entity count to settle at `count`. */
async function expectEntities(page: Page, count: number) {
  await expect.poll(() => entityCount(page), { timeout: 30_000 }).toBe(count);
}

/** Waits for more entities than `count`, and returns how many there are. */
async function expectMoreThan(page: Page, count: number) {
  await expect
    .poll(() => entityCount(page), { timeout: 30_000 })
    .toBeGreaterThan(count);
  return entityCount(page);
}

/** The free degrees the header's solve dot reports, or null. */
async function freedom(page: Page): Promise<number | null> {
  const label = await page
    .getByRole('img', { name: /^Sketch state:/ })
    .getAttribute('aria-label');
  const match = /(\d+) DOF/.exec(label ?? '');
  return match ? Number(match[1]) : null;
}

test.describe('the compact sketch', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const size of SIZES) {
    const smoke = size.width === 360 ? { tag: '@ci-smoke' } : {};
    test(
      `sketches and extrudes by taps alone at ${size.width}×${size.height}`,
      smoke,
      async ({ page }) => {
        test.setTimeout(300_000);
        await openCompact(page, size, `Compact sketch ${size.width}`);
        await sketchOnTop(page);

        // The sketch takes over the shell.
        await expect(finish(page)).toBeVisible();
        await expectReachable(finish(page));
        await expect(
          page.getByRole('group', { name: 'Workspace mode' })
        ).toHaveCount(0);
        await expect(
          page.getByRole('img', { name: /^Sketch state:/ })
        ).toBeVisible();
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        // No rail stands on the stage: the canvas keeps its width.
        expect(await canvasShare(page)).toBeGreaterThanOrEqual(0.9);
        await expectLargeTargets(page);

        // A line chain of two segments, ended by choosing Select.
        await tapTool(page, 'Line');
        await tapPlane(page, [
          [-25, 0],
          [25, 0],
          [32, 14]
        ]);
        await tapTool(page, 'Select');
        let count = await expectMoreThan(page, 1);

        // A rectangle across the first segment.
        await tapTool(page, 'Rectangle');
        await tapPlane(page, [
          [-10, -6],
          [10, 6]
        ]);
        count = await expectMoreThan(page, count);

        // A circle, clear of the rest.
        await tapTool(page, /^Circle:/);
        await tapPlane(page, [
          [20, 24],
          [24, 24]
        ]);
        count = await expectMoreThan(page, count);

        // A fit spline: its type chosen in the tray's own row, never over
        // the canvas, and finished with the tray's ✓.
        const curve = await tapTool(page, /^Curve:/);
        await curve.tap();
        const types = sketchTools(page).getByRole('radiogroup', {
          name: 'Curve type'
        });
        await expect(types).toBeVisible();
        const canvas = (await page
          .locator('.viewer-host canvas')
          .boundingBox())!;
        const sheetBox = (await sheet(page).boundingBox())!;
        const typesBox = (await types.boundingBox())!;
        // Inside the sheet's box: the drawing area stays clear.
        expect(typesBox.y).toBeGreaterThanOrEqual(sheetBox.y - 0.5);
        expect(typesBox.x).toBeGreaterThanOrEqual(sheetBox.x - 0.5);
        expect(canvas.width).toBeGreaterThan(0);
        await expectLargeTargets(page);
        await types.getByRole('radio', { name: 'Fit spline' }).tap();
        await expect(types).toHaveCount(0);
        await tapPlane(page, [
          [-22, 24],
          [-12, 30],
          [-2, 24]
        ]);
        const finishSpline = sketchTools(page).getByRole('button', {
          name: 'Finish spline'
        });
        await expect(finishSpline).toBeVisible();
        await finishSpline.tap();
        await expectMoreThan(page, count);
        await expect(finishSpline).toHaveCount(0);

        // Trim the first segment's end outside the rectangle, before any
        // relation moves it.
        await openAllSketchTools(page);
        await (
          await pageControl(
            page,
            'Trim',
            sheet(page).getByRole('region', { name: 'Modify' })
          )
        ).tap();
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        const before = await entityCount(page);
        const untrimmed = JSON.stringify((await sketchState(page)).objects);
        await tapPlane(page, [[-24, 0]]);
        await expect
          .poll(async () => JSON.stringify((await sketchState(page)).objects), {
            timeout: 30_000
          })
          .not.toBe(untrimmed);

        // Pick the slanted segment: the relations that fit it stand as
        // chips on the stage, and Horizontal holds it.
        await tapTool(page, 'Select');
        await tapPlane(page, [[28.5, 7]]);
        const relations = page.getByRole('toolbar', { name: 'Relations' });
        await expect(relations).toBeVisible({ timeout: 15_000 });
        // Only what applies to a line: no Radius, no Concentric.
        await expect(
          relations.getByRole('button', { name: 'Radius', exact: true })
        ).toHaveCount(0);
        await expect(
          relations.getByRole('button', { name: 'Concentric', exact: true })
        ).toHaveCount(0);
        const horizontal = relations.getByRole('button', {
          name: 'Horizontal',
          exact: true
        });
        await expectReachable(horizontal);
        await expectLargeTargets(page);
        // The header's dot reads the solve: one freedom fewer.
        await expect.poll(() => freedom(page)).not.toBeNull();
        const free = (await freedom(page))!;
        await horizontal.tap();
        await expect
          .poll(() => freedom(page), { timeout: 30_000 })
          .toBe(free - 1);

        // A dimension on the rectangle's top side: its length, typed on
        // the keypad (the length it has, so the rest stays put).
        await tapTool(page, 'Select');
        await tapPlane(page, [[0, 6]]);
        await expect(
          page.getByRole('button', { name: /^Selection: / })
        ).not.toHaveText('Line 2', { timeout: 15_000 });
        await openAllSketchTools(page);
        await expectLargeTargets(page);
        const held = (await freedom(page))!;
        await (await pageControl(page, 'Dimension')).tap();
        const keypad = page.getByRole('dialog', { name: /value$/ });
        await expect(keypad).toBeVisible({ timeout: 30_000 });
        await keypadEntry(page, keypad, '20');
        await expect
          .poll(() => freedom(page), { timeout: 30_000 })
          .toBe(held - 1);

        // Construction, from the page: the next geometry is construction.
        await openAllSketchTools(page);
        const construction = await pageControl(page, 'Construction');
        await construction.tap();
        await expect(construction).toHaveAttribute('aria-pressed', 'true');
        await construction.tap();
        await expect(construction).toHaveAttribute('aria-pressed', 'false');

        // Select all, copy and paste, from the page.
        const all = await entityCount(page);
        expect(all).toBeGreaterThanOrEqual(before);
        await openAllSketchTools(page);
        await (await pageControl(page, 'Select all')).tap();
        await expect(
          page.getByRole('button', { name: `Selection: ${all} entities` })
        ).toBeVisible();
        await (await pageControl(page, 'Copy')).tap();
        await expect(status(page)).toContainText(`Copied ${all} sketch`);
        await (await pageControl(page, 'Paste')).tap();
        await expectEntities(page, all * 2);
        await expect(status(page)).toContainText(`Pasted ${all} sketch`);

        // The selection chip opens the pick's page with the same actions.
        await sheet(page)
          .getByRole('button', { name: 'Back', exact: true })
          .tap();
        await page
          .getByRole('button', { name: `Selection: ${all} entities` })
          .tap();
        await expect(
          sheet(page).getByRole('list', { name: 'Selection actions' })
        ).toBeVisible();
        await expectLargeTargets(page);
        await sheet(page)
          .getByRole('button', { name: 'Back', exact: true })
          .tap();

        // Finish, then Extrude the circle's region from Build's tray.
        await finish(page).tap();
        await expect(sketchTools(page)).toHaveCount(0);
        await expect(
          page.getByRole('group', { name: 'Workspace mode' })
        ).toBeVisible();
        const buildTray = sheet(page).getByRole('group', {
          name: 'Build tray'
        });
        await expect(buildTray).toBeVisible();
        await buildTray.getByRole('button', { name: 'Extrude' }).tap();
        const bar = sheet(page).getByRole('group', { name: 'Extrude command' });
        const circleCentre = await page.locator('.viewer-host canvas').evaluate(
          (element) =>
            new Promise<{ x: number; y: number }>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-project-points', {
                  detail: {
                    points: [[20, 24, 0]],
                    resolve: (state: { points: { x: number; y: number }[] }) =>
                      resolve(state.points[0]!)
                  }
                })
              );
            })
        );
        await expect
          .poll(
            async () => {
              if ((await bar.count()) === 0) {
                await page.touchscreen.tap(circleCentre.x, circleCentre.y);
              }
              return bar.count();
            },
            { timeout: 60_000 }
          )
          .toBe(1);
        const row = sheet(page).locator(
          '.compact-command-row .compact-tray-row'
        );
        await row.getByRole('button', { name: 'Extrude options' }).tap();
        await bar.getByRole('button', { name: 'Distance', exact: true }).tap();
        await keypadEntry(
          page,
          bar.getByRole('dialog', { name: /value$/ }),
          '8'
        );
        const done = row.getByRole('button', { name: 'Done' });
        await expect(done).toBeEnabled({ timeout: 30_000 });
        await done.tap();
        await expect(bar).toHaveCount(0);
        await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
          'data-e2e-rendered-bodies',
          '1',
          { timeout: 60_000 }
        );
      }
    );
  }

  test(
    'reaches every sketch action the registry gives the sketch, by taps',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(180_000);
      await openCompact(page, SIZES[0], 'Compact sketch parity');
      await sketchOnTop(page);
      // A closed profile, so the modify tools, relations and Extrude are
      // live.
      await tapTool(page, 'Rectangle');
      await tapPlane(page, [
        [-10, -6],
        [10, 6]
      ]);
      await tapTool(page, 'Select');
      await expectMoreThan(page, 0);

      const tray = (name: string | RegExp) => async () =>
        sketchTools(page).getByRole('button', { name, exact: true });
      const typeIn =
        (slot: string | RegExp, group: string, radio: string) => async () => {
          const tool = sketchTools(page).getByRole('button', {
            name: slot,
            exact: true
          });
          await tool.scrollIntoViewIfNeeded();
          // A hold opens the types of a tool that is not live yet.
          const box = (await tool.boundingBox())!;
          await tool.dispatchEvent('pointerdown', {
            button: 0,
            pointerType: 'touch',
            isPrimary: true
          });
          // Held: the row turns into the slot's types.
          expect(box.width).toBeGreaterThanOrEqual(43.5);
          return sketchTools(page)
            .getByRole('radiogroup', { name: group })
            .getByRole('radio', { name: radio, exact: true });
        };
      const onPage = (name: string, region?: string) => async () => {
        if (
          (await sheet(page)
            .getByRole('heading', { name: 'Sketch', exact: true })
            .count()) === 0
        ) {
          await openAllSketchTools(page);
        }
        const scope = region
          ? sheet(page).getByRole('region', { name: region })
          : sheet(page);
        return scope.getByRole('button', { name, exact: true });
      };
      const back = async () => {
        const backButton = sheet(page).getByRole('button', {
          name: 'Back',
          exact: true
        });
        if ((await backButton.count()) > 0 && (await backButton.isVisible())) {
          await backButton.tap();
        }
        const closeTypes = sketchTools(page).getByRole('button', {
          name: 'Back to the sketch tools'
        });
        if ((await closeTypes.count()) > 0) await closeTypes.tap();
      };
      const routes: Record<string, () => Promise<Locator>> = {
        'sketch-select': tray('Select'),
        'sketch-line': tray('Line'),
        'sketch-arc': tray('Arc'),
        'sketch-circle': tray(/^Circle:/),
        'sketch-rectangle': tray('Rectangle'),
        'sketch-polygon': typeIn('Rectangle', 'Shape type', 'Polygon'),
        'sketch-ellipse': typeIn(/^Curve:/, 'Curve type', 'Ellipse'),
        'sketch-spline': typeIn(/^Curve:/, 'Curve type', 'Fit spline'),
        'sketch-text': tray('Text'),
        'sketch-project': tray('Project edges'),
        'sketch-finish': async () => finish(page),
        'sketch-extrude': onPage('Extrude'),
        'sketch-dimension': onPage('Dimension'),
        'sketch-construction': onPage('Construction'),
        'sketch-trim': onPage('Trim', 'Modify'),
        'sketch-extend': onPage('Extend', 'Modify'),
        'sketch-offset': onPage('Offset', 'Modify'),
        'sketch-select-all': onPage('Select all'),
        'sketch-copy': onPage('Copy'),
        'sketch-paste': onPage('Paste')
      };
      const marked = Object.entries(COMPACT_ENTRIES)
        .filter(
          ([id, surface]) =>
            surface === 'sketch-tray' ||
            surface === 'sketch-sheet' ||
            (surface === 'header' && id.startsWith('sketch-'))
        )
        .map(([id]) => id);
      expect(marked.sort()).toEqual(Object.keys(routes).sort());
      for (const [id, reach] of Object.entries(routes)) {
        const control = await reach();
        await control.scrollIntoViewIfNeeded();
        await expect(control, id).toBeVisible();
        await expectReachable(control);
        if (id !== 'sketch-copy') await expect(control, id).toBeEnabled();
        await back();
      }
    }
  );
});
