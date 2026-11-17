import type { Page } from '@playwright/test';
import type { ProjectDocument, SketchConstraintData } from '@openzcad/shared';
import { expect, stubApi, test, MODEL_ONLY } from './openzcad-fixtures';

/**
 * S08 inference while drawing through the real Line tool and canvas picks:
 * with Auto-constrain on, a chain is joined end to end, its axis-locked
 * segments are held horizontal and vertical, a click back on the first end
 * joins it, and every relation the commit inferred is named on the status
 * line and drawn as a glyph that a click and Delete remove. With the setting
 * off only joined ends and midpoints are kept. Relation oracles live in
 * apps/web/src/lib/sketch/inference.test.ts and test/sketch-inference.test.ts
 * (solved on the pinned kernel); this proves the wiring.
 */

const READ_TIMEOUT = { timeout: 30_000 };

async function startSketch(page: Page, name: string) {
  page.setDefaultTimeout(15_000);
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
  const bounds = (await page.locator('.viewer-host canvas').boundingBox())!;
  return (fx: number, fy: number) => ({
    x: bounds.x + bounds.width * fx,
    y: bounds.y + bounds.height * fy
  });
}

/** Sets the palette's Snap to grid and Auto-constrain checkboxes. */
async function setSnapping(
  page: Page,
  settings: { grid: boolean; autoConstrain: boolean }
) {
  const palette = page.getByRole('button', { name: /Sketch palette/ });
  const gridSnap = page.getByRole('checkbox', { name: 'Snap to grid' });
  if (!(await gridSnap.isVisible())) await palette.click();
  await gridSnap.setChecked(settings.grid);
  await page
    .getByRole('checkbox', { name: 'Auto-constrain' })
    .setChecked(settings.autoConstrain);
  await palette.click();
  await expect(gridSnap).toBeHidden();
}

async function exportConstraints(
  page: Page
): Promise<{ objects: number; constraints: SketchConstraintData[] }> {
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
    objects: sketch.objectIds.length,
    constraints: (sketch.constraints ?? []).map((entry) => entry.data)
  };
}

const kinds = (constraints: SketchConstraintData[]) =>
  constraints.map((constraint) => constraint.constraintKind).sort();

test(
  'a drawn chain keeps the relations it lands on, each visible and deletable',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    const at = await startSketch(page, 'Inference');
    await setSnapping(page, { grid: false, autoConstrain: true });
    const status = page.getByRole('contentinfo');
    const glyph = (kind: string) =>
      page.locator(`.sketch-relation-glyph[data-kind="${kind}"]`);

    // p0 → p1 is axis-locked horizontal, p1 → p2 vertical, and the last
    // click lands back on p0's endpoint snap.
    const p0 = at(0.3, 0.62);
    const p1 = at(0.55, 0.62);
    const p2 = at(0.55, 0.38);
    await page
      .getByRole('toolbar', { name: 'Sketch tools' })
      .getByRole('button', { name: /^Line/ })
      .click();
    await page.mouse.click(p0.x, p0.y);
    await page.mouse.move(p1.x, p1.y, { steps: 4 });
    await page.mouse.click(p1.x, p1.y);
    await expect(status).toContainText(
      'Sketch 01 started · inferred horizontal'
    );
    await page.mouse.move(p2.x, p2.y, { steps: 4 });
    await page.mouse.click(p2.x, p2.y);
    await expect(status).toContainText(
      'Added line · inferred coincident, vertical'
    );
    await page.mouse.move(p0.x, p0.y, { steps: 4 });
    await page.mouse.click(p0.x, p0.y);
    await expect(status).toContainText('Added line · inferred coincident ×2');
    await page.keyboard.press('Escape');

    const drawn = await exportConstraints(page);
    expect(drawn.objects).toBe(3);
    expect(kinds(drawn.constraints)).toEqual([
      'coincident',
      'coincident',
      'coincident',
      'horizontal',
      'vertical'
    ]);

    // Glyphs show only the selection's relations by default, but the last
    // commit's inferred ones are drawn with nothing selected.
    await expect(glyph('coincident')).toHaveCount(2);
    await glyph('coincident').first().click();
    await expect(status).toContainText('Press Delete to remove it.');
    await page.keyboard.press('Delete');
    await expect(status).toContainText('Deleted constraint.');
    const deleted = await exportConstraints(page);
    expect(deleted.objects).toBe(3);
    expect(kinds(deleted.constraints)).toEqual([
      'coincident',
      'coincident',
      'horizontal',
      'vertical'
    ]);

    // Undo brings the relation back; one more takes the closing line and
    // both of its relations in one step.
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await undo.click();
    await expect
      .poll(async () => (await exportConstraints(page)).constraints.length)
      .toBe(5);
    await undo.click();
    const undone = await exportConstraints(page);
    expect(undone.objects).toBe(2);
    expect(kinds(undone.constraints)).toEqual([
      'coincident',
      'horizontal',
      'vertical'
    ]);

    // Auto-constrain off: a line from the first segment's midpoint keeps
    // only the midpoint, though it is axis-locked vertical.
    await setSnapping(page, { grid: false, autoConstrain: false });
    const mid = { x: (p0.x + p1.x) / 2, y: p0.y };
    const below = { x: mid.x, y: at(0.5, 0.8).y };
    await page
      .getByRole('toolbar', { name: 'Sketch tools' })
      .getByRole('button', { name: /^Line/ })
      .click();
    await page.mouse.move(mid.x, mid.y, { steps: 4 });
    await page.mouse.click(mid.x, mid.y);
    await page.mouse.move(below.x, below.y, { steps: 4 });
    await page.mouse.click(below.x, below.y);
    await expect(status).toContainText('Added line · inferred midpoint');
    await page.keyboard.press('Escape');
    const off = await exportConstraints(page);
    expect(off.objects).toBe(3);
    expect(kinds(off.constraints)).toEqual([
      'coincident',
      'horizontal',
      'midpoint',
      'vertical'
    ]);
  }
);
