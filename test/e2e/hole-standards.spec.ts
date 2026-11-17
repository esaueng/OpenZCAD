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
 * M01 standard hole sizes, with U11's pick-and-drag interaction: the Hole
 * tool takes the block's top face where it is clicked, Options choose ISO
 * metric, M8 and Tap drill, and the table sets the diameter, which has no
 * handle to drag; a blind depth is dragged with its arrow. Nothing is typed.
 */

const BLOCK = { x: 40, y: 30, z: 20 };
const ENTRY: [number, number, number] = [20, 15, BLOCK.z];

async function openBlock(page: Page): Promise<Locator> {
  const document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument('Standard hole', toUserId('user_e2e')),
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

test(
  'a Hole sized by the ISO table: M8 tap drill, its depth dragged',
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
    await expect(bar).toContainText('drag the diameter');

    await bar.locator('summary').click();
    await choose(bar, 'Depth', 'Blind');
    await choose(bar, 'Standard', 'ISO metric');
    await choose(bar, 'Screw', 'M8');
    await choose(bar, 'For', 'Tap drill');
    await bar.locator('summary').click();
    // The table sets the diameter: it is read out, with no handle to drag.
    await expect(bar).toContainText('M8×1.25 tap drill ⌀ 6.8');
    await expect(page.getByTestId('command-handle-diameter')).toHaveCount(0);

    // The depth arrow hangs 10 mm below the entry: drag it to about 14.
    await expect.poll(() => commandHandle(canvas, 'depth')).not.toBeNull();
    const handle = (await commandHandle(canvas, 'depth'))!;
    expect(handle.value).toBe(10);
    const entry = await projected(canvas, ENTRY);
    const target = {
      x: entry.x + ((handle.x - entry.x) * 14) / 10,
      y: entry.y + ((handle.y - entry.y) * 14) / 10
    };
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 16 });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandle(canvas, 'depth'))?.value ?? 0)
      .toBeGreaterThan(12);
    const depth = (await commandHandle(canvas, 'depth'))!.value;
    expect(depth).toBeLessThan(16);
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 60_000
    });
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
      depthMode: 'blind',
      diameter: 6.8,
      standard: { system: 'iso', size: 'M8', kind: 'tap-drill' }
    });
    expect((hole!.data as { depth: number }).depth).toBeCloseTo(depth, 6);
    await revealModelPanel(page, 'History');
    await expect(
      page.locator('.feature-row', { hasText: 'M8×1.25 tap drill' })
    ).toBeVisible();
  }
);
