import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

test('explains a failed downstream edit and opens the exact feature for repair', async ({
  page
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.goto('/');
  await expect(page).toHaveTitle(/OpenZCAD/);
  await page.getByRole('button', { name: /Heat Sink/ }).click();
  await expectBodyCount(page, 1);
  await page.locator('.feature-row-main', { hasText: 'Extrude base' }).click();
  const details = page.getByRole('region', { name: 'History details' });
  await expect(
    details.getByRole('button', { name: 'Inspect Base corner fillets' })
  ).toBeVisible();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector
    .getByRole('textbox', { name: 'Distance', exact: true })
    .fill('base_t + 1');
  await expect(inspector.getByRole('alert')).toContainText(
    'Base corner fillets',
    { timeout: 30_000 }
  );
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(details.getByRole('alert')).toContainText(
    'The previous model is intact',
    { timeout: 30_000 }
  );
  await details
    .getByRole('button', { name: 'Edit Base corner fillets' })
    .click();
  await expect(
    inspector.getByRole('heading', { name: 'Base corner fillets' })
  ).toBeVisible();
  await expect(
    details.getByRole('button', { name: 'Inspect Union fin field' })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true })
  ).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('history-repair.png') });
  await page.setViewportSize({ width: 960, height: 720 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('history-repair-compact.png')
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await details.getByRole('button', { name: 'Dismiss failure' }).click();
  await expect(
    details.getByText('Edit not saved', { exact: false })
  ).toHaveCount(0);
  const radius = inspector.getByLabel('Radius', { exact: true });
  const originalRadius = await radius.inputValue();
  await radius.fill('1000');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(details.getByRole('alert')).toContainText('Edit not saved', {
    timeout: 30_000
  });
  await radius.fill(originalRadius);
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Base corner fillets applied.',
    { timeout: 30_000 }
  );
  await expect(
    details.getByText('Edit not saved', { exact: false })
  ).toHaveCount(0);
  await expectBodyCount(page, 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page
    .locator('.feature-row-main', { hasText: 'Base corner fillets' })
    .click();
  await expect(radius).toHaveValue(originalRadius);
  expect(errors).toEqual([]);
});

test('resumes rollback without resuming manually suppressed features and supports undo', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('History recovery');
  await page.getByRole('button', { name: 'Create project' }).click();
  for (const tool of [/^Box \(B\)/, /^Cylinder \(C\)/, /^Sphere/]) {
    await page.getByRole('button', { name: tool }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();
  }
  await expectBodyCount(page, 3);
  await page
    .getByRole('button', { name: 'Suppress Cylinder', exact: true })
    .click();
  await expectBodyCount(page, 2);
  await page
    .getByRole('button', { name: 'Roll back history after Box', exact: true })
    .click();
  await expectBodyCount(page, 1);
  const details = page.getByRole('region', { name: 'History details' });
  await expect(details).toContainText('2 later features are paused');
  await details.getByRole('button', { name: 'Resume full history' }).click();
  await expectBodyCount(page, 2);
  await expect(
    page.locator('.feature-row', { hasText: /^Cylinder/ })
  ).toContainText('suppressed');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 1);
  await expect(details).toContainText('2 later features are paused');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 2);
});

test('names a deleted sketch input and restores the dependent model with undo', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Heat Sink/ }).click();
  await expectBodyCount(page, 1);
  await page.locator('.feature-row-main', { hasText: 'Base profile' }).click();
  const details = page.getByRole('region', { name: 'History details' });
  await expect(details.getByText(/Affects [1-9]/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Delete Base profile', exact: true })
    .click();
  await page.locator('.feature-row-main', { hasText: 'Extrude base' }).click();
  await expect(
    details.getByText(/An input sketch is missing from history/)
  ).toBeVisible();
  await page.keyboard.press('Control+z');
  await expectBodyCount(page, 1);
  await page.locator('.feature-row-main', { hasText: 'Extrude base' }).click();
  await expect(
    details.getByRole('button', { name: 'Inspect Base profile' })
  ).toBeVisible();
  await expect(details.getByText(/An input sketch is missing/)).toHaveCount(0);
});
