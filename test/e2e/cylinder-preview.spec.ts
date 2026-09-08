import {
  test,
  expect,
  stubApi,
  expectConsumedBodyCount
} from './openzcad-fixtures';

for (const dimension of ['radius', 'height'] as const) {
  test(`rounded cylinder ${dimension} follows the drag without worker rebuilds and restores on cancel`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => {
      const scope = window as typeof window & { editSyncs: number };
      scope.editSyncs = 0;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, transfer) {
        if ((message as { type?: string } | null)?.type === 'sync')
          scope.editSyncs += 1;
        return post.call(this, message, transfer as StructuredSerializeOptions);
      };
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByLabel('Project name').fill('Rounded cylinder preview');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    await inspector.getByLabel('Radius', { exact: true }).fill('70');
    await inspector.getByLabel('Height', { exact: true }).fill('22');
    await inspector.getByRole('button', { name: /^Create/ }).click();
    await page.getByRole('button', { name: /^Fillet/ }).click();
    await inspector.getByRole('button', { name: 'Select all 2 edges' }).click();
    await inspector.getByLabel('Radius', { exact: true }).fill('2');
    await inspector.getByRole('button', { name: /^Create/ }).click();
    await expect(page.locator('.feature-row')).toHaveCount(2);
    await expectConsumedBodyCount(page, 1);
    await expect(
      page.locator('.body-row', { hasText: 'Fillet' })
    ).toBeVisible();
    const canvas = page.locator('.viewer-host canvas');
    const select = () =>
      canvas.evaluate(
        (element, surface) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: { surface }
            })
          );
        },
        dimension === 'radius' ? 'wall' : 'top-cap'
      );
    const rendered = () =>
      canvas.evaluate(
        (element) =>
          new Promise<{ min: number[]; max: number[] }>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-render-policy', {
                detail: {
                  resolve: (state: {
                    bodyFaces: { bounds: { min: number[]; max: number[] } }[];
                  }) => resolve(state.bodyFaces[0]!.bounds)
                }
              })
            );
          })
      );
    const syncs = () =>
      page.evaluate(
        () => (window as typeof window & { editSyncs: number }).editSyncs
      );
    const proxyAttribute =
      dimension === 'radius'
        ? 'data-e2e-cylinder-proxy-radius'
        : 'data-e2e-height-proxy-offset';
    const axis = dimension === 'radius' ? 0 : 2;
    const original = dimension === 'radius' ? 70 : 22;
    await select();
    await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
    const originalBounds = await rendered();

    for (const outcome of ['cancel', 'commit'] as const) {
      await select();
      await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
      const handle = await canvas.evaluate((element) => ({
        x: Number(element.dataset.e2eHandleX),
        y: Number(element.dataset.e2eHandleY),
        dx: Number(element.dataset.e2eHandleDx),
        dy: Number(element.dataset.e2eHandleDy),
        scale: Number(element.dataset.e2eHandlePixelsPerUnit)
      }));
      const bounds = (await canvas.boundingBox())!;
      const count = await syncs();
      await page.mouse.move(bounds.x + handle.x, bounds.y + handle.y);
      await page.mouse.down();
      for (const change of [4, 8, 10]) {
        await page.mouse.move(
          bounds.x + handle.x + handle.dx * handle.scale * change,
          bounds.y + handle.y + handle.dy * handle.scale * change,
          { steps: 4 }
        );
        await expect(canvas).toHaveAttribute(proxyAttribute, /.+/);
        const value = Number(await canvas.getAttribute(proxyAttribute));
        await expect
          .poll(async () => (await rendered()).max[axis]!)
          .toBeCloseTo(dimension === 'radius' ? value : original + value, 3);
      }
      await expect(
        page.getByText('Preview · exact on release', { exact: true })
      ).toBeVisible();
      expect(await syncs()).toBe(count);
      if (outcome === 'cancel') {
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect(canvas).not.toHaveAttribute(proxyAttribute, /.+/);
        expect(await rendered()).toEqual(originalBounds);
        expect(await syncs()).toBe(count);
      } else {
        const value = Number(await canvas.getAttribute(proxyAttribute));
        await page.mouse.up();
        await expect(page.getByRole('contentinfo')).toContainText(
          dimension === 'radius' ? 'Adjusted cylinder diameter' : 'height set'
        );
        await expect(canvas).not.toHaveAttribute(proxyAttribute, /.+/);
        await expect
          .poll(async () => (await rendered()).max[axis]!)
          .toBeCloseTo(dimension === 'radius' ? value : original + value, 3);
        await expect(page.locator('.feature-row')).toHaveCount(2);
        await page
          .getByRole('button', { name: 'Undo', exact: true })
          .evaluate((element) => (element as HTMLButtonElement).click());
        await expect
          .poll(async () => (await rendered()).max[axis]!)
          .toBeCloseTo(original, 3);
      }
    }
    await select();
    await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      scale: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(bounds.x + handle.x, bounds.y + handle.y);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    // Enter the proxy first, then shrink through the rim's valid range.
    for (const change of [4, 1 - original]) {
      await page.mouse.move(
        bounds.x + handle.x + handle.dx * handle.scale * change,
        bounds.y + handle.y + handle.dy * handle.scale * change,
        { steps: 4 }
      );
    }
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(page.getByRole('contentinfo')).toContainText(
      'Fillet could not be created'
    );
    await expect(canvas).not.toHaveAttribute(proxyAttribute, /.+/);
    await expect
      .poll(async () => (await rendered()).max[axis]!)
      .toBeCloseTo(original, 3);
    await expect(page.locator('.feature-row')).toHaveCount(2);
    await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
