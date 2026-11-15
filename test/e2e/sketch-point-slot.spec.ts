import type { Page } from '@playwright/test';
import type {
  ProjectDocument,
  SketchConstraintData,
  SketchObjectData
} from '@openzcad/shared';
import { expect, stubApi, test, MODEL_ONLY } from './openzcad-fixtures';

/**
 * I01 slot and point through the rail's shape strip and canvas clicks: a
 * slot is three clicks (both end centres, then the radius) and lands as two
 * lines and two half circles held by one composite; a point is one click,
 * snaps onto the slot's centre line and a Coincident pick holds it there;
 * Undo takes each back in one step. Solver, region and volume oracles live
 * in test/sketch-point-slot.test.ts; this proves the wiring.
 */

const READ_TIMEOUT = { timeout: 30_000 };

async function startSketch(page: Page, name: string) {
  page.setDefaultTimeout(15_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await page.waitForTimeout(800);
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
  return {
    objects: sketch.objectIds.map((id) => {
      const node = document.nodes[id];
      if (node?.kind !== 'sketch-object') throw new Error('Not an object.');
      return { id: String(id), data: node.data };
    }),
    constraints: (sketch.constraints ?? []).map(
      (constraint): SketchConstraintData => constraint.data
    ),
    composites: sketch.composites ?? []
  };
}

async function shapeTile(page: Page, name: 'Slot' | 'Point') {
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  // The slot's button is named for the shape it last drew.
  await rail
    .getByRole('button', { name: /^(Rectangle|Polygon|Slot|Point)$/ })
    .click();
  await rail
    .getByRole('radiogroup', { name: 'Shape type' })
    .getByRole('radio', { name, exact: true })
    .click();
}

test(
  'a slot is three clicks and a point one, each one undo step',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    const at = await startSketch(page, 'Slot and point');
    const status = page.getByRole('contentinfo');

    // A seed line far from the slot starts the sketch.
    await page
      .getByRole('toolbar', { name: 'Sketch tools' })
      .getByRole('button', { name: /^Line/ })
      .click();
    await page.mouse.click(at(0.15, 0.85).x, at(0.15, 0.85).y);
    await page.mouse.click(at(0.22, 0.8).x, at(0.22, 0.8).y);
    await page.keyboard.press('Escape');
    await expect(status).toContainText('Sketch 01 started.');

    // Both end centres on one horizontal, then a click above for the radius.
    const first = at(0.35, 0.55);
    const second = at(0.6, 0.55);
    const radius = at(0.6, 0.48);
    await shapeTile(page, 'Slot');
    await page.mouse.click(first.x, first.y);
    await page.mouse.move(second.x, second.y, { steps: 4 });
    await page.mouse.click(second.x, second.y);
    await page.mouse.move(radius.x, radius.y, { steps: 4 });
    await expect(page.locator('.sketch-dim-label')).toContainText('· R ');
    await page.mouse.click(radius.x, radius.y);
    await expect(status).toContainText('Added slot.');

    const slot = await exportSketch(page);
    slot.objects.shift(); // the seed line
    expect(slot.objects.map(({ data }) => data.objectKind)).toEqual([
      'line',
      'arc',
      'line',
      'arc',
      'line'
    ]);
    expect(slot.composites).toHaveLength(1);
    expect(slot.composites[0]).toMatchObject({
      compositeKind: 'slot',
      method: 'center-to-center'
    });
    expect(
      slot.constraints.map((constraint) => constraint.constraintKind).sort()
    ).toEqual(
      [
        ...Array<string>(6).fill('coincident'),
        'equal',
        ...Array<string>(4).fill('tangent')
      ].sort()
    );
    const [line0, arc1, , arc3, centreLine] = slot.objects.map(
      ({ data }) => data
    ) as [
      Extract<SketchObjectData, { objectKind: 'line' }>,
      Extract<SketchObjectData, { objectKind: 'arc' }>,
      unknown,
      Extract<SketchObjectData, { objectKind: 'arc' }>,
      Extract<SketchObjectData, { objectKind: 'line' }>
    ];
    expect(Number(arc1.radius)).toBeGreaterThan(0);
    expect(Number(arc3.radius)).toBeCloseTo(Number(arc1.radius), 9);
    expect(Number(arc1.endAngleDeg) - Number(arc1.startAngleDeg)).toBeCloseTo(
      180,
      9
    );
    expect(centreLine).toMatchObject({ construction: true });
    // The side runs the full centre distance, tangent into both ends.
    expect(
      Math.hypot(
        Number(line0.x2) - Number(line0.x1),
        Number(line0.y2) - Number(line0.y1)
      )
    ).toBeCloseTo(
      Math.hypot(
        Number(centreLine.x2) - Number(centreLine.x1),
        Number(centreLine.y2) - Number(centreLine.y1)
      ),
      9
    );

    // A point snapped onto the centre line's midpoint, then held there.
    const middle = at(0.475, 0.55);
    await shapeTile(page, 'Point');
    await page.mouse.move(middle.x, middle.y, { steps: 4 });
    await page.mouse.click(middle.x, middle.y);
    await expect(status).toContainText('Added point.');
    const pointed = await exportSketch(page);
    const point = pointed.objects.at(-1)!;
    expect(point.data).toMatchObject({ objectKind: 'point' });
    const mid = {
      x: (Number(centreLine.x1) + Number(centreLine.x2)) / 2,
      y: (Number(centreLine.y1) + Number(centreLine.y2)) / 2
    };
    const placed = point.data as Extract<
      SketchObjectData,
      { objectKind: 'point' }
    >;
    expect(Number(placed.x)).toBeCloseTo(mid.x, 9);
    expect(Number(placed.y)).toBeCloseTo(mid.y, 9);

    // Undo takes the point, then the whole slot, one step each.
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await undo.click();
    await expect
      .poll(async () => (await exportSketch(page)).objects.length)
      .toBe(6);
    await undo.click();
    await expect
      .poll(async () => {
        const left = await exportSketch(page);
        return [
          left.objects.length,
          left.composites.length,
          left.constraints.length
        ];
      })
      .toEqual([1, 0, 0]);
  }
);
