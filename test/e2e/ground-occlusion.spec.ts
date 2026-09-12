import { test, expect, stubApi } from './openzcad-fixtures';

for (const view of ['perspective', 'orthographic', 'below'] as const) {
  test(`ground decorations do not paint over an opaque sphere crossing Z=0 (${view})`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await stubApi(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByLabel('Project name').fill('Ground occlusion');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('button', { name: /^Sphere/ }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');
    // Fit once, then keep the camera and pointer fixed for both captures.
    await page.getByRole('button', { name: 'Fit view (F)' }).click();
    if (view === 'orthographic') {
      await page
        .getByRole('button', { name: /^Orthographic projection/ })
        .click();
    } else if (view === 'below') {
      await page
        .getByRole('button', {
          name: 'Bottom front right isometric view',
          exact: true
        })
        .click();
    }
    await page.mouse.move(10, 10);
    await page.waitForTimeout(700);
    const toggle = page.getByRole('button', { name: 'Toggle grid (G)' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const withGround = await canvas.screenshot({
      path: testInfo.outputPath('grid-on.png')
    });
    await toggle.click();
    await page.mouse.move(10, 10);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const withoutGround = await canvas.screenshot({
      path: testInfo.outputPath('grid-off.png')
    });
    await testInfo.attach('grid-on', {
      body: withGround,
      contentType: 'image/png'
    });
    await testInfo.attach('grid-off', {
      body: withoutGround,
      contentType: 'image/png'
    });
    const pixels = await page.evaluate(
      async ([on, off]) => {
        async function decode(base64: string) {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height);
        }
        const a = await decode(on!);
        const b = await decode(off!);
        const solid = (i: number) =>
          b.data[i]! > 100 &&
          b.data[i + 1]! > 100 &&
          b.data[i]! > b.data[i + 2]! * 1.3 &&
          b.data[i + 1]! > b.data[i + 2]! * 1.2;
        let interior = 0;
        let changedInterior = 0;
        let changedBackground = 0;
        for (let y = 3; y < b.height - 3; y++) {
          for (let x = 3; x < b.width - 3; x++) {
            const i = (y * b.width + x) * 4;
            const changed = [0, 1, 2].some(
              (c) => Math.abs(a.data[i + c]! - b.data[i + c]!) > 3
            );
            // Erode the silhouette so antialiasing at its boundary is excluded.
            if (
              [0, -3, 3, -3 * b.width, 3 * b.width].every((d) =>
                solid(i + d * 4)
              )
            ) {
              interior++;
              if (changed) changedInterior++;
            } else if (!solid(i) && changed) {
              changedBackground++;
            }
          }
        }
        return { interior, changedInterior, changedBackground };
      },
      [withGround.toString('base64'), withoutGround.toString('base64')]
    );
    expect(pixels.interior).toBeGreaterThan(1000);
    expect(pixels.changedBackground).toBeGreaterThan(1000);
    expect(pixels.changedInterior / pixels.interior).toBeLessThan(0.001);
    expect(errors).toEqual([]);
  });
}
