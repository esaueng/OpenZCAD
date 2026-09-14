import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { compoundOffsetSolids } from '../support/compound-offset';

test('previews and commits a compound STEP cap offset, then undoes, redoes and reopens it', async ({
  page
}) => {
  test.setTimeout(120_000);
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const solids = compoundOffsetSolids(kernel);
  // The existing viewport test hook selects the first matching planar face.
  // Adapter coverage separately verifies ownership when it is not first.
  const bytes = io.exportStep(
    kernel.serializeSolids(
      Uint32Array.from([solids[2]!, solids[0]!, solids[1]!, solids[3]!])
    )
  );
  kernel.free();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Compound face offset');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel(/^Import STEP or \/ /).setInputFiles({
    name: 'components.step',
    mimeType: 'application/step',
    buffer: Buffer.from(bytes)
  });
  await expectBodyCount(page, 1);
  const canvas = page.locator('.viewer-host canvas');
  const selectCap = () =>
    canvas.evaluate((element) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-planar-face', {
          detail: { normal: { x: 1, y: 0, z: 0 } }
        })
      );
    });
  const capX = () =>
    canvas.evaluate(
      (element) =>
        new Promise<number | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: {
                surface: 'wall',
                select: false,
                resolve: (
                  geometry: {
                    axisStart?: { x: number };
                    axisEnd?: { x: number };
                  } | null
                ) =>
                  resolve(
                    geometry?.axisStart && geometry.axisEnd
                      ? Math.max(geometry.axisStart.x, geometry.axisEnd.x)
                      : null
                  )
              }
            })
          );
        })
    );
  await expect.poll(capX, { timeout: 30_000 }).toBeCloseTo(63, 5);
  await expect
    .poll(async () => {
      await selectCap();
      return canvas.getAttribute('data-e2e-handle-x');
    })
    .not.toBeNull();
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Offset value' });
  await keypad.getByRole('textbox').fill('5');
  // Exact entry drives the same worker preview as a drag, without screen
  // projection or grid snapping changing the requested five millimeters.
  await expect.poll(capX, { timeout: 30_000 }).toBeCloseTo(68, 5);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await keypad.getByRole('button', { name: 'Apply offset' }).click();
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect.poll(capX).toBeCloseTo(68, 2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(capX).toBeCloseTo(63, 5);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(capX).toBeCloseTo(68, 2);
  // The source badge does not indicate whether the debounced device save
  // has finished. Wait for the committed history in IndexedDB before reload.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const request = indexedDB.open('openzcad-v2');
            request.onerror = () =>
              reject(new Error('Could not read the saved project.'));
            request.onsuccess = () => {
              const db = request.result;
              const all = db
                .transaction('projects', 'readonly')
                .objectStore('projects')
                .getAll();
              all.onerror = () => {
                db.close();
                reject(new Error('Could not read the saved project.'));
              };
              all.onsuccess = () => {
                const projects = all.result as { featureOrder?: string[] }[];
                db.close();
                resolve(projects[0]?.featureOrder?.length ?? 0);
              };
            };
          })
      )
    )
    .toBe(2);
  await page.reload();
  await expect.poll(capX, { timeout: 30_000 }).toBeCloseTo(68, 2);
  await expectBodyCount(page, 1);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(errors).toEqual([]);
});
