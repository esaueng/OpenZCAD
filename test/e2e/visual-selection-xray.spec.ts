import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubApi } from './openzcad-fixtures';

interface ProbePoint {
  x: number;
  y: number;
  topologyId: string;
}

interface ColorSample {
  pixels: number[];
}

async function selectProbeSurface(
  canvas: Locator,
  surface: 'bore' | 'annulus'
): Promise<ProbePoint | null> {
  return canvas.evaluate(
    (element, requestedSurface) =>
      new Promise<ProbePoint | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-visual-selection-probe', {
            detail: { surface: requestedSurface, resolve }
          })
        );
      }),
    surface
  );
}

async function settleRender(canvas: Locator) {
  await canvas.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

async function sampleAround(
  page: Page,
  canvas: Locator,
  point: ProbePoint
): Promise<ColorSample> {
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('Viewer canvas is not laid out.');
  }
  const size = 15;
  const screenshot = await page.screenshot({
    clip: {
      x: bounds.x + point.x - Math.floor(size / 2),
      y: bounds.y + point.y - Math.floor(size / 2),
      width: size,
      height: size
    }
  });
  return page.evaluate<ColorSample, string>(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const sample = document.createElement('canvas');
    sample.width = image.naturalWidth;
    sample.height = image.naturalHeight;
    const context = sample.getContext('2d');
    if (!context) {
      throw new Error('Could not inspect the viewport probe screenshot.');
    }
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    return {
      pixels: Array.from(pixels)
    };
  }, screenshot.toString('base64'));
}

test('x-rays the selected bore behind the outer wall only', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const status = page.getByRole('contentinfo');
  await expect(status).not.toContainText(
    /Starting geometry worker|Loading exact BrepKit kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 60_000 }
  );

  let boreProbe: ProbePoint | null = null;
  await expect
    .poll(async () => {
      boreProbe = await selectProbeSurface(canvas, 'bore');
      return boreProbe;
    })
    .not.toBeNull();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-face',
    boreProbe!.topologyId
  );
  await settleRender(canvas);
  // The first selection opens the inspector and narrows the canvas. Resolve
  // the world-space probe again only after that layout transition settles.
  boreProbe = await selectProbeSurface(canvas, 'bore');
  expect(boreProbe).not.toBeNull();
  await settleRender(canvas);
  const bore = await sampleAround(page, canvas, boreProbe!);

  const annulusProbe = await selectProbeSurface(canvas, 'annulus');
  expect(annulusProbe).not.toBeNull();
  expect(annulusProbe?.x).toBeCloseTo(boreProbe!.x, 5);
  expect(annulusProbe?.y).toBeCloseTo(boreProbe!.y, 5);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-face',
    annulusProbe!.topologyId
  );
  await settleRender(canvas);
  const settledAnnulusProbe = await selectProbeSurface(canvas, 'annulus');
  expect(settledAnnulusProbe).not.toBeNull();
  await settleRender(canvas);
  const annulus = await sampleAround(page, canvas, settledAnnulusProbe!);

  let strongestCyanShift = -Infinity;
  for (let offset = 0; offset < bore.pixels.length; offset += 4) {
    const redShift = bore.pixels[offset]! - annulus.pixels[offset]!;
    const greenShift = bore.pixels[offset + 1]! - annulus.pixels[offset + 1]!;
    const blueShift = bore.pixels[offset + 2]! - annulus.pixels[offset + 2]!;
    strongestCyanShift = Math.max(
      strongestCyanShift,
      blueShift - (redShift + greenShift) / 2
    );
  }
  expect(strongestCyanShift).toBeGreaterThan(5);

  if (process.env.OZ_QA_EVIDENCE === '1') {
    const selectedProbe = await selectProbeSurface(canvas, 'bore');
    expect(selectedProbe).not.toBeNull();
    await expect(canvas).toHaveAttribute(
      'data-e2e-selected-face',
      selectedProbe!.topologyId
    );
    await settleRender(canvas);
    await page.screenshot({
      path: 'docs/qa/visual-selection/phase-2/bore-xray-oblique-front.jpg',
      type: 'jpeg',
      quality: 84
    });

    const bounds = await canvas.boundingBox();
    if (!bounds) {
      throw new Error('Viewer canvas is not laid out.');
    }
    const start = {
      x: bounds.x + bounds.width * 0.3,
      y: bounds.y + bounds.height * 0.25
    };
    await page.keyboard.down('Shift');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(
      start.x + bounds.width * 0.14,
      start.y - bounds.height * 0.05,
      { steps: 8 }
    );
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await settleRender(canvas);
    await page.screenshot({
      path: 'docs/qa/visual-selection/phase-2/bore-xray-oblique-rear.jpg',
      type: 'jpeg',
      quality: 84
    });
  }
});
