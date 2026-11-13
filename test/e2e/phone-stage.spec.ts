import type { Page } from '@playwright/test';
import {
  expect,
  modelPanel,
  railPanelButton,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * The workspace as a touch phone held upright opens it (UI/UX review,
 * 12 Nov 2026). At 390 × 844 the first view of the demo had the Parameters
 * panel across the middle of the stage, over both two-column rails, with
 * "Tools" clipped under it and about a fifth of the part in view; 40% of the
 * stage under the top bar was clear, and 26% at 360 × 640.
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

async function openDemo(page: Page) {
  // The suite's seeded layout: five panels docked in one right column, as a
  // layout arranged on a wider screen is stored.
  await stubApi(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 120_000
  });
  await expect(
    page.getByRole('button', { name: /^More tools/ })
  ).toBeVisible({ timeout: 60_000 });
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
      ['tool rail', '.workspace-column-float > *'],
      ['instrument rail', '.instrument-rail > .viewer-rail'],
      ['cube', '.viewer-rail-stack'],
      // The rule and its value: the box around both is mostly empty.
      ['scale bar', '.viewport-scale-rule, .viewport-scale-value'],
      ['panel lane', '.stage-right > *'],
      ['search bar', '.command-bar-row'],
      ['toast', '.workspace-toast:not(.hidden) .workspace-toast-body'],
      ['panels pill', '.panels-hidden-pill']
    ];
    const boxes = chrome.flatMap(([name, selector]) =>
      [...document.querySelectorAll(selector)].filter(visible).map((element) => {
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
    const tools = document.querySelector('.command-more-toggle')!;
    const toolsBox = tools.getBoundingClientRect();
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
        tools: document
          .querySelector('.workspace-column-float')!
          .getBoundingClientRect().width,
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
        hit !== null &&
        tools.contains(hit) &&
        toolsBox.bottom <= innerHeight &&
        // The label under the glyph, inside the button it names.
        tools.querySelector('.command-rail-label')!.getBoundingClientRect()
          .bottom <= toolsBox.bottom + 0.5
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
        // under the top bar is clear of chrome. (It was 40% at 390 × 844 and
        // 26% at 360 × 640.)
        expect(opened.stage).toBeGreaterThanOrEqual(0.6);
        expect(opened.overlaps).toEqual([]);
        expect(opened.offScreen).toEqual([]);
        expect(opened.smallTargets).toEqual([]);
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
            page
              .locator('.instrument-rail')
              .getByRole('button', { name })
          ).toBeInViewport({ ratio: 1 });
        }
        const expanded = await stageReport(page);
        expect(expanded.offScreen).toEqual([]);
        expect(expanded.smallTargets).toEqual([]);
        expect(
          expanded.overlaps.filter(
            (overlap) => /search bar|top bar/.test(overlap)
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
});
