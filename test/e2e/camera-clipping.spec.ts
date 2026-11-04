import {
  addPrimitiveFeature,
  createBodyFeatureIds,
  createProjectDocument,
  setNodeMetadata
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  enableFullRender,
  expectBodyCount,
  waitForStillViewport
} from './openzcad-fixtures';

function cabinetBackup() {
  const ids = createBodyFeatureIds();
  let document = addPrimitiveFeature(
    createProjectDocument('Full-size cabinet depth', toUserId('user_e2e')),
    {
      ids,
      name: 'Cabinet envelope',
      bodyName: 'Cabinet envelope',
      primitiveKind: 'box',
      dimensions: { width: 2362.2, height: 762, depth: 2100 }
    }
  );
  document = setNodeMetadata(document, {
    nodeId: ids.bodyNodeId,
    metadata: { color: '#e5534b' }
  });
  return Buffer.from(
    JSON.stringify({
      format: 'openzcad-project',
      version: 1,
      document,
      files: []
    })
  );
}

/** Check actual face pixels, independently of camera metadata and body counts. */
async function expectWholeFront(page: Page) {
  const points = await page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        const points: number[][] = [];
        for (const x of [0.2, 0.5, 0.8])
          for (const z of [0.2, 0.5, 0.8])
            points.push([2362.2 * x, 0, 2100 * z]);
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (value: { points: { x: number; y: number }[] }) =>
                resolve(value.points)
            }
          })
        );
      })
  );
  const screenshot = await page.screenshot();
  const redSamples = await page.evaluate(
    async ({ base64, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const sample = document.createElement('canvas');
      sample.width = image.naturalWidth;
      sample.height = image.naturalHeight;
      const context = sample.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return points.filter(({ x, y }) => {
        const [r, g, b] = context.getImageData(
          Math.round(x),
          Math.round(y),
          1,
          1
        ).data;
        return r! > g! + 25 && r! > b! + 25;
      }).length;
    },
    { base64: screenshot.toString('base64'), points }
  );
  expect(
    redSamples,
    'all nine points on the cabinet front must remain drawn'
  ).toBe(9);
}

test(
  'full-size assembly stays drawn after reopen and projection changes',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await enableFullRender(page);
    await stubApi(page, { panelLayout: null });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Import project', exact: true })
      .click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'cabinet.openzcad',
      mimeType: 'application/json',
      buffer: cabinetBackup()
    });
    await expectBodyCount(page, 1);
    await page.getByRole('button', { name: 'Fit view (F)' }).click();
    await waitForStillViewport(page);
    await expectWholeFront(page);
    for (const projection of ['perspective', 'orthographic'] as const) {
      if (projection === 'orthographic') {
        await page.keyboard.press('p');
        await expect(
          page.getByRole('button', { name: /Ortho/ })
        ).toHaveAttribute('aria-pressed', 'true');
        await waitForStillViewport(page);
        await expectWholeFront(page);
      }
      await page.reload();
      await expectBodyCount(page, 1);
      await waitForStillViewport(page);
      await expectWholeFront(page);
      const screenshot = test.info().outputPath(`${projection}-reopened.png`);
      await page.screenshot({ path: screenshot });
      await test.info().attach(`${projection}-reopened`, {
        path: screenshot,
        contentType: 'image/png'
      });
    }
    expect(errors).toEqual([]);
  }
);
