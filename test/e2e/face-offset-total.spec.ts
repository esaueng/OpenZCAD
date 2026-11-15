import { roundedPlateDocument } from '../support/rounded-plate';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  createPrimitiveInPlace,
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
      const mode = page.getByTestId('direct-manipulation-mode');
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
        // A face starts on Offset, the signed move (owner decision after
        // QA 2026-11-14 finding #9); these picks read Total, one switch away.
        if (!/^Total/.test(await mode.innerText())) await mode.click();
        await expect(mode).toHaveText(/^Total/);
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
      // The plate is 80 mm wide with a Ø10 hole at x=40. Total reads plane to
      // plane, to the flat face across the plate: the line from y=20 crosses
      // the hole's wall, which is not the reference, and still reads 80, the
      // same as y=8 beside the hole.
      await pick(80, 20, 80);
      const initial = await count();
      await pick(80, 8, 80);
      expect(await count()).toBe(initial);
      await pick(80, 20, 80);
      // Accepting the rounded prefill must not subtract it from a more precise
      // mesh baseline and accidentally create a microscopic offset feature.
      await value.click();
      const unchanged = page.getByRole('dialog', { name: 'Total value' });
      await unchanged.getByRole('button', { name: 'Apply total' }).click();
      await expect(unchanged).toBeHidden();
      expect(await count()).toBe(initial);
      await expect.poll(span).toBeCloseTo(80 * scale, 4);
      // A typed Total is the width the plate is left at: 75 stores −5.
      await enter(units === 'mm' ? '70 + 5' : '75 / 25.4');
      await expect.poll(count).toBe(initial + 1);
      await expect.poll(span).toBeCloseTo(75 * scale, 4);
      const grown = await span();
      // The moved face is armed again; its Total is the new width.
      if (!/^Total/.test(await mode.innerText())) await mode.click();
      await expect.poll(read).toBeCloseTo(75 * scale, 2);
      await pick(grown / scale, 8, 75);
      await pick(grown / scale, 20, 75);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(span).toBeCloseTo(80 * scale, 4);
      await pick(80, 20, 80);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect.poll(span).toBeCloseTo(grown, 4);
      await pick(grown / scale, 20, 75);
      await mode.click();
      await expect(mode).toHaveText(/^Offset/);
      await enter(units === 'mm' ? '5' : '5 / 25.4', 'Offset');
      await expect.poll(count).toBe(initial + 2);
      const restored = grown + 5 * scale;
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
      await pick(restored / scale, 20, 80);
      await expect.poll(span).toBeCloseTo(restored, 4);
      expect(await count()).toBe(initial + 2);
      await page.getByLabel('Operation instructions', { exact: true }).click();
      await expect(page.locator('.workspace-hint-help[open]')).toContainText(
        'Holes, fillets and chamfers are not counted'
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

// QA 2026-11-14 finding #9: typing 5 on a 24 mm box's top face moved it by
// −19, because the field started on Total. Owner decision: it starts on
// Offset, the signed move; Total stays one switch away on the chip's tag.
test(
  'a typed face value is an Offset by default; Total is one switch away',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Offset default');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', { sizes: { height: 24 } });
    await expectBodyCount(page, 1);
    const canvas = page.locator('.viewer-host canvas');
    const value = page.getByTestId('direct-manipulation-value');
    const mode = page.getByTestId('direct-manipulation-mode');
    const height = () =>
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
                    resolve(bounds.max[2]! - bounds.min[2]!);
                  }
                }
              })
            );
          })
      );
    const pickTop = async () => {
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
    };
    await expect.poll(height).toBeCloseTo(24, 4);

    await pickTop();
    await expect(mode).toHaveText(/^Offset/);
    await expect(value).toHaveText('+0 mm');
    await value.click();
    const offsetKeypad = page.getByRole('dialog', { name: 'Offset value' });
    await expect(offsetKeypad.getByRole('textbox')).toHaveAccessibleDescription(
      'Offset: how far the face moves, + out, − in'
    );
    await offsetKeypad.getByRole('textbox').fill('5');
    await offsetKeypad.getByRole('button', { name: 'Apply offset' }).click();
    await expect(offsetKeypad).toBeHidden();
    // +5, not the −19 a Total of 5 made.
    await expect.poll(height).toBeCloseTo(29, 4);

    // Switched to Total, the same 5 is the size the face sets.
    await pickTop();
    await expect(mode).toHaveText(/^Offset/);
    await mode.click();
    await expect(mode).toHaveText(/^Total/);
    await expect(value).toHaveText('29 mm');
    await value.click();
    const totalKeypad = page.getByRole('dialog', { name: 'Total value' });
    // Opening entry re-arms the handle; the switch holds for this face.
    await expect(mode).toHaveText(/^Total/);
    await expect(totalKeypad.getByRole('textbox')).toHaveValue('29');
    await totalKeypad.getByRole('textbox').fill('5');
    await expect(totalKeypad.getByRole('textbox')).toHaveAccessibleDescription(
      'Total: the size this face sets, 29 mm before this edit · moves the face −24 mm'
    );
    await totalKeypad.getByRole('button', { name: 'Apply total' }).click();
    await expect(totalKeypad).toBeHidden();
    await expect.poll(height).toBeCloseTo(5, 4);
  }
);
