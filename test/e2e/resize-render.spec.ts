import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubAnonymousApi } from './openzcad-fixtures';

interface ResizeProbeWindow extends Window {
  __openZcadResizeProbe?: {
    frame: number;
    originalSidebarWidth: string;
  };
}

async function centerLuminance(page: Page, canvas: Locator): Promise<number> {
  const clip = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.left + bounds.width * 0.2,
      y: bounds.top + bounds.height * 0.2,
      width: bounds.width * 0.6,
      height: bounds.height * 0.6
    };
  });
  const screenshot = await page.screenshot({ clip });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const sample = document.createElement('canvas');
    sample.width = image.naturalWidth;
    sample.height = image.naturalHeight;
    const context = sample.getContext('2d');
    if (!context) {
      throw new Error('Could not inspect the viewer screenshot.');
    }
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let luminance = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      luminance +=
        pixels[index]! * 0.2126 +
        pixels[index + 1]! * 0.7152 +
        pixels[index + 2]! * 0.0722;
    }
    return luminance / (pixels.length / 4);
  }, screenshot.toString('base64'));
}

test('keeps the rendered scene visible while a docked panel resizes', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubAnonymousApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Resize Render Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(250);
  const settledLuminance = await centerLuminance(page, canvas);
  expect(settledLuminance).toBeGreaterThan(4);

  await page.evaluate(() => {
    const browserWindow = window as ResizeProbeWindow;
    const workspace = document.querySelector<HTMLElement>('.workspace');
    if (!workspace) {
      throw new Error('Workspace is not available.');
    }
    const probe = {
      frame: 0,
      originalSidebarWidth: workspace.style.getPropertyValue('--sidebar-w')
    };
    browserWindow.__openZcadResizeProbe = probe;
    let step = 0;
    const resize = () => {
      workspace.style.setProperty('--sidebar-w', `${252 + (step % 28)}px`);
      step += 1;
      probe.frame = requestAnimationFrame(resize);
    };
    probe.frame = requestAnimationFrame(resize);
  });

  await page.waitForTimeout(250);
  const resizingLuminance = await centerLuminance(page, canvas);

  await page.evaluate(() => {
    const browserWindow = window as ResizeProbeWindow;
    const probe = browserWindow.__openZcadResizeProbe;
    const workspace = document.querySelector<HTMLElement>('.workspace');
    if (probe) {
      cancelAnimationFrame(probe.frame);
      workspace?.style.setProperty('--sidebar-w', probe.originalSidebarWidth);
    }
    delete browserWindow.__openZcadResizeProbe;
  });

  expect(resizingLuminance).toBeGreaterThan(settledLuminance * 0.5);
});
