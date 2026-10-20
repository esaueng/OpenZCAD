import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * S03 relation glyphs through the real canvas: by default only the selected
 * entity's relations draw; the palette's Relation glyphs choice shows a
 * corner rectangle's held relations on all its sides and corners, or hides
 * them. Layout oracles live in apps/web/src/lib/sketch/relationGlyphs.test.ts;
 * this proves the wiring.
 */
test('relation glyphs mark held geometry and follow the visibility choice', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Glyph display');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(rail).toBeVisible();
  await page.waitForTimeout(800);

  const bounds = (await page.locator('.viewer-host canvas').boundingBox())!;
  const corner = {
    x: bounds.x + bounds.width * 0.3,
    y: bounds.y + bounds.height * 0.7
  };
  await rail.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.mouse.click(corner.x, corner.y);
  await page.mouse.move(corner.x + 90, corner.y - 50, { steps: 4 });
  await page.keyboard.type('40');
  await page.keyboard.press('Tab');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Sketch 01 started.'
  );

  const glyphs = page.locator('.sketch-relation-glyph');
  const glyph = (kind: string) =>
    page.locator(`.sketch-relation-glyph[data-kind="${kind}"]`);
  // The default shows only the selection's relations, and nothing is
  // selected yet.
  await expect(glyphs).toHaveCount(0);

  const palette = page.getByRole('button', { name: /Sketch palette/ });
  const visibility = page.getByRole('combobox', {
    name: 'Relation glyphs',
    exact: true
  });
  if (!(await visibility.isVisible())) await palette.click();
  await expect(visibility).toHaveValue('selected');

  // One side selected: its horizontal or vertical relation and the
  // coincidents at its two corners.
  await page
    .getByRole('region', { name: 'Sketch overview' })
    .getByLabel('Selected geometry')
    .selectOption({ index: 1 });
  await expect(glyphs).toHaveCount(3);
  await expect(glyph('coincident')).toHaveCount(2);

  // Always: four corner coincidents, two horizontal and two vertical sides.
  if (!(await visibility.isVisible())) await palette.click();
  await visibility.selectOption('always');
  await expect(glyph('coincident')).toHaveCount(4);
  await expect(glyph('horizontal')).toHaveCount(2);
  await expect(glyph('vertical')).toHaveCount(2);
  await expect(
    page.locator('.sketch-relation-chip[data-placement="object"]')
  ).toHaveCount(4);

  await visibility.selectOption('hidden');
  await expect(glyphs).toHaveCount(0);
});
