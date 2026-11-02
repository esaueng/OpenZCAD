import {
  addPrimitiveFeature,
  createBodyFeatureIds,
  createProjectDocument,
  setNodeMetadata,
  transformBody
} from '@openzcad/document-core';
import { toBodyId, toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  enableFullRender,
  expectBodyCount,
  waitForStillViewport,
  revealModelPanel
} from './openzcad-fixtures';

function reproduction(gap = 0) {
  let document = createProjectDocument(
    'Coplanar body colours',
    toUserId('user_e2e')
  );
  for (const [name, color, bodyId, width, height] of [
    ['Red plate', '#e5534b', gap ? 'body_a' : 'body_b', 100, 80],
    [
      'Blue plate',
      '#5f8fe8',
      gap ? 'body_b' : 'body_a',
      gap ? 100 : 70,
      gap ? 80 : 60
    ]
  ] as const) {
    const ids = { ...createBodyFeatureIds(), bodyId: toBodyId(bodyId) };
    document = addPrimitiveFeature(document, {
      ids,
      name,
      bodyName: name,
      primitiveKind: 'box',
      // Stored primitive keys are dx, dy, dz; the UI's Height is depth.
      dimensions: { width, height, depth: 10 }
    });
    document = setNodeMetadata(document, {
      nodeId: ids.bodyNodeId,
      metadata: { color }
    });
    if (name === 'Blue plate')
      document = transformBody(document, {
        name: 'Place blue plate',
        targetBodyId: ids.bodyId,
        translation: { x: gap ? 0 : 15, y: gap ? 0 : 10, z: gap }
      }).document;
  }
  return Buffer.from(
    JSON.stringify({
      format: 'openzcad-project',
      version: 1,
      document,
      files: []
    })
  );
}

/** Sample many interior points, so a single clean pixel cannot hide z-fighting. */
async function topColours(page: Page, z: number) {
  const canvas = page.locator('.viewer-host canvas');
  const points = await canvas.evaluate(
    (element, height) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        const points: number[][] = [];
        for (let x = 25; x <= 75; x += 10)
          for (let y = 20; y <= 60; y += 10) points.push([x, y, height]);
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
    z
  );
  const screenshot = await page.screenshot();
  return page.evaluate(
    async ({ base64, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const sample = document.createElement('canvas');
      sample.width = image.naturalWidth;
      sample.height = image.naturalHeight;
      const context = sample.getContext('2d')!;
      context.drawImage(image, 0, 0);
      let blue = 0,
        red = 0;
      for (const point of points) {
        const pixels = context.getImageData(
          Math.round(point.x) - 1,
          Math.round(point.y) - 1,
          3,
          3
        ).data;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 2]! > pixels[i]! + 25) blue++;
          if (pixels[i]! > pixels[i + 2]! + 25) red++;
        }
      }
      return { blue, red, total: points.length * 9 };
    },
    { base64: screenshot.toString('base64'), points }
  );
}

for (const gap of [0, 0.02]) {
  test(
    `opaque body colours stay stable while rocking the camera (${gap} mm gap)`,
    gap === 0 ? { tag: '@ci-smoke' } : {},
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await enableFullRender(page);
      await stubApi(page);
      const backup = reproduction(gap);
      await test
        .info()
        .attach('coplanar-reproduction.openzcad', {
          body: backup,
          contentType: 'application/json'
        });
      await page.goto('/');
      await page
        .getByRole('button', { name: 'Import project', exact: true })
        .click();
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'coplanar.openzcad',
        mimeType: 'application/json',
        buffer: backup
      });
      await expectBodyCount(page, 2);
      await page.getByRole('button', { name: 'Fit view (F)' }).click();
      await waitForStillViewport(page);
      const cube = page.getByRole('group', {
        name: 'Drag to rotate the view',
        exact: true
      });
      const bounds = (await cube.boundingBox())!;
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      for (const delta of [0, 12, -24, 12, 12, -12]) {
        if (delta) {
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + delta, y, { steps: 6 });
          await page.mouse.up();
          await page.mouse.move(60, 80);
          await waitForStillViewport(page);
        }
        const colours = await topColours(page, 10 + gap);
        expect(
          colours.blue,
          `rock ${delta}: ${JSON.stringify(colours)}`
        ).toBeGreaterThan(colours.total * 0.98);
        expect(colours.red).toBe(0);
      }
      if (gap === 0) {
        await revealModelPanel(page, 'Objects');
        await page
          .getByRole('button', { name: 'Hide body Blue plate', exact: true })
          .click();
        await waitForStillViewport(page);
        const hidden = await topColours(page, 10);
        expect(hidden.red).toBeGreaterThan(hidden.total * 0.98);
        await page
          .getByRole('button', { name: 'Show body Blue plate', exact: true })
          .click();
        await waitForStillViewport(page);
        expect((await topColours(page, 10)).red).toBe(0);
        await page.reload();
        await expectBodyCount(page, 2);
        await waitForStillViewport(page);
        expect((await topColours(page, 10)).red).toBe(0);
      }
    }
  );
}
