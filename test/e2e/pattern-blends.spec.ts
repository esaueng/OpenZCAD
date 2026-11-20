import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
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
  expectBodyCount,
  finishInPlaceCommand,
  MODEL_ONLY,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M02 patterns of fillets, with U11's pick-and-drag interaction: a Linear
 * pattern set to Repeat Features takes a boss from a click on its top and
 * the fillet that rounds its corners from a click on one rounded corner,
 * and its arrow drags the spacing. Every copy comes out rounded.
 */

const PLATE = { x: 100, y: 40, z: 10 };
const BOSS = { size: 10, height: 5 };
const RADIUS = 2;

/** The boss's top centre, where the plate's own placement puts it. */
interface BossTop {
  x: number;
  y: number;
  z: number;
}

/** A plate with a square boss whose four upright edges are rounded. */
async function filletedBoss(): Promise<{
  document: ProjectDocument;
  bossId: string;
  filletId: string;
  bossTop: BossTop;
}> {
  const plate = addPrimitiveFeature(
    createProjectDocument('Fillet pattern', toUserId('user_e2e')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: PLATE.x, height: PLATE.y, depth: PLATE.z }
    }
  );
  const plateId = plate.bodyOrder.at(-1)!;
  const adapter = await createExactKernelAdapter();
  const box = (await adapter.syncDocument(plate)).bodyRepresentations[plateId]!
    .bbox;
  const bossTop: BossTop = {
    x: box.min.x + 15,
    y: (box.min.y + box.max.y) / 2,
    z: box.max.z + BOSS.height
  };
  const sketched = addSketchFeature(plate, {
    name: 'Boss sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset: box.max.z },
    objects: [
      {
        objectKind: 'rectangle',
        width: BOSS.size,
        height: BOSS.size,
        centerX: bossTop.x,
        centerY: bossTop.y
      }
    ]
  });
  const bossed = extrudeSketch(sketched.document, {
    name: 'Boss',
    sketchId: sketched.sketchId,
    distance: BOSS.height,
    operation: 'add',
    targetBodyId: plateId
  }).document;
  const bossId = listFeaturesInOrder(bossed).at(-1)!.featureId;
  const derived = await adapter.syncDocument(bossed);
  adapter.dispose();
  const top = bossTop.z;
  const bossedId = bossed.bodyOrder.at(-1)!;
  const uprights = derived.bodyRepresentations[
    bossedId
  ]!.topology!.edges.filter((edge) => {
    const witness = edge.reference?.witness;
    if (!witness || witness.closed) return false;
    const [a, b] = witness.endpoints.map((point) => point[2] * 1e-6) as [
      number,
      number
    ];
    return (
      Math.abs(Math.min(a, b) - box.max.z) < 1e-5 &&
      Math.abs(Math.max(a, b) - top) < 1e-5
    );
  });
  expect(uprights).toHaveLength(4);
  const document = filletEdges(bossed, {
    name: 'Corner round',
    targetBodyId: bossedId,
    size: RADIUS,
    edgeHashes: uprights.map((edge) => edge.hash),
    edgeReferences: uprights.map((edge) => edge.reference!)
  }).document;
  return {
    document,
    bossId,
    filletId: listFeaturesInOrder(document).at(-1)!.featureId,
    bossTop
  };
}

async function openDocument(
  page: Page,
  document: ProjectDocument
): Promise<Locator> {
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
  return canvas;
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

function patterns(document: ProjectDocument): FeatureNode[] {
  return listFeaturesInOrder(document).filter(
    (feature) => feature.data.featureKind === 'pattern'
  );
}

/** Clicks the boss's top, the way the viewport's own pick reaches it. */
async function pickBossTop(canvas: Locator, near: BossTop): Promise<boolean> {
  return canvas.evaluate(
    (element, point) =>
      new Promise<boolean>((resolve) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: {
              normal: { x: 0, y: 0, z: 1 },
              near: point,
              select: true,
              resolve: (value: unknown) => resolve(value !== null)
            }
          })
        )
      ),
    near
  );
}

/** Clicks one of the boss's rounded corners. */
async function pickRoundedCorner(canvas: Locator): Promise<boolean> {
  return canvas.evaluate(
    (element, radius) =>
      new Promise<boolean>((resolve) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: {
              surface: 'wall',
              radius,
              resolve: (value: unknown) => resolve(value !== null)
            }
          })
        )
      ),
    RADIUS
  );
}

test(
  'a Linear pattern repeats a boss and the fillet that rounds it, picked and dragged',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const { document, bossId, filletId, bossTop } = await filletedBoss();
    const canvas = await openDocument(page, document);

    const bar = await startTool(page, /^Linear pattern/, 'Linear pattern');
    await bar.getByLabel('Linear pattern options').click();
    await bar.getByRole('radio', { name: 'Features' }).click();
    await bar.getByLabel('Linear pattern options').click();
    await expect
      .poll(() => pickBossTop(canvas, bossTop), { timeout: 30_000 })
      .toBe(true);
    await expect(bar).toContainText('tap a copy to skip it');
    await expect
      .poll(() => pickRoundedCorner(canvas), { timeout: 30_000 })
      .toBe(true);
    const done = bar.getByRole('button', { name: /Done/ });
    await expect(done).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByTestId('command-handle-instance:2')).toBeVisible();

    // Drag the spacing arrow from 20 out to about 25 along X.
    await waitForStillViewport(page);
    const grip = (await commandHandle(canvas, 'spacing'))!;
    expect(grip.value).toBe(20);
    const target = await projected(canvas, [
      bossTop.x + 25,
      bossTop.y,
      bossTop.z
    ]);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 16 });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandle(canvas, 'spacing'))?.value ?? 0)
      .toBeGreaterThan(22);
    await expect(done).toBeEnabled({ timeout: 60_000 });
    await finishInPlaceCommand(page, 'Linear pattern');
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).not.toContainText(
      /finds no edge|cannot repeat/
    );

    const saved = await exportedDocument(page);
    const [pattern] = patterns(saved);
    expect(pattern?.data).toMatchObject({ patternKind: 'linear', count: 3 });
    expect(
      pattern?.data.featureKind === 'pattern'
        ? [...(pattern.data.sourceFeatureIds ?? [])].sort()
        : []
    ).toEqual([bossId, filletId].sort());
  }
);
