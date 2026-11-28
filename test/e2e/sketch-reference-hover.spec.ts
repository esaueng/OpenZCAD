import type { Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  finishInPlaceCommand,
  pressTool,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * I01: while the sketch's Project tool waits for a model reference, the
 * pointer lights the model edge or face under it — the one a click would
 * project — and lights nothing over geometry the click refuses, such as
 * the sketch's own line. The viewer stamps what its hover lit on the canvas
 * (`data-e2e-hover-target`) under the e2e build.
 */

type Point = { x: number; y: number };

async function screenPoints(
  canvas: Locator,
  points: Point[]
): Promise<Point[]> {
  return canvas.evaluate(
    (element, project) =>
      new Promise<Point[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: {
              project,
              resolve: (state: { screen: Point[] } | null) =>
                resolve(state?.screen ?? [])
            }
          })
        );
      }),
    points
  );
}

const hoverTarget = (canvas: Locator) =>
  canvas.evaluate((element) => element.dataset.e2eHoverTarget ?? null);

/** The topology ids the viewport's edge overlay actually lights. */
const litEdges = (canvas: Locator) =>
  canvas.evaluate((element) =>
    element.dataset.e2eHoverEdges
      ? element.dataset.e2eHoverEdges.split(',')
      : []
  );

/**
 * Rests the pointer on each point in turn, long enough for the hover dwell
 * to settle, and returns the first hover the viewer reports as an edge.
 */
async function restUntilEdge(page: Page, canvas: Locator, points: Point[]) {
  for (const point of points) {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(120);
    const target = await hoverTarget(canvas);
    if (target?.startsWith('edge:')) return { target, point };
  }
  return null;
}

test(
  'Project lights the model edge it would take and not the sketch line it would refuse',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Reference hover');
    await page.getByRole('button', { name: 'New project' }).click();
    const canvas = page.locator('.viewer-host canvas');

    // A corner-origin box: x 0..20, y 0..10, z 0..5.
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '20', depth: '10', height: '5' }
    });
    await expectBodyCount(page, 1);

    await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
    await page.getByRole('button', { name: 'Top (XY)' }).click();
    const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
    await expect(rail).toBeVisible();
    await waitForStillViewport(page);

    // A sketch line clear of the box: sketch geometry, never a reference.
    const [lineStart, lineEnd, lineMid] = await screenPoints(canvas, [
      { x: 26, y: 1 },
      { x: 26, y: 9 },
      { x: 26, y: 5 }
    ]);
    await rail.getByRole('button', { name: /^Line/ }).click();
    await page.mouse.click(lineStart!.x, lineStart!.y);
    await page.mouse.click(lineEnd!.x, lineEnd!.y);
    await page.keyboard.press('Escape');

    // U arms Project.
    await page.keyboard.press('u');
    await expect(
      rail
        .getByRole('radiogroup', { name: 'Projection link' })
        .getByRole('radio', { name: 'Linked', exact: true })
    ).toBeChecked();

    // Sweep across the box's front edge (y = 0) from inside the top face.
    const sweep = await screenPoints(
      canvas,
      Array.from({ length: 33 }, (_, index) => ({
        x: 10,
        y: 1.6 - index * 0.1
      }))
    );
    const lit = await restUntilEdge(page, canvas, sweep);
    expect(lit?.target, 'a model edge under the pointer is lit').toMatch(
      /^edge:./
    );
    const edgePoint = lit!.point;

    // Over the sketch's own line, nothing is lit, and the canvas keeps no
    // stale highlight from the edge.
    await page.mouse.move(lineMid!.x, lineMid!.y);
    await expect.poll(() => hoverTarget(canvas)).toBeNull();
    await page.waitForTimeout(200);
    expect(await hoverTarget(canvas)).toBeNull();

    // Back on the face the hover returns; switching to Line by key, with
    // the pointer still resting there, drops it.
    const [faceCenter] = await screenPoints(canvas, [{ x: 10, y: 5 }]);
    await page.mouse.move(faceCenter!.x, faceCenter!.y);
    await expect.poll(() => hoverTarget(canvas)).toMatch(/^(face|edge):./);
    await page.keyboard.press('l');
    await expect(
      rail.getByRole('button', { name: 'Project edges', exact: true })
    ).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => hoverTarget(canvas)).toBeNull();

    // A hover changed nothing: the sketch still holds only the drawn line.
    const status = page.getByRole('contentinfo');
    await expect(status).not.toContainText('Projected');

    // Project that edge, then arm Re-pick source on the projected line. A
    // re-pick takes exactly one edge, so the top face — four boundary
    // edges — is refused and gets no highlight, while an edge still lights.
    await page.keyboard.press('u');
    await page.mouse.click(edgePoint.x, edgePoint.y);
    await expect(status).toContainText('Projected 1 linked edge.', {
      timeout: 30_000
    });
    // The sketch now follows that edge, so linked Project would refuse it
    // and it no longer lights; the face, with three edges left, still does.
    await page.mouse.move(faceCenter!.x, faceCenter!.y);
    await expect.poll(() => hoverTarget(canvas)).toMatch(/^face:./);
    await page.mouse.move(edgePoint.x, edgePoint.y);
    await expect.poll(() => hoverTarget(canvas)).toBeNull();
    await page.waitForTimeout(200);
    expect(await hoverTarget(canvas)).toBeNull();
    await rail.getByRole('button', { name: 'Select', exact: true }).click();
    const [projectedMid] = await screenPoints(canvas, [{ x: 10, y: 0 }]);
    await page.mouse.click(projectedMid!.x, projectedMid!.y);
    const repick = page.getByRole('button', { name: 'Re-pick source' });
    await expect(repick).toBeVisible();
    await repick.click();
    await expect(status).toContainText(
      'Click the model edge that should replace this projection'
    );
    await expect(
      rail.getByRole('button', { name: 'Project edges', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(faceCenter!.x, faceCenter!.y);
    await page.waitForTimeout(300);
    expect(await hoverTarget(canvas)).toBeNull();
    const relit = await restUntilEdge(page, canvas, sweep);
    expect(relit?.target, 'an edge still lights under a re-pick').toMatch(
      /^edge:./
    );
  }
);

test(
  'Project lights the one edge of a smooth run it would take, not the run',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Reference hover run');
    await page.getByRole('button', { name: 'New project' }).click();
    const canvas = page.locator('.viewer-host canvas');

    // Rounding every edge of a box makes each face boundary a smooth run
    // of lines and arcs, which plain hover lights as a whole.
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '20', depth: '10', height: '5' }
    });
    await expectBodyCount(page, 1);
    await pressTool(page, /^Fillet/);
    const filletBar = page.getByRole('group', { name: 'Fillet command' });
    await filletBar.locator('summary').click();
    await filletBar
      .getByRole('button', { name: 'Select all 12 edges' })
      .click();
    await filletBar.locator('summary').click();
    await finishInPlaceCommand(page, 'Fillet');
    await expect(
      page.locator('.feature-row', { hasText: 'Fillet' })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.inspector-float > *')).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).not.toContainText(
      /Preparing model|Rebuilding exact geometry|Waiting for exact geometry|Rebuilding geometry|Exact geometry is still rebuilding/i,
      { timeout: 30_000 }
    );

    await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
    await page.getByRole('button', { name: 'Top (XY)' }).click();
    const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
    await expect(rail).toBeVisible();
    await waitForStillViewport(page);
    await page.keyboard.press('u');

    // Across the front of the rounded top: every edge met lights alone,
    // the one Project would take, and never the run it continues into.
    const sweep = await screenPoints(
      canvas,
      Array.from({ length: 41 }, (_, index) => ({
        x: 10,
        y: 2 - index * 0.1
      }))
    );
    let edgesLit = 0;
    for (const point of sweep) {
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(120);
      const target = await hoverTarget(canvas);
      if (!target?.startsWith('edge:')) continue;
      edgesLit += 1;
      expect(await litEdges(canvas)).toEqual([target.slice('edge:'.length)]);
    }
    expect(edgesLit, 'the sweep crossed a rounded edge').toBeGreaterThan(0);
  }
);
