import type { Page } from '@playwright/test';
import type {
  ProjectDocument,
  SketchConstraintData,
  SketchObjectData
} from '@openzcad/shared';
import {
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  stubApi,
  test,
  MODEL_ONLY
} from './openzcad-fixtures';

/**
 * S08 guidelines and guidepoints through canvas picks: a line started on
 * another line's extension is held on it; a line ending on a circle's
 * tangent guide is held on the circle and tangent to it; with the view
 * looking straight down the sketch, a vertex of a box below the plane is
 * projected in as a named guidepoint a point snaps to, and Snap hints off
 * drops the name but keeps the snap. Oracles live in
 * apps/web/src/lib/sketch/guides.test.ts; this proves the wiring.
 */

const READ_TIMEOUT = { timeout: 30_000 };

async function openSketch(page: Page, name: string, withBox = false) {
  page.setDefaultTimeout(15_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  if (withBox) {
    // A 20 cube wholly below the XY plane, its corner at (0, 0, -30).
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '20', depth: '20', height: '20' },
      at: { x: 0, y: 0, z: -30 }
    });
    await expectBodyCount(page, 1);
  }
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await page.waitForTimeout(800);
  const palette = page.getByRole('button', { name: /Sketch palette/ });
  const gridSnap = page.getByRole('checkbox', { name: 'Snap to grid' });
  if (!(await gridSnap.isVisible())) await palette.click();
  await gridSnap.setChecked(false);
  await page.getByRole('checkbox', { name: 'Auto-constrain' }).setChecked(true);
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
    )
  };
}

const kinds = (constraints: SketchConstraintData[]) =>
  constraints.map((constraint) => constraint.constraintKind).sort();

async function tool(page: Page, name: RegExp) {
  await page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name })
    .click();
}

test(
  'extension and tangent guidelines hold what is drawn on them',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    const at = await openSketch(page, 'Guidelines');
    const status = page.getByRole('contentinfo');
    const marker = page.locator('.sketch-snap-marker');

    // A horizontal line, then a line started well past its right end on the
    // extension guide and run straight up.
    await tool(page, /^Line/);
    await page.mouse.click(at(0.25, 0.4).x, at(0.25, 0.4).y);
    await page.mouse.click(at(0.4, 0.4).x, at(0.4, 0.4).y);
    await expect(status).toContainText('Sketch 01 started');
    await page.keyboard.press('Escape');
    await tool(page, /^Line/);
    const onExtension = at(0.55, 0.4);
    await page.mouse.move(onExtension.x, onExtension.y + 3, { steps: 4 });
    await expect(marker).toHaveAttribute('data-kind', 'extension');
    await expect(marker).toHaveAttribute('data-label', 'Extension');
    await page.mouse.click(onExtension.x, onExtension.y + 3);
    await page.mouse.click(at(0.55, 0.22).x, at(0.55, 0.22).y);
    await expect(status).toContainText('inferred on curve, vertical');
    await page.keyboard.press('Escape');

    // A circle, then a line from a point left of it to the upper tangent
    // point, which the tangent guide offers from the line's anchor. The view
    // is head-on, so screen geometry is the plane's at a uniform scale.
    const centre = at(0.72, 0.7);
    const radiusPx = 40;
    await tool(page, /^Circle/);
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + radiusPx, centre.y, { steps: 6 });
    await page.mouse.up();
    await expect(status).toContainText('Added circle.');
    // Close in, so the tangent point sits well away from the quadrants.
    const anchor = { x: centre.x - 60, y: centre.y };
    const spread = Math.acos(radiusPx / 60);
    const touch = {
      x: centre.x - radiusPx * Math.cos(spread),
      y: centre.y - radiusPx * Math.sin(spread)
    };
    await tool(page, /^Line/);
    await page.mouse.click(anchor.x, anchor.y);
    await page.mouse.move(touch.x + 2, touch.y + 2, { steps: 4 });
    await expect(marker).toHaveAttribute('data-kind', 'tangent');
    await page.mouse.click(touch.x + 2, touch.y + 2);
    // At exact tangency a hold on the circle adds no rank (the two
    // relations' gradients coincide), so the settle keeps the tangent.
    await expect(status).toContainText('Added line · inferred tangent.');
    await page.keyboard.press('Escape');

    const drawn = await exportSketch(page);
    expect(kinds(drawn.constraints)).toEqual([
      'horizontal',
      'point-on-object',
      'tangent',
      'vertical'
    ]);
  }
);

test('a model vertex below the plane is projected in while the view is head-on', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openSketch(page, 'Guidepoints', true);
  const marker = page.locator('.sketch-snap-marker');
  const canvas = page.locator('.viewer-host canvas');
  // Where the box's (20, 20, -10) corner sits over the plane.
  const [over] = await canvas.evaluate(
    (element) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: [[20, 20, 0]],
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      })
  );
  const box = (await canvas.boundingBox())!;
  const target = { x: box.x + over!.x + 3, y: box.y + over!.y + 3 };

  // A line started on the projected corner.
  await tool(page, /^Line/);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await expect(marker).toHaveAttribute(
    'data-label',
    'Model vertex (projected)'
  );
  await page.mouse.click(target.x, target.y);
  await page.mouse.click(target.x + 120, target.y + 70);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Sketch 01 started'
  );
  await page.keyboard.press('Escape');
  const placed = (await exportSketch(page)).objects[0]!.data as Extract<
    SketchObjectData,
    { objectKind: 'line' }
  >;
  expect(Number(placed.x1)).toBeCloseTo(20, 9);
  expect(Number(placed.y1)).toBeCloseTo(20, 9);

  // Snap hints off: the same snap, named by its glyph alone.
  const palette = page.getByRole('button', { name: /Sketch palette/ });
  const hints = page.getByRole('checkbox', { name: 'Snap hints' });
  if (!(await hints.isVisible())) await palette.click();
  await hints.setChecked(false);
  await palette.click();
  await page.mouse.move(target.x + 30, target.y + 30, { steps: 4 });
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await expect(marker).toHaveAttribute('data-kind', 'endpoint');
  await expect(marker).not.toHaveAttribute('data-label', /.+/);
});
