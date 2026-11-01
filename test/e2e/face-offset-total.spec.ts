import { displayTessellationForExtents } from '../../packages/kernel-adapter/src/display-tessellation';
import { roundedPlateDocument } from '../support/rounded-plate';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY
} from './openzcad-fixtures';

for (const units of ['mm', 'inch'] as const) {
  test(
    `Total follows the pick and typed Offset restores the same solid (${units})`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(120_000);
      await stubApi(page, { panelLayout: MODEL_ONLY });
      await page.setViewportSize({ width: 1440, height: 1000 });
      const { document } = await roundedPlateDocument({ units });
      const scale = units === 'inch' ? 1 / 25.4 : 1;
      await page.goto('/');
      await page.getByRole('button', { name: 'Import project' }).click();
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'total-pick.openzcad',
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
      await expectBodyCount(page, 1);
      const canvas = page.locator('.viewer-host canvas');
      const value = page.getByTestId('direct-manipulation-value');
      const count = async () =>
        Number(
          (
            await page
              .locator('.workspace-status-summary [title]')
              .getAttribute('title')
          )?.match(/(\d+) features?/)?.[1]
        );
      const read = async () => parseFloat(await value.innerText());
      const pick = async (x: number, y: number, expected: number) => {
        await expect
          .poll(async () => {
            await canvas.evaluate(
              (element, point) =>
                element.dispatchEvent(
                  new CustomEvent('openzcad:e2e-select-planar-face', {
                    detail: { normal: { x: 1, y: 0, z: 0 }, point }
                  })
                ),
              { x: x * scale, y: y * scale, z: 3 * scale }
            );
            return canvas.getAttribute('data-e2e-handle-x');
          })
          .not.toBeNull();
        await expect.poll(read).toBeCloseTo(expected * scale, 2);
      };
      const span = () =>
        canvas.evaluate(
          (element) =>
            new Promise<number>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-render-policy', {
                  detail: {
                    resolve: (state: {
                      bodyFaces: {
                        worldBounds: { min: number[]; max: number[] };
                      }[];
                    }) => {
                      const bounds = state.bodyFaces[0]!.worldBounds;
                      resolve(bounds.max[0]! - bounds.min[0]!);
                    }
                  }
                })
              );
            })
        );
      const enter = async (
        expression: string,
        mode: 'Total' | 'Offset' = 'Total'
      ) => {
        await value.click();
        const keypad = page.getByRole('dialog', { name: `${mode} value` });
        await keypad.getByRole('textbox').fill(expression);
        await keypad
          .getByRole('button', { name: `Apply ${mode.toLowerCase()}` })
          .click();
        await expect(keypad).toBeHidden();
      };
      // The plate is 80 mm wide. At y=20 a Ø10 hole at x=40 ends
      // the material at x=45; y=8 misses the hole and reads all 80 mm.
      await pick(80, 20, 35);
      const initial = await count();
      await pick(80, 8, 80);
      expect(await count()).toBe(initial);
      await pick(80, 20, 35);
      // Accepting the rounded prefill must not subtract it from a more precise
      // mesh baseline and accidentally create a microscopic offset feature.
      await value.click();
      const unchanged = page.getByRole('dialog', { name: 'Total value' });
      await unchanged.getByRole('button', { name: 'Apply total' }).click();
      await expect(unchanged).toBeHidden();
      expect(await count()).toBe(initial);
      await expect.poll(span).toBeCloseTo(80 * scale, 4);
      await enter(units === 'mm' ? '35 + 6' : '41 / 25.4');
      await expect.poll(count).toBe(initial + 1);
      // Total is explicitly mesh-derived: a chord through the hole can differ
      // from its analytic circle by the viewer's existing deflection budget.
      const tolerance =
        displayTessellationForExtents(80, 40, 6).linearDeflection * scale;
      await expect
        .poll(async () => Math.abs((await span()) - 86 * scale))
        .toBeLessThanOrEqual(tolerance);
      const grown = await span();
      await expect.poll(read).toBeCloseTo(41 * scale, 2);
      await pick(grown / scale, 8, 86);
      await pick(grown / scale, 20, 41);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(span).toBeCloseTo(80 * scale, 4);
      await pick(80, 20, 35);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect.poll(span).toBeCloseTo(grown, 4);
      await pick(grown / scale, 20, 41);
      await page.getByTestId('direct-manipulation-mode').click();
      await expect(page.getByTestId('direct-manipulation-mode')).toHaveText(
        /^Offset/
      );
      await enter(units === 'mm' ? '-6' : '-6 / 25.4', 'Offset');
      await expect.poll(count).toBe(initial + 2);
      const restored = grown - 6 * scale;
      await expect.poll(span).toBeCloseTo(restored, 4);
      // Device persistence is a separate witness from the account save label.
      await expect
        .poll(() =>
          page.evaluate(
            (expected) =>
              new Promise<boolean>((resolve, reject) => {
                const request = indexedDB.open('openzcad-v2');
                request.onerror = () =>
                  reject(
                    new Error('Could not open project database', {
                      cause: request.error
                    })
                  );
                request.onsuccess = () => {
                  const db = request.result;
                  const all = db
                    .transaction('projects', 'readonly')
                    .objectStore('projects')
                    .getAll();
                  all.onerror = () => {
                    db.close();
                    reject(
                      new Error('Could not read saved projects', {
                        cause: all.error
                      })
                    );
                  };
                  all.onsuccess = () => {
                    db.close();
                    resolve(
                      all.result.some(
                        (doc: { featureOrder?: string[] }) =>
                          doc.featureOrder?.length === expected
                      )
                    );
                  };
                };
              }),
            initial + 2
          )
        )
        .toBe(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectBodyCount(page, 1);
      await pick(restored / scale, 20, 35);
      await expect.poll(span).toBeCloseTo(restored, 4);
      expect(await count()).toBe(initial + 2);
      await page.getByLabel('Operation instructions', { exact: true }).click();
      await expect(page.locator('.workspace-hint-help[open]')).toContainText(
        'Holes or a different pick location can change it.'
      );
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const details = page.locator('.workspace-hint-help[open] > p');
        const bounds = await details.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        await page.screenshot({
          path: test.info().outputPath(`total-pick-${units}-${width}.png`)
        });
      }
    }
  );
}
