import { expect, test, type Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  locateEdge,
  setSelectionFilter,
  stubApi
} from './openzcad-fixtures';

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
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box');
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
test('mobile measurement actions stay clear of the viewport ruler', async ({
  page
}) => {
  await createBox(page, 'QA mobile measurement layout');
  await switchWorkspace(page, 'View');
  await armMeasure(page);
  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);
  const workbench = page.getByLabel('Measurement workbench');
  await expect(workbench.getByRole('listitem')).toHaveCount(1);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const ruler = page.getByTestId('viewport-scale-indicator');
    await expect(ruler).toBeVisible();
    await expect(
      workbench.getByRole('button', { name: 'Copy all' })
    ).toBeVisible();
    // The ruler stands in the corner under the workbench's sheet; what has
    // to hold is that neither covers the other.
    await expect
      .poll(async () => {
        const scale = await ruler.boundingBox();
        const dock = await workbench.boundingBox();
        return (
          scale !== null &&
          dock !== null &&
          scale.y >= 0 &&
          scale.y + scale.height <= 844 &&
          (scale.y + scale.height + 4 <= dock.y ||
            scale.y >= dock.y + dock.height + 4)
        );
      })
      .toBe(true);
  }
});

test('measuring in View leaves the Build selection untouched', async ({
  page
}) => {
  await createBox(page, 'Measure Independence');
  const status = page.getByRole('contentinfo');

  // Select an edge while modelling, the way someone would before a fillet.
  await setSelectionFilter(page, 'Edge');
  const buildEdge = await locateEdge(page);
  await page.mouse.click(buildEdge.x, buildEdge.y);
  await expect(status).toContainText('1 edge selected');
  const selectedBefore = await page
    .locator('.selection-readout .selection-callout-name')
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
  await expect(
    page.locator('.selection-readout .selection-callout-name')
  ).toHaveText(selectedBefore!);
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
  await expect(
    page.locator('.selection-readout .selection-callout-name')
  ).toBeHidden();
  await expect(page.getByRole('contentinfo')).toContainText('measured');
});

test('measuring an edge records it without selecting it', async ({ page }) => {
  await createBox(page, 'Measure Edge');

  await switchWorkspace(page, 'View');
  await armMeasure(page);
  // Narrow to edges: a face is under the pointer too, and Smart mode would
  // happily measure that instead.
  await setSelectionFilter(page, 'Edge');

  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);

  const workbench = page.getByLabel('Measurement workbench');
  await expect(workbench.getByRole('listitem')).toHaveCount(1);
  await expect(workbench.getByRole('listitem')).toContainText('mm');
  // The running edge set is the measure tool's own state now, so recording a
  // length leaves the workspace selection empty.
  await expect(
    page.locator('.selection-readout .selection-callout-name')
  ).toBeHidden();

  await switchWorkspace(page, 'Build');
  await expect(
    page.locator('.selection-readout .selection-callout-name')
  ).toBeHidden();
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

  // Measure off closes the workbench — the result stays pinned on the model
  // — instead of leaving it open to say only that Measure is off; Measure on
  // brings the list back.
  await armMeasure(page);
  await expect(workbench).toHaveCount(0);
  await armMeasure(page);
  await expect(workbench.getByRole('listitem')).toHaveCount(1);
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
  await setSelectionFilter(page, 'Edge');

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

test('a Distance pick records the point its snap glyph names', async ({
  page
}) => {
  // QA15-2E-01: the glyph read "Endpoint" while the pick was recorded as the
  // edge's midpoint, so a corner-to-corner distance came out 57.31 for 56.
  // Whatever kind the glyph names, the first pick's label must name the same.
  // Where the located point lands decides which kind that is; the
  // deterministic Endpoint regression is `test/measure-snap-pick.test.ts`.
  await createBox(page, 'Measure Snap Pick');

  await switchWorkspace(page, 'View');
  await armMeasure(page);
  await page
    .getByLabel('Measurement workbench')
    .getByRole('button', { name: 'Distance' })
    .click();
  await setSelectionFilter(page, 'Edge');

  const edge = await locateEdge(page);
  await page.mouse.move(edge.x - 60, edge.y - 60);
  await page.mouse.move(edge.x, edge.y);
  const glyph = page.locator('.snap-glyph');
  await expect(glyph).toBeVisible();
  const kind = (await glyph.textContent())?.trim();
  const named: Record<string, RegExp> = {
    Endpoint: / (start|end) selected · pick the second target/,
    Midpoint: / midpoint selected · pick the second target/,
    Center: / center selected · pick the second target/
  };
  expect(Object.keys(named)).toContain(kind);

  await page.mouse.click(edge.x, edge.y);
  await expect(
    page
      .getByRole('group', { name: 'Workspace status' })
      .getByText(named[kind!]!)
  ).toBeVisible();
});

test(
  'a measurement survives a reload',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    // The whole promise of persisting them. Measurements belong to the project,
    // not to the tab: someone who measures a part, closes the laptop and comes
    // back to check a figure should find it.
    //
    // They are stored in their own per-project IndexedDB record rather than in
    // the document, because anything written into a ProjectDocument that no user
    // typed makes an untouched project read `diverged` and invalidates the exact
    // rebuild cache.
    await createBox(page, 'Measure Durability');

    await switchWorkspace(page, 'View');
    await armMeasure(page);
    await setSelectionFilter(page, 'Edge');

    const edge = await locateEdge(page);
    await page.mouse.click(edge.x, edge.y);

    const workbench = page.getByLabel('Measurement workbench');
    await expect(workbench.getByRole('listitem')).toHaveCount(1);
    const recorded = await workbench.getByRole('listitem').textContent();
    expect(recorded).toBeTruthy();

    // The write is debounced, so give it the chance the app gives it.
    await page.waitForTimeout(700);
    await page.reload();

    // Back in View mode with the measurement still listed. Measure has to be
    // re-armed — that is session state, and arming a tool is not a measurement.
    await switchWorkspace(page, 'View');
    await armMeasure(page);
    await expect(
      page.getByLabel('Measurement workbench').getByRole('listitem')
    ).toHaveCount(1);
    await expect(
      page.getByLabel('Measurement workbench').getByRole('listitem')
    ).toHaveText(recorded!);
  }
);

test('measurements stay with their own project across a switch', async ({
  page
}) => {
  await createBox(page, 'Measured First Project');
  await switchWorkspace(page, 'View');
  await armMeasure(page);
  await setSelectionFilter(page, 'Edge');
  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);

  const firstWorkbench = page.getByLabel('Measurement workbench');
  const recorded = await firstWorkbench.getByRole('listitem').textContent();
  expect(recorded).toBeTruthy();
  await page.waitForTimeout(700);

  await page.getByTitle('Back to projects').click();
  await page.getByLabel('Project name').fill('Unmeasured Second Project');
  await page.getByRole('button', { name: 'New project' }).click();
  await switchWorkspace(page, 'View');
  await armMeasure(page);
  await expect(
    page.getByLabel('Measurement workbench').getByRole('listitem')
  ).toHaveCount(0);

  await page.getByTitle('Back to projects').click();
  await page
    .locator('.start-tile-open', { hasText: 'Measured First Project' })
    .click();
  await switchWorkspace(page, 'View');
  await armMeasure(page);
  await expect(
    page.getByLabel('Measurement workbench').getByRole('listitem')
  ).toHaveText(recorded!);
});

/**
 * M13: a Distance pick can ask for a point kind. Asked for midpoints, each
 * edge pick records that edge's midpoint whatever end the pointer was
 * nearer, the glyph offers midpoints only, and the distance lands between
 * the two midpoints.
 */
test(
  'a Distance pick asked for midpoints records each edge midpoint',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await createBox(page, 'Measure Point Kind');

    await switchWorkspace(page, 'View');
    await armMeasure(page);
    const workbench = page.getByLabel('Measurement workbench');
    await workbench.getByRole('button', { name: 'Distance' }).click();
    const kinds = workbench.getByRole('group', { name: 'Point to pick' });
    await kinds.getByRole('button', { name: 'Midpoint' }).click();
    await expect(
      kinds.getByRole('button', { name: 'Midpoint' })
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(workbench).toContainText('Each records its midpoint.');
    await setSelectionFilter(page, 'Edge');

    const status = page.getByRole('group', { name: 'Workspace status' });
    const first = await locateEdge(page);
    await page.mouse.move(first.x - 60, first.y - 60);
    await page.mouse.move(first.x, first.y);
    // Whatever glyph shows is a midpoint: the others are not offered.
    const glyph = page.locator('.snap-glyph');
    if (await glyph.isVisible()) await expect(glyph).toHaveText('Midpoint');
    await page.mouse.click(first.x, first.y);
    await expect(
      status.getByText(/ midpoint selected · pick the second target/)
    ).toBeVisible();

    const second = await locateEdge(page, { exclude: [first.topologyId] });
    await page.mouse.move(second.x, second.y);
    await page.mouse.click(second.x, second.y);
    await expect(workbench.getByRole('listitem')).toHaveCount(1);
    await expect(workbench.getByRole('listitem')).toContainText('midpoint');

    // Back on Auto, the dock says what Distance does by default.
    await kinds.getByRole('button', { name: 'Auto' }).click();
    await expect(workbench).toContainText(
      'Pick two targets. Circles and cylinders use their exact centers.'
    );
  }
);
