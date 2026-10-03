import { expect, test, stubApi } from './openzcad-fixtures';

/**
 * The bodies a boolean will consume are marked in the viewport itself: each
 * picked body wears its pick number, the number the form's list shows, and
 * the canvas reports the same order. Before this, the scene showed one name
 * with a "+1" and the user had to trust the list.
 */
test('numbers the picked bodies in the viewport as the boolean form does', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Numbered Union');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  const canvas = page.locator('.viewer-host canvas');

  for (const name of ['Lower', 'Upper']) {
    await page.getByRole('button', { name: /^Box \(B\)/ }).click();
    await inspector.getByLabel('Name').fill(name);
    await inspector.getByLabel('Width (X)').fill('10');
    await inspector.getByLabel('Depth (Y)').fill('10');
    await inspector.getByLabel('Height (Z)').fill('10');
    await inspector.getByRole('button', { name: /^Create/ }).click();
  }

  await page.getByRole('button', { name: /^Subtract \(X\)/ }).click();
  const callouts = page.locator('.body-order-callout');
  await inspector.locator('.pick-row', { hasText: 'Upper 1' }).click();
  await inspector.locator('.pick-row', { hasText: 'Lower 1' }).click();

  // Both bodies carry their number, base first, and the canvas agrees on the
  // order the form will submit.
  await expect(callouts).toHaveCount(2);
  // Bodies are numbered at creation, so the order is read from its own span.
  await expect(
    callouts.filter({ hasText: 'Upper 1' }).locator('.callout-order')
  ).toHaveText('1');
  await expect(
    callouts.filter({ hasText: 'Lower 1' }).locator('.callout-order')
  ).toHaveText('2');
  await expect(
    inspector.locator('.pick-row', { hasText: 'Upper 1' })
  ).toContainText('base');
  const order = await canvas.getAttribute('data-e2e-selected-bodies');
  expect(order?.split(',')).toHaveLength(2);

  // Dropping a body from the list clears its number in the scene too; the
  // one left keeps the plain name callout of a single selection.
  await inspector.locator('.pick-row', { hasText: 'Lower 1' }).click();
  await expect(callouts).toHaveCount(0);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    order!.split(',')[0]!
  );
  await expect(inspector.locator('.pick-row.selected')).toHaveCount(1);
});
