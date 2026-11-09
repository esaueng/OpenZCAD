import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { LOOKDEV_SCENES, LOOKDEV_VIEWS } from '../fixtures/lookdev-scenes';
import type { Page } from '@playwright/test';
import {
  clickWorldPoint,
  enableFullRender,
  expect,
  expectBodyCount,
  selectBodyFromObjects,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';
import type { LookdevScene } from '../fixtures/lookdev-scenes';

/*
  Look-development captures, not a regression test (U10). Each fixed scene
  is opened in the production renderer and drawn from the same camera
  corners, so two builds can be compared image for image:

    OZ_LOOKDEV=1 OZ_LOOKDEV_LABEL=before pnpm exec playwright test test/e2e/viewport-lookdev.spec.ts
    # change the renderer, then
    OZ_LOOKDEV=1 OZ_LOOKDEV_LABEL=after pnpm exec playwright test test/e2e/viewport-lookdev.spec.ts
    node scripts/lookdev-compare.mjs artifacts/lookdev/before artifacts/lookdev/after

  Captures land in `artifacts/lookdev/<label>` (git-ignored); OZ_LOOKDEV_DIR
  writes somewhere else. Skipped unless OZ_LOOKDEV is set and weighted 0 in
  `shard-weights.json`, like the documentation captures.

  Only the WebGL canvas is captured: every other element is hidden first, so
  panels, labels and toasts never land in a comparison.
*/
test.skip(
  !process.env.OZ_LOOKDEV,
  'Look-development captures; set OZ_LOOKDEV=1 to write them.'
);

const VIEWPORT = { width: 1400, height: 1000 };
const OUT_DIR = resolve(
  process.env.OZ_LOOKDEV_DIR ??
    join('artifacts', 'lookdev', process.env.OZ_LOOKDEV_LABEL ?? 'current')
);

/** Hides everything but the WebGL canvas, the view cube included. */
const CANVAS_ONLY_CSS = `body * { visibility: hidden !important; }
.viewer-host canvas { visibility: visible !important; }
.orientation-widget { display: none !important; }`;

// A Retina-class backing store: line widths and antialiasing are judged at
// the pixel ratio most users see them at (the viewer caps it at 2).
// OZ_LOOKDEV_SCHEME=light captures the light stage instead of the dark one.
test.use({
  deviceScaleFactor: 2,
  colorScheme: process.env.OZ_LOOKDEV_SCHEME === 'light' ? 'light' : 'dark'
});
test.setTimeout(240_000);

/** Imports `scene` as a project backup and waits for its one body. */
async function openScene(page: Page, scene: LookdevScene) {
  const adapter = await createExactKernelAdapter();
  let backup: Buffer;
  try {
    backup = Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: await scene.build(adapter),
        files: []
      })
    );
  } finally {
    adapter.dispose();
  }
  await enableFullRender(page);
  await stubApi(page, { panelLayout: null });
  await page.setViewportSize(VIEWPORT);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: `${scene.id}.openzcad`,
    mimeType: 'application/json',
    buffer: backup
  });
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).toBeVisible({ timeout: 60_000 });
  await expectBodyCount(page, 1);
  mkdirSync(OUT_DIR, { recursive: true });
  return errors;
}

/** Turns to one of the view cube's corners and fits the part. */
async function showCorner(page: Page, label: string) {
  // A corner facing away from the camera is hidden on the view cube, so it
  // is neither clickable nor in the accessibility tree; its keyboard
  // activation still selects it.
  await page
    .locator(`.orientation-widget [aria-label="${label}"]`)
    .dispatchEvent('keydown', { key: 'Enter' });
  await page.getByRole('button', { name: 'Fit view (F)' }).click();
}

/** Writes the canvas alone, once the view has come to rest. */
async function capture(page: Page, name: string) {
  await waitForStillViewport(page);
  await page.evaluate((css) => {
    const style = document.createElement('style');
    style.id = 'lookdev-canvas-only';
    style.textContent = css;
    document.head.append(style);
  }, CANVAS_ONLY_CSS);
  await page.locator('.viewer-host canvas').screenshot({
    path: join(OUT_DIR, `${name}.png`),
    animations: 'disabled'
  });
  await page.evaluate(() =>
    document.getElementById('lookdev-canvas-only')?.remove()
  );
}

/** Parks the pointer in a corner of the stage, where it hovers nothing. */
async function parkPointer(page: Page) {
  await page.mouse.move(2, VIEWPORT.height - 2);
}

for (const scene of LOOKDEV_SCENES) {
  test(`lookdev: ${scene.title}`, async ({ page }) => {
    const errors = await openScene(page, scene);
    for (const view of LOOKDEV_VIEWS) {
      await showCorner(page, view.label);
      await parkPointer(page);
      await capture(page, `${scene.id}--${view.id}`);
    }
    writeFileSync(
      join(OUT_DIR, `${scene.id}.json`),
      `${JSON.stringify({ id: scene.id, title: scene.title, views: LOOKDEV_VIEWS }, null, 2)}
`
    );
    expect(errors).toEqual([]);
  });
}

/**
 * The interaction states drawn over the shading: a hovered face, a selected
 * face (the rest of the part recedes), a selected body and X-ray. Their
 * tints and dimming were tuned against the old Phong lighting, so they are
 * judged here against the studio rig.
 */
test('lookdev: interaction states', async ({ page }) => {
  const scene = LOOKDEV_SCENES.find(({ id }) => id === 'boss-on-block')!;
  const errors = await openScene(page, scene);
  await showCorner(page, 'Top front left isometric view');
  // The block's top face, clear of the boss (a 30 × 18 × 26 block with a
  // radius-6 boss on its corner at the origin).
  const topFace: [number, number, number] = [20, 12, 26];

  await parkPointer(page);
  await capture(page, 'states--idle');

  await page.mouse.move(2, 2);
  await clickWorldPoint(page, topFace);
  await parkPointer(page);
  await capture(page, 'states--face-selected');

  await page.keyboard.press('Escape');
  await parkPointer(page);
  await waitForStillViewport(page);
  // Hover only: move onto the face without clicking.
  const canvas = page.locator('.viewer-host canvas');
  const [point] = await canvas.evaluate(
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
    [topFace]
  );
  await page.mouse.move(point!.x, point!.y);
  await capture(page, 'states--face-hovered');

  await parkPointer(page);
  await selectBodyFromObjects(page);
  await parkPointer(page);
  await capture(page, 'states--body-selected');

  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await page.keyboard.press('Shift+X');
  await expect(canvas).toHaveAttribute('data-e2e-xray', /^0\./);
  await parkPointer(page);
  await capture(page, 'states--xray');
  expect(errors).toEqual([]);
});
