import type { Page } from '@playwright/test';
import {
  expect,
  modelPanel,
  pickPlanarFace,
  railPanelButton,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * The workspace as a touch phone held upright opens it (UI/UX review,
 * 12 Nov 2026). At 390 × 844 the first view of the demo had the Parameters
 * panel across the middle of the stage, over both two-column rails, with
 * "Tools" clipped under it and about a fifth of the part in view; 44% of the
 * stage under the top bar was clear, and 33% at 360 × 640.
 *
 * Touch emulation gives Chromium `pointer: coarse`, as a phone reports it.
 * This is layout evidence only: a real device's browser bars take more of the
 * height, which is why the smaller size is here.
 */
const PHONES = [
  { width: 390, height: 844, fit: true },
  { width: 360, height: 640, fit: false }
];

/** The stage's clear share: `stage` under the top bar, `canvas` with it. */
interface StageReport {
  coarse: boolean;
  stage: number;
  canvas: number;
  overlaps: string[];
  offScreen: string[];
  smallTargets: string[];
  railWidths: { tools: number; instruments: number };
  instruments: string[];
  toolsReachable: boolean;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

async function openDemo(page: Page) {
  // The suite's seeded layout: five panels docked in one right column, as a
  // layout arranged on a wider screen is stored. The Tools drawer is closed,
  // as a new device has it: the suite's usual seed opens it, and it is
  // remembered open by design, across the stage on a phone.
  await stubApi(page, { commandFoldClosed: true });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 120_000
  });
  await expect(page.locator('.command-more-toggle')).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Preparing model|Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 60_000 }
  );
}

function stageReport(page: Page): Promise<StageReport> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 0 &&
        box.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    // Everything drawn over the canvas, by its own box. The instrument
    // rail's wrapper takes no pointer and spans its islands, so the islands
    // are what count; the toast comes and goes, and counts while it is up.
    const chrome: Array<[string, string]> = [
      ['top bar', '.app-shell > .topbar'],
      // Build's rail, Tweak's and View's, and the instruments opposite.
      ['tool rail', '.workspace-column-float > :not(.tweak-flyouts)'],
      ['tool rail', '.view-rail'],
      ['instrument rail', '.instrument-rail > .viewer-rail'],
      ['instrument rail', '.palette-float > .view-mode-bar'],
      ['cube', '.viewer-rail-stack'],
      // The rule and its value: the box around both is mostly empty.
      ['scale bar', '.viewport-scale-rule, .viewport-scale-value'],
      ['panel lane', '.stage-right > *'],
      ['search bar', '.command-bar-row'],
      [
        'guidance card',
        '.workspace-hint.is-selection, .workspace-hint.is-raised'
      ],
      ['help', '.workspace-hint-help[open] > p'],
      ['toast', '.workspace-toast:not(.hidden) .workspace-toast-body'],
      ['panels pill', '.panels-hidden-pill'],
      // What each surface opens over the stage. Left out of this list, an
      // open drawer hid 47% of the stage from the count.
      ['tools drawer', '.command-flyout'],
      ['parts list', '.view-flyouts > *'],
      ['tweak sheet', '.tweak-flyouts.is-open'],
      ['assembly card', '.assembly-panel-float > *'],
      ['empty stage', '.stage-empty > *']
    ];
    const boxes = chrome.flatMap(([name, selector]) =>
      [...document.querySelectorAll(selector)]
        .filter(visible)
        .map((element) => {
          const box = element.getBoundingClientRect();
          return { name, x: box.x, y: box.y, w: box.width, h: box.height };
        })
    );
    const overlaps: string[] = [];
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const first = boxes[a]!;
        const second = boxes[b]!;
        // The rail's two islands share an edge.
        if (first.name === second.name) continue;
        const x =
          Math.min(first.x + first.w, second.x + second.w) -
          Math.max(first.x, second.x);
        const y =
          Math.min(first.y + first.h, second.y + second.h) -
          Math.max(first.y, second.y);
        if (x > 0.5 && y > 0.5) {
          overlaps.push(
            `${first.name} over ${second.name} by ${Math.round(x)}×${Math.round(y)}`
          );
        }
      }
    }
    const offScreen = boxes
      .filter(
        (box) =>
          box.x < -0.5 ||
          box.y < -0.5 ||
          box.x + box.w > innerWidth + 0.5 ||
          box.y + box.h > innerHeight + 0.5
      )
      .map((box) => box.name);

    const canvas = document
      .querySelector('.viewer-host canvas')!
      .getBoundingClientRect();
    const topBar = document
      .querySelector('.app-shell > .topbar')!
      .getBoundingClientRect();
    // Sampled every 2px: the share of the rectangle no chrome box covers.
    const clear = (top: number) => {
      let total = 0;
      let covered = 0;
      for (let y = Math.ceil(top) + 1; y < canvas.bottom; y += 2) {
        for (let x = canvas.left + 1; x < canvas.right; x += 2) {
          total += 1;
          if (
            boxes.some(
              (box) =>
                x >= box.x &&
                x < box.x + box.w &&
                y >= box.y &&
                y < box.y + box.h
            )
          ) {
            covered += 1;
          }
        }
      }
      return 1 - covered / total;
    };

    const label = (element: Element) =>
      (element.getAttribute('aria-label') ?? element.textContent ?? '')
        .trim()
        .replace(/ \(.*$| — .*$/, '');
    const railButtons = [
      ...document.querySelectorAll(
        '.instrument-rail .rail-button, button.command-rail'
      )
    ].filter(visible);
    const tools = document.querySelector('.command-more-toggle');
    const toolsBox = tools?.getBoundingClientRect() ?? new DOMRect();
    const hit = document.elementFromPoint(
      toolsBox.x + toolsBox.width / 2,
      toolsBox.y + toolsBox.height / 2
    );
    return {
      coarse: matchMedia('(pointer: coarse)').matches,
      stage: clear(topBar.bottom),
      canvas: clear(canvas.top),
      overlaps,
      offScreen,
      smallTargets: railButtons
        .filter((button) => {
          const box = button.getBoundingClientRect();
          return box.width < 44 || box.height < 44;
        })
        .map(label),
      railWidths: {
        tools:
          document
            .querySelector('.workspace-column-float')
            ?.getBoundingClientRect().width ?? 0,
        instruments: Math.max(
          ...[...document.querySelectorAll('.instrument-rail > .viewer-rail')]
            .filter(visible)
            .map((rail) => rail.getBoundingClientRect().width)
        )
      },
      instruments: [
        ...document.querySelectorAll('.instrument-rail .rail-button')
      ]
        .filter(visible)
        .map(label),
      toolsReachable:
        tools !== null &&
        hit !== null &&
        tools.contains(hit) &&
        toolsBox.bottom <= innerHeight &&
        // The label under the glyph, inside the button it names.
        tools.querySelector('.command-rail-label')!.getBoundingClientRect()
          .bottom <=
          toolsBox.bottom + 0.5
    };
  });
}

/** Where the model is drawn on the page, once the camera has come to rest. */
async function restingModel(page: Page): Promise<Box> {
  const read = () =>
    page.locator('.viewer-host canvas').evaluate(
      (element) =>
        new Promise<Box | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-bodies-in-view', {
              detail: {
                resolve: (state: { screen: Box | null }) =>
                  resolve(state.screen)
              }
            })
          );
        })
    );
  let last: Box | null = null;
  await expect
    .poll(
      async () => {
        const next = await read();
        const still =
          next !== null &&
          last !== null &&
          (['left', 'top', 'right', 'bottom'] as const).every(
            (side) => Math.abs(next[side] - last![side]) < 0.5
          );
        last = next;
        return still;
      },
      { intervals: [300], timeout: 20_000 }
    )
    .toBe(true);
  return last!;
}

/**
 * The stage the chrome leaves the model: between the two rails, under the
 * top bar and over the search bar.
 */
function clearStage(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const edge = (
      selector: string,
      side: 'left' | 'right' | 'top' | 'bottom'
    ) =>
      [...document.querySelectorAll(selector)]
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0)
        .map((box) => box[side]);
    return {
      left: Math.max(...edge('.workspace-column-float > *', 'right')),
      right: Math.min(...edge('.instrument-rail > .viewer-rail', 'left')),
      top: Math.max(...edge('.app-shell > .topbar', 'bottom')),
      bottom: Math.min(...edge('.command-bar-row', 'top'))
    };
  });
}

function storedDocks(page: Page) {
  return page.evaluate(() => {
    const layout = JSON.parse(
      window.localStorage.getItem('openzcad-panel-layout:v1') ?? '{}'
    ) as Record<string, unknown>;
    return {
      left: layout.left,
      right: layout.right,
      floats: layout.floats,
      unpinned: layout.unpinned,
      hidden: (layout.options as { hidden?: boolean } | undefined)?.hidden
    };
  });
}

test.describe('the workspace on an upright phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const { width, height, fit } of PHONES) {
    test(
      `opens on the model at ${width}×${height}, panels and tools one tap away`,
      { tag: '@ci-smoke' },
      async ({ page }, testInfo) => {
        test.setTimeout(180_000);
        await page.setViewportSize({ width, height });
        await openDemo(page);

        // No panel on first open, whatever the stored layout has docked.
        await expect(page.locator('.model-panel')).toHaveCount(0);
        await expect(page.locator('.panel-lane-float')).toHaveCount(0);
        const stored = await storedDocks(page);
        expect(stored.right).toEqual([
          ['parameters', 'bodies', 'history', 'revisions', 'diagnostics']
        ]);

        const opened = await stageReport(page);
        await testInfo.attach(`first-open-${width}x${height}`, {
          body: await page.screenshot(),
          contentType: 'image/png'
        });
        await testInfo.attach(`stage-${width}x${height}.json`, {
          body: JSON.stringify(opened, null, 2),
          contentType: 'application/json'
        });
        expect(opened.coarse).toBe(true);
        // The part is what the first view shows: three fifths of the stage
        // under the top bar is clear of chrome. (It was 44% at 390 × 844 and
        // 33% at 360 × 640; it is 76% and 68%.)
        expect(opened.stage).toBeGreaterThanOrEqual(0.6);
        expect(opened.overlaps).toEqual([]);
        expect(opened.offScreen).toEqual([]);
        expect(opened.smallTargets).toEqual([]);
        // And the part is in it: the first frame is fitted between the rails,
        // not to the whole canvas with both ends of the part under them.
        const model = await restingModel(page);
        const clear = await clearStage(page);
        expect(model.left).toBeGreaterThanOrEqual(clear.left);
        expect(model.right).toBeLessThanOrEqual(clear.right);
        expect(model.top).toBeGreaterThanOrEqual(clear.top);
        expect(model.bottom).toBeLessThanOrEqual(clear.bottom);
        // At a size worth looking at: half the width between the rails.
        expect(model.right - model.left).toBeGreaterThan(
          (clear.right - clear.left) / 2
        );
        // One 52px column each side, where there were two.
        expect(opened.railWidths.tools).toBeLessThanOrEqual(56);
        expect(opened.railWidths.instruments).toBeLessThanOrEqual(56);
        expect(opened.toolsReachable).toBe(true);
        // The short set, with the rest behind one button.
        expect(opened.instruments).toEqual([
          'Undo',
          'Redo',
          'Multi-select',
          ...(fit ? ['Fit view'] : []),
          'More view tools',
          'Objects panel',
          'History panel',
          'Parameters panel',
          'Revisions panel',
          'Diagnostics panel'
        ]);

        // The rest of the rail: every instrument, on screen, at touch size.
        const more = page.getByRole('button', { name: 'More view tools' });
        await more.tap();
        await expect(more).toHaveAttribute('aria-expanded', 'true');
        for (const name of [
          'Free values',
          'Measure',
          /^Fit view/,
          /^Toggle grid/,
          /^Section view/,
          'Standard views',
          'Open activity log'
        ]) {
          await expect(
            page.locator('.instrument-rail').getByRole('button', { name })
          ).toBeInViewport({ ratio: 1 });
        }
        const expanded = await stageReport(page);
        expect(expanded.offScreen).toEqual([]);
        expect(expanded.smallTargets).toEqual([]);
        expect(
          expanded.overlaps.filter((overlap) =>
            /search bar|top bar/.test(overlap)
          )
        ).toEqual([]);

        // A panel is one tap away, and that tap folds the rail again so the
        // panel has the stage between the two rails to itself.
        await railPanelButton(page, 'Parameters').tap();
        await expect(more).toHaveAttribute('aria-expanded', 'false');
        const lane = page.locator('.stage-right > .panel-lane-float');
        await expect(
          lane.getByRole('region', { name: 'Parameters', exact: true })
        ).toBeVisible();
        await expect(page.locator('.model-panel')).toHaveCount(1);
        await expect(railPanelButton(page, 'Parameters')).toHaveAttribute(
          'aria-pressed',
          'true'
        );
        // The sheet stands between the rails, over the foot of the stage:
        // the cube is under it by design (the ruler moves to the top for
        // the same reason), and nothing else is.
        await expect
          .poll(async () =>
            (await stageReport(page)).overlaps.filter(
              (overlap) => !overlap.startsWith('cube over panel lane')
            )
          )
          .toEqual([]);

        // Asked for here, it stays through a change of mode and back.
        const modes = page.getByRole('group', { name: 'Workspace mode' });
        await modes.getByRole('button', { name: 'View' }).tap();
        await expect(page.locator('.model-panel')).toHaveCount(0);
        await modes.getByRole('button', { name: 'Build' }).tap();
        await expect(
          lane.getByRole('region', { name: 'Parameters', exact: true })
        ).toBeVisible();

        // Another panel takes the lane; a second tap on it clears the lane
        // rather than falling back to a panel nobody asked for here.
        await railPanelButton(page, 'History').tap();
        await expect(
          lane.getByRole('region', { name: 'History', exact: true })
        ).toBeVisible();
        await expect(page.locator('.model-panel')).toHaveCount(1);
        await railPanelButton(page, 'History').tap();
        await expect(page.locator('.model-panel')).toHaveCount(0);
        await expect(page.locator('.panel-lane-float')).toHaveCount(0);

        // The layout stored on the wider screen came through the visit.
        expect(await storedDocks(page)).toEqual(stored);
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect(page.locator('.panel-column')).toHaveCount(1);
        for (const title of [
          'Objects',
          'Parameters',
          'History',
          'Revisions',
          'Diagnostics'
        ] as const) {
          await expect(modelPanel(page, title)).toBeVisible();
        }
      }
    );
  }

  for (const { width, height } of PHONES) {
    test(
      `a pick, the Tools drawer and the bar’s help keep clear of the rest at ${width}×${height}`,
      { tag: '@ci-smoke' },
      async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize({ width, height });
        await openDemo(page);

        // A pick puts its name and guidance on a card over the bar, four
        // lines deep at this width. The cube stood under it, with the status
        // row across what was left of it.
        expect(await pickPlanarFace(page, { x: 0, y: 0, z: 1 })).not.toBeNull();
        const card = page.locator('.workspace-hint.is-selection');
        await expect(card).toBeVisible();
        await expect
          .poll(async () => (await stageReport(page)).overlaps)
          .toEqual([]);
        const picked = await stageReport(page);
        expect(picked.offScreen).toEqual([]);
        expect(picked.toolsReachable).toBe(true);
        const cube = (await page.locator('.viewer-rail-stack').boundingBox())!;
        expect(cube.y + cube.height).toBeLessThanOrEqual(
          (await card.boundingBox())!.y
        );
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(card).toHaveCount(0);

        // The Tools drawer is docked to the rail and stands over the stage
        // (and the cube in its corner) until it is closed; it is on screen
        // whole, clear of the instruments, with its close button in reach.
        await page.locator('.command-more-toggle').tap();
        const drawer = page.getByRole('group', { name: 'Tools drawer' });
        await expect(drawer).toBeVisible();
        const drawn = await stageReport(page);
        expect(drawn.offScreen).toEqual([]);
        expect(
          drawn.overlaps.filter(
            // Docked, the drawer shares the rail's own edge, a pixel of it.
            (overlap) => !/^(cube|tool rail) over tools drawer/.test(overlap)
          )
        ).toEqual([]);
        const close = drawer.locator('.command-flyout-close');
        const closeBox = (await close.boundingBox())!;
        expect(closeBox.width).toBeGreaterThanOrEqual(44);
        expect(closeBox.height).toBeGreaterThanOrEqual(44);
        await close.tap();
        await expect(drawer).toHaveCount(0);

        // The bar's whole guidance, from its help glyph, which a 360px bar
        // has no room for. It opens over the foot of the stage, off the tool
        // rail and its Tools button.
        const help = page.locator('.workspace-hint-help > summary');
        if (await help.isVisible()) {
          await help.tap();
          await expect(page.locator('.workspace-hint-help > p')).toBeVisible();
          const helped = await stageReport(page);
          expect(helped.offScreen).toEqual([]);
          expect(
            helped.overlaps.filter((overlap) => /rail|search bar/.test(overlap))
          ).toEqual([]);
          expect(helped.toolsReachable).toBe(true);
        }
      }
    );
  }

  test(
    'View, Tweak, Assemble and Draw open clear of their own chrome',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openDemo(page);
      const modes = page.getByRole('group', { name: 'Workspace mode' });
      const partsFlag = () =>
        page.evaluate(
          () =>
            (
              JSON.parse(
                window.localStorage.getItem('openzcad-panel-state:v1') ?? '{}'
              ) as { viewModeRailOpen?: boolean }
            ).viewModeRailOpen
        );

      // View opened with its parts list beside the rail, across the middle
      // of the model: open is that list's default on a new device. A
      // workspace opened on a phone keeps it one tap away, and leaves the
      // stored flag as it is for a wider stage.
      await modes.getByRole('button', { name: 'View' }).tap();
      const showParts = page.getByRole('button', {
        name: 'Show the parts list'
      });
      await expect(showParts).toBeVisible();
      await expect(page.locator('.view-mode-rail')).toHaveCount(0);
      expect(await partsFlag()).not.toBe(false);
      // Once Build's rails have left and View's have come in.
      await expect
        .poll(async () => (await stageReport(page)).offScreen)
        .toEqual([]);
      const viewing = await stageReport(page);
      expect(viewing.stage).toBeGreaterThanOrEqual(0.6);
      expect(viewing.overlaps).toEqual([]);
      await showParts.tap();
      await expect(page.locator('.view-mode-rail')).toBeVisible();
      await page.getByRole('button', { name: 'Hide the parts list' }).tap();
      await expect(page.locator('.view-mode-rail')).toHaveCount(0);
      expect(await partsFlag()).not.toBe(false);

      // Tweak is its parameter sheet, across the foot of the stage with the
      // model framed above it; the cube is under the sheet, as it is under a
      // panel in the lane.
      await modes.getByRole('button', { name: 'Tweak' }).tap();
      await expect(page.locator('.tweak-flyouts.is-open')).toBeVisible();
      await expect
        .poll(async () =>
          (await stageReport(page)).overlaps.filter(
            (overlap) => !overlap.startsWith('cube over tweak sheet')
          )
        )
        .toEqual([]);
      await expect
        .poll(async () => (await stageReport(page)).offScreen)
        .toEqual([]);
      const sheet = (await page
        .locator('.tweak-flyouts.is-open')
        .boundingBox())!;
      expect((await restingModel(page)).bottom).toBeLessThanOrEqual(sheet.y);

      // Assemble opens on its card, over the head of the stage.
      await modes.getByRole('button', { name: 'Assemble' }).tap();
      await expect(page.locator('.assembly-panel-float > *')).toBeVisible();
      await expect
        .poll(async () => (await stageReport(page)).overlaps)
        .toEqual([]);
      await expect
        .poll(async () => (await stageReport(page)).offScreen)
        .toEqual([]);
      expect((await stageReport(page)).stage).toBeGreaterThanOrEqual(0.6);

      // Draw has no model stage; nothing of it runs off the screen.
      await modes.getByRole('button', { name: 'Draw' }).tap();
      await expect(
        page.getByRole('button', { name: 'New drawing sheet' })
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true);

      // And back in Build the lane is still at rest.
      await modes.getByRole('button', { name: 'Build' }).tap();
      await expect(page.locator('.command-more-toggle')).toBeVisible();
      await expect(page.locator('.model-panel')).toHaveCount(0);
    }
  );

  test(
    'an empty project’s invitation stands clear of the rails',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 640 });
      await stubApi(page, { commandFoldClosed: true });
      await page.goto('/');
      await page.getByLabel('Project name').fill('Empty on a phone');
      await page.getByRole('button', { name: 'New project' }).click();
      await expect(page.locator('.stage-empty')).toBeVisible({
        timeout: 60_000
      });
      await expect(page.locator('.model-panel')).toHaveCount(0);
      await expect
        .poll(async () => (await stageReport(page)).overlaps)
        .toEqual([]);
      const empty = await stageReport(page);
      expect(empty.offScreen).toEqual([]);
      expect(empty.toolsReachable).toBe(true);
      for (const action of await page.locator('.stage-empty-action').all()) {
        await expect(action).toBeInViewport({ ratio: 1 });
      }
    }
  );
});
