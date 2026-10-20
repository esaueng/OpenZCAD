import type { Page } from '@playwright/test';
import type { ProjectDocument, SketchObjectData } from '@openzcad/shared';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * I01 curve entities through the real rail, canvas and keyboard: the curve
 * slot's Ellipse, Arc, Fit and Control types, the O and S keys, the spline's
 * Enter and close-on-first-point finishes, and an extrude of the ellipse's
 * region. The exported document proves what each gesture wrote. Geometry,
 * kernel and solver oracles live in test/sketch-curve-*.test.ts; this proves
 * the wiring.
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
  // Grid snapping would move the clicked points; geometry snaps stay on.
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

async function exportObjects(page: Page): Promise<SketchObjectData[]> {
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
  expect(document.schemaVersion).toBe(33);
  const sketch = Object.values(document.nodes).find(
    (node) => node.kind === 'sketch'
  );
  if (sketch?.kind !== 'sketch') throw new Error('No sketch exported.');
  return sketch.objectIds.map((id) => {
    const node = document.nodes[id];
    if (node?.kind !== 'sketch-object') throw new Error('Not an object.');
    return node.data;
  });
}

type Ellipse = Extract<SketchObjectData, { objectKind: 'ellipse' }>;
type Spline = Extract<SketchObjectData, { objectKind: 'spline' }>;

test('the curve slot draws ellipses, elliptical arcs and both splines', async ({
  page
}) => {
  test.setTimeout(120_000);
  const at = await startSketch(page, 'Curves');
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  const curveType = rail.getByRole('radiogroup', { name: 'Curve type' });
  const status = page.getByRole('contentinfo');
  const click = async (fx: number, fy: number) => {
    const point = at(fx, fy);
    await page.mouse.move(point.x, point.y, { steps: 3 });
    await page.mouse.click(point.x, point.y);
  };

  // O arms the ellipse: centre, a horizontal axis end, the other radius.
  await page.keyboard.press('o');
  await expect(curveType.getByRole('radio', { name: 'Ellipse' })).toBeChecked();
  await click(0.3, 0.3);
  await click(0.42, 0.3);
  await click(0.3, 0.24);
  await expect(status).toContainText('Sketch 01 started.');

  // O again steps to the elliptical arc: an ellipse, then start and end.
  await page.keyboard.press('o');
  await expect(curveType.getByRole('radio', { name: 'Arc' })).toBeChecked();
  await click(0.7, 0.3);
  await click(0.8, 0.3);
  await click(0.7, 0.25);
  await click(0.8, 0.29);
  await click(0.6, 0.31);
  await expect(status).toContainText('Added ellipse.');

  // S arms the fit spline; a click on its first point closes it.
  await page.keyboard.press('s');
  await expect(curveType.getByRole('radio', { name: 'Fit' })).toBeChecked();
  await click(0.2, 0.6);
  await click(0.3, 0.55);
  await click(0.32, 0.72);
  await click(0.22, 0.75);
  await click(0.2, 0.6);
  await expect(status).toContainText('Added spline.');

  // The Control tile; Enter finishes an open spline through what is placed.
  await curveType.getByRole('radio', { name: 'Control' }).click();
  await click(0.55, 0.7);
  await click(0.62, 0.55);
  await click(0.72, 0.58);
  await click(0.78, 0.72);
  await page.keyboard.press('Enter');
  await expect(status).toContainText('Added spline.');

  const [ellipse, arc, fit, control] = (await exportObjects(page)) as [
    Ellipse,
    Ellipse,
    Spline,
    Spline
  ];
  expect(ellipse.objectKind).toBe('ellipse');
  // A horizontal axis click: the major axis lies along x.
  expect(Math.sin((Number(ellipse.rotationDeg) * Math.PI) / 180)).toBeCloseTo(
    0,
    6
  );
  expect(Number(ellipse.radiusX)).toBeGreaterThan(Number(ellipse.radiusY));
  expect(ellipse.startParamDeg).toBeUndefined();

  expect(arc.objectKind).toBe('ellipse');
  const sweep = Number(arc.endParamDeg) - Number(arc.startParamDeg);
  expect(sweep).toBeGreaterThan(90);
  expect(sweep).toBeLessThan(270);

  expect(fit).toMatchObject({ objectKind: 'spline', method: 'fit', closed: true });
  expect(fit.points).toHaveLength(4);
  expect(control).toMatchObject({
    objectKind: 'spline',
    method: 'control',
    degree: 3
  });
  expect(control.closed).toBeUndefined();
  expect(control.points).toHaveLength(4);

  // The full ellipse and the closed spline each bound a region that
  // extrudes as an exact new body.
  await page.keyboard.press('e');
  const distance = page.getByLabel('Distance', { exact: true });
  await distance.fill('10');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(status).toContainText('Extruded', READ_TIMEOUT);
});
