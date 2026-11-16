import {
  addPrimitiveFeature,
  createProjectDocument,
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
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M01 cosmetic threads and D02 callouts, with U11's pick-and-drag
 * interaction: the Hole tool takes the block's top face where it is
 * clicked, Options choose ISO metric, M6, Tap drill, Tapped and a Cosmetic
 * thread form, and the thread's arrow is dragged short of the blind bore.
 * In Draw, a diameter picked on the bore's rim in the top view calls the
 * thread out. Nothing is typed.
 */

const BLOCK = { x: 40, y: 30, z: 20 };
const ENTRY: [number, number, number] = [20, 15, BLOCK.z];

async function openBlock(page: Page): Promise<Locator> {
  const document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument('Hole callout', toUserId('user_e2e')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: BLOCK.x, height: BLOCK.y, depth: BLOCK.z }
    }
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
  return canvas;
}

/** Clicks the block's top face at the middle, as the viewport's pick does. */
async function pickTop(canvas: Locator): Promise<boolean> {
  return canvas.evaluate(
    (element, point) =>
      new Promise<boolean>((resolve) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: {
              normal: { x: 0, y: 0, z: 1 },
              point: { x: point[0], y: point[1], z: point[2] },
              select: true,
              resolve: (selection: unknown) => resolve(selection !== null)
            }
          })
        )
      ),
    ENTRY
  );
}

/** Choose an Options choice, shown as segments or, when crowded, a menu. */
async function choose(bar: Locator, label: string, choice: string) {
  const segments = bar.getByRole('radiogroup', { name: label });
  if ((await segments.count()) > 0) {
    await segments.getByRole('radio', { name: choice, exact: true }).click();
    return;
  }
  await bar
    .getByRole('combobox', { name: label })
    .selectOption({ label: choice });
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

function mode(page: Page, name: 'Build' | 'Draw') {
  return page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name, exact: true });
}

test(
  'a cosmetic M6 thread, dragged short, is called out on a drawing',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const canvas = await openBlock(page);

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
    await expect.poll(() => pickTop(canvas), { timeout: 60_000 }).toBe(true);

    await bar.locator('summary').click();
    await choose(bar, 'Depth', 'Blind');
    await choose(bar, 'Standard', 'ISO metric');
    await choose(bar, 'Screw', 'M6');
    await choose(bar, 'For', 'Tap drill');
    await choose(bar, 'Thread', 'Tapped');
    await choose(bar, 'Thread form', 'Cosmetic');
    await bar.locator('summary').click();

    // Drag the thread's arrow up the bore by four of the depth arrow's
    // tenths: about 6 of the bore's 10 mm.
    await expect.poll(() => commandHandle(canvas, 'tapLength')).not.toBeNull();
    const depth = (await commandHandle(canvas, 'depth'))!;
    const thread = (await commandHandle(canvas, 'tapLength'))!;
    const entry = await projected(canvas, ENTRY);
    const perMm = {
      x: (depth.x - entry.x) / 10,
      y: (depth.y - entry.y) / 10
    };
    await page.mouse.move(thread.x, thread.y);
    await page.mouse.down();
    await page.mouse.move(thread.x - perMm.x * 4, thread.y - perMm.y * 4, {
      steps: 16
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandle(canvas, 'tapLength'))?.value ?? 10)
      .toBeLessThan(8);
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 60_000
    });
    await finishInPlaceCommand(page, 'Hole');
    await expectBodyCount(page, 1);

    const saved = await exportedDocument(page);
    const hole = listFeaturesInOrder(saved).find(
      (feature) => feature.data.featureKind === 'hole'
    );
    const tapped = (
      hole!.data as { tapped?: { length?: number; cosmetic?: boolean } }
    ).tapped;
    expect(tapped?.cosmetic).toBe(true);
    const length = tapped!.length!;
    expect(length).toBeGreaterThan(4);
    expect(length).toBeLessThan(8);
    await revealModelPanel(page, 'History');
    await expect(
      page.locator('.feature-row', { hasText: 'M6×1 tapped (cosmetic)' })
    ).toBeVisible();

    // Draw: a diameter on the bore's rim in the top view calls out the
    // thread, its length as stored, and the tap drill's depth.
    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const sheet = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(sheet.locator('.drawing-view.is-placeholder')).toHaveCount(0, {
      timeout: 30_000
    });
    const hit = sheet.locator('[data-view="top"] .drawing-view-hit');
    const box = (await hit.boundingBox())!;
    const pxPerMm = box.width / Number(await hit.getAttribute('width'));
    const scale = await drawings
      .getByRole('combobox', { name: 'Scale', exact: true })
      .inputValue();
    const [n, d] = scale.split(':').map(Number);
    const radius = ((2.5 * n!) / d!) * pxPerMm;
    await drawings
      .getByRole('button', { name: 'Diameter', exact: true })
      .click();
    await page.mouse.click(
      box.x + box.width / 2 + radius,
      box.y + box.height / 2
    );
    await page.mouse.click(
      box.x + box.width / 2,
      box.y + box.height + 12 * pxPerMm
    );
    const callout = sheet.getByRole('button', {
      name: /^Diameter dimension M6×1 × [\d.]+ DEEP, Ø5 × 10 DEEP$/
    });
    await expect(callout).toBeVisible();
    const name = await callout.evaluate(
      (element) =>
        element.getAttribute('aria-label') ?? element.textContent ?? ''
    );
    expect(Number(/× ([\d.]+) DEEP,/.exec(name)?.[1])).toBeCloseTo(length, 1);
  }
);
