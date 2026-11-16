import {
  addAssemblyComponents,
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
 * M17 slice 3, standard parts in the AS03 bill of materials, with U11's
 * pick-and-drag interaction: in a block that is already an assembly, the
 * Standard part tool places an ISO M6 socket head screw where the top face
 * is clicked and its length arrow is dragged longer. Assemble lists the new
 * screw as not yet in the assembly; once added, the bill of materials and
 * its CSV name it by its designation at the dragged length.
 */

const BLOCK = { x: 40, y: 30, z: 20 };
const ENTRY: [number, number, number] = [20, 15, BLOCK.z];

async function openBlock(page: Page): Promise<Locator> {
  const block: ProjectDocument = addPrimitiveFeature(
    createProjectDocument('Standard parts BOM', toUserId('user_e2e')),
    {
      name: 'Block',
      bodyName: 'Block',
      primitiveKind: 'box',
      dimensions: { width: BLOCK.x, height: BLOCK.y, depth: BLOCK.z }
    }
  );
  const document = addAssemblyComponents(block, {
    components: [
      {
        componentId: 'comp_block',
        name: 'Block',
        bodyId: block.bodyOrder[0]!,
        grounded: true
      }
    ]
  });
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

/** Clicks the block's top face at `ENTRY`, as the viewport's pick does. */
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
  'a placed screw listed in the bill of materials by its designation',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(240_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const canvas = await openBlock(page);

    const moreTools = page.getByRole('button', { name: /^More tools/ });
    if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
      await moreTools.click();
    }
    await page.getByRole('button', { name: /^Standard part/ }).click();
    const bar = page.getByRole('group', { name: 'Standard part command' });
    await expect(bar).toBeVisible();
    if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
      await moreTools.click();
    }
    await expect.poll(() => pickTop(canvas), { timeout: 60_000 }).toBe(true);
    await expect(bar).toContainText('ISO 4762 M6×1 × 16 socket head cap screw');

    // Drag the length arrow 8 mm further down into the block.
    await expect.poll(() => commandHandle(canvas, 'length')).not.toBeNull();
    await waitForStillViewport(page);
    const handle = (await commandHandle(canvas, 'length'))!;
    const entry = await projected(canvas, ENTRY);
    const perMm = {
      x: (handle.x - entry.x) / 16,
      y: (handle.y - entry.y) / 16
    };
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + perMm.x * 8, handle.y + perMm.y * 8, {
      steps: 16
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandle(canvas, 'length'))?.value ?? 16)
      .toBeGreaterThan(20);
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 90_000
    });
    await finishInPlaceCommand(page, 'Standard part');
    await expectBodyCount(page, 2);
    const saved = await exportedDocument(page);
    const part = listFeaturesInOrder(saved).find(
      (feature) => feature.data.featureKind === 'standard-part'
    )!;
    const length = (part.data as { length: number }).length;
    const designation = `ISO 4762 M6×1 × ${Number(length.toPrecision(6))} socket head cap screw`;

    // Assemble: the screw is not in the assembly yet; add it.
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Assembly' });
    const parts = panel.getByRole('region', { name: 'Parts' });
    const outside = parts.getByRole('group', { name: 'Not in the assembly' });
    await expect(outside).toBeVisible({ timeout: 60_000 });
    await outside.getByRole('button', { name: /^Add / }).first().click();
    await expect(outside).toHaveCount(0);

    // The BOM and its CSV name the screw by its designation.
    const bom = panel.getByRole('region', { name: 'Bill of materials' });
    await expect(bom.getByRole('listitem')).toHaveText([
      '1Block×1',
      `2${designation}×1`
    ]);
    const pending = page.waitForEvent('download');
    await bom
      .getByRole('button', { name: 'Download bill of materials as CSV' })
      .click();
    const download = await pending;
    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream())
      chunks.push(chunk as Buffer);
    const csv = Buffer.concat(chunks).toString('utf8').trim().split('\n');
    expect(csv[0]).toBe('item,quantity,part,instances,source_body,status');
    expect(csv[2]!.split(',').slice(0, 3)).toEqual(['2', '1', designation]);
  }
);
