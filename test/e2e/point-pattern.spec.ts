import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  enterCommandValue,
  expectBodyCount,
  finishInPlaceCommand,
  MODEL_ONLY,
  pickPlanarFace,
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M02 patterns on sketch points, with U11's pick-and-drag interaction: a
 * Point pattern set to Repeat Features takes the hole a click on its bore
 * names, then clicks on a sketch's points; the original stays on the point
 * it stands on, every other clicked point takes a copy, and a copy's chip
 * skips it. Beyond the hole's own diameter, nothing is typed.
 */

const PLATE = { x: 100, y: 40, z: 10 };

/** The plate's top: the original's point, then the two to repeat at. */
const POINTS: [number, number][] = [
  [PLATE.x / 2, PLATE.y / 2],
  [20, 10],
  [80, 30]
];

async function openPlate(
  page: Page
): Promise<{ canvas: Locator; pointIds: string[] }> {
  const plate = addPrimitiveFeature(
    createProjectDocument('Point pattern', toUserId('user_e2e')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: PLATE.x, height: PLATE.y, depth: PLATE.z }
    }
  );
  const sketched = addSketchFeature(plate, {
    name: 'Points',
    planeRef: { type: 'canonical', plane: 'XY', offset: PLATE.z },
    objects: POINTS.map(([x, y]) => ({ objectKind: 'point' as const, x, y }))
  });
  const document: ProjectDocument = sketched.document;
  const pointIds = findSketch(document, sketched.sketchId)!.objectIds.map(
    String
  );
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  return { canvas, pointIds };
}

async function startTool(page: Page, tool: RegExp, title: string) {
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: tool }).click();
  const bar = page.getByRole('group', { name: `${title} command` });
  await expect(bar).toBeVisible();
  // Folded again, so it stands over nothing a later click aims at.
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  return bar;
}

async function exportedDocument(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download', { timeout: 15_000 });
  await menu.getByRole('button', { name: /Export project/ }).click();
  const download = await pending;
  if ((await menu.getAttribute('open')) !== null) {
    await menu.locator('summary').click();
  }
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
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

/** Clicks the hole's bore, the way the viewport's own pick reaches it. */
async function pickBore(canvas: Locator): Promise<boolean> {
  return canvas.evaluate(
    (element) =>
      new Promise<boolean>((resolve) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: {
              surface: 'wall',
              resolve: (value: unknown) => resolve(value !== null)
            }
          })
        )
      )
  );
}

function patterns(document: ProjectDocument): FeatureNode[] {
  return listFeaturesInOrder(document).filter(
    (feature) => feature.data.featureKind === 'pattern'
  );
}

test(
  'a Point pattern repeats a hole at clicked sketch points and skips one by its chip',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const { canvas, pointIds } = await openPlate(page);

    // The hole, at the middle of the top face: on the first point.
    const hole = await startTool(page, /^Hole/, 'Hole');
    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }), {
        timeout: 60_000
      })
      .not.toBeNull();
    await expect(hole).toContainText('drag the diameter');
    await enterCommandValue(page, 'diameter', '6');
    await finishInPlaceCommand(page, 'Hole');
    await expectBodyCount(page, 1);
    await waitForStillViewport(page);

    const bar = await startTool(page, /^Point pattern/, 'Point pattern');
    await bar.locator('summary').click();
    await bar.getByRole('radio', { name: 'Features' }).click();
    await bar.locator('summary').click();
    await expect(bar).toContainText('Click a hole, boss or cut to repeat');
    await expect.poll(() => pickBore(canvas), { timeout: 30_000 }).toBe(true);
    await expect(bar).toContainText('Click the sketch points to repeat at');

    // Every point of the sketch is offered, each a click where it is drawn.
    await expect(canvas).toHaveAttribute(
      'data-e2e-curve-picker',
      String(POINTS.length)
    );
    for (const [x, y] of POINTS.slice(1)) {
      await waitForStillViewport(page);
      const at = await projected(canvas, [x, y, PLATE.z]);
      await page.mouse.move(at.x, at.y);
      await page.mouse.click(at.x, at.y);
    }
    await expect(bar).toContainText('tap a copy to skip it');
    const done = bar.getByRole('button', { name: /Done/ });
    await expect(done).toBeEnabled({ timeout: 60_000 });
    const [reference, first, second] = pointIds as [string, string, string];
    await expect(
      page.getByTestId(`command-handle-instance:${first}`)
    ).toBeVisible();
    // UX-008: each copy reads and is announced by its pick order, not by
    // the sketch point's `ent_<uuid>` id, which stays its skip key (the
    // test ids above, and `skippedInstances` below).
    await expect(
      page.getByTestId(`command-handle-instance:${first}`)
    ).toHaveText('Point 1');
    await expect(
      page.getByRole('button', { name: 'Copy at Point 2 · skip it' })
    ).toBeVisible();
    await expect(
      page.locator('.handle-instance-chip', { hasText: /ent_/ })
    ).toHaveCount(0);
    const chip = page.getByTestId(`command-handle-instance:${second}`);
    await chip.click();
    await expect(
      page.getByTestId(`command-handle-instance:${second}`)
    ).toHaveAttribute('aria-pressed', 'false');
    await expect(done).toBeEnabled({ timeout: 60_000 });
    await finishInPlaceCommand(page, 'Point pattern');
    await expectBodyCount(page, 1);

    const saved = await exportedDocument(page);
    const holeFeature = listFeaturesInOrder(saved).find(
      (feature) => feature.data.featureKind === 'hole'
    )!;
    const [pattern] = patterns(saved);
    expect(pattern?.data).toMatchObject({
      patternKind: 'points',
      sourceFeatureIds: [holeFeature.featureId],
      points: {
        pointIds: [reference, first, second],
        referencePointId: reference
      },
      skippedInstances: [second]
    });
    await revealModelPanel(page, 'History');
    await expect(
      page.locator('.feature-row', { hasText: '1 skipped' })
    ).toBeVisible();
  }
);
