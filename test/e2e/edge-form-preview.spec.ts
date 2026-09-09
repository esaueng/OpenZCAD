import { test, expect, stubApi } from './openzcad-fixtures';

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
