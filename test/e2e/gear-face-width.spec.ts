import type { Locator, Page } from '@playwright/test';
import { standaloneSpurGearDocument } from '../support/spur-gear';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY,
  waitForStillViewport
} from './openzcad-fixtures';

const rendered = (canvas: Locator) =>
  canvas.evaluate(
    (element) =>
      new Promise<{ min: number[]; max: number[] }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                bodyFaces: { worldBounds: { min: number[]; max: number[] } }[];
              }) => resolve(state.bodyFaces[0]!.worldBounds)
            }
          })
        );
      })
  );

/** The saved gear's face width: the mesh can show a value still being checked. */
const storedWidth = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () =>
          reject(new Error('Could not open project storage.'));
        request.onsuccess = () => {
          const db = request.result;
          const all = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          all.onsuccess = () => {
            db.close();
            const widths = all.result.flatMap(
              (project: {
                nodes: Record<
                  string,
                  { data?: { featureKind?: string; faceWidth?: unknown } }
                >;
              }) =>
                Object.values(project.nodes).flatMap((node) =>
                  node.data?.featureKind === 'gear' ? [node.data.faceWidth] : []
                )
            );
            resolve(widths.length === 1 ? widths[0] : widths);
          };
          all.onerror = () => {
            db.close();
            reject(new Error('Could not read saved projects.'));
          };
        };
      })
  );

async function selectTop(canvas: Locator) {
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: { normal: { x: 0, y: 0, z: 1 } }
          })
        )
      );
      return canvas.getAttribute('data-e2e-handle-x');
    })
    .not.toBeNull();
}

async function expectWidth(page: Page, canvas: Locator, width: number) {
  await expect(page.getByRole('contentinfo')).not.toContainText('Checking', {
    timeout: 30_000
  });
  await expect.poll(() => storedWidth(page), { timeout: 30_000 }).toBe(width);
  await expect
    .poll(async () => (await rendered(canvas)).max[2]!, { timeout: 30_000 })
    .toBeCloseTo(width, 2);
  expect((await rendered(canvas)).min[2]).toBeCloseTo(0, 2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
}

test(
  'a standalone gear resizes its face width from the top cap',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: 'Import project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'gear.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: standaloneSpurGearDocument(),
          files: []
        })
      )
    });
    await expectBodyCount(page, 1);
    const canvas = page.locator('.viewer-host canvas');
    await page.keyboard.press('f');
    await waitForStillViewport(page);
    await selectTop(canvas);
    const chip = page.getByTestId('direct-manipulation-value');
    await expect(page.getByTestId('direct-manipulation-mode')).toHaveText(
      /^Total/
    );
    await expect(chip).toContainText('10');

    // Drag 10 → 13. This used to plan a local push/pull, which the kernel
    // refuses on involute flanks.
    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      scale: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    const rect = (await canvas.boundingBox())!;
    await page.mouse.move(rect.x + handle.x, rect.y + handle.y);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.mouse.move(
      rect.x + handle.x + handle.dx * handle.scale * 3,
      rect.y + handle.y + handle.dy * handle.scale * 3,
      { steps: 6 }
    );
    await expect(chip).toContainText('13');
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(page.getByRole('contentinfo')).toContainText(
      'Gear face width set to 13 mm.',
      { timeout: 30_000 }
    );
    await expectWidth(page, canvas, 13);
    await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');

    // Typed 13 → 9.
    await selectTop(canvas);
    await expect(chip).toContainText('13');
    await chip.click();
    const keypad = page.getByRole('dialog', { name: 'Total value' });
    await keypad.getByRole('textbox').fill('9');
    await keypad.getByRole('button', { name: 'Apply total' }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Gear face width set to 9 mm.',
      { timeout: 30_000 }
    );
    await expectWidth(page, canvas, 9);

    // A fresh pick reads the committed width.
    await page.keyboard.press('Escape');
    await selectTop(canvas);
    await expect(chip).toContainText('9');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectWidth(page, canvas, 13);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectWidth(page, canvas, 9);
    await page.reload();
    await expectBodyCount(page, 1);
    await expectWidth(page, canvas, 9);
    expect(errors).toEqual([]);
  }
);
