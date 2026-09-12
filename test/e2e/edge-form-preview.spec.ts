import {
  test,
  expect,
  stubApi,
  setSelectionFilter,
  locateEdge
} from './openzcad-fixtures';

for (const [tool, field] of [
  ['Fillet', 'Radius'],
  ['Chamfer', 'Distance']
] as const) {
  test(`${tool} creation retains its entered size after an exact preview`, async ({
    page
  }) => {
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Edge form preview');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    await inspector.getByLabel('Radius', { exact: true }).fill('14');
    await inspector.getByLabel('Height', { exact: true }).fill('28');
    await inspector.getByRole('button', { name: /^Create/ }).click();
    await page.getByRole('button', { name: new RegExp(`^${tool}`) }).click();
    await inspector.getByRole('button', { name: 'Select all 2 edges' }).click();
    await inspector.getByLabel(field, { exact: true }).fill('1');
    await expect(page.getByRole('contentinfo')).toContainText(
      'Preview · Apply to save the exact result.'
    );
    await expect(inspector.getByLabel(field, { exact: true })).toHaveValue('1');
    await expect(page.locator('.feature-row')).toHaveCount(1);
    await inspector.getByRole('button', { name: /^Create/ }).click();
    const feature = page.locator('.feature-row', {
      hasText: new RegExp(`^${tool}`)
    });
    await expect(feature).toBeVisible();
    await feature.locator('.feature-row-main').click();
    await expect(inspector.getByLabel(field, { exact: true })).toHaveValue('1');
    await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
  });
}

test('a fillet takes another edge after creation from its own form', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet retarget');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.locator('.feature-row')).toHaveCount(1);

  // One rim first.
  await setSelectionFilter(page, 'Edge');
  const first = await locateEdge(page);
  await page.mouse.click(first.x, first.y);
  await page.getByRole('button', { name: /^Fillet/ }).click();
  await expect(inspector).toContainText('1 exact edge');
  await inspector.getByLabel('Radius', { exact: true }).fill('1');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  const feature = page.locator('.feature-row', { hasText: /^Fillet/ });
  await expect(feature).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  // Reopen the fillet and add the other rim: the edit form takes the pick
  // and Apply patches the same feature instead of creating a second one.
  await feature.locator('.feature-row-main').click();
  await expect(inspector).toContainText('1 exact edge');
  const second = await locateEdge(page, { exclude: [first.topologyId] });
  await page.keyboard.down('Shift');
  await page.mouse.click(second.x, second.y);
  await page.keyboard.up('Shift');
  await expect(inspector).toContainText('2 exact edges');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Fillet applied.'
  );
  await expect(
    page.locator('.feature-row', { hasText: /^Fillet/ })
  ).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
});
