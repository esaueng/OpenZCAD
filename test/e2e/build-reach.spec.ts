import { expect, test, type Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  locateEdge,
  promptField,
  setSelectionFilter,
  stubApi,
  MODEL_ONLY,
  finishInPlaceCommand
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
  size: { width: string; depth: string; height: string },
  corner?: { x: string }
) {
  await createPrimitiveInPlace(page, 'box', {
    sizes: size,
    ...(corner ? { at: corner } : {})
  });
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
  const boxBar = page.getByRole('group', { name: 'Box command' });
  await expect(boxBar).toBeVisible();
  await expect(workbench).toHaveCount(0);
  await expect(measure).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(boxBar).toHaveCount(0);

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
  // Fitting only the vertical field of view cut a long body off at the
  // sides of a narrow canvas. Use the closed phone workspace so a panel in
  // the phone lane and the command fold do not cover the primitive form's
  // controls.
  await page.setViewportSize({ width: 390, height: 844 });
  await createProject(page, 'Auto Frame Phone', {
    panelLayout: MODEL_ONLY,
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

  // Position composes the primitive and its Place move into one commit.
  // The new body must be framed at its placed position, not at the origin.
  await addBox(page, { width: '10', depth: '10', height: '10' }, { x: '400' });
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '4'
  );
  await expect
    .poll(() => bodiesInView(page), {
      message: 'the placed box should be brought into view',
      timeout: 15_000
    })
    .toBe(true);
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
  await expect(page.locator('.model-panel .feature-row')).toHaveCount(17, {
    timeout: 60_000
  });
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 60_000 }
  );

  // U09 phase 7: the row re-arms the fillet in place; its edges are listed
  // by name under the bar's Options, where one can be taken off.
  const row = page.locator('.feature-row-main', {
    hasText: 'Wall top edge break'
  });
  await row.click();
  const bar = page.getByRole('group', {
    name: 'Edit Wall top edge break command'
  });
  await expect(bar).toContainText('2 edges');
  await bar.locator('summary').click();
  const edges = bar.getByRole('list', { name: 'Filleted edges' });
  // Each row is owned as the viewport tag names it: "<body> · Back · Top edge".
  await expect(edges.getByRole('listitem')).toHaveText([
    /^1\s*\S.* · Back · Top edge/,
    /^2\s*\S.* · Top · Front edge/
  ]);
  // History lights the two stored blend faces as focus, separately from a
  // selection-first operation's live blend preview; the body is not lit whole.
  await expect(canvas).not.toHaveAttribute('data-e2e-selected-bodies', /.+/);
  await expect(canvas).toHaveAttribute('data-e2e-focus-faces', '2');
  await expect(canvas).not.toHaveAttribute('data-e2e-preview-blend-count');

  // Taking one off previews the blend without it.
  await bar
    .getByRole('button', { name: /^Remove 2 \S.* · Top · Front edge$/ })
    .click();
  await expect(edges.getByRole('listitem')).toHaveCount(1);
  await expect(bar).toContainText('1 edge');
  await expect(canvas).not.toHaveAttribute('data-e2e-preview-blend-count');
  // The last edge cannot be removed: a fillet needs one.
  await expect(
    bar.getByRole('button', { name: /^Remove 1 \S.* · Back · Top edge$/ })
  ).toBeDisabled();
  await bar.locator('summary').click();

  // Done patches the feature. Re-arming reads the stored one-edge set from
  // the new document version and lights its one blend.
  await finishInPlaceCommand(page, 'Edit Wall top edge break');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Edited Wall top edge break',
    { timeout: 60_000 }
  );
  await row.click();
  await expect(bar).toContainText('1 edge');
  await bar.locator('summary').click();
  await expect(edges.getByRole('listitem')).toHaveText([
    /^1\s*\S.* · Back · Top edge/
  ]);
  await expect(canvas).toHaveAttribute('data-e2e-focus-faces', '1');
  await expect(canvas).not.toHaveAttribute('data-e2e-preview-blend-count');
});
