import {
  createPrimitiveInPlace,
  expect,
  test,
  stubApi,
  modelPanel,
  revealModelPanel
} from './openzcad-fixtures';

/**
 * The bodies a boolean will consume are marked in the viewport itself: each
 * picked body wears its pick number, and the canvas reports the same order.
 * Before this, the scene showed one name with a "+1". Booleans run in place
 * (U09): bodies are picked from the model or the Objects list, no card.
 */
test('numbers the picked bodies in the viewport as an in-place boolean takes them', { tag: '@ci-smoke' }, async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Numbered Union');
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');

  for (const name of ['Lower', 'Upper']) {
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '10', depth: '10', height: '10' },
      name: name
    });
  }

  await page.getByRole('button', { name: /^Subtract \(X\)/ }).click();
  const bar = page.getByRole('group', { name: 'Subtract command' });
  await expect(bar).toContainText('cut from');
  const callouts = page.locator('.body-order-callout');
  await revealModelPanel(page, 'Objects');
  const rows = modelPanel(page, 'Objects').locator('.body-row-main');
  await rows.filter({ hasText: 'Upper 1' }).click();
  await rows.filter({ hasText: 'Lower 1' }).click();

  // Both bodies carry their number, base first, and the canvas agrees on the
  // order the command will submit.
  await expect(callouts).toHaveCount(2);
  // Bodies are numbered at creation, so the order is read from its own span.
  await expect(
    callouts.filter({ hasText: 'Upper 1' }).locator('.callout-order')
  ).toHaveText('1');
  await expect(
    callouts.filter({ hasText: 'Lower 1' }).locator('.callout-order')
  ).toHaveText('2');
  // The two equal boxes leave nothing to subtract, so the bar's line is the
  // refusal; the picks still stand.
  await expect(bar.getByRole('button', { name: /Done/ })).toBeDisabled();
  const order = await canvas.getAttribute('data-e2e-selected-bodies');
  expect(order?.split(',')).toHaveLength(2);

  // Picking a body again drops it, and its number leaves the scene too; the
  // one left keeps the plain name callout of a single selection.
  await rows.filter({ hasText: 'Lower 1' }).click();
  await expect(callouts).toHaveCount(0);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    order!.split(',')[0]!
  );
  await expect(bar).toContainText('cut away');
});
