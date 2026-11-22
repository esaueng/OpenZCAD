import type { Page } from '@playwright/test';
import type {
  ProjectDocument,
  SketchConstraintData,
  SketchObjectData
} from '@openzcad/shared';
import {
  expect,
  finishInPlaceCommand,
  stubApi,
  test,
  MODEL_ONLY,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * S05 Trim, Mirror, the linear and circular patterns, Offset and the
 * construction toggle through the real rail fold, canvas picks and keypad. Each flow is one undoable transaction;
 * the exported document proves what it wrote. Geometry and constraint
 * oracles live in apps/web/src/lib/sketch/modify.test.ts, offset.test.ts and
 * test/sketch-modify-tools.test.ts; this proves the wiring.
 */

const READ_TIMEOUT = { timeout: 30_000 };

async function startSketch(page: Page, name: string) {
  page.setDefaultTimeout(15_000);
  // Geometry gestures use open canvas, clear of the docked model panels.
  await stubApi(page, { panelLayout: MODEL_ONLY });
  // Signed out, so Export project is a plain local download.
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

/** A rectangle from the Rectangle tool: four held lines, `a` to `b`. */
async function drawRectangle(page: Page, a: Point, b: Point) {
  await page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: 'Rectangle', exact: true })
    .click();
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.click(b.x, b.y);
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
  await page
    .getByRole('group', { name: 'More modify tools' })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} modify menu keyboard`, () => {
    test.use({ colorScheme, reducedMotion: 'reduce' });
    test('enters the portal and returns to the adjacent rail tools', async ({
      page
    }) => {
      // Seed geometry on clear canvas before exercising the keyboard at both
      // sizes; the phone's rectangle-type flyout occupies those old picks.
      await page.setViewportSize({ width: 1440, height: 900 });
      const at = await startSketch(page, 'Modify keyboard');
      await drawLine(page, at(0.4, 0.4), at(0.55, 0.5));
      const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
      const fold = rail.getByRole('button', { name: 'More modify tools' });
      const menu = page.getByRole('group', { name: 'More modify tools' });
      for (const size of [
        { width: 320, height: 568 },
        { width: 1440, height: 900 }
      ]) {
        await page.setViewportSize(size);
        await fold.press('Enter');
        await expect(
          menu.getByRole('button', { name: 'Offset', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(
          menu.getByRole('button', { name: 'Trim', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(
          menu.getByRole('button', { name: 'Offset', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(fold).toBeFocused();
        await expect(menu).toHaveCount(0);
        await fold.press('Enter');
        await page.keyboard.press('Escape');
        await expect(fold).toBeFocused();
        await expect(menu).toHaveCount(0);
        await fold.press('Enter');
        for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
        await expect(
          menu.getByRole('button', { name: 'Circular pattern', exact: true })
        ).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(menu).toHaveCount(0);
        await expect(
          rail.getByRole('button', { name: 'Construction', exact: true })
        ).toBeFocused();
      }
    });
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

test(
  'Trim cuts a line back to its crossings, one undo step per click',
  { tag: '@ci-smoke' },
  async ({ page }) => {
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
  }
);

test('Extend runs a line on to the first curve in its way, one undo step per click', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Extend');
  // A short horizontal line with two verticals beyond its right end.
  await drawLine(page, at(0.25, 0.55), at(0.35, 0.55));
  await drawLine(page, at(0.45, 0.42), at(0.45, 0.68));
  await drawLine(page, at(0.6, 0.42), at(0.6, 0.68));
  const before = await exportSketch(page);
  const [line, near] = before.objects as [
    { id: string; data: Extract<SketchObjectData, { objectKind: 'line' }> },
    { id: string; data: Extract<SketchObjectData, { objectKind: 'line' }> }
  ];
  const status = page.getByRole('contentinfo');

  await modifyTool(page, 'Extend');
  await expect(status).toContainText('Click a line or arc near the end');
  // A click near the right end runs it on to the nearer vertical.
  await page.mouse.click(at(0.34, 0.55).x, at(0.34, 0.55).y);
  await expect(status).toContainText(
    'Extend lengthened the line to the nearest boundary.'
  );
  // Extend stays armed: the same end again reaches the far vertical, and
  // its hold on the near one goes with the end that moved.
  await page.mouse.click(at(0.43, 0.55).x, at(0.43, 0.55).y);
  await expect(status).toContainText(
    'Extend lengthened the line to the nearest boundary. Dropped 1 relation on the moved end.'
  );
  // The left end has nothing beyond it, which is refused by name.
  await page.mouse.click(at(0.29, 0.55).x, at(0.29, 0.55).y);
  await expect(status).toContainText('Nothing lies beyond that end');
  await page.keyboard.press('Escape');

  const extended = await exportSketch(page);
  expect(kindsOf(extended.objects)).toEqual(['line', 'line', 'line']);
  const reached = extended.objects[0]!.data as typeof line.data;
  const far = extended.objects[2]!.data as typeof line.data;
  // Same entity, same start; the end sits on the far vertical.
  expect(extended.objects[0]!.id).toBe(line.id);
  expect(Number(reached.x1)).toBeCloseTo(Number(line.data.x1), 6);
  expect(Number(reached.x2)).toBeCloseTo(Number(far.x1), 6);
  expect(constraintKinds(extended.constraints)).toEqual(['point-on-object']);

  // One undo per click: first back to the near vertical, then the original.
  await undo(page);
  await expect
    .poll(async () => {
      const data = (await exportSketch(page)).objects[0]!
        .data as typeof line.data;
      return Math.abs(Number(data.x2) - Number(near.data.x1)) < 1e-6;
    })
    .toBe(true);
  await undo(page);
  const restored = await exportSketch(page);
  expect(restored.objects[0]!.data).toEqual(line.data);
  expect(restored.constraints).toEqual([]);
});

test(
  'a box selects several entities to mirror, copy, paste and delete together',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const at = await startSketch(page, 'Multi Select');
    // The axis on the left; a two-line wedge to its right.
    await drawLine(page, at(0.3, 0.3), at(0.3, 0.8));
    await drawLine(page, at(0.4, 0.6), at(0.47, 0.4));
    await drawLine(page, at(0.47, 0.4), at(0.54, 0.6));
    // Off Line, onto Select.
    await page.keyboard.press('Escape');
    const status = page.getByRole('contentinfo');

    // A left-to-right box takes only what lies wholly inside it: the wedge,
    // not the axis it starts beside.
    const from = at(0.36, 0.34);
    const to = at(0.6, 0.66);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();

    // Shift-click on the primary (the last line swept) drops it rather than
    // grabbing it to move; a second Shift-click adds it back.
    const second = at(0.505, 0.5);
    await page.keyboard.down('Shift');
    await page.mouse.click(second.x, second.y);
    await page.keyboard.up('Shift');
    await modifyTool(page, 'Mirror');
    await expect(status).toContainText(
      'Mirror: click the line to mirror the selected entity about.'
    );
    await page.keyboard.press('Escape');
    await page.keyboard.down('Shift');
    await page.mouse.click(second.x, second.y);
    await page.keyboard.up('Shift');

    // Mirror armed over the selection asks only for the axis.
    await modifyTool(page, 'Mirror');
    await expect(status).toContainText(
      'Mirror: click the line to mirror the 2 selected entities about.'
    );
    await page.mouse.click(at(0.3, 0.5).x, at(0.3, 0.5).y);
    await expect(status).toContainText('Mirror added 2 linked entities.');
    await expect
      .poll(async () => (await exportSketch(page)).objects.length)
      .toBe(5);
    const mirrored = await exportSketch(page);
    type Line = Extract<SketchObjectData, { objectKind: 'line' }>;
    const [axis, sourceA, , imageA] = mirrored.objects.map(
      (object) => object.data
    ) as [Line, Line, Line, Line, Line];
    expect(Number(imageA.x1)).toBeCloseTo(
      2 * Number(axis.x1) - Number(sourceA.x1),
      6
    );

    // Select all, copy and paste: five more entities, the copies selected.
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+a`);
    await page.keyboard.press(`${modifier}+c`);
    await expect(status).toContainText('Copied 5 sketch entities.');
    await page.keyboard.press(`${modifier}+v`);
    await expect(status).toContainText('Pasted 5 sketch entities.');
    await expect
      .poll(async () => (await exportSketch(page)).objects.length)
      .toBe(10);

    // Delete takes the whole pasted selection in one step.
    await page.keyboard.press('Delete');
    await expect(status).toContainText('Deleted 5 sketch entities.');
    await expect
      .poll(async () => (await exportSketch(page)).objects.length)
      .toBe(5);
    await undo(page);
    await expect
      .poll(async () => (await exportSketch(page)).objects.length)
      .toBe(10);
  }
);

test('Delete after an undo removes the selected entities that remain', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Undo Selection');
  await drawLine(page, at(0.35, 0.4), at(0.45, 0.6));
  await drawLine(page, at(0.55, 0.4), at(0.65, 0.6));
  await page.keyboard.press('Escape');
  const status = page.getByRole('contentinfo');
  // Box the later line, then Shift-click the first, which becomes primary.
  await page.mouse.move(at(0.52, 0.35).x, at(0.52, 0.35).y);
  await page.mouse.down();
  await page.mouse.move(at(0.7, 0.65).x, at(0.7, 0.65).y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.down('Shift');
  await page.mouse.click(at(0.4, 0.5).x, at(0.4, 0.5).y);
  await page.keyboard.up('Shift');
  await modifyTool(page, 'Mirror');
  await expect(status).toContainText(
    'Mirror: click the line to mirror the 2 selected entities about.'
  );
  await page.keyboard.press('Escape');
  // Undo takes the later line away while the selection still names it.
  await undo(page);
  await expect
    .poll(async () => (await exportSketch(page)).objects.length)
    .toBe(1);
  // Only the line that is still there counts as selected.
  await modifyTool(page, 'Mirror');
  await expect(status).toContainText(
    'Mirror: click the line to mirror the selected entity about.'
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Delete');
  await expect(status).toContainText('Deleted sketch entity.');
  await expect
    .poll(async () => (await exportSketch(page)).objects.length)
    .toBe(0);
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
  // One relation holds both instances' positions and sizes.
  expect(constraintKinds(constraints)).toEqual(['pattern']);
});

test('dragging a linear pattern’s source carries every instance with it', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Pattern drag');
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
  await count.fill('3');
  await count.press('Enter');
  await expect(status).toContainText('Linear pattern added 2 linked circles.');
  await page.keyboard.press('Escape');

  // Pick the source by its rim, then drag it by its grab dot.
  await page.mouse.click(center.x - 24, center.y);
  const editor = page.getByRole('form', { name: 'Edit circle' });
  await expect(editor).toBeVisible();
  const before = Number(await editor.getByLabel('Center Y').inputValue());
  const handle = page.locator('.sketch-grab-handle');
  await expect(handle).toBeVisible();
  await waitForStillViewport(page);
  const box = (await handle.boundingBox())!;
  const grab = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x, grab.y - 40, { steps: 12 });
  await page.mouse.up();
  await expect(status).toContainText('Moved circle.');

  const { objects, constraints } = await exportSketch(page);
  const circles = objects
    .map((object) => object.data)
    .filter(
      (data): data is Extract<SketchObjectData, { objectKind: 'circle' }> =>
        data.objectKind === 'circle'
    );
  expect(circles).toHaveLength(3);
  const source = circles[0]!;
  // The source moved up; both instances kept their steps from it.
  expect(Number(source.centerY)).toBeGreaterThan(before + 1);
  const line = objects[1]!.data as Extract<
    SketchObjectData,
    { objectKind: 'line' }
  >;
  const dx = Number(line.x2) - Number(line.x1);
  const dy = Number(line.y2) - Number(line.y1);
  const length = Math.hypot(dx, dy);
  for (const [index, circle] of circles.entries()) {
    expect(Number(circle.centerX) - Number(source.centerX)).toBeCloseTo(
      (15 * index * dx) / length,
      6
    );
    expect(Number(circle.centerY) - Number(source.centerY)).toBeCloseTo(
      (15 * index * dy) / length,
      6
    );
    expect(Number(circle.radius)).toBeCloseTo(Number(source.radius), 9);
  }
  expect(constraintKinds(constraints)).toEqual(['pattern']);
});

test('Linear pattern spreads its instances over an extent chosen beside its slot', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Linear pattern extent');
  const center = at(0.35, 0.45);
  await drawCircle(page, center, 24);
  await drawLine(page, at(0.3, 0.7), at(0.5, 0.7));
  const status = page.getByRole('contentinfo');

  await modifyTool(page, 'Linear pattern');
  await page
    .getByRole('radiogroup', { name: 'Pattern spacing' })
    .getByRole('radio', { name: 'Extent' })
    .click();
  await page.mouse.click(center.x + 24, center.y);
  await expect(status).toContainText('Linear pattern: pick 2 of 2.');
  await page.mouse.click(at(0.4, 0.7).x, at(0.4, 0.7).y);
  const extent = page.getByRole('textbox', { name: 'Pattern extent' });
  await expect(extent).toBeVisible();
  await extent.fill('30');
  await extent.press('Enter');
  const count = page.getByRole('textbox', { name: 'Pattern count' });
  await expect(count).toBeVisible();
  await count.fill('4');
  await count.press('Enter');
  await expect(status).toContainText('Linear pattern added 3 linked circles.');

  const { objects } = await exportSketch(page);
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
  const length = Math.hypot(dx, Number(line.y2) - Number(line.y1));
  // The last of four instances lies the extent from the source: steps of 10.
  expect(circles).toHaveLength(4);
  for (const [index, circle] of circles.entries()) {
    expect(Number(circle.centerX) - Number(circles[0]!.centerX)).toBeCloseTo(
      (10 * index * dx) / length,
      6
    );
  }
});

test('a pattern and Construction act on a box selection in one step each', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Pattern selection');
  const a = at(0.35, 0.4);
  const b = at(0.35, 0.5);
  await drawCircle(page, a, 14);
  await drawCircle(page, b, 14);
  await drawLine(page, at(0.3, 0.7), at(0.5, 0.7));
  await page.keyboard.press('Escape');
  const status = page.getByRole('contentinfo');

  // A left-to-right box takes the two circles, not the line below them.
  const from = at(0.3, 0.33);
  const to = at(0.4, 0.57);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();

  await modifyTool(page, 'Linear pattern');
  await expect(status).toContainText(
    'Linear pattern: click a line for the direction to repeat 2 selected entities along.'
  );
  await page.mouse.click(at(0.4, 0.7).x, at(0.4, 0.7).y);
  const spacing = page.getByRole('textbox', { name: 'Pattern spacing' });
  await expect(spacing).toBeVisible();
  await spacing.fill('40');
  await spacing.press('Enter');
  const count = page.getByRole('textbox', { name: 'Pattern count' });
  await expect(count).toBeVisible();
  await count.fill('2');
  await count.press('Enter');
  await expect(status).toContainText(
    'Linear pattern added 2 linked entities from 2 selected.'
  );
  await expect
    .poll(async () => (await exportSketch(page)).objects.length)
    .toBe(5);

  // Box the two new circles and mark them construction together.
  const { objects } = await exportSketch(page);
  expect(kindsOf(objects)).toEqual([
    'circle',
    'circle',
    'line',
    'circle',
    'circle'
  ]);
  await page.keyboard.press('Escape');
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+a`);
  const toggle = page.getByRole('button', { name: 'Construction (5)' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(status).toContainText(
    '5 entities are construction geometry now; they no longer bound a profile.'
  );
  await expect
    .poll(async () =>
      (await exportSketch(page)).objects.every(
        (object) => object.data.construction === true
      )
    )
    .toBe(true);
  // One undo step restores all five.
  await undo(page);
  await expect
    .poll(async () =>
      (await exportSketch(page)).objects.some(
        (object) => object.data.construction === true
      )
    )
    .toBe(false);
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

type LineData = Extract<SketchObjectData, { objectKind: 'line' }>;

function lineBounds(objects: { data: SketchObjectData }[]) {
  const lines = objects
    .map((object) => object.data)
    .filter((data): data is LineData => data.objectKind === 'line');
  const xs = lines.flatMap((line) => [Number(line.x1), Number(line.x2)]);
  const ys = lines.flatMap((line) => [Number(line.y1), Number(line.y2)]);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
}

async function offsetBy(page: Page, at: Point, distance: string) {
  await page.mouse.click(at.x, at.y);
  const field = page.getByRole('textbox', { name: 'Offset distance' });
  await expect(field).toBeVisible();
  await field.fill(distance);
  await field.press('Enter');
}

test('Fillet and Chamfer meet a circle a line ends on, keeping the circle whole', async ({
  page
}) => {
  test.setTimeout(120_000);
  const at = await startSketch(page, 'Curved corners');
  // Sized from the canvas, so a phone-width run draws the same picture.
  const center = at(0.35, 0.5);
  const radiusPx = Math.round((at(0.5, 0.5).x - at(0.35, 0.5).x) * 0.6);
  await drawCircle(page, center, radiusPx);
  // The line ends on the circle's quadrant snap, so the joint is exact.
  const joint = { x: center.x + radiusPx, y: center.y };
  const lineStart = at(0.8, 0.5);
  await drawLine(page, lineStart, joint);
  await page.keyboard.press('Escape');
  const status = page.getByRole('contentinfo');
  const drawn = await exportSketch(page);
  expect(kindsOf(drawn.objects)).toEqual(['circle', 'line']);
  const circle = drawn.objects[0]!.data as Extract<
    SketchObjectData,
    { objectKind: 'circle' }
  >;
  const line = drawn.objects[1]!.data as Extract<
    SketchObjectData,
    { objectKind: 'line' }
  >;
  const r = Number(circle.radius);
  expect(
    Math.hypot(
      Number(line.x2) - Number(circle.centerX),
      Number(line.y2) - Number(circle.centerY)
    )
  ).toBeCloseTo(r, 6);

  // Fillet: the joint offers a corner each way round; one is rounded.
  await page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: /^Fillet(?:$| —)/ })
    .click();
  const bar = page.getByRole('group', {
    name: 'Sketch Fillet command',
    exact: true
  });
  await expect(bar).toBeVisible(READ_TIMEOUT);
  const corners = page.getByTestId('sketch-fillet-corner');
  await expect(corners).toHaveCount(2, READ_TIMEOUT);
  // A marker is picked through the canvas at its point, as on screen.
  await expect(corners.first()).toBeVisible();
  const marker = (await corners.first().boundingBox())!;
  await page.mouse.click(
    marker.x + marker.width / 2,
    marker.y + marker.height / 2
  );
  await expect(
    page
      .getByTestId('sketch-fillet-corner')
      .and(page.getByRole('button', { pressed: true }))
  ).toHaveCount(1);
  await bar.getByRole('button', { name: /^(?:Fillet )?Radius\b/i }).click();
  const radius = page
    .getByRole('dialog', { name: 'Fillet radius value' })
    .getByRole('textbox', { name: 'Fillet radius' });
  await radius.fill(String(Math.round(r * 30) / 100));
  await radius.press('Enter');
  await finishInPlaceCommand(page, 'Sketch Fillet');
  await expect
    .poll(async () => (await exportSketch(page)).objects.length, READ_TIMEOUT)
    .toBe(3);
  const filleted = await exportSketch(page);
  expect(kindsOf(filleted.objects)).toEqual(['circle', 'line', 'arc']);
  // The circle is untouched; the fillet is tangent to it by relation.
  expect(filleted.objects[0]!.data).toEqual(circle);
  expect(constraintKinds(filleted.constraints)).toContain('tangent');

  // One undo restores the corner; Chamfer then cuts the clicked side.
  await undo(page);
  await expect
    .poll(async () => (await exportSketch(page)).objects.length)
    .toBe(2);
  await page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: /^Chamfer/ })
    .click();
  await page.mouse.click((lineStart.x + joint.x) / 2, joint.y);
  await expect(status).toContainText('Chamfer: pick 2 of 2.');
  // The circle's upper side.
  await page.mouse.click(center.x, center.y - radiusPx);
  const distance = page.getByRole('textbox', { name: 'Chamfer distance' });
  await expect(distance).toBeVisible();
  await distance.fill(String(Math.round(r * 40) / 100));
  await distance.press('Enter');
  await expect(status).toContainText('Chamfer cut both legs back');
  const chamfered = await exportSketch(page);
  expect(kindsOf(chamfered.objects)).toEqual(['circle', 'line', 'line']);
  expect(chamfered.objects[0]!.data).toEqual(circle);
  const bevel = chamfered.objects[2]!.data as Extract<
    SketchObjectData,
    { objectKind: 'line' }
  >;
  // Its far end is on the circle, on the side that was clicked (sketch y up
  // is screen up).
  expect(
    Math.hypot(
      Number(bevel.x2) - Number(circle.centerX),
      Number(bevel.y2) - Number(circle.centerY)
    )
  ).toBeCloseTo(r, 6);
  expect(Number(bevel.y2)).toBeGreaterThan(Number(circle.centerY));
  expect(constraintKinds(chamfered.constraints)).toContain('point-on-object');
});

test('Offset follows a rectangle, mitered then round, one undo step each', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Offset');
  const a = at(0.35, 0.4);
  const b = at(0.55, 0.65);
  await drawRectangle(page, a, b);
  const status = page.getByRole('contentinfo');
  const side = { x: (a.x + b.x) / 2, y: b.y };
  const source = await exportSketch(page);
  expect(kindsOf(source.objects)).toEqual(['line', 'line', 'line', 'line']);
  const size = lineBounds(source.objects);

  // Miter is the default: a sharp rectangle 1 out on every side.
  await modifyTool(page, 'Offset');
  const strip = page.getByRole('group', { name: 'Offset options' });
  await expect(strip.getByRole('radio', { name: 'Miter' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(strip.getByRole('button', { name: 'Chain' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await offsetBy(page, side, '1');
  await expect(status).toContainText('Offset added 4 curves at 1.');
  const mitered = await exportSketch(page);
  const miterLines = mitered.objects.slice(4);
  expect(kindsOf(miterLines)).toEqual(['line', 'line', 'line', 'line']);
  const grown = lineBounds(miterLines);
  expect(grown.width).toBeCloseTo(size.width + 2, 6);
  expect(grown.height).toBeCloseTo(size.height + 2, 6);

  // Round: radius-2 arcs about the source corners, chosen on the strip.
  await modifyTool(page, 'Offset');
  await strip.getByRole('radio', { name: 'Round' }).click();
  await offsetBy(page, side, '2');
  await expect(status).toContainText('Offset added 8 curves at 2.');
  const rounded = await exportSketch(page);
  const arcs = rounded.objects
    .slice(8)
    .map((object) => object.data)
    .filter((data) => data.objectKind === 'arc');
  expect(arcs).toHaveLength(4);
  for (const arc of arcs) {
    expect(arc.objectKind === 'arc' && Number(arc.radius)).toBeCloseTo(2, 9);
  }

  await undo(page);
  await expect
    .poll(async () => (await exportSketch(page)).objects.length)
    .toBe(8);
});

test('Offset grows a circle, and refuses one that would vanish', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Offset circle');
  const center = at(0.45, 0.5);
  await drawCircle(page, center, 40);
  const status = page.getByRole('contentinfo');
  const [circle] = (await exportSketch(page)).objects;
  const radius = Number(
    circle!.data.objectKind === 'circle' ? circle!.data.radius : NaN
  );

  await modifyTool(page, 'Offset');
  await offsetBy(page, { x: center.x + 40, y: center.y }, `-${radius}`);
  await expect(status).toContainText('would have no radius left');
  expect((await exportSketch(page)).objects).toHaveLength(1);

  await modifyTool(page, 'Offset');
  await offsetBy(page, { x: center.x + 40, y: center.y }, '-1');
  await expect(status).toContainText('Offset added a circle of radius');
  const { objects, constraints } = await exportSketch(page);
  expect(kindsOf(objects)).toEqual(['circle', 'circle']);
  const copy = objects[1]!.data;
  expect(copy.objectKind === 'circle' && Number(copy.radius)).toBeCloseTo(
    radius - 1,
    6
  );
  expect(constraintKinds(constraints)).toEqual(['concentric']);
});

test('the Offset value prompt says Esc cancels it, not that Esc leaves the sketch (I43)', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Offset escape');
  const center = at(0.45, 0.5);
  await drawCircle(page, center, 40);
  const status = page.getByRole('contentinfo');
  const finish = page.getByRole('button', {
    name: 'Finish Sketch',
    exact: true
  });

  // The modify tool disarms once its picks are in, so the prompt opens on
  // the sketch ladder's last rung: its hint read "Esc leaves the sketch".
  await modifyTool(page, 'Offset');
  await page.mouse.click(center.x + 40, center.y);
  const field = page.getByRole('textbox', { name: 'Offset distance' });
  await expect(field).toBeVisible();
  await expect(status).toContainText('Esc cancel');
  await expect(status).not.toContainText('leaves the sketch');

  // Escape cancels the value only; the sketch stays open, exit unarmed.
  await field.press('Escape');
  await expect(field).toBeHidden();
  await expect(finish).toBeVisible();
  await expect(status).not.toContainText('Press Esc again');

  // The ladder then asks before it leaves, and Finish leaves in one click
  // with the circle kept.
  await page.keyboard.press('Escape');
  await expect(status).toContainText('Press Esc again to leave the sketch');
  await expect(finish).toBeVisible();
  await finish.click();
  await expect(finish).toBeHidden();
  expect(kindsOf((await exportSketch(page)).objects)).toEqual(['circle']);
});

test('Construction on one side of a rectangle removes its profile; undo restores it', async ({
  page
}) => {
  test.setTimeout(90_000);
  const at = await startSketch(page, 'Construction');
  const a = at(0.35, 0.4);
  const b = at(0.55, 0.65);
  await drawRectangle(page, a, b);
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  const extrude = rail.getByRole('button', { name: 'Extrude' });
  await expect(extrude).toBeEnabled();

  await rail.getByRole('button', { name: /^Select/ }).click();
  await page.mouse.click((a.x + b.x) / 2, b.y);
  const editor = page.getByRole('form', { name: 'Edit line', exact: true });
  const toggle = editor.getByRole('button', { name: 'Construction' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'The line is construction geometry now'
  );
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(extrude).toBeDisabled();
  const marked = await exportSketch(page);
  expect(
    marked.objects.filter((object) => object.data.construction === true)
  ).toHaveLength(1);

  await undo(page);
  await expect(extrude).toBeEnabled();
  const restored = await exportSketch(page);
  expect(
    restored.objects.filter((object) => object.data.construction === true)
  ).toHaveLength(0);
});
