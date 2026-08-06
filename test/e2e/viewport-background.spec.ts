import { expect, test } from '@playwright/test';
import { stubApi } from './openzcad-fixtures';

test.use({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2
});

interface BackgroundMetrics {
  topLuminance: number;
  middleLuminance: number;
  bottomLuminance: number;
  medianUniqueColorsPerRow: number;
  medianLongestFlatRun: number;
}

test('dithers the studio gradient without flattening it', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Background Dither');
  await page.getByRole('button', { name: 'Create project' }).click();

  const grid = page.getByRole('button', { name: 'Toggle grid (G)' });
  await grid.click();
  await expect(grid).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Standard views' }).click();
  await page
    .getByRole('button', { name: 'Front view (1)', exact: true })
    .click();
  await page.waitForTimeout(900);

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('Viewer canvas is not laid out.');
  }

  // Stay left of the vertical axis and clear of the tool rail, orientation
  // cube, and viewport HUD. The crop spans enough height to prove that the
  // dither has not flattened or inverted the studio gradient.
  const screenshot = await page.screenshot({
    clip: {
      x: bounds.x + bounds.width * 0.25,
      y: bounds.y + bounds.height * 0.12,
      width: bounds.width * 0.2,
      height: bounds.height * 0.76
    }
  });

  const metrics = await page.evaluate<BackgroundMetrics, string>(
    async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const sample = document.createElement('canvas');
      sample.width = image.naturalWidth;
      sample.height = image.naturalHeight;
      const context = sample.getContext('2d');
      if (!context) {
        throw new Error('Could not inspect the background screenshot.');
      }
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        sample.width,
        sample.height
      ).data;
      const median = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] ?? 0;
      };
      const luminanceAt = (x: number, y: number) => {
        const offset = (y * sample.width + x) * 4;
        return (
          pixels[offset]! * 0.2126 +
          pixels[offset + 1]! * 0.7152 +
          pixels[offset + 2]! * 0.0722
        );
      };
      const averageBand = (start: number, end: number) => {
        let total = 0;
        let count = 0;
        for (let y = start; y < end; y += 2) {
          for (let x = 0; x < sample.width; x += 2) {
            const luminance = luminanceAt(x, y);
            // Ignore the rare bright axis/overlay pixel if platform raster
            // rounding lets one enter the otherwise background-only crop.
            if (luminance < 45) {
              total += luminance;
              count += 1;
            }
          }
        }
        return total / Math.max(count, 1);
      };

      const uniqueColorsPerRow: number[] = [];
      const longestFlatRuns: number[] = [];
      for (let y = 8; y < sample.height - 8; y += 31) {
        const colors = new Set<string>();
        let previous = '';
        let run = 0;
        let longest = 0;
        for (let x = 0; x < sample.width; x += 1) {
          const offset = (y * sample.width + x) * 4;
          const color = `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`;
          colors.add(color);
          if (color === previous) {
            run += 1;
          } else {
            longest = Math.max(longest, run);
            previous = color;
            run = 1;
          }
        }
        uniqueColorsPerRow.push(colors.size);
        longestFlatRuns.push(Math.max(longest, run));
      }

      const bandHeight = Math.max(1, Math.floor(sample.height * 0.08));
      return {
        topLuminance: averageBand(0, bandHeight),
        middleLuminance: averageBand(
          Math.floor(sample.height * 0.46),
          Math.floor(sample.height * 0.54)
        ),
        bottomLuminance: averageBand(sample.height - bandHeight, sample.height),
        medianUniqueColorsPerRow: median(uniqueColorsPerRow),
        medianLongestFlatRun: median(longestFlatRuns)
      };
    },
    screenshot.toString('base64')
  );

  expect(metrics.topLuminance).toBeGreaterThan(metrics.middleLuminance + 3);
  expect(metrics.middleLuminance).toBeGreaterThan(metrics.bottomLuminance + 3);
  expect(metrics.medianUniqueColorsPerRow).toBeGreaterThanOrEqual(2);
  expect(metrics.medianLongestFlatRun).toBeLessThan(64);
});
