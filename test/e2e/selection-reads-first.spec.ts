import type { Locator, Page } from '@playwright/test';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

/*
  Design review batch 6e, "the selection reads first".

  F8: a picked face used to take the accent blue over its gold feature
  colour, which mixed to grey-tan and read as the one part switched off.
  It now keeps its colour, lifted, under a bright rim, while the rest of
  the scene recedes.

  F11: a pick that armed an operation also raised a second chip at the top
  of the column ("Fillet · Ready") saying what the chip on the pick said.
  The operation's phase, refusal and switch now ride the chip on the pick.
*/

async function createBox(page: Page, name: string) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await createProject(page, name);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  return page.locator('.viewer-host canvas');
}

interface FacePoint {
  x: number;
  y: number;
  face: string;
}

/**
 * Points on two different faces of the box. A point is on a face when the
 * pointer turns to a grab there; clicking it says which face, and Escape
 * leaves nothing selected again.
 */
async function twoFacePoints(canvas: Locator): Promise<[FacePoint, FacePoint]> {
  const page = canvas.page();
  const bounds = (await canvas.boundingBox())!;
  const found: FacePoint[] = [];
  for (const yRatio of [0.36, 0.44, 0.52, 0.6, 0.68]) {
    for (const xRatio of [0.36, 0.44, 0.52, 0.6, 0.68]) {
      const point = {
        x: bounds.x + bounds.width * xRatio,
        y: bounds.y + bounds.height * yRatio
      };
      await page.mouse.move(point.x, point.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) !== 'grab'
      ) {
        continue;
      }
      await page.mouse.click(point.x, point.y);
      await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
      const face = (await canvas.getAttribute('data-e2e-selected-face'))!;
      await page.keyboard.press('Escape');
      await expect(canvas).not.toHaveAttribute('data-e2e-selected-face', /.+/);
      if (!found.some((candidate) => candidate.face === face)) {
        found.push({ ...point, face });
        if (found.length === 2) {
          return [found[0]!, found[1]!];
        }
      }
    }
  }
  throw new Error(`found ${found.length} of two pickable faces`);
}

interface ColourReading {
  /** Mean WCAG relative luminance. */
  luminance: number;
  /** HSL saturation of the mean colour: what grey-tan lost. */
  saturation: number;
}

/** Reads a 7 px square of the rendered page. */
async function colourAt(
  page: Page,
  point: { x: number; y: number }
): Promise<ColourReading> {
  const size = 7;
  const screenshot = await page.screenshot({
    clip: {
      x: Math.round(point.x) - 3,
      y: Math.round(point.y) - 3,
      width: size,
      height: size
    }
  });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const sample = document.createElement('canvas');
    sample.width = image.naturalWidth;
    sample.height = image.naturalHeight;
    const context = sample.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, sample.width, sample.height).data;
    const channel = (value: number) => {
      const unit = value / 255;
      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const pixels = data.length / 4;
    let luminance = 0;
    const mean = [0, 0, 0];
    for (let offset = 0; offset < data.length; offset += 4) {
      luminance +=
        0.2126 * channel(data[offset]!) +
        0.7152 * channel(data[offset + 1]!) +
        0.0722 * channel(data[offset + 2]!);
      for (let index = 0; index < 3; index += 1) {
        mean[index]! += data[offset + index]! / 255 / pixels;
      }
    }
    const high = Math.max(...mean);
    const low = Math.min(...mean);
    const lightness = (high + low) / 2;
    const saturation =
      high === low ? 0 : (high - low) / (1 - Math.abs(2 * lightness - 1));
    return { luminance: luminance / pixels, saturation };
  }, screenshot.toString('base64'));
}

/** Parks the pointer off the model so no hover tint lands on a sample. */
async function parkPointer(canvas: Locator) {
  const bounds = (await canvas.boundingBox())!;
  await canvas
    .page()
    .mouse.move(bounds.x + bounds.width * 0.08, bounds.y + bounds.height * 0.9);
}

test('a picked face is drawn brighter than it was, and the rest recedes', async ({
  page
}) => {
  test.setTimeout(120_000);
  const canvas = await createBox(page, 'Selection tint');
  const [picked, other] = await twoFacePoints(canvas);
  await parkPointer(canvas);
  await page.waitForTimeout(400);
  const idlePicked = await colourAt(page, picked);
  const idleOther = await colourAt(page, other);

  await page.mouse.click(picked.x, picked.y);
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', picked.face);
  await parkPointer(canvas);
  // Polled: the highlight fades in by frame time, which runs long when the
  // machine is loaded.
  let selectedPicked = idlePicked;
  let recededOther = idleOther;
  const reading = () =>
    JSON.stringify({ idlePicked, selectedPicked, idleOther, recededOther });
  await expect
    .poll(
      async () => {
        selectedPicked = await colourAt(page, picked);
        recededOther = await colourAt(page, other);
        return (
          // Lifted, never darkened.
          selectedPicked.luminance > idlePicked.luminance * 1.02 &&
          // Everything else gives up brightness while something is selected.
          recededOther.luminance < idleOther.luminance * 0.85
        );
      },
      { timeout: 20_000 }
    )
    .toBe(true);
  // Not greyed: the accent laid over the gold took most of its saturation.
  expect(selectedPicked.saturation, reading()).toBeGreaterThan(
    idlePicked.saturation * 0.7
  );
  // The pick is the brighter of the two by a wider margin than before.
  const contrast = (a: ColourReading, b: ColourReading) =>
    (a.luminance + 0.05) / (b.luminance + 0.05);
  expect(contrast(selectedPicked, recededOther), reading()).toBeGreaterThan(
    contrast(idlePicked, idleOther) * 1.3
  );
  await expect(canvas).toHaveAttribute('data-e2e-selection-recedes', 'true');

  // Deselecting gives every face its own colour back.
  await page.keyboard.press('Escape');
  await expect(canvas).not.toHaveAttribute('data-e2e-selection-recedes');
  await expect
    .poll(
      async () =>
        Math.abs(
          (await colourAt(page, other)).luminance - idleOther.luminance
        ) / idleOther.luminance,
      { timeout: 20_000 }
    )
    .toBeLessThan(0.03);
});

test('an edge pick carries its operation on the chip, refusal included', async ({
  page
}) => {
  test.setTimeout(120_000);
  const canvas = await createBox(page, 'Operation on the chip');
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-edge', {
                  detail: {
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        ),
      { timeout: 30_000 }
    )
    .toBe(true);

  // One surface: the chip on the pick is the operation, and no second chip
  // stands at the top of the column saying the same.
  const chip = page.locator('.selection-callout-chip');
  const operation = page.getByRole('region', { name: 'Fillet operation' });
  await expect(operation).toBeVisible();
  await expect(operation).toHaveClass(/selection-callout-chip/);
  await expect(page.locator('.tool-card')).toHaveCount(0);
  await expect(chip.locator('.selection-callout-phase')).toHaveText('Ready');

  // Its Fillet/Chamfer switch is the chip's own pressed verbs.
  const fillet = chip.getByRole('button', {
    name: 'Selection: Fillet',
    exact: true
  });
  const chamfer = chip.getByRole('button', {
    name: 'Selection: Chamfer',
    exact: true
  });
  await expect(fillet).toHaveAttribute('aria-pressed', 'true');
  await chamfer.click();
  await expect(
    page.getByRole('region', { name: 'Chamfer operation' })
  ).toBeVisible();
  await expect(chamfer).toHaveAttribute('aria-pressed', 'true');
  await fillet.click();
  await expect(operation).toBeVisible();

  // The chip stays on top of the model and takes its own presses.
  const hit = await fillet.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const target = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2
    );
    return Boolean(target && button.contains(target));
  });
  expect(hit).toBe(true);

  // A refusal is said on the chip, with the way out, not on a second card.
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('40');
  await keypad.getByRole('textbox').press('Enter');
  await expect(chip.locator('.selection-callout-phase')).toHaveText('Failed', {
    timeout: 60_000
  });
  const refusal = chip.getByRole('alert');
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText(/radius/i);
  await expect(page.locator('.tool-card')).toHaveCount(0);
  // The refusal wraps inside the chip rather than stretching it across
  // the viewport.
  const widths = await chip.evaluate((element) => ({
    chip: element.getBoundingClientRect().width,
    refusal: element
      .querySelector('.selection-callout-diagnostic')!
      .getBoundingClientRect().width
  }));
  expect(widths.refusal).toBeLessThanOrEqual(widths.chip);
  expect(widths.chip).toBeLessThan(720);

  // The handle's own riding label stays: the chip did not replace it.
  await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();
});
