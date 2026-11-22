import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * S03 per-entity freedom through the real solve: with one line locked at
 * both ends and another left free, the palette names the free line and its
 * freedom count beside the sketch-wide DOF, and selects it on request. The
 * counts themselves are checked against hand-counted freedoms on the pinned
 * kernel in test/sketch-entity-freedom.test.ts; this proves the wiring.
 */
test('the palette lists the geometry that can still move and selects it', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Entity freedom');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await page.waitForTimeout(800);

  const bounds = (await page.locator('.viewer-host canvas').boundingBox())!;
  const at = (fx: number, fy: number) => ({
    x: bounds.x + bounds.width * fx,
    y: bounds.y + bounds.height * fy
  });
  const fixedStart = at(0.25, 0.65);
  const fixedEnd = at(0.42, 0.65);
  for (const [a, b] of [
    [fixedStart, fixedEnd],
    [at(0.5, 0.4), at(0.6, 0.55)]
  ] as const) {
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await page.keyboard.press('Escape');
  }

  const relations = page.getByRole('toolbar', { name: 'Relations' });
  const status = page.getByRole('contentinfo');
  const lockAt = async (point: { x: number; y: number }) => {
    const group = relations.getByRole('button', {
      name: 'Point relations',
      exact: true
    });
    await group.click();
    await relations
      .getByRole('group', { name: 'Point relations' })
      .getByRole('button', { name: 'Lock', exact: true })
      .click();
    await page.mouse.click(point.x, point.y);
    await expect(status).toContainText('Lock constraint added');
  };
  await lockAt(fixedStart);
  await lockAt(fixedEnd);

  await page.getByRole('button', { name: 'Solve', exact: true }).click();
  await expect(page.locator('.sketch-solve-pill')).toHaveText(
    '4 DOF remaining',
    { timeout: 30_000 }
  );
  const paletteButton = page.getByRole('button', {
    name: 'Sketch palette',
    exact: true
  });
  if ((await paletteButton.getAttribute('aria-expanded')) !== 'true')
    await paletteButton.click();
  const free = page.getByRole('group', {
    name: 'Geometry that can still move'
  });
  await expect(free).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(
      'One entity can still move; green geometry is fully constrained.'
    )
  ).toBeVisible();
  const rows = free.getByRole('button');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText(/ · 4 DOF$/);
  await rows.first().click();
  await expect(status).toContainText('which can still move.');
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'true');
});
