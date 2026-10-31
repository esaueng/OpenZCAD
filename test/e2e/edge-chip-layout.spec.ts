import {
  createPrimitiveInPlace,
  expect,
  test,
  stubApi
} from './openzcad-fixtures';

for (const tool of ['Fillet', 'Chamfer'] as const) {
  test(`${tool} keeps its full size clear of the operation tag while dragging`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveTitle(/OpenZCAD/);
    await page.getByLabel('Project name').fill(`${tool} chip layout`);
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'cylinder', {
      sizes: { radius: '30', height: '40' }
    });
    const canvas = page.locator('.viewer-host canvas');
    const chip = page.getByTestId('direct-manipulation-value');
    const tag = page.locator('.handle-label-chip');

    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect
        .poll(
          () =>
            canvas.evaluate(
              (element) =>
                new Promise<boolean>((resolve) => {
                  element.dispatchEvent(
                    new CustomEvent('openzcad:e2e-select-edge', {
                      detail: {
                        curve: 'circle',
                        resolve: (value: unknown) => resolve(value !== null)
                      }
                    })
                  );
                })
            ),
          { timeout: 30_000 }
        )
        .toBe(true);
      await expect(chip).toHaveText('R 0 mm');
      if (tool === 'Chamfer') {
        await tag.click();
      }
      await expect(tag).toHaveText(`${tool} ▾`);
      await expect(chip).toHaveText(`${tool === 'Fillet' ? 'R' : 'C'} 0 mm`);
      await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
      const handle = await canvas.evaluate((element) => ({
        x: Number(element.dataset.e2eHandleX),
        y: Number(element.dataset.e2eHandleY),
        dx: Number(element.dataset.e2eHandleDx),
        dy: Number(element.dataset.e2eHandleDy),
        pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
      }));
      const box = (await canvas.boundingBox())!;
      const start = { x: box.x + handle.x, y: box.y + handle.y };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.keyboard.down('Shift');
      try {
        for (const distance of [0.7, 7.7, 12.34, 7.7]) {
          const previous = await chip.textContent();
          await page.mouse.move(
            start.x + handle.dx * handle.pixelsPerUnit * distance,
            start.y + handle.dy * handle.pixelsPerUnit * distance,
            { steps: 8 }
          );
          await expect(chip).not.toHaveText(previous!);
          await expect(chip).toHaveText(
            new RegExp(`^${tool === 'Fillet' ? 'R' : 'C'} [\\d.]+ mm$`)
          );
          const samples = await chip.evaluate(async (element) => {
            const tag = element
              .closest('.viewer-host')!
              .querySelector('.handle-label-chip')!;
            const samples = [];
            for (let frame = 0; frame < 4; frame += 1) {
              await new Promise(requestAnimationFrame);
              const value = element.getBoundingClientRect();
              const label = tag.getBoundingClientRect();
              const host = element
                .closest('.viewer-host')!
                .getBoundingClientRect();
              samples.push({
                gap: value.left - label.right,
                left: label.left - host.left,
                right: host.right - value.right
              });
            }
            return samples;
          });
          for (const sample of samples) {
            expect(
              sample.gap,
              `${tool}, ${width}px, drag distance ${distance}`
            ).toBeGreaterThanOrEqual(2);
            expect(sample.left).toBeGreaterThanOrEqual(0);
            expect(sample.right).toBeGreaterThanOrEqual(0);
          }
        }
        if (process.env.OZ_CHIP_SCREENSHOTS) {
          await page.screenshot({
            path: `${process.env.OZ_CHIP_SCREENSHOTS}/${tool.toLowerCase()}-${width}.png`
          });
        }
        // Cancel the held preview: no geometry/history edit is needed to
        // exercise layout, and the next viewport starts from the same edge.
        await page.keyboard.press('Escape');
      } finally {
        await page.keyboard.up('Shift');
        await page.mouse.up();
      }
      await chip.click();
      await expect(
        page.getByRole('dialog', {
          name: tool === 'Fillet' ? 'Radius value' : 'Distance value'
        })
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    }
    expect(errors).toEqual([]);
  });
}
