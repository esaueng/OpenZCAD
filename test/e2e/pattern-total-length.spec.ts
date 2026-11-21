import {
  addPrimitiveFeature,
  createProjectDocument,
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
  expectBodyCount,
  finishInPlaceCommand,
  MODEL_ONLY,
  pickPlanarFace,
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M02 total-length linear patterns, with U11's pick-and-drag interaction: a
 * Linear pattern of a block set to Total length in Options shares the
 * length out between its copies, and its arrow drags the last copy.
 */

const PLATE = { x: 20, y: 20, z: 10 };

async function openPlate(page: Page): Promise<{ canvas: Locator }> {
  const document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument('Total length', toUserId('user_e2e')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: PLATE.x, height: PLATE.y, depth: PLATE.z }
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
  return { canvas };
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

test(
  'a Linear pattern over a total length drags its last copy and keeps the mode',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const { canvas } = await openPlate(page);

    const bar = await startTool(page, /^Linear pattern/, 'Linear pattern');
    // A flat face gives the pattern its direction (U09), so the +X side
    // runs it along X.
    await expect
      .poll(() => pickPlanarFace(page, { x: 1, y: 0, z: 0 }), {
        timeout: 60_000
      })
      .not.toBeNull();
    await bar.locator('summary').click();
    await bar.getByRole('radio', { name: 'Total length' }).click();
    await bar.locator('summary').click();
    await expect(bar).toContainText('Drag the last copy');

    // The arrow is the last copy: from 40 out to about 70 along X. Fitted
    // again with the copies shown, so its far end stands on screen.
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press('f');
    await waitForStillViewport(page);
    const grip = (await commandHandle(canvas, 'total'))!;
    expect(grip.value).toBe(40);
    const target = await projected(canvas, [
      PLATE.x / 2 + 70,
      PLATE.y / 2,
      PLATE.z / 2
    ]);
    expect(target.x).toBeLessThan(box.x + box.width);
    expect(target.y).toBeLessThan(box.y + box.height);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 16 });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandle(canvas, 'total'))?.value ?? 0)
      .toBeGreaterThan(55);
    // The middle copy stands halfway along the total.
    await expect(page.getByTestId('command-handle-instance:2')).toBeVisible();
    const done = bar.getByRole('button', { name: /Done/ });
    await expect(done).toBeEnabled({ timeout: 60_000 });
    await finishInPlaceCommand(page, 'Linear pattern');
    await expectBodyCount(page, 1);

    const saved = await exportedDocument(page);
    const [pattern] = patterns(saved);
    expect(pattern?.data).toMatchObject({
      patternKind: 'linear',
      count: 3,
      spacingMode: 'total'
    });
    const spacing =
      pattern?.data.featureKind === 'pattern' ? pattern.data.spacing : null;
    expect(typeof spacing === 'number' && spacing > 55 && spacing < 85).toBe(
      true
    );
    await revealModelPanel(page, 'History');
    await expect(
      page.locator('.feature-row', { hasText: /× 3 over/ })
    ).toBeVisible();
  }
);
