import { expect, test } from '@playwright/test';
import { stubApi } from './openzcad-fixtures';
import type { EdgeOverlayGrowthSample } from '../../apps/web/src/components/viewer/edgeOverlayGrowthProbe';

test(
  'draws complete edge highlights after growing rendered buffers',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await stubApi(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/');
    await page
      .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
      .click();
    const canvas = page.locator('.viewer-host canvas').first();
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    const samples = await canvas.evaluate(
      (element) =>
        new Promise<EdgeOverlayGrowthSample[]>((resolve, reject) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-edge-overlay-growth', {
              detail: { resolve, reject }
            })
          );
        })
    );
    expect(samples.map((sample) => sample.segments)).toEqual(
      Array.from({ length: 3 }, () => [
        1, 1, 64, 64, 128, 128, 1, 1, 64, 64
      ]).flat()
    );
    for (const sample of samples) {
      const label = `${sample.tier}, hidden=${sample.hidden}, segments=${sample.segments}`;
      // LineSegments2 renders six triangles per segment. A stale WebGL limit
      // draws only six after the straight-edge warmup, even with instanceCount=64.
      expect(sample.triangles, label).toBe(sample.segments * 6);
      if (sample.segments > 1)
        expect(sample.highlightedQuadrants, label).toBe(4);
    }
    await testInfo.attach('edge-overlay-growth-render-results', {
      body: JSON.stringify(samples, null, 2),
      contentType: 'application/json'
    });
    expect(errors).toEqual([]);
  }
);
