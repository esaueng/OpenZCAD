import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  waitForStillViewport
} from './openzcad-fixtures';

/*
  A picked region's Extrude card opens at the head of the right lane, which
  stands over the stage's right third. A production review at 1512 x 861
  found the card drawn straight over the region it edits: the arrow at the
  card's left edge and the preview behind it. The view now glides sideways
  until the region and its arrow are in the stage the panels leave clear.
*/

/** Serves `document` as the project the start screen's Create returns. */
async function openDocument(page: Page, document: ProjectDocument) {
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            project: {
              projectId: document.projectId,
              name: document.name,
              revisionCount: 1,
              updatedAt: new Date().toISOString()
            },
            document
          }
        })
      : route.fulfill({ json: { projects: [] } })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
}

/** Where `point` is drawn, in page pixels. */
async function projected(
  canvas: Locator,
  point: [number, number, number]
): Promise<{ x: number; y: number }> {
  return canvas.evaluate(
    (element, points) =>
      new Promise<{ x: number; y: number }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points[0]!)
            }
          })
        );
      }),
    [point]
  );
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 1512, height: 861 }
]) {
  test(`a picked region and its arrow stay clear of the Extrude card at ${size.width}x${size.height}`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    // The default layout: the right dock open, as on a first visit.
    await stubApi(page);
    await page.setViewportSize(size);
    let project = createProjectDocument(
      'Region beside the card',
      toUserId('user_e2e')
    );
    project = addPrimitiveFeature(project, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 120, height: 60, depth: 10 }
    });
    // A disk on the top face, at the plate's far end: on the stage's right,
    // where the card opens.
    const centroid: [number, number, number] = [105, 30, 10];
    project = addSketchFeature(project, {
      name: 'Boss',
      plane: 'XY',
      offset: 10,
      objects: [{ objectKind: 'circle', radius: 8, centerX: 105, centerY: 30 }]
    }).document;
    await openDocument(page, project);
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
      timeout: 30_000
    });
    await waitForStillViewport(page);
    const before = await projected(canvas, centroid);

    await canvas.evaluate((element) =>
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-profile', {
          detail: { index: 0 }
        })
      )
    );
    const card = page.locator('.stage-right > .command-float');
    await expect(
      card.getByRole('region', { name: 'Extrude operation' })
    ).toBeVisible();
    await waitForStillViewport(page);
    const cardBox = (await card.boundingBox())!;
    const under = (x: number) =>
      x >= cardBox.x && x <= cardBox.x + cardBox.width;
    // Premise: the region opened where the card now stands.
    expect(under(before.x)).toBe(true);

    const after = await projected(canvas, centroid);
    expect(under(after.x)).toBe(false);
    expect(after.x).toBeLessThan(cardBox.x);
    const canvasBox = (await canvas.boundingBox())!;
    const handles = await canvas.evaluate(
      (element) =>
        JSON.parse(element.dataset.e2eRegionHandles ?? '[]') as {
          x: number;
          y: number;
        }[]
    );
    expect(handles).toHaveLength(1);
    const arrow = {
      x: canvasBox.x + handles[0]!.x,
      y: canvasBox.y + handles[0]!.y
    };
    expect(under(arrow.x)).toBe(false);
    // Nothing else is drawn over the arrow or the centroid either.
    for (const point of [arrow, after]) {
      expect(
        await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.tagName,
          point
        )
      ).toBe('CANVAS');
    }
    // The value chip reads beside the arrow, not under the card or the fold.
    const chip = page.getByTestId('direct-manipulation-value');
    await expect(chip).toBeVisible();
    const chipBox = (await chip.boundingBox())!;
    expect(chipBox.x + chipBox.width).toBeLessThan(cardBox.x);
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest('[data-testid="direct-manipulation-value"]') !== null,
        { x: chipBox.x + chipBox.width / 2, y: chipBox.y + chipBox.height / 2 }
      )
    ).toBe(true);
    // A value change keeps the view where the pick put it.
    const distance = card.getByRole('textbox', {
      name: 'Distance',
      exact: true
    });
    await distance.fill('5');
    await distance.press('Tab');
    await waitForStillViewport(page);
    const typed = await projected(canvas, centroid);
    expect(Math.abs(typed.x - after.x)).toBeLessThan(1);
  });
}
