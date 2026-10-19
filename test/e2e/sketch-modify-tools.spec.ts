import type { Page } from '@playwright/test';
import type {
  ProjectDocument,
  SketchConstraintData,
  SketchObjectData
} from '@openzcad/shared';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * S05 Trim, Mirror and the linear and circular patterns through the real
 * rail fold, canvas picks and keypad. Each flow is one undoable transaction;
 * the exported document proves what it wrote. Geometry and constraint
 * oracles live in apps/web/src/lib/sketch/modify.test.ts and
 * test/sketch-modify-tools.test.ts; this proves the wiring.
 */

const READ_TIMEOUT = { timeout: 30_000 };

async function startSketch(page: Page, name: string) {
  page.setDefaultTimeout(15_000);
  await stubApi(page);
  // Signed out, so Export project is a plain local download.
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await page.waitForTimeout(800);
  // Grid snapping would move the drawn points; geometry snaps stay on.
  const palette = page.getByRole('button', { name: /Sketch palette/ });
  if (
    !(await page.getByRole('checkbox', { name: 'Snap to grid' }).isVisible())
  ) {
    await palette.click();
  }
  const gridSnap = page.getByRole('checkbox', { name: 'Snap to grid' });
  if (await gridSnap.isChecked()) await gridSnap.uncheck();
  await palette.click();
  await expect(gridSnap).toBeHidden();
  const bounds = (await page.locator('.viewer-host canvas').boundingBox())!;
  return (fx: number, fy: number) => ({
    x: bounds.x + bounds.width * fx,
    y: bounds.y + bounds.height * fy
  });
}

type Point = { x: number; y: number };

async function drawLine(page: Page, a: Point, b: Point) {
  await page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: /^Line/ })
    .click();
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.keyboard.press('Escape');
}

async function drawCircle(page: Page, center: Point, radiusPx: number) {
  await page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: /^Circle/ })
    .click();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + radiusPx, center.y, { steps: 6 });
  await page.mouse.up();
}

/** Arm one of the modify tools folded into the rail's "More" slot. */
async function modifyTool(page: Page, name: string) {
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  const fold = rail.getByRole('button', {
    name: 'More modify tools',
    exact: true
  });
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await rail
    .getByRole('group', { name: 'More modify tools' })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
}

async function exportSketch(page: Page) {
  const menu = page.locator('details.file-menu');
  if ((await menu.getAttribute('open')) === null)
    await menu.locator('summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', READ_TIMEOUT),
    menu.getByRole('button', { name: /^Export project/ }).click()
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  const document = (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
  const sketch = Object.values(document.nodes).find(
    (node) => node.kind === 'sketch'
  );
  if (sketch?.kind !== 'sketch') throw new Error('No sketch exported.');
  const objects = sketch.objectIds.map((id) => {
    const node = document.nodes[id];
    if (node?.kind !== 'sketch-object') throw new Error('Not an object.');
    return { id: String(id), data: node.data };
  });
  return {
    objects,
    constraints: (sketch.constraints ?? []).map((constraint) => constraint.data)
  };
}

function kindsOf(objects: { data: SketchObjectData }[]) {
  return objects.map((object) => object.data.objectKind);
}

function constraintKinds(constraints: SketchConstraintData[]) {
  return constraints.map((constraint) => constraint.constraintKind).sort();
}

const undo = (page: Page) =>
  page.getByRole('button', { name: 'Undo', exact: true }).click();

test('Trim cuts a line back to its crossings, one undo step per click', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Trim');
  // A horizontal line crossed by two verticals.
  await drawLine(page, at(0.25, 0.55), at(0.6, 0.55));
  await drawLine(page, at(0.35, 0.42), at(0.35, 0.68));
  await drawLine(page, at(0.5, 0.42), at(0.5, 0.68));
  const status = page.getByRole('contentinfo');

  await modifyTool(page, 'Trim');
  await page.mouse.click(at(0.425, 0.55).x, at(0.425, 0.55).y);
  await expect(status).toContainText('Trim split the line in two.');
  // Trim stays armed: the next click trims the left stub, which now ends
  // on its only crossing, so the whole stub goes.
  await page.mouse.click(at(0.3, 0.55).x, at(0.3, 0.55).y);
  await expect(status).toContainText(
    'Trim removed the whole line: nothing crosses it.'
  );
  await page.keyboard.press('Escape');

  const trimmed = await exportSketch(page);
  expect(kindsOf(trimmed.objects)).toEqual(['line', 'line', 'line']);
  // The far piece starts on the right vertical and is held there.
  expect(constraintKinds(trimmed.constraints)).toEqual(['point-on-object']);

  await undo(page);
  await expect
    .poll(async () => (await exportSketch(page)).objects.length)
    .toBe(4);
  await undo(page);
  const restored = await exportSketch(page);
  expect(kindsOf(restored.objects)).toEqual(['line', 'line', 'line']);
  expect(restored.constraints).toEqual([]);
});

test('Mirror reflects a line about a picked line and links it back', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Mirror');
  await drawLine(page, at(0.45, 0.35), at(0.45, 0.75));
  await drawLine(page, at(0.5, 0.48), at(0.58, 0.62));
  const status = page.getByRole('contentinfo');

  await modifyTool(page, 'Mirror');
  await page.mouse.click(at(0.54, 0.55).x, at(0.54, 0.55).y);
  await expect(status).toContainText('Mirror: pick 2 of 2.');
  await page.mouse.click(at(0.45, 0.4).x, at(0.45, 0.4).y);
  await expect(status).toContainText('Mirror added a linked line.');

  const { objects, constraints } = await exportSketch(page);
  expect(kindsOf(objects)).toEqual(['line', 'line', 'line']);
  const [axis, source, image] = objects.map((object) => object.data) as [
    Extract<SketchObjectData, { objectKind: 'line' }>,
    Extract<SketchObjectData, { objectKind: 'line' }>,
    Extract<SketchObjectData, { objectKind: 'line' }>
  ];
  const axisX = Number(axis.x1);
  expect(Number(image.x1)).toBeCloseTo(2 * axisX - Number(source.x1), 6);
  expect(Number(image.y1)).toBeCloseTo(Number(source.y1), 6);
  expect(Number(image.x2)).toBeCloseTo(2 * axisX - Number(source.x2), 6);
  expect(constraintKinds(constraints)).toEqual(['symmetric', 'symmetric']);

  await undo(page);
  await expect
    .poll(async () => (await exportSketch(page)).objects.length)
    .toBe(2);
});

test('Linear pattern asks for spacing then count and repeats along a line', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Linear pattern');
  const center = at(0.35, 0.45);
  await drawCircle(page, center, 24);
  await drawLine(page, at(0.3, 0.7), at(0.5, 0.7));
  const status = page.getByRole('contentinfo');

  await modifyTool(page, 'Linear pattern');
  await page.mouse.click(center.x + 24, center.y);
  await expect(status).toContainText('Linear pattern: pick 2 of 2.');
  await page.mouse.click(at(0.4, 0.7).x, at(0.4, 0.7).y);
  const spacing = page.getByRole('textbox', { name: 'Pattern spacing' });
  await expect(spacing).toBeVisible();
  await spacing.fill('15');
  await spacing.press('Enter');
  const count = page.getByRole('textbox', { name: 'Pattern count' });
  await expect(count).toBeVisible();
  // A count is unitless: no unit chips beside it.
  await expect(
    page.getByRole('radiogroup', { name: 'Entry unit' })
  ).toHaveCount(0);
  await count.fill('3');
  await count.press('Enter');
  await expect(status).toContainText('Linear pattern added 2 linked circles.');

  const { objects, constraints } = await exportSketch(page);
  expect(kindsOf(objects)).toEqual(['circle', 'line', 'circle', 'circle']);
  const circles = objects
    .map((object) => object.data)
    .filter(
      (data): data is Extract<SketchObjectData, { objectKind: 'circle' }> =>
        data.objectKind === 'circle'
    );
  const line = objects[1]!.data as Extract<
    SketchObjectData,
    { objectKind: 'line' }
  >;
  const dx = Number(line.x2) - Number(line.x1);
  const dy = Number(line.y2) - Number(line.y1);
  const length = Math.hypot(dx, dy);
  for (const [index, circle] of circles.entries()) {
    expect(Number(circle.centerX) - Number(circles[0]!.centerX)).toBeCloseTo(
      (15 * index * dx) / length,
      6
    );
    expect(Number(circle.radius)).toBeCloseTo(Number(circles[0]!.radius), 9);
  }
  expect(constraintKinds(constraints)).toEqual(['equal', 'equal']);
});

test('Circular pattern turns an entity about a picked circle’s centre', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Circular pattern');
  const pivot = at(0.42, 0.52);
  await drawCircle(page, pivot, 50);
  const small = at(0.55, 0.52);
  await drawCircle(page, small, 14);
  const status = page.getByRole('contentinfo');

  await modifyTool(page, 'Circular pattern');
  await page.mouse.click(small.x + 14, small.y);
  await expect(status).toContainText('Circular pattern: pick 2 of 2.');
  // The pivot is the hub's centre snap: no curve under the click, so
  // the snap names it, and the click must not also select the hub's region.
  await page.mouse.move(pivot.x, pivot.y);
  await page.mouse.click(pivot.x, pivot.y);
  const count = page.getByRole('textbox', { name: 'Pattern count' });
  await expect(count).toBeVisible();
  await count.fill('4');
  await count.press('Enter');
  const angle = page.getByRole('textbox', { name: 'Pattern angle' });
  await expect(angle).toBeVisible();
  await angle.press('Enter');
  await expect(status).toContainText(
    'Circular pattern added 3 linked circles.'
  );

  const { objects } = await exportSketch(page);
  expect(objects).toHaveLength(5);
  const [hub, source, ...copies] = objects.map(
    (object) =>
      object.data as Extract<SketchObjectData, { objectKind: 'circle' }>
  );
  const cx = Number(hub!.centerX);
  const cy = Number(hub!.centerY);
  const rx = Number(source!.centerX) - cx;
  const ry = Number(source!.centerY) - cy;
  // Quarter turns about the hub's centre.
  const expected = [
    [-ry, rx],
    [-rx, -ry],
    [ry, -rx]
  ];
  for (const [index, copy] of copies.entries()) {
    expect(Number(copy.centerX) - cx).toBeCloseTo(expected[index]![0]!, 6);
    expect(Number(copy.centerY) - cy).toBeCloseTo(expected[index]![1]!, 6);
  }
  // The pivot click was the tool's: it left no hub region selected behind.
  await page.getByRole('button', { name: 'Finish Sketch' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Sketch 01 finished.'
  );
  await expect(page.getByText('closed profile selected')).toHaveCount(0);
});
