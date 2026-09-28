import { expect, test, stubApi } from './openzcad-fixtures';

interface BlendSync {
  requestId: string | null;
  featureOrder: string[];
}

test('commits the exact previewed fillet with the same feature IDs and no second validation rebuild', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.addInitScript(() => {
    const scope = window as typeof window & { blendSyncs: BlendSync[] };
    scope.blendSyncs = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      const sync = message as {
        type?: string;
        requestId?: string;
        document?: { featureOrder?: string[] };
      };
      if (sync.type === 'sync' && sync.document?.featureOrder?.length === 2) {
        scope.blendSyncs.push({
          requestId: sync.requestId ?? null,
          featureOrder: [...sync.document.featureOrder]
        });
      }
      return post.call(this, message, transfer as StructuredSerializeOptions);
    };
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet preview reuse');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const selectCircularEdge = () =>
    canvas.evaluate(
      (element) =>
        new Promise<boolean>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-edge', {
              detail: {
                curve: 'circle',
                resolve: (selection: unknown) => resolve(selection !== null)
              }
            })
          );
        })
    );
  const readBlendRadius = () =>
    canvas.evaluate(
      (element) =>
        new Promise<number | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-blend', {
              detail: {
                inspectOnly: true,
                resolve: (blend: { blendRadius: number } | null) =>
                  resolve(blend?.blendRadius ?? null)
              }
            })
          );
        })
    );
  const syncs = () =>
    page.evaluate(
      () => (window as typeof window & { blendSyncs: BlendSync[] }).blendSyncs
    );

  await expect.poll(selectCircularEdge, { timeout: 30_000 }).toBe(true);
  await expect(
    page.getByRole('region', { name: 'Fillet operation' })
  ).toBeVisible();
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Radius value' });
  await expect(keypad).toBeVisible();
  await keypad.getByRole('textbox').fill('2');
  await expect.poll(readBlendRadius, { timeout: 60_000 }).toBeCloseTo(2, 5);
  const before = await syncs();
  const preview = before.filter((entry) => entry.requestId !== null);
  expect(preview.length).toBeGreaterThan(0);

  await keypad.getByRole('textbox').press('Enter');
  await expect(keypad).toBeHidden();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expect.poll(readBlendRadius, { timeout: 30_000 }).toBeCloseTo(2, 5);
  await expect
    .poll(async () => (await syncs()).some((entry) => entry.requestId === null))
    .toBe(true);
  const after = await syncs();
  expect(after.filter((entry) => entry.requestId !== null)).toHaveLength(
    preview.length
  );
  expect(after.find((entry) => entry.requestId === null)?.featureOrder).toEqual(
    preview.at(-1)?.featureOrder
  );
  await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
});
