import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * S07 point relations through the real rail and canvas picks: Lock records
 * a lock and a second Lock on the same point removes it; Disconnect frees a
 * coincident joint and explains a point with none; Point on curve takes its
 * picks and adds one relation. Geometry oracles live in
 * test/sketch-constraint-set.test.ts; this proves the pick wiring.
 */
test('point relations arm from the rail and act on snap-point picks', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Point relations');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await page.waitForTimeout(800);
  if (
    !(await page.getByRole('checkbox', { name: 'Snap to grid' }).isVisible())
  ) {
    await page.getByRole('button', { name: /Sketch palette/ }).click();
  }
  const gridSnap = page.getByRole('checkbox', { name: 'Snap to grid' });
  if (await gridSnap.isChecked()) await gridSnap.uncheck();
  await page.getByRole('button', { name: /Sketch palette/ }).click();
  await expect(gridSnap).toBeHidden();

  const canvas = page.locator('.viewer-host canvas');
  const bounds = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number) => ({
    x: bounds.x + bounds.width * fx,
    y: bounds.y + bounds.height * fy
  });
  // Two separate segments: p0 → p1 and p2 → p3. The polyline tool records
  // no relation where segments meet, so the joint is made explicitly below.
  const p0 = at(0.25, 0.65);
  const p1 = at(0.42, 0.65);
  const p2 = at(0.46, 0.6);
  const p3 = at(0.56, 0.42);
  for (const [a, b] of [
    [p0, p1],
    [p2, p3]
  ] as const) {
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await page.keyboard.press('Escape');
  }

  const relations = page.getByRole('toolbar', { name: 'Relations' });
  const status = page.getByRole('contentinfo');
  const tool = (name: string) =>
    relations.getByRole('button', { name, exact: true });
  // The point relations share one rail slot and open in a flyout.
  const pointTool = async (name: string) => {
    const group = relations.getByRole('button', {
      name: 'Point relations',
      exact: true
    });
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await relations
      .getByRole('group', { name: 'Point relations' })
      .getByRole('button', { name, exact: true })
      .click();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
  };

  await pointTool('Lock');
  await page.mouse.click(p0.x, p0.y);
  await expect(status).toContainText('Lock constraint added');

  await pointTool('Lock');
  await page.mouse.click(p0.x, p0.y);
  await expect(status).toContainText('Point unlocked.');

  await tool('Coincident').click();
  await page.mouse.click(p1.x, p1.y);
  await page.mouse.click(p2.x, p2.y);
  await expect(status).toContainText('Coincident constraint added');

  await pointTool('Disconnect');
  await page.mouse.click(p1.x, p1.y);
  await expect(status).toContainText('Disconnected · removed 1 relation.');

  // Nothing joins p0 now, so a second Disconnect there explains itself.
  await pointTool('Disconnect');
  await page.mouse.click(p0.x, p0.y);
  await expect(status).toContainText(
    'That point has no coincident, midpoint or on-curve relation.'
  );

  // Point on curve: the free end p3, then the first segment.
  await pointTool('Point on curve');
  await page.mouse.click(p3.x, p3.y);
  await expect(status).toContainText('Point on curve: pick 2 of 2.');
  await page.mouse.click((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
  await expect(status).toContainText('Point on curve constraint added');
});
