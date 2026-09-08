import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  expectConsumedBodyCount
} from './openzcad-fixtures';

for (const dimension of ['radius', 'height', 'bottom-height'] as const) {
  test(`rounded cylinder ${dimension} follows the drag without worker rebuilds and restores on cancel`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    const { canvas, errors } = await setupRoundedCylinder(
      page,
      dimension === 'bottom-height'
    );
    const select = () =>
      canvas.evaluate(
        (element, surface) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: { surface }
            })
          );
        },
        dimension === 'radius'
          ? 'wall'
          : dimension === 'bottom-height'
            ? 'bottom-cap'
            : 'top-cap'
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
    const original =
      dimension === 'radius' ? 70 : dimension === 'bottom-height' ? 0 : 22;
    const extent = dimension === 'bottom-height' ? 'min' : 'max';
    const expectedExtent = (value: number) =>
      dimension === 'radius'
        ? value
        : dimension === 'bottom-height'
          ? -value
          : original + value;
    await select();
    await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
    const originalBounds = await rendered(canvas);

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
          .poll(async () => (await rendered(canvas))[extent][axis]!)
          .toBeCloseTo(expectedExtent(value), 3);
      }
      await expect(
        page.getByText('Preview · exact on release', { exact: true })
      ).toBeVisible();
      expect(await syncs()).toBe(count);
      if (outcome === 'cancel') {
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect(canvas).not.toHaveAttribute(proxyAttribute, /.+/);
        expect(await rendered(canvas)).toEqual(originalBounds);
        expect(await syncs()).toBe(count);
      } else {
        const value = Number(await canvas.getAttribute(proxyAttribute));
        await page.mouse.up();
        await expect(page.getByRole('contentinfo')).toContainText(
          dimension === 'radius' ? 'Adjusted cylinder diameter' : 'height set'
        );
        await expect(canvas).not.toHaveAttribute(proxyAttribute, /.+/);
        await expect
          .poll(async () => (await rendered(canvas))[extent][axis]!)
          .toBeCloseTo(expectedExtent(value), 3);
        await expect(page.locator('.feature-row')).toHaveCount(
          dimension === 'bottom-height' ? 3 : 2
        );
        if (dimension === 'bottom-height')
          expect((await rendered(canvas)).max[2]).toBeCloseTo(22, 3);
        await page
          .getByRole('button', { name: 'Undo', exact: true })
          .evaluate((element) => (element as HTMLButtonElement).click());
        await expect
          .poll(async () => (await rendered(canvas))[extent][axis]!)
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
    for (const change of [
      4,
      1 - (dimension === 'bottom-height' ? 22 : original)
    ]) {
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
      .poll(async () => (await rendered(canvas))[extent][axis]!)
      .toBeCloseTo(original, 3);
    await expect(page.locator('.feature-row')).toHaveCount(2);
    await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('rounded cylinder rapid bottom, top, and radius edits survive reload', async ({
  page
}) => {
  test.setTimeout(90_000);
  const { canvas, errors } = await setupRoundedCylinder(page, true);
  for (const [surface, change, minZ, maxZ, radius] of [
    ['bottom-cap', 5, -5, 22, 70],
    ['bottom-cap', 5, -10, 22, 70],
    ['top-cap', 5, -10, 27, 70],
    ['wall', 5, -10, 27, 75]
  ] as const) {
    await canvas.evaluate(
      (element, surface) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: { surface }
          })
        ),
      surface
    );
    await expect(canvas).toHaveAttribute(
      'data-e2e-chip-anchor-rig',
      surface === 'wall' ? 'cylinder-radius' : 'offset-face'
    );
    await expect(page.locator('.inspector-float')).toContainText(
      surface === 'bottom-cap'
        ? 'Bottom face'
        : surface === 'top-cap'
          ? 'Top face'
          : 'Cylindrical face'
    );
    await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();
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
    await page.mouse.move(
      bounds.x + handle.x + handle.dx * handle.scale * change,
      bounds.y + handle.y + handle.dy * handle.scale * change
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await rendered(canvas)).min[2]!)
      .toBeCloseTo(minZ, 2);
    await expect
      .poll(async () => (await rendered(canvas)).max[2]!)
      .toBeCloseTo(maxZ, 2);
    await expect
      .poll(async () => (await rendered(canvas)).max[0]!)
      .toBeCloseTo(radius, 2);
    await expect(page.locator('.feature-row')).toHaveCount(3);
    await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
    await expect(canvas).not.toHaveAttribute('data-e2e-chip-anchor-rig', /.+/);
  }
  await page.getByTitle('Back to projects').click();
  await page
    .locator('.start-tile-open', { hasText: 'Rounded cylinder preview' })
    .click();
  await expect(page.locator('.feature-row')).toHaveCount(3);
  await page.reload();
  await expect(page.locator('.feature-row')).toHaveCount(3);
  await expect
    .poll(async () => (await rendered(canvas)).min[2]!)
    .toBeCloseTo(-10, 2);
  await expect
    .poll(async () => (await rendered(canvas)).max[2]!)
    .toBeCloseTo(27, 2);
  await expect
    .poll(async () => (await rendered(canvas)).max[0]!)
    .toBeCloseTo(75, 2);
  await test.info().attach('bottom-top-radius-after-reload', {
    body: await page.screenshot({
      path: test.info().outputPath('bottom-top-radius.png')
    }),
    contentType: 'image/png'
  });
  expect(errors).toEqual([]);
});

async function setupRoundedCylinder(page: Page, bottomView: boolean) {
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
  await expect(page.locator('.body-row', { hasText: 'Fillet' })).toBeVisible();
  if (bottomView) {
    await page
      .getByRole('button', {
        name: 'Bottom front right isometric view',
        exact: true
      })
      .click();
  }
  const canvas = page.locator('.viewer-host canvas');
  return { canvas, errors };
}

const rendered = (canvas: ReturnType<Page['locator']>) =>
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
