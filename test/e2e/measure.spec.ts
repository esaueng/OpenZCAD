import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './openzcad-fixtures';

/**
 * Measuring must not change what is selected.
 *
 * View mode is read-only, and a measurement is an observation. But the measure
 * handler used to be called for its side effects and then fall straight
 * through into sketch entry, the direct-manipulation handles, and the
 * selection update — so inspecting a part quietly replaced whatever a
 * modelling session had been holding. Nothing in the suite covered it, because
 * every measurement test looked only at the measurement.
 */

async function createBox(page: Page, name: string) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
}

async function switchWorkspace(page: Page, to: 'View' | 'Build') {
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: to })
    .click();
}

async function armMeasure(page: Page) {
  await page
    .getByRole('toolbar', { name: 'View tools' })
    .getByRole('button', { name: 'Measure' })
    .click();
}

/**
 * Asks the viewport where a pickable edge is, rather than clicking a lattice of
 * screen points hoping to land on a line two pixels wide.
 *
 * Guessing fractions of the canvas is doubly unreliable here: View mode drops
 * the sidebar, so the same fraction lands on different geometry than it does in
 * Build. This hook projects the real display polyline through the live camera.
 */
async function locateEdge(page: Page) {
  const canvas = page.locator('.viewer-host canvas');
  let found: { x: number; y: number; topologyId: string } | null = null;
  await expect
    .poll(
      async () => {
        found = await canvas.evaluate(
          (element) =>
            new Promise<{
              x: number;
              y: number;
              topologyId: string;
            } | null>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-locate-edge', {
                  detail: { resolve }
                })
              );
            })
        );
        return found !== null;
      },
      { message: 'the body should expose a pickable edge', timeout: 20_000 }
    )
    .toBe(true);
  return found!;
}

test('measuring in View leaves the Build selection untouched', async ({
  page
}) => {
  await createBox(page, 'Measure Independence');
  const status = page.getByRole('contentinfo');

  // Select an edge while modelling, the way someone would before a fillet.
  await page.getByRole('button', { name: 'Edge', exact: true }).click();
  const buildEdge = await locateEdge(page);
  await page.mouse.click(buildEdge.x, buildEdge.y);
  await expect(status).toContainText('1 exact edge selected');
  const selectedBefore = await page
    .locator('.selection-chip-label')
    .textContent();
  expect(selectedBefore).toBeTruthy();

  // Go and measure.
  await switchWorkspace(page, 'View');
  await armMeasure(page);
  const viewEdge = await locateEdge(page);
  await page.mouse.click(viewEdge.x, viewEdge.y);

  const workbench = page.getByLabel('Measurement workbench');
  await expect(workbench.getByRole('listitem')).toHaveCount(1);

  // Back to modelling: the edge picked before is still the edge selected.
  //
  // Asserted on the chip and the persistent hint rather than on the status
  // bar's transient line, which by now reports the mode switch — the newest
  // thing that happened, not the state that survived it.
  await switchWorkspace(page, 'Build');
  await expect(page.locator('.selection-chip-label')).toHaveText(
    selectedBefore!
  );
  await expect(status).toContainText('Edge selected');
});

test('a measured pick arms no sketch and no drag handle', async ({ page }) => {
  await createBox(page, 'Measure Consumes');
  const canvas = page.locator('.viewer-host canvas');

  await switchWorkspace(page, 'View');
  await armMeasure(page);

  // A face click is the pick that used to arm three things at once.
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  await canvas.click({
    position: { x: bounds.width * 0.5, y: bounds.height * 0.4 }
  });

  const workbench = page.getByLabel('Measurement workbench');
  await expect(workbench.getByRole('listitem')).toHaveCount(1);
  // None of the surfaces a fall-through would have opened.
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toBeHidden();
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeHidden();
  // And no selection was made to produce the measurement.
  await expect(page.locator('.selection-chip-label')).toBeHidden();
  await expect(page.getByRole('contentinfo')).toContainText('measured');
});

test('measuring an edge records it without selecting it', async ({ page }) => {
  await createBox(page, 'Measure Edge');

  await switchWorkspace(page, 'View');
  await armMeasure(page);
  // Narrow to edges: a face is under the pointer too, and Smart mode would
  // happily measure that instead.
  await page.getByRole('button', { name: 'Edge', exact: true }).click();

  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);

  const workbench = page.getByLabel('Measurement workbench');
  await expect(workbench.getByRole('listitem')).toHaveCount(1);
  await expect(workbench.getByRole('listitem')).toContainText('mm');
  // The running edge set is the measure tool's own state now, so recording a
  // length leaves the workspace selection empty.
  await expect(page.locator('.selection-chip-label')).toBeHidden();

  await switchWorkspace(page, 'Build');
  await expect(page.locator('.selection-chip-label')).toBeHidden();
});

test('the preview names exactly what the click then measures', async ({
  page
}) => {
  // Two things could break this. The preview could use a cheaper derivation
  // than the click and disagree about the number; or — the subtler one — the
  // preview could ADVANCE the depth cycle, because `cycleDepthPick` treats a
  // second call within a few pixels as a request for the next candidate down.
  // Hovering and then clicking one spot would then measure the second thing in
  // the stack while the chip named the first.
  await createBox(page, 'Measure Preview');
  const canvas = page.locator('.viewer-host canvas');

  await switchWorkspace(page, 'View');
  await armMeasure(page);

  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  const spot = {
    x: bounds.x + bounds.width * 0.5,
    y: bounds.y + bounds.height * 0.4
  };

  await page.mouse.move(spot.x, spot.y);
  const chip = page.locator('.measure-preview-chip');
  await expect(chip).toBeVisible();
  const previewed = (await chip.textContent())?.trim();
  expect(previewed).toBeTruthy();

  // Nothing recorded yet: a preview is a look, not a commitment.
  const workbench = page.getByLabel('Measurement workbench');
  await expect(workbench.getByRole('listitem')).toHaveCount(0);

  await page.mouse.click(spot.x, spot.y);
  await expect(workbench.getByRole('listitem')).toHaveCount(1);
  await expect(workbench.getByRole('listitem')).toContainText(previewed!);
});

test('a hover on an edge snaps to a named point', async ({ page }) => {
  // Snapping is what makes a measured distance exact rather than "wherever the
  // cursor happened to be". The glyph naming the kind is half of it: a marker
  // alone says something happened, where "Endpoint" says the position is now
  // exact.
  //
  // Candidates are scoped by `measureSnapEdges` before anything is projected.
  // `resolveSnap` projects every candidate it is handed, on every hover frame,
  // so handing it a whole body is how this becomes a frame-rate problem on an
  // imported assembly.
  await createBox(page, 'Measure Snap');

  await switchWorkspace(page, 'View');
  await armMeasure(page);
  await page.getByRole('button', { name: 'Edge', exact: true }).click();

  // The locator hands back a point on a real edge, confirmed pickable through
  // the live camera — which is also within snap range of that edge's own
  // midpoint or an end.
  const edge = await locateEdge(page);
  await page.mouse.move(edge.x - 60, edge.y - 60);
  await page.mouse.move(edge.x, edge.y);

  const glyph = page.locator('.snap-glyph');
  await expect(glyph).toBeVisible();
  await expect(glyph).toHaveText(/Endpoint|Midpoint|Center/);
});
