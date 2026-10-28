import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import {
  expect,
  modelPanel,
  seedPanelLayout,
  stubAnonymousApi,
  test,
  waitForStillViewport,
  type SeedPanelLayout
} from './openzcad-fixtures';

/*
  Documentation captures, not a regression test: it writes the README's
  Build workspace image and the model-panel images in `docs/design/` from
  the production bundle, the exact geometry worker and anonymous API
  fixtures (the same setup as the earlier hand-made captures), so the docs
  can be refreshed the same way after the workspace changes again.

  Skipped unless OZ_CAPTURE=1, like the OZ_PERF probes, and weighted 0 in
  `shard-weights.json`, so a CI shard collects it and skips it at once:

    OZ_CAPTURE=1 pnpm exec playwright test test/e2e/docs-captures.spec.ts

  OZ_CAPTURE_DIR writes somewhere else (default `docs/design`). Re-save the
  PNGs with lossless optimisation before committing them (the 20 October
  set used Pillow's `optimize=True`), and check each one by eye: the demo
  camera, the panels and the status line are whatever the build shows.
*/
test.skip(
  !process.env.OZ_CAPTURE,
  'Documentation captures; set OZ_CAPTURE=1 to write them.'
);

const VIEWPORT = { width: 1600, height: 1000 };
const OUT_DIR = resolve(process.env.OZ_CAPTURE_DIR ?? 'docs/design');

/** The new-device default: Objects docked left, Parameters right. */
const ESSENTIALS: SeedPanelLayout = {
  left: [['bodies']],
  right: [['parameters']],
  recent: ['parameters', 'bodies']
};

/**
 * The verb rail's "More tools" fold as a new device has it: closed. The
 * fixtures open it for the suite, but only where nothing is stored yet.
 */
async function seedClosedCommandFold(page: Page) {
  await page.addInitScript(() => {
    const key = 'openzcad-panel-state:v1';
    try {
      const raw = window.localStorage.getItem(key);
      const state: Record<string, unknown> = raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
      if (typeof state.commandFoldOpen !== 'boolean') {
        state.commandFoldOpen = false;
        window.localStorage.setItem(key, JSON.stringify(state));
      }
    } catch {
      // Unreadable storage falls back to the app's own defaults.
    }
  });
}

async function openMountingBracket(page: Page, layout: SeedPanelLayout) {
  // Seeded first: the anonymous stub's own seeds only fill empty keys.
  await seedPanelLayout(page, layout);
  await seedClosedCommandFold(page);
  await stubAnonymousApi(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 120_000
  });
  await expect(modelPanel(page, 'Parameters')).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Preparing model|Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Rebuilding geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 60_000 }
  );
}

/** Lets the camera and every panel come to rest, then writes the PNG. */
async function capture(page: Page, name: string) {
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height / 2);
  await waitForStillViewport(page);
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        void Promise.all(
          document
            .getAnimations()
            .filter((animation) =>
              Number.isFinite(
                animation.effect?.getComputedTiming().iterations ?? 1
              )
            )
            .map((animation) => animation.finished.catch(() => undefined))
        ).then(() => done());
      })
  );
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: join(OUT_DIR, name), animations: 'disabled' });
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test('README: Build workspace in the default Essentials layout', async ({
  page
}) => {
  await openMountingBracket(page, ESSENTIALS);
  await expect(modelPanel(page, 'Objects')).toBeVisible();
  await expect(page.locator('.panel-column[data-side="left"]')).toHaveCount(1);
  await expect(page.locator('.panel-column[data-side="right"]')).toHaveCount(1);
  await capture(page, 'readme-mounting-bracket.png');
});

test('model panels: History and Revisions stacked in a floating window', async ({
  page
}) => {
  await openMountingBracket(page, {
    ...ESSENTIALS,
    floats: [
      {
        id: 'float-1',
        x: 380,
        y: 450,
        w: 340,
        h: 420,
        panels: ['history', 'revisions']
      }
    ],
    weights: { history: 1.2, revisions: 0.8 },
    recent: ['history', 'parameters', 'bodies']
  });
  await expect(modelPanel(page, 'History')).toBeVisible();
  await expect(modelPanel(page, 'Revisions')).toBeVisible();
  await capture(page, 'readme-panels-floating-window.png');
});

test('model panels: the View options menu', async ({ page }) => {
  await openMountingBracket(page, ESSENTIALS);
  await page
    .getByRole('toolbar', { name: 'Model panels' })
    .getByRole('button', { name: 'View options' })
    .click();
  const menu = page.getByRole('menu', { name: 'View options' });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole('menuitemradio', { name: 'Essentials' })
  ).toHaveAttribute('aria-checked', 'true');
  await capture(page, 'readme-panels-view-options.png');
});
