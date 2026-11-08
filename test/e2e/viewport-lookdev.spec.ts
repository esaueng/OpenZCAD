import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { LOOKDEV_SCENES, LOOKDEV_VIEWS } from '../fixtures/lookdev-scenes';
import {
  enableFullRender,
  expect,
  expectBodyCount,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

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
test.use({ deviceScaleFactor: 2 });
test.setTimeout(240_000);

for (const scene of LOOKDEV_SCENES) {
  test(`lookdev: ${scene.title}`, async ({ page }) => {
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

    const canvas = page.locator('.viewer-host canvas');
    mkdirSync(OUT_DIR, { recursive: true });
    for (const view of LOOKDEV_VIEWS) {
      // A corner facing away from the camera is hidden on the view cube, so
      // it is neither clickable nor in the accessibility tree; its keyboard
      // activation still selects it.
      await page
        .locator(`.orientation-widget [aria-label="${view.label}"]`)
        .dispatchEvent('keydown', { key: 'Enter' });
      await page.getByRole('button', { name: 'Fit view (F)' }).click();
      // Park the pointer in a corner so no hover highlight is drawn.
      await page.mouse.move(2, VIEWPORT.height - 2);
      await waitForStillViewport(page);
      await page.evaluate((css) => {
        const style = document.createElement('style');
        style.id = 'lookdev-canvas-only';
        style.textContent = css;
        document.head.append(style);
      }, CANVAS_ONLY_CSS);
      await canvas.screenshot({
        path: join(OUT_DIR, `${scene.id}--${view.id}.png`),
        animations: 'disabled'
      });
      await page.evaluate(() =>
        document.getElementById('lookdev-canvas-only')?.remove()
      );
    }
    writeFileSync(
      join(OUT_DIR, `${scene.id}.json`),
      `${JSON.stringify({ id: scene.id, title: scene.title, views: LOOKDEV_VIEWS }, null, 2)}\n`
    );
    expect(errors).toEqual([]);
  });
}
