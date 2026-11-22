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
  // a point-only tool names it instead of repeating its hint. (Lock there
  // now locks the whole line, below.) Checked before any relation moves the
  // drawn segments.
  await pointTool('Disconnect');
  await page.mouse.click((p2.x + p3.x) / 2, (p2.y + p3.y) / 2);
  await expect(status).toContainText(
    "Disconnect can't use a midpoint: it is not a stored sketch point."
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

/**
 * Whole-entity symmetry: picked away from their points, two lines and the
 * axis mirror the second line onto the first's image in one undoable edit,
 * the first held where it is.
 */
test('Symmetric mirrors a whole line about an axis in one edit', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Entity symmetry');
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
  const axis = [at(0.45, 0.3), at(0.45, 0.75)] as const;
  const first = [at(0.52, 0.4), at(0.62, 0.6)] as const;
  // Roughly where the image belongs, drawn the other way round.
  const second = [at(0.36, 0.63), at(0.4, 0.42)] as const;
  for (const [a, b] of [axis, first, second]) {
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await page.keyboard.press('Escape');
  }
  await expect.poll(async () => (await liveLines(page)).length).toBe(3);
  const before = await liveLines(page);
  const [, firstLine] = before;

  const relations = page.getByRole('toolbar', { name: 'Relations' });
  const status = page.getByRole('contentinfo');
  const group = relations.getByRole('button', {
    name: 'Point relations',
    exact: true
  });
  await group.click();
  await relations
    .getByRole('group', { name: 'Point relations' })
    .getByRole('button', { name: 'Symmetric', exact: true })
    .click();
  const mid = ([a, b]: readonly { x: number; y: number }[]) => ({
    x: (a!.x + b!.x) / 2,
    y: (a!.y + b!.y) / 2
  });
  await page.mouse.click(mid(first).x, mid(first).y);
  await expect(status).toContainText('Symmetric: pick 2 of 3.');
  await page.mouse.click(mid(second).x, mid(second).y);
  await expect(status).toContainText('Symmetric: pick 3 of 3.');
  await page.mouse.click(mid(axis).x, mid(axis).y);
  await expect(status).toContainText('Symmetric constraint added and applied', {
    timeout: 30_000
  });

  const [solvedAxis, held, image] = await liveLines(page);
  expect(held).toEqual(firstLine);
  // The image is the first line reflected in the solved axis (which the
  // relation may move: only the first pick is held). The drawn direction is
  // kept, so the image's start mirrors the first's end.
  const a = { x: Number(solvedAxis!.x1), y: Number(solvedAxis!.y1) };
  const d = {
    x: Number(solvedAxis!.x2) - a.x,
    y: Number(solvedAxis!.y2) - a.y
  };
  const reflect = (x: number, y: number) => {
    const t = ((x - a.x) * d.x + (y - a.y) * d.y) / (d.x * d.x + d.y * d.y);
    return { x: 2 * (a.x + t * d.x) - x, y: 2 * (a.y + t * d.y) - y };
  };
  const start = reflect(Number(held!.x2), Number(held!.y2));
  const end = reflect(Number(held!.x1), Number(held!.y1));
  expect(Number(image!.x1)).toBeCloseTo(start.x, 6);
  expect(Number(image!.y1)).toBeCloseTo(start.y, 6);
  expect(Number(image!.x2)).toBeCloseTo(end.x, 6);
  expect(Number(image!.y2)).toBeCloseTo(end.y, 6);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => liveLines(page)).toEqual(before);
});

/** The palette's constraint rows, in list order. */
async function constraintRows(page: Page): Promise<string[]> {
  const palette = page.getByRole('button', {
    name: 'Sketch palette',
    exact: true
  });
  if ((await palette.getAttribute('aria-expanded')) !== 'true')
    await palette.click();
  return page
    .locator('.sketch-palette .sketch-constraint-list > li')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')!));
}

/**
 * Entity lock: Lock picked on a line away from its points holds the whole
 * line, taking over a point lock already on it in the same edit, and a
 * second Lock there unlocks it. Solver oracles for every kind live in
 * test/sketch-constraint-set.test.ts.
 */
test('Lock holds a whole line, replacing its point lock, and unlocks it', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Entity lock');
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
  const start = at(0.3, 0.6);
  const end = at(0.55, 0.45);
  await page.mouse.click(start.x, start.y);
  await page.mouse.click(end.x, end.y);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await liveLines(page)).length).toBe(1);
  const [drawn] = await liveLines(page);

  const relations = page.getByRole('toolbar', { name: 'Relations' });
  const status = page.getByRole('contentinfo');
  const lockTool = async () => {
    await relations
      .getByRole('button', { name: 'Point relations', exact: true })
      .click();
    await relations
      .getByRole('group', { name: 'Point relations' })
      .getByRole('button', { name: 'Lock', exact: true })
      .click();
  };
  await lockTool();
  await page.mouse.click(start.x, start.y);
  await expect(status).toContainText('Lock constraint added');
  await expect
    .poll(() => constraintRows(page))
    .toEqual([expect.stringMatching(/^Lock · .+ of /)]);

  // Away from its points: the whole line, in place of the point lock.
  const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  await lockTool();
  await page.mouse.click(middle.x, middle.y);
  await expect(status).toContainText('Lock constraint added');
  await expect
    .poll(() => constraintRows(page))
    .toEqual([
      expect.stringMatching(/^Lock · Line( \d+)?( · fully defined)?$/)
    ]);
  expect((await liveLines(page))[0]).toEqual(drawn);

  await lockTool();
  await page.mouse.click(middle.x, middle.y);
  await expect(status).toContainText('Entity unlocked.');
  await expect.poll(() => constraintRows(page)).toEqual([]);

  // Undo brings the whole lock back; undo again, the point lock.
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(() => constraintRows(page))
    .toEqual([
      expect.stringMatching(/^Lock · Line( \d+)?( · fully defined)?$/)
    ]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(() => constraintRows(page))
    .toEqual([expect.stringMatching(/^Lock · .+ of /)]);
});
