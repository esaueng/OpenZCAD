import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  finishInPlaceCommand,
  MODEL_ONLY,
  pickPlanarFace,
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M01 holes on sketch points, with U11's pick-and-drag interaction: the
 * Hole tool takes the plate's top face, Position → Sketch points, then a
 * click on each point of the sketch drawn there; one drag on the diameter
 * handle sizes every bore. Nothing is typed.
 */

const PLATE = { x: 100, y: 40, z: 10 };

/** Points on the plate's top, where the bores go. */
const POINTS: [number, number][] = [
  [20, 10],
  [50, 30],
  [80, 10]
];

async function openPlate(
  page: Page
): Promise<{ canvas: Locator; pointIds: string[] }> {
  const plate = addPrimitiveFeature(
    createProjectDocument('Hole points', toUserId('user_e2e')),
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

async function startHole(page: Page): Promise<Locator> {
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: /^Hole/ }).click();
  const bar = page.getByRole('group', { name: 'Hole command' });
  await expect(bar).toBeVisible();
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

/** A command handle's ball on screen, and the value it stands at. */
async function commandHandle(
  canvas: Locator,
  valueId: string
): Promise<{ x: number; y: number; value: number } | null> {
  return canvas.evaluate(
    (element, id) =>
      element.dataset.e2eCommandHandles
        ? ((
            JSON.parse(element.dataset.e2eCommandHandles) as Record<
              string,
              { x: number; y: number; value: number }
            >
          )[id] ?? null)
        : null,
    valueId
  );
}

test(
  'a Hole on sketch points drills at each clicked point, sized by one drag',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const { canvas, pointIds } = await openPlate(page);

    const bar = await startHole(page);
    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }), {
        timeout: 60_000
      })
      .not.toBeNull();
    await bar.locator('summary').click();
    await bar.getByRole('radio', { name: 'Sketch points' }).click();
    await bar.locator('summary').click();
    await expect(bar).toContainText('Click the sketch points to drill at');

    // Every point of the sketch is offered, each a click where it is drawn.
    await expect(canvas).toHaveAttribute(
      'data-e2e-curve-picker',
      String(POINTS.length)
    );
    for (const [x, y] of POINTS) {
      await waitForStillViewport(page);
      const at = await projected(canvas, [x, y, PLATE.z]);
      await page.mouse.move(at.x, at.y);
      await page.mouse.click(at.x, at.y);
    }
    await expect(bar).toContainText('Click more points · drag the diameter');
    const done = bar.getByRole('button', { name: /Done/ });
    await expect(done).toBeEnabled({ timeout: 60_000 });

    // The diameter handle rides the first bore's rim: drag it out to about
    // a 5 mm radius, along the face away from the bore.
    await expect.poll(() => commandHandle(canvas, 'diameter')).not.toBeNull();
    const handle = (await commandHandle(canvas, 'diameter'))!;
    const centre = await projected(canvas, [...POINTS[0]!, PLATE.z]);
    const outward = {
      x: handle.x - centre.x,
      y: handle.y - centre.y
    };
    const reach = Math.hypot(outward.x, outward.y);
    expect(reach).toBeGreaterThan(2);
    // The ball stands at 3 mm (half the 6 mm default): 5/3 of the way out.
    const target = {
      x: centre.x + (outward.x * 5) / 3,
      y: centre.y + (outward.y * 5) / 3
    };
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 16 });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandle(canvas, 'diameter'))?.value ?? 0)
      .toBeGreaterThan(7.5);
    const dragged = (await commandHandle(canvas, 'diameter'))!.value;
    expect(dragged).toBeLessThan(12);
    await expect(done).toBeEnabled({ timeout: 60_000 });
    await finishInPlaceCommand(page, 'Hole');
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
      timeout: 30_000
    });

    const saved = await exportedDocument(page);
    const hole = listFeaturesInOrder(saved).find(
      (feature) => feature.data.featureKind === 'hole'
    );
    expect(hole?.data).toMatchObject({
      featureKind: 'hole',
      depthMode: 'through',
      points: { pointIds }
    });
    const diameter = (hole!.data as { diameter: number }).diameter;
    expect(diameter).toBeCloseTo(dragged, 6);
    await revealModelPanel(page, 'History');
    await expect(
      page.locator('.feature-row', { hasText: 'at 3 points' })
    ).toBeVisible();
  }
);
