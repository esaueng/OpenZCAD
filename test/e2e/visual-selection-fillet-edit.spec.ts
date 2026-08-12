import { expect, test, stubApi } from './openzcad-fixtures';

test('creates, re-edits twice, and removes a selected history fillet', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet Select To Edit');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('10');
  await inspector.getByLabel('Height', { exact: true }).fill('20');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const canvas = page.locator('.viewer-host canvas');
  const status = page.getByRole('contentinfo');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(status).not.toContainText(
    /Starting geometry worker|Loading exact BrepKit kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 30_000 }
  );

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
  await expect.poll(selectCircularEdge, { timeout: 30_000 }).toBe(true);
  await expect(
    page.getByRole('region', { name: 'Fillet operation' })
  ).toBeVisible();
  const chip = page.getByTestId('direct-manipulation-value');
  await expect(chip).toHaveText('R 0 mm');
  await chip.click();
  let keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('1');
  await expect
    .poll(
      () =>
        canvas.evaluate((element) =>
          Number(element.dataset.e2ePreviewBlendCount ?? 0)
        ),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Filleted 1 edge at 1 mm.');
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expect(status).not.toContainText(
    /Starting geometry worker|Loading exact BrepKit kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 30_000 }
  );

  type BlendResult = {
    topologyId: string;
    blendRadius: number;
    producingFeatureId?: string;
    lineageName?: string;
  };
  const readBlend = (select = false) =>
    canvas.evaluate(
      (element, shouldSelect) =>
        new Promise<BlendResult | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-blend', {
              detail: { select: shouldSelect, resolve }
            })
          );
        }),
      select
    );
  await expect
    .poll(async () => (await readBlend())?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(1, 6);
  expect((await readBlend())?.producingFeatureId).toBeTruthy();
  const selectedLineage = (await readBlend())?.lineageName;
  expect(selectedLineage).toMatch(/^modifier\.fillet\.face\.band-between\./);
  expect(await readBlend(true)).not.toBeNull();

  const editFillet = page.getByRole('region', {
    name: 'Edit Fillet operation'
  });
  await expect(editFillet).toBeVisible();
  await expect(chip).toHaveText('Edit Fillet · R 1 mm');
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);

  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('2');
  await expect
    .poll(async () => (await readBlend())?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(2, 6);
  expect((await readBlend())?.lineageName).toBe(selectedLineage);
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Set Fillet edges radius to R 2 mm.');
  await expect(editFillet).toBeVisible();
  await expect(chip).toHaveText('Edit Fillet · R 2 mm');

  // The second edit uses the still-armed, re-resolved blend face. No viewport
  // selection event is dispatched between the two commits.
  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('3');
  await expect
    .poll(async () => (await readBlend())?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(3, 6);
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Set Fillet edges radius to R 3 mm.');
  await expect(editFillet).toBeVisible();
  await expect(chip).toHaveText('Edit Fillet · R 3 mm');
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();

  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('0');
  await expect.poll(readBlend, { timeout: 30_000 }).toBeNull();
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Removed Fillet edges.');
  await expect(
    page.locator('.feature-row', { hasText: /^Fillet edges/ })
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await expect.poll(readBlend, { timeout: 30_000 }).toBeNull();
  expect(consoleErrors).toEqual([]);
});
