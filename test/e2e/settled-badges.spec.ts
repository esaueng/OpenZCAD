import type { Locator, Page } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * Brief states must not blink on the Selection card: a "Validating" pill for
 * a check that answers within a frame or two, or the pick renamed "Face"
 * (its area gone) while a typed value's exact preview is on screen. Each was
 * a few frames in a screen recording, so the card is sampled every frame.
 */

declare global {
  interface Window {
    __cardFrames?: string[];
  }
}

async function selectFace(canvas: Locator, normal: object) {
  await expect
    .poll(() =>
      canvas.evaluate(
        (element, normal) =>
          new Promise((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: { normal, resolve }
              })
            );
          }),
        normal
      )
    )
    .not.toBeNull();
}

/** A 30 × 18 × 24 box with its front face armed for Offset Face. */
async function armedBox(page: Page) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Settled badges');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Width (X)').fill('30');
  await inspector.getByLabel('Depth (Y)').fill('18');
  await inspector.getByLabel('Height (Z)').fill('24');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  const canvas = page.locator('.viewer-host canvas');
  await selectFace(canvas, { x: 0, y: -1, z: 0 });
  await page
    .locator('.selection-card')
    .getByRole('button', { name: 'Selection: Offset', exact: true })
    .click();
  const card = page.getByRole('region', { name: 'Offset Face operation' });
  await expect(card).toBeVisible();
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  return { canvas, card };
}

/** Records the card's visible text on every frame from now on. */
async function sampleCard(page: Page) {
  await page.evaluate(() => {
    const frames: string[] = [];
    window.__cardFrames = frames;
    const sample = () => {
      const card = document.querySelector<HTMLElement>('.selection-card');
      frames.push(card ? card.innerText.replace(/\s+/g, ' ') : '');
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

const frames = (page: Page) => page.evaluate(() => window.__cardFrames ?? []);

test('a drag release whose check answers quickly never blinks a Validating pill', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  const { canvas } = await armedBox(page);
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixels: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  const x = bounds.x + handle.x,
    y = bounds.y + handle.y;
  await sampleCard(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    x + handle.dx * handle.pixels * 3,
    y + handle.dy * handle.pixels * 3,
    { steps: 12 }
  );
  await expect(canvas).toHaveAttribute('data-e2e-height-proxy-offset', '3');
  await page.mouse.up();
  await expect(page.getByText('Offset face by', { exact: false })).toBeVisible({
    timeout: 30_000
  });
  await page.waitForTimeout(300);
  const seen = await frames(page);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((text) => text.includes('Validating'))).toEqual([]);
});

test('a typed offset keeps naming the face while its exact preview is up', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  const { card } = await armedBox(page);
  await expect(card).toContainText('Box 1 · Front face');
  await sampleCard(page);
  await page.getByTestId('direct-manipulation-value').click();
  // The box side reads its whole span (Total, 18 mm deep): 21 is a 3 mm pull.
  const keypad = page.getByRole('dialog', { name: 'Total value' });
  await keypad.getByRole('textbox').fill('21');
  // Long enough for the typed value's exact preview to land and show.
  await page.waitForTimeout(1500);
  await keypad.getByRole('textbox').press('Enter');
  await expect(page.getByText('Offset face by', { exact: false })).toBeVisible({
    timeout: 30_000
  });
  await page.waitForTimeout(300);
  const seen = (await frames(page)).filter((text) => text !== '');
  expect(seen.length).toBeGreaterThan(0);
  // Every frame names the front face and gives its area.
  expect(seen.filter((text) => !text.includes('Box 1 · Front face'))).toEqual(
    []
  );
  expect(seen.filter((text) => !/mm²/.test(text))).toEqual([]);
});
