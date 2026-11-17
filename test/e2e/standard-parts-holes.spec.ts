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
 * M17 slice 2, parts inserted into M01 holes, with U11's pick-and-drag
 * interaction: the Hole tool drills an ISO M6 clearance hole through the
 * block's top face; the Standard part tool, placed Into a hole, takes the
 * hole's bore, sizes the screw M6 from the hole and stands its length arrow
 * at the matched 30 mm (20 through the block, a nut and two pitches beyond);
 * the arrow is dragged longer. Nothing is typed.
 */

const BLOCK = { x: 40, y: 30, z: 20 };
const ENTRY: [number, number, number] = [20, 15, BLOCK.z];
const BOTTOM: [number, number, number] = [20, 15, 0];

async function openBlock(page: Page): Promise<Locator> {
  const document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument('Standard parts', toUserId('user_e2e')),
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

/** Clicks the bore of radius `radius`, as the viewport's pick does. */
async function pickBore(canvas: Locator, radius: number): Promise<boolean> {
  return canvas.evaluate(
    (element, r) =>
      new Promise<boolean>((resolve) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: {
              surface: 'wall',
              radius: r,
              select: true,
              resolve: (value: unknown) => resolve(value !== null)
            }
          })
        )
      ),
    radius
  );
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

async function openTool(page: Page, name: string): Promise<Locator> {
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  const bar = page.getByRole('group', { name: `${name} command` });
  await expect(bar).toBeVisible();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  return bar;
}

test(
  'a screw inserted into an M6 clearance hole: matched, then dragged longer',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(300_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const canvas = await openBlock(page);

    // An ISO M6 clearance hole through the block.
    const holeBar = await openTool(page, 'Hole');
    await expect.poll(() => pickTop(canvas), { timeout: 60_000 }).toBe(true);
    await holeBar.locator('summary').click();
    await choose(holeBar, 'Standard', 'ISO metric');
    await choose(holeBar, 'Screw', 'M6');
    await choose(holeBar, 'For', 'Clearance');
    await holeBar.locator('summary').click();
    await expect(holeBar.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 60_000
    });
    await finishInPlaceCommand(page, 'Hole');
    await expectBodyCount(page, 1);
    await waitForStillViewport(page);

    // A screw into it: the hole sizes it and matches its length.
    const bar = await openTool(page, 'Standard part');
    await bar.locator('summary').click();
    await choose(bar, 'Part', 'Screw');
    await choose(bar, 'Place', 'Into a hole');
    await bar.locator('summary').click();
    // The bore of the normal M6 clearance hole, 6.6 across, clicked once the
    // model has it. A bore whose feature is not yet read asks for a second
    // click, but a picked feature's face clicked again comes back out, so it
    // is clicked again only when no length arrow follows.
    await expect
      .poll(() => pickBore(canvas, 3.3), { timeout: 60_000 })
      .toBe(true);
    const arrow = () =>
      expect
        .poll(() => commandHandle(canvas, 'length'), { timeout: 10_000 })
        .not.toBeNull()
        .then(
          () => true,
          () => false
        );
    if (!(await arrow())) {
      await pickBore(canvas, 3.3);
      expect(await arrow()).toBe(true);
    }
    // The preview of the matched screw settles before the arrow is taken;
    // its handles are drawn again with the settled preview.
    await waitForStillViewport(page);
    await expect.poll(() => commandHandle(canvas, 'length')).not.toBeNull();
    const handle = (await commandHandle(canvas, 'length'))!;
    // 20 through the block, a 5.2 nut and two pitches: the 30 is the
    // shortest preferred length past 27.2.
    expect(handle.value).toBe(30);
    const entry = await projected(canvas, ENTRY);
    const bottom = await projected(canvas, BOTTOM);
    const perMm = {
      x: (bottom.x - entry.x) / BLOCK.z,
      y: (bottom.y - entry.y) / BLOCK.z
    };
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + perMm.x * 6, handle.y + perMm.y * 6, {
      steps: 16
    });
    await page.mouse.up();
    // The dragged length, read where the poll saw it (the handle is drawn
    // again whenever the preview lands).
    let length = 30;
    await expect
      .poll(async () => {
        length = (await commandHandle(canvas, 'length'))?.value ?? length;
        return length;
      })
      .toBeGreaterThan(33);
    expect(length).toBeLessThan(40);
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 90_000
    });
    await finishInPlaceCommand(page, 'Standard part');
    await expectBodyCount(page, 2);

    const saved = await exportedDocument(page);
    const features = listFeaturesInOrder(saved);
    const hole = features.find(
      (feature) => feature.data.featureKind === 'hole'
    );
    const part = features.find(
      (feature) => feature.data.featureKind === 'standard-part'
    );
    expect(part?.data).toMatchObject({
      partKind: 'screw',
      system: 'iso',
      size: 'M6',
      hole: { featureId: hole!.featureId },
      axis: { x: 0, y: 0, z: -1 }
    });
    expect((part!.data as { length?: number }).length).toBeCloseTo(length, 6);
    await revealModelPanel(page, 'History');
    await expect(
      page.locator('.feature-row', { hasText: 'ISO 4762 M6×1' })
    ).toBeVisible();
    await expect(page.getByRole('contentinfo')).not.toContainText(
      'build failed'
    );
  }
);
