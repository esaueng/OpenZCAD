import { expect, test, type Page } from '@playwright/test';
import {
  locateEdge,
  promptField,
  setSelectionFilter,
  stubApi
} from './openzcad-fixtures';

/**
 * Design review, 1 October 2026 — Build-mode reach (F13, F29, F30).
 *
 * Measure lived only on View mode's rail; the bracket's second box was made
 * half off screen and left there; and an opened fillet said "2 exact edges
 * selected" over a wholly tinted body, with no way to see or drop one edge.
 */

async function createProject(
  page: Page,
  name: string,
  options: Parameters<typeof stubApi>[1] = {}
) {
  await stubApi(page, options);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
}

async function addBox(
  page: Page,
  size: { width: string; depth: string; height: string }
) {
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Width (X)').fill(size.width);
  await inspector.getByLabel('Depth (Y)').fill(size.depth);
  await inspector.getByLabel('Height (Z)').fill(size.height);
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(inspector).toHaveCount(0);
}

/**
 * Whether every drawn body is wholly inside the canvas through the live
 * camera, and where that camera stands.
 */
function viewState(page: Page) {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<{ inView: boolean; camera: number[] }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-bodies-in-view', {
            detail: { resolve }
          })
        );
      })
  );
}

async function bodiesInView(page: Page) {
  return (await viewState(page)).inView;
}

/** The camera position once it has stopped moving between two reads. */
async function restingCamera(page: Page) {
  let last: number[] = [];
  await expect
    .poll(async () => {
      const { camera } = await viewState(page);
      const still =
        last.length === 3 &&
        camera.every((value, index) => Math.abs(value - last[index]!) < 1e-6);
      last = camera;
      return still;
    })
    .toBe(true);
  return last;
}

test('F13: Measure is on Build’s instrument rail and in the palette, and yields to a command', async ({
  page
}) => {
  await createProject(page, 'Build Measure');
  await addBox(page, { width: '30', depth: '18', height: '24' });
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  const viewerBar = page.getByRole('toolbar', { name: 'Viewer bar' });
  const measure = viewerBar.getByRole('button', { name: 'Measure' });
  await measure.click();
  await expect(measure).toHaveAttribute('aria-pressed', 'true');
  // The same workbench View mode opens, as the command card of the moment.
  const workbench = page.getByLabel('Measurement workbench');
  await expect(page.locator('.command-float .measurement-dock')).toBeVisible();

  // A pick measures; it does not select or arm a handle.
  await setSelectionFilter(page, 'Edge');
  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);
  await expect(workbench.getByRole('listitem')).toHaveCount(1);
  await expect(page.locator('.selection-callout-chip')).toHaveCount(0);

  // Starting a command ends the measure session: the two never stack.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toBeVisible();
  await expect(workbench).toHaveCount(0);
  await expect(measure).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toHaveCount(0);

  // The palette reaches it by name, and Escape puts it away again.
  await promptField(page).fill('/measure');
  await page
    .getByRole('option')
    .filter({ hasText: /^Measure/ })
    .first()
    .click();
  await expect(workbench).toBeVisible();
  await expect(workbench.getByRole('listitem')).toHaveCount(1);
  // Escape from the workspace, not from the prompt line the run came from.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('Escape');
  await expect(workbench).toHaveCount(0);
  await expect(measure).toHaveAttribute('aria-pressed', 'false');
});

test('F13: the instrument rail with Measure stays inside a short window', async ({
  page
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await createProject(page, 'Short Measure Rail');
  await addBox(page, { width: '30', depth: '18', height: '24' });
  // One column of both islands no longer fits from here down; the rail
  // stands two islands wide instead of running to the window's edge.
  await page.setViewportSize({ width: 1280, height: 505 });
  const islands = [
    page.getByRole('toolbar', { name: 'Viewer bar' }),
    page.getByRole('toolbar', { name: 'Model panels' })
  ];
  for (const island of islands) {
    await expect
      .poll(async () => {
        const box = await island.boundingBox();
        return box !== null && box.y >= 0 && box.y + box.height <= 505 - 4;
      })
      .toBe(true);
  }
  const measure = islands[0]!.getByRole('button', { name: 'Measure' });
  await measure.click();
  await expect(page.getByLabel('Measurement workbench')).toBeVisible();
});

test('F29: on a portrait phone a wide body is framed across the width too', async ({
  page
}) => {
  // Fitting the vertical field of view alone left a long body cut off at the
  // sides of a narrow canvas, glide or not.
  await page.setViewportSize({ width: 390, height: 844 });
  // A phone has no room for the drawer or the open fold beside the rail.
  await createProject(page, 'Auto Frame Phone', {
    modelDrawer: false,
    commandFoldClosed: true
  });
  await addBox(page, { width: '10', depth: '10', height: '10' });
  await expect.poll(() => bodiesInView(page)).toBe(true);
  await addBox(page, { width: '160', depth: '5', height: '5' });
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '2'
  );
  await expect
    .poll(() => bodiesInView(page), {
      message: 'the long bar should be framed across the narrow canvas',
      timeout: 15_000
    })
    .toBe(true);
});

test('F29: a body created off screen is framed, one already in view is not', async ({
  page
}) => {
  await createProject(page, 'Auto Frame');
  // The camera frames the first body and then stayed put: a later body
  // larger than that frame — the bracket's 80 × 5 × 40 flange beside a
  // small first part — was made half off screen and left there.
  await addBox(page, { width: '10', depth: '10', height: '10' });
  await expect.poll(() => bodiesInView(page)).toBe(true);
  await addBox(page, { width: '80', depth: '5', height: '40' });
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '2'
  );
  await expect
    .poll(() => bodiesInView(page), {
      message: 'the flange should be brought into view',
      timeout: 15_000
    })
    .toBe(true);

  // A third body inside what is already framed leaves the camera alone.
  const framed = await restingCamera(page);
  await addBox(page, { width: '5', depth: '5', height: '5' });
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '3'
  );
  await expect.poll(() => bodiesInView(page)).toBe(true);
  const rested = await restingCamera(page);
  rested.forEach((value, index) =>
    expect(value).toBeCloseTo(framed[index]!, 6)
  );
});

test('F30: an opened fillet lists its edges by name, lights them, and drops one', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.sidebar .feature-row')).toHaveCount(17, {
    timeout: 60_000
  });
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 60_000 }
  );

  await page
    .locator('.feature-row-main', { hasText: 'Wall top edge break' })
    .click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  const edges = inspector.getByRole('list', { name: 'Filleted edges' });
  await expect(inspector.locator('.selection-summary')).toContainText(
    '2 exact edges selected'
  );
  await expect(edges.getByRole('listitem')).toHaveText([
    /^1\s*Back · Top edge/,
    /^2\s*Top · Front edge/
  ]);
  // The two blend faces are lit; the body is not selected whole.
  await expect(canvas).not.toHaveAttribute('data-e2e-selected-bodies', /.+/);
  await expect(canvas).toHaveAttribute('data-e2e-preview-blend-count', '2');

  // Taking one off previews the blend without it, and the light follows.
  await inspector
    .getByRole('button', { name: 'Remove 2 Top · Front edge' })
    .click();
  await expect(edges.getByRole('listitem')).toHaveCount(1);
  await expect(inspector.locator('.selection-summary')).toContainText(
    '1 exact edge selected'
  );
  await expect(canvas).toHaveAttribute('data-e2e-preview-blend-count', '1', {
    timeout: 30_000
  });
  // The last edge cannot be removed: a fillet needs one.
  await expect(
    inspector.getByRole('button', { name: 'Remove 1 Back · Top edge' })
  ).toBeDisabled();

  // Applied, the stored set is the one edge: the card, reseeded from the
  // new document version, lists it and the light stays on its one blend.
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Wall top edge break applied.',
    { timeout: 60_000 }
  );
  await expect(edges.getByRole('listitem')).toHaveText([
    /^1\s*Back · Top edge/
  ]);
  await expect(canvas).toHaveAttribute('data-e2e-preview-blend-count', '1');
});
