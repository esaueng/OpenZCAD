import type { Page } from '@playwright/test';
import type { SketchObjectData } from '@openzcad/shared';
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
  await page.getByRole('button', { name: 'New project' }).click();
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

  // UX-2: the hover marker offers a midpoint, which is no stored point, so
  // Lock names it instead of repeating its hint. Checked before any relation
  // moves the drawn segments.
  await pointTool('Lock');
  await page.mouse.click((p2.x + p3.x) / 2, (p2.y + p3.y) / 2);
  await expect(status).toContainText(
    "Lock can't use a midpoint: it is not a stored sketch point."
  );
  await page.keyboard.press('Escape');

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

type Line = Extract<SketchObjectData, { objectKind: 'line' }>;

async function liveLines(page: Page): Promise<Line[]> {
  const state = await page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<{ objects: { data: SketchObjectData }[] }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: { resolve }
          })
        );
      })
  );
  return state.objects
    .map(({ data }) => data)
    .filter((data): data is Line => data.objectKind === 'line');
}

const lineLength = (line: Line) =>
  Math.hypot(
    Number(line.x2) - Number(line.x1),
    Number(line.y2) - Number(line.y1)
  );

/**
 * ZC-041: a relation applies as it is added, and its first pick stays put.
 * Equal from the long line keeps it and stretches the short one; undone, and
 * picked the other way round, the short line stays and the long one shrinks.
 */
test('a relation applies on add and holds its first pick', async ({ page }) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Anchored relations');
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
  // A long and a short segment, drawn apart so nothing joins them.
  const long = [at(0.22, 0.7), at(0.5, 0.7)] as const;
  const short = [at(0.3, 0.45), at(0.4, 0.4)] as const;
  for (const [a, b] of [long, short]) {
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await page.keyboard.press('Escape');
  }
  const [longLine, shortLine] = await liveLines(page);
  const longLength = lineLength(longLine!);
  const shortLength = lineLength(shortLine!);
  expect(longLength).toBeGreaterThan(shortLength * 1.5);

  const relations = page.getByRole('toolbar', { name: 'Relations' });
  const status = page.getByRole('contentinfo');
  const equal = relations.getByRole('button', { name: 'Equal', exact: true });
  const mid = ([a, b]: readonly { x: number; y: number }[]) => ({
    x: (a!.x + b!.x) / 2,
    y: (a!.y + b!.y) / 2
  });

  await equal.click();
  await page.mouse.click(mid(long).x, mid(long).y);
  await page.mouse.click(mid(short).x, mid(short).y);
  await expect(status).toContainText('Equal constraint added and applied', {
    timeout: 30_000
  });
  let [held, moved] = await liveLines(page);
  expect(held).toEqual(longLine);
  expect(lineLength(moved!)).toBeCloseTo(longLength, 6);

  // One undo removes the relation and its applied geometry together.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => liveLines(page)).toEqual([longLine, shortLine]);

  await equal.click();
  await page.mouse.click(mid(short).x, mid(short).y);
  await page.mouse.click(mid(long).x, mid(long).y);
  await expect(status).toContainText('Equal constraint added and applied', {
    timeout: 30_000
  });
  [moved, held] = await liveLines(page);
  expect(held).toEqual(shortLine);
  expect(lineLength(moved!)).toBeCloseTo(shortLength, 6);
});
