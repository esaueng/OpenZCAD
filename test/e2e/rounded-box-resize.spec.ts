import { test, expect, stubApi } from './openzcad-fixtures';

test('resizes a rounded box from its minimum side with exact entry, drag, cancel and undo', async ({
  page
}, testInfo) => {
  // This multi-edit flow rebuilds exact fillets for entry, drag, undo and redo.
  // Hosted CI reached the final UI checks but exhausted the 120 s total budget.
  test.setTimeout(process.env.CI ? 180000 : 120000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await page.getByLabel('Project name').fill('Rounded box resize');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Width (X)').fill('40');
  await inspector.getByLabel('Depth (Y)').fill('24');
  await inspector.getByLabel('Height (Z)').fill('10');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await page.getByRole('button', { name: /^Fillet/ }).click();
  await inspector.getByRole('button', { name: 'Select all 12 edges' }).click();
  await inspector.getByLabel('Radius', { exact: true }).fill('1.5');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  const fillet = page.locator('.feature-row-main', { hasText: 'Fillet' });
  await expect(fillet).toBeVisible();
  const canvas = page.locator('.viewer-host canvas');
  const selectSide = async () => {
    await expect
      .poll(() =>
        canvas.evaluate(
          (element) =>
            new Promise((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-planar-face', {
                  detail: { normal: { x: 0, y: -1, z: 0 }, resolve }
                })
              );
            })
        )
      )
      .toMatchObject({
        hasReference: true,
        lineageName: 'modifier.box.face.y-min'
      });
    await expect(
      page.getByRole('region', { name: 'Resize Body operation' })
    ).toBeVisible();
  };
  const checkShape = async (depth: number) => {
    await fillet.click();
    await expect(page.locator('.panel-body')).toContainText(
      `40 × ${depth} × 10 mm`
    );
    await expect(
      page.locator('.kv-grid b', { hasText: /^faces$/ }).locator('+ span')
    ).toHaveText('26');
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expect(
      page.locator('.feature-row-main', { hasText: 'Offset face' })
    ).toHaveCount(0);
  };
  await checkShape(24);
  await selectSide();
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Total value' });
  await keypad.getByRole('textbox').fill('28');
  await keypad.getByRole('button', { name: 'Apply total' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'depth set to 28 mm'
  );
  await checkShape(28);
  await selectSide();
  const drag = async (delta: number) => {
    await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      pixels: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    const bounds = (await canvas.boundingBox())!;
    const x = bounds.x + handle.x,
      y = bounds.y + handle.y;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(
      x + handle.dx * handle.pixels * delta,
      y + handle.dy * handle.pixels * delta,
      { steps: 12 }
    );
  };
  await drag(2);
  await expect(page.getByTestId('direct-manipulation-value')).toContainText(
    '30'
  );
  await expect(page.locator('.panel-body')).toContainText('40 × 30 × 10 mm');
  await page.screenshot({
    path: testInfo.outputPath('rounded-box-resize-preview.png')
  });
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText(
    'depth set to 30 mm'
  );
  await checkShape(30);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await checkShape(28);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await checkShape(30);
  await selectSide();
  await drag(2);
  await expect(page.getByTestId('direct-manipulation-value')).toContainText(
    '32'
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await checkShape(30);
  await selectSide();
  const card = page.getByRole('region', { name: 'Resize Body operation' });
  await card.getByRole('tab', { name: 'Offset Face', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toBeVisible();
  await page.getByTestId('direct-manipulation-value').click();
  await expect(
    page.getByRole('dialog', { name: 'Offset value' })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page
    .getByRole('region', { name: 'Offset Face operation' })
    .getByRole('tab', { name: 'Resize body', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Resize Body operation' })
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('rounded-box-resize-result.png')
  });
  expect(errors).toEqual([]);
});
