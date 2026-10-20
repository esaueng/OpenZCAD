import type { Page } from '@playwright/test';
import type {
  ProjectDocument,
  SketchComposite,
  SketchConstraintData,
  SketchObjectData
} from '@openzcad/shared';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * S04 composite identity through the real rail, canvas and keyboard: the
 * Rectangle tool's corner, centre and three-point types and the Polygon tool
 * each draw real lines held by relations, named as one object by a
 * `SketchComposite` record, in one undoable transaction. The exported
 * document proves what each wrote. Geometry and solver oracles live in
 * apps/web/src/lib/sketch/composites.test.ts and test/sketch-composites.test.ts;
 * this proves the wiring.
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

type Line = Extract<SketchObjectData, { objectKind: 'line' }>;

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
  const objects = new Map(
    sketch.objectIds.map((id) => {
      const node = document.nodes[id];
      if (node?.kind !== 'sketch-object') throw new Error('Not an object.');
      return [String(id), node.data] as const;
    })
  );
  return {
    objects,
    constraints: (sketch.constraints ?? []).map(
      (constraint) => constraint.data
    ),
    composites: sketch.composites ?? []
  };
}

type Exported = Awaited<ReturnType<typeof exportSketch>>;

/** A composite's side lengths, in its own counter-clockwise order. */
function sideLengths(exported: Exported, composite: SketchComposite) {
  return composite.edgeIds.map((id) => {
    const line = exported.objects.get(id) as Line;
    expect(line.objectKind).toBe('line');
    return Math.hypot(
      Number(line.x2) - Number(line.x1),
      Number(line.y2) - Number(line.y1)
    );
  });
}

/** The relation kinds that name any of the composite's members. */
function relationKinds(exported: Exported, composite: SketchComposite) {
  const members = new Set<string>([
    ...composite.edgeIds,
    ...(composite.helperIds ?? [])
  ]);
  const names = (data: SketchConstraintData) =>
    JSON.stringify(data)
      .match(/ent_[\w-]+/g)
      ?.some((id) => members.has(id)) ?? false;
  return exported.constraints
    .filter(names)
    .map((data) => data.constraintKind)
    .sort();
}

test('Rectangle types and Polygon draw held lines named as one shape', async ({
  page
}) => {
  test.setTimeout(120_000);
  const at = await startSketch(page, 'Composites');
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  const shapeType = rail.getByRole('radiogroup', { name: 'Shape type' });
  const label = page.locator('.sketch-dim-label');

  // Corner rectangle, typed exactly: 40 × 20.
  await rail.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await expect(
    shapeType.getByRole('radio', { name: 'Corner' })
  ).toHaveAttribute('aria-checked', 'true');
  const corner = at(0.12, 0.78);
  await page.mouse.click(corner.x, corner.y);
  await page.mouse.move(corner.x + 90, corner.y - 50, { steps: 4 });
  await page.keyboard.type('40');
  await page.keyboard.press('Tab');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Sketch 01 started.'
  );

  // R steps to the centre type; typed sizes are the whole rectangle.
  await page.keyboard.press('r');
  await expect(
    shapeType.getByRole('radio', { name: 'Center' })
  ).toHaveAttribute('aria-checked', 'true');
  const center = at(0.42, 0.75);
  await page.mouse.click(center.x, center.y);
  await page.mouse.move(center.x + 40, center.y - 30, { steps: 4 });
  await page.keyboard.type('20');
  await page.keyboard.press('Tab');
  await page.keyboard.type('12');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Added center rectangle.'
  );

  // Three points: a collinear third point refuses and places nothing.
  await shapeType.getByRole('radio', { name: '3 points' }).click();
  const a = at(0.58, 0.8);
  const b = at(0.68, 0.72);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  const beyond = { x: b.x + (b.x - a.x), y: b.y + (b.y - a.y) };
  await page.mouse.move(beyond.x, beyond.y, { steps: 3 });
  await page.mouse.click(beyond.x, beyond.y);
  await expect(label).toContainText('Pick the third point off the first side');
  const off = at(0.67, 0.9);
  await page.mouse.move(off.x, off.y, { steps: 3 });
  await page.mouse.click(off.x, off.y);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Added three-point rectangle.'
  );

  // P is the polygon; five sides, circumradius typed as 10.
  await page.keyboard.press('p');
  await expect(
    shapeType.getByRole('radio', { name: 'Polygon' })
  ).toHaveAttribute('aria-checked', 'true');
  await rail.getByLabel('Polygon sides').fill('5');
  // Right of the shape strip, which rides beside the vertically centred rail.
  const hub = at(0.45, 0.35);
  await page.mouse.click(hub.x, hub.y);
  await page.mouse.move(hub.x, hub.y - 40, { steps: 4 });
  await page.keyboard.type('10');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText('Added polygon.');

  const drawn = await exportSketch(page);
  expect(
    drawn.composites.map(({ compositeKind, method }) => [compositeKind, method])
  ).toEqual([
    ['rectangle', 'corner'],
    ['rectangle', 'center'],
    ['rectangle', 'three-point'],
    ['polygon', 'inscribed']
  ]);
  const [cornerShape, centerShape, threePoint, polygon] = drawn.composites as [
    SketchComposite,
    SketchComposite,
    SketchComposite,
    SketchComposite
  ];

  // Every side is a real line; the sizes are the typed ones.
  const near = (values: number[], expected: number[]) =>
    values.forEach((value, index) =>
      expect(value).toBeCloseTo(expected[index]!, 6)
    );
  near(sideLengths(drawn, cornerShape), [40, 20, 40, 20]);
  expect(relationKinds(drawn, cornerShape)).toEqual(
    [
      ...Array<string>(4).fill('coincident'),
      'horizontal',
      'horizontal',
      'vertical',
      'vertical'
    ].sort()
  );

  near(sideLengths(drawn, centerShape), [20, 12, 20, 12]);
  // Two construction diagonals, held on opposite corners.
  expect(centerShape.helperIds).toHaveLength(2);
  for (const id of centerShape.helperIds!) {
    expect(drawn.objects.get(id)).toMatchObject({
      objectKind: 'line',
      construction: true
    });
  }
  expect(relationKinds(drawn, centerShape)).toEqual(
    [
      ...Array<string>(8).fill('coincident'),
      'horizontal',
      'horizontal',
      'vertical',
      'vertical'
    ].sort()
  );

  const [w, h, w2, h2] = sideLengths(drawn, threePoint);
  expect(w2).toBeCloseTo(w!, 6);
  expect(h2).toBeCloseTo(h!, 6);
  expect(relationKinds(drawn, threePoint)).toEqual(
    [
      ...Array<string>(4).fill('coincident'),
      'parallel',
      'parallel',
      'perpendicular'
    ].sort()
  );

  // A regular pentagon of circumradius 10 has sides of 2·10·sin 36°.
  near(
    sideLengths(drawn, polygon),
    Array<number>(5).fill(20 * Math.sin(Math.PI / 5))
  );
  expect(drawn.objects.get(polygon.helperIds![0]!)).toMatchObject({
    objectKind: 'circle',
    radius: 10,
    construction: true
  });
  expect(relationKinds(drawn, polygon)).toEqual(
    [
      ...Array<string>(5).fill('coincident'),
      ...Array<string>(4).fill('equal'),
      ...Array<string>(5).fill('point-on-object')
    ].sort()
  );

  // One undo takes the whole polygon: its sides, circle, relations and record.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const undone = await exportSketch(page);
  expect(undone.composites).toHaveLength(3);
  expect(undone.objects.size).toBe(drawn.objects.size - 6);
  expect(undone.constraints).toHaveLength(drawn.constraints.length - 14);
});

test('A side’s card resizes its rectangle as one object, keeping the centre', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Resize composite');
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await rail.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await rail
    .getByRole('radiogroup', { name: 'Shape type' })
    .getByRole('radio', { name: 'Center' })
    .click();
  const center = at(0.5, 0.55);
  await page.mouse.click(center.x, center.y);
  await page.mouse.move(center.x + 60, center.y - 40, { steps: 4 });
  await page.keyboard.type('30');
  await page.keyboard.press('Tab');
  await page.keyboard.type('10');
  await page.keyboard.press('Enter');
  const before = await exportSketch(page);
  const [shape] = before.composites as [SketchComposite];
  const middle = (exported: Exported) => {
    const line = exported.objects.get(shape.edgeIds[0]!) as Line;
    const opposite = exported.objects.get(shape.edgeIds[2]!) as Line;
    return {
      x: (Number(line.x1) + Number(opposite.x1)) / 2,
      y: (Number(line.y1) + Number(opposite.y1)) / 2
    };
  };

  // Pick the top side (side 3) as any entity is picked from the overview.
  await page.getByRole('button', { name: /Sketch palette/ }).click();
  await page
    .getByRole('region', { name: 'Sketch overview' })
    .getByLabel('Selected geometry')
    .selectOption(shape.edgeIds[2]!);
  const card = page.getByRole('form', { name: 'Resize center rectangle' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Side 3 of 4');
  await expect(card.getByLabel('Width', { exact: true })).toHaveValue('30');
  await card.getByLabel('Width', { exact: true }).fill('50');
  await card.getByLabel('Height', { exact: true }).fill('24');
  await card.getByRole('button', { name: 'Resize', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Resized rectangle.'
  );

  const after = await exportSketch(page);
  const sides = sideLengths(after, shape);
  [50, 24, 50, 24].forEach((value, index) =>
    expect(sides[index]).toBeCloseTo(value, 6)
  );
  expect(middle(after).x).toBeCloseTo(middle(before).x, 6);
  expect(middle(after).y).toBeCloseTo(middle(before).y, 6);
  // The record and every relation survive the resize unchanged.
  expect(after.composites).toEqual(before.composites);
  expect(after.constraints).toEqual(before.constraints);
});
