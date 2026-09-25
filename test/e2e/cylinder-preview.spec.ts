import type { Page } from '@playwright/test';
import { steppedCylinderDocument } from '../support/stepped-cylinder';
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
    // Three exact rebuilds (commit, undo, refused fillet) plus two preview
    // passes. On hosted 2-core software-GL runners the radius and height
    // cases ran out of 90 s at varying late steps after #430 and #433; the
    // no-rebuild and restore assertions are unchanged.
    test.setTimeout(180_000);
    const { canvas, errors } = await setupRoundedCylinder(
      page,
      dimension === 'bottom-height'
    );
    const select = () =>
      selectHandle(canvas, 'openzcad:e2e-select-cylinder', {
        surface:
          dimension === 'radius'
            ? 'wall'
            : dimension === 'bottom-height'
              ? 'bottom-cap'
              : 'top-cap'
      });
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
    const originalBounds = await rendered(canvas);

    for (const outcome of ['cancel', 'commit'] as const) {
      const handle = await select();
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
    const handle = await select();
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
  // The body keeps its own name through the fillet; only History says Fillet.
  await expect(
    page.locator('.body-row', { hasText: 'Cylinder Body' })
  ).toBeVisible();
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

interface Handle {
  x: number;
  y: number;
  dx: number;
  dy: number;
  scale: number;
}

/**
 * Dispatches a selection hook and reads the drag handle it arms. The render
 * loop writes the handle's screen position, so a read straight after a
 * cancelled drag still sees where that drag left it until the next frame
 * draws — on a slow software-GL frame the test then pressed empty canvas.
 * Two frames: the loop's own callback may already be queued ahead of the
 * first, and the second runs after it either way.
 */
async function selectHandle(
  canvas: ReturnType<Page['locator']>,
  event: string,
  detail: unknown
): Promise<Handle> {
  let handle: Handle | null = null;
  await expect
    .poll(async () => {
      handle = await canvas.evaluate(
        (element, { event, detail }) =>
          new Promise<Handle | null>((resolve) => {
            element.dispatchEvent(new CustomEvent(event, { detail }));
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const data = element.dataset;
                resolve(
                  data.e2eHandleX
                    ? {
                        x: Number(data.e2eHandleX),
                        y: Number(data.e2eHandleY),
                        dx: Number(data.e2eHandleDx),
                        dy: Number(data.e2eHandleDy),
                        scale: Number(data.e2eHandlePixelsPerUnit)
                      }
                    : null
                );
              })
            );
          }),
        { event, detail }
      );
      return handle;
    })
    .not.toBeNull();
  return handle!;
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

for (const sense of [1, -1]) {
  test(`stepped rounded cap ${sense} previews without worker work and keeps the other end fixed`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => {
      const scope = window as typeof window & {
        editSyncs: number;
        holdEdits: boolean;
        releaseEdits: () => void;
      };
      scope.editSyncs = 0;
      const pending: (() => void)[] = [];
      scope.releaseEdits = () => {
        scope.holdEdits = false;
        pending.splice(0).forEach((send) => send());
      };
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, transfer) {
        if ((message as { type?: string })?.type === 'sync') {
          scope.editSyncs++;
          if (scope.holdEdits) {
            pending.push(() =>
              send.call(this, message, transfer as StructuredSerializeOptions)
            );
            return;
          }
        }
        send.call(this, message, transfer as StructuredSerializeOptions);
      };
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { document } = await steppedCylinderDocument();
    await page.goto('/');
    await page.getByRole('button', { name: 'Import project…' }).click();
    // The chooser is driven through the same input used by the File menu.
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'stepped.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document,
          files: []
        })
      )
    });
    await expect(page.locator('.feature-row')).toHaveCount(1);
    const canvas = page.locator('.viewer-host canvas');
    await page
      .getByRole('button', {
        name:
          sense < 0
            ? 'Bottom front right isometric view'
            : 'Top front right isometric view',
        exact: true
      })
      .click();
    await page
      .getByRole('button', { name: 'Fit view (F)', exact: true })
      .click();
    const select = () =>
      canvas.evaluate(
        (element, z) =>
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-planar-face', {
              detail: { normal: { x: 0, y: 0, z } }
            })
          ),
        sense
      );
    await expect
      .poll(async () => {
        await select();
        return canvas.getAttribute('data-e2e-handle-x');
      })
      .not.toBeNull();
    const before = await rendered(canvas);
    const moving = sense > 0 ? 'max' : 'min',
      fixed = sense > 0 ? 'min' : 'max';
    const syncs = () =>
      page.evaluate(
        () => (window as typeof window & { editSyncs: number }).editSyncs
      );
    for (const outcome of ['cancel', 'commit'] as const) {
      const handle = await selectHandle(
        canvas,
        'openzcad:e2e-select-planar-face',
        { normal: { x: 0, y: 0, z: sense } }
      );
      const bounds = (await canvas.boundingBox())!;
      const count = await syncs();
      await page.mouse.move(bounds.x + handle.x, bounds.y + handle.y);
      await page.mouse.down();
      for (const delta of [2, 5, 3, -1, 4]) {
        await page.mouse.move(
          bounds.x + handle.x + handle.dx * handle.scale * delta,
          bounds.y + handle.y + handle.dy * handle.scale * delta,
          { steps: 4 }
        );
        await expect(canvas).toHaveAttribute(
          'data-e2e-height-proxy-offset',
          /.+/
        );
        const value = Number(
          await canvas.getAttribute('data-e2e-height-proxy-offset')
        );
        await expect
          .poll(async () => (await rendered(canvas))[moving][2]!)
          .toBeCloseTo(before[moving][2]! + sense * value, 3);
        expect((await rendered(canvas))[fixed][2]).toBeCloseTo(
          before[fixed][2]!,
          4
        );
      }
      expect(await syncs()).toBe(count);
      await expect(page.locator('.feature-row')).toHaveCount(1);
      await expect(
        page.getByText('Preview · exact on release', { exact: true })
      ).toBeVisible();
      if (outcome === 'cancel') {
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect(canvas).not.toHaveAttribute(
          'data-e2e-height-proxy-offset',
          /.+/
        );
        expect(await rendered(canvas)).toEqual(before);
        expect(await syncs()).toBe(count);
      } else {
        const held = await rendered(canvas);
        await page.evaluate(() => {
          (window as typeof window & { holdEdits: boolean }).holdEdits = true;
        });
        await page.mouse.up();
        await expect(
          page.getByText('Checking geometry…', { exact: true }).first()
        ).toBeVisible();
        expect(await rendered(canvas)).toEqual(held);
        await page.evaluate(() =>
          (
            window as typeof window & { releaseEdits: () => void }
          ).releaseEdits()
        );
        await expect(page.locator('.feature-row')).toHaveCount(2);
        await expect(canvas).not.toHaveAttribute(
          'data-e2e-height-proxy-offset',
          /.+/
        );
        await expect
          .poll(async () => (await rendered(canvas))[moving][2]!)
          .toBeCloseTo(held[moving][2]!, 3);
        expect((await rendered(canvas))[fixed][2]).toBeCloseTo(
          before[fixed][2]!,
          4
        );
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(page.locator('.feature-row')).toHaveCount(1);
        await expect
          .poll(async () => (await rendered(canvas))[moving][2]!)
          .toBeCloseTo(before[moving][2]!, 3);
      }
    }
    expect(errors).toEqual([]);
  });
}
