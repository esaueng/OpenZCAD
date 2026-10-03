import { expect, test, stubApi } from './openzcad-fixtures';

/**
 * F28: a box is built from its corner and a cylinder from its base center,
 * so both left at the origin put the cylinder's axis on the box's corner.
 * The stored convention stays; each card names its point and lets you place
 * it. This places a cylinder on the default box's top, reads the result back
 * through the exact center of mass, then moves it from its own card.
 */
test('places a cylinder on a box from the position row its card names', async ({
  page
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Primitive position');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const boxPosition = inspector.getByRole('group', { name: 'Position' });
  await expect(boxPosition).toContainText('lowest X, Y and Z');
  for (const axis of ['X', 'Y', 'Z']) {
    await expect(
      boxPosition.getByRole('textbox', { name: `Corner ${axis}` })
    ).toHaveValue('0');
  }
  // The default box: 30 × 18 × 24 from the origin corner.
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const cylinderPosition = inspector.getByRole('group', { name: 'Position' });
  await expect(cylinderPosition).toContainText('center of the bottom face');
  await expect(
    cylinderPosition.getByRole('textbox', { name: /^Corner/ })
  ).toHaveCount(0);
  // The center of the box's top face.
  await cylinderPosition
    .getByRole('textbox', { name: 'Base center X' })
    .fill('15');
  await cylinderPosition
    .getByRole('textbox', { name: 'Base center Y' })
    .fill('9');
  await cylinderPosition
    .getByRole('textbox', { name: 'Base center Z' })
    .fill('24');
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();

  const placement = page.locator('.feature-row-main', {
    hasText: 'Place Cylinder'
  });
  await expect(placement).toHaveCount(1);
  const cylinderRow = page
    .locator('.feature-row-main')
    .filter({ hasText: /^Cylinder/ })
    .first();
  const selectCylinder = async () => {
    if ((await cylinderRow.getAttribute('aria-pressed')) !== 'true')
      await cylinderRow.click();
    await expect(cylinderRow).toHaveAttribute('aria-pressed', 'true');
  };
  const mass = inspector.locator('details.panel-section').filter({
    has: page.locator('summary', {
      hasText: 'Mass properties (at unit density)'
    })
  });
  const expectCenter = async (center: string) => {
    await selectCylinder();
    await mass.locator('summary').click();
    await expect(mass).toContainText(center);
    await mass.locator('summary').click();
  };

  await selectCylinder();
  const baseX = inspector.getByRole('textbox', { name: 'Base center X' });
  await expect(baseX).toHaveValue('15');
  await expect(
    inspector.getByRole('textbox', { name: 'Base center Z' })
  ).toHaveValue('24');
  // Radius 6, height 28 rising from z = 24.
  await expectCenter('15, 9, 38');

  await baseX.fill('5');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await selectCylinder();
  await expect(baseX).toHaveValue('5');
  await expectCenter('5, 9, 38');
  // The card rewrote its placement rather than stacking a second Move.
  await expect(placement).toHaveCount(1);
  expect(errors).toEqual([]);
});
