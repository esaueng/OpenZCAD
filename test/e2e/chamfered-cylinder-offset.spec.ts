import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { chamferedCylinderSolid } from '../support/chamfered-cylinder';
import { steppedChamferedCylinderSolid } from '../support/stepped-chamfered-cylinder';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY
} from './openzcad-fixtures';

type WorldBounds = { min: number[]; max: number[] };

for (const fixture of [
  {
    name: 'cylinder',
    build: chamferedCylinderSolid,
    height: 240,
    total: 300,
    offset: 60,
    radius: 10,
    wallEnd: 238
  },
  {
    name: 'stepped shoulder',
    build: steppedChamferedCylinderSolid,
    height: 77,
    total: 182,
    offset: 105,
    radius: 6,
    wallEnd: 45 + 2 * Math.tan(Math.atan(0.4) / 2)
  }
]) {
  test(`offsets an imported ${fixture.name} bottom cap while preserving the chamfer and shoulder, undo, redo and reload`, async ({
    page
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const kernel = new RemusKernel();
    const io = await loadRemusTranslators();
    const stepText = new TextDecoder().decode(
      io.exportStep(kernel.serializeSolid(fixture.build(kernel)))
    );
    kernel.free();
    const { document } = importStepBody(
      createProjectDocument('Chamfered rod', toUserId('user_test')),
      {
        name: 'Rod',
        sourceName: 'rod.step',
        artifactId: 'artifact_rod',
        stepText
      }
    );
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Import project…' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'rod.openzcad',
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
    // Cold viewport and WASM chunks can finish after the backup import itself.
    await expect(page.locator('.viewer-host canvas')).toBeVisible({
      timeout: 30_000
    });
    await expect(
      page
        .getByRole('group', { name: 'Workspace status' })
        .getByLabel(/ · \d+ features? · 1 body\. Sync /)
    ).toBeVisible({ timeout: 30_000 });
    await expectBodyCount(page, 1);
    const canvas = page.locator('.viewer-host canvas');
    const bounds = (): Promise<WorldBounds | null> =>
      canvas.evaluate((element): WorldBounds | null => {
        let bounds: WorldBounds | null = null;
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                bodyFaces: { worldBounds?: WorldBounds | null }[];
              }) => {
                bounds =
                  state.bodyFaces.find((face) => face.worldBounds)
                    ?.worldBounds ?? null;
              }
            }
          })
        );
        return bounds;
      });
    await expect.poll(async () => (await bounds())?.min[2]).toBeCloseTo(0, 5);
    await expect
      .poll(async () => {
        await canvas.evaluate((element) =>
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-planar-face', {
              detail: { normal: { x: 0, y: 0, z: -1 } }
            })
          )
        );
        return canvas.getAttribute('data-e2e-handle-x');
      })
      .not.toBeNull();
    await expect(page.getByTestId('direct-manipulation-mode')).toHaveText(
      /^Total/
    );
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Total value' });
    await keypad.getByRole('textbox').fill(String(fixture.total));
    await expect
      .poll(async () => (await bounds())?.min[2], { timeout: 30_000 })
      .toBeCloseTo(-fixture.offset, 5);
    await expect
      .poll(async () => (await bounds())?.max[2])
      .toBeCloseTo(fixture.height, 5);
    await keypad.getByRole('button', { name: 'Apply total' }).click();
    await expect(
      page
        .getByRole('group', { name: 'Workspace status' })
        .getByLabel(/ · 2 features · 1 body\. Sync /)
    ).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await bounds())?.min[2]).toBeCloseTo(0, 5);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect
      .poll(async () => (await bounds())?.min[2])
      .toBeCloseTo(-fixture.offset, 5);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<number>((resolve, reject) => {
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
                  resolve(
                    Math.max(
                      0,
                      ...all.result.map(
                        (project: { featureOrder: unknown[] }) =>
                          project.featureOrder.length
                      )
                    )
                  );
                };
                all.onerror = () => {
                  db.close();
                  reject(new Error('Could not read saved projects.'));
                };
              };
            })
        )
      )
      .toBe(2);
    await page.reload();
    await expectBodyCount(page, 1);
    await expect
      .poll(async () => (await bounds())?.min[2], { timeout: 30_000 })
      .toBeCloseTo(-fixture.offset, 5);
    await expect
      .poll(async () => (await bounds())?.max[2])
      .toBeCloseTo(fixture.height, 5);
    const wall = await canvas.evaluate((element) => {
      let geometry: {
        radius?: number;
        axisStart?: { z: number };
        axisEnd?: { z: number };
      } | null = null;
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: {
            surface: 'wall',
            select: false,
            resolve: (value: typeof geometry) => {
              geometry = value;
            }
          }
        })
      );
      return geometry;
    });
    expect(wall).toMatchObject({
      radius: fixture.radius,
      axisStart: { z: expect.closeTo(2 - fixture.offset, 5) },
      axisEnd: { z: expect.closeTo(fixture.wallEnd, 5) }
    });
    expect(errors).toEqual([]);
    const screenshot = testInfo.outputPath('chamfered-bottom-offset.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('chamfered-bottom-offset', {
      path: screenshot,
      contentType: 'image/png'
    });
  });
}
