import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder,
  ribBody
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
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M02 patterns of ribs, with U11's pick-and-drag interaction: a Linear
 * pattern set to Repeat Features along Z takes a bracket's gusset from a
 * click on its side, and its arrow drags the spacing. Every copy is added
 * across the bracket's inside corner.
 */

/** An L bracket 20 deep in Z with a 2-thick gusset at mid-depth. */
function gussetedBracket(): { document: ProjectDocument; ribId: string } {
  let document = createProjectDocument('Rib pattern', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Base',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 5, depth: 20 }
  });
  const base = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Wall',
    primitiveKind: 'box',
    dimensions: { width: 5, height: 40, depth: 20 }
  });
  const wall = document.bodyOrder.at(-1)!;
  const joined = booleanBodies(document, {
    name: 'Bracket',
    operation: 'union',
    targetBodyIds: [base, wall]
  });
  const sketch = addSketchFeature(joined.document, {
    name: 'Rib profile',
    plane: 'XY',
    offset: 10,
    objects: [{ objectKind: 'line', x1: 5, y1: 30, x2: 30, y2: 5 }]
  });
  const rib = ribBody(sketch.document, {
    name: 'Gusset',
    targetBodyId: joined.bodyId,
    profile: {
      sketchId: sketch.sketchId,
      entityIds: findSketch(sketch.document, sketch.sketchId)!.objectIds
    },
    thickness: 2,
    thicknessSide: 'symmetric',
    direction: 'parallel'
  });
  return {
    document: rib.document,
    ribId: listFeaturesInOrder(rib.document).at(-1)!.featureId
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

/** Clicks the gusset's upper side, at z = 11 inside the bracket's corner. */
async function pickGusset(canvas: Locator): Promise<boolean> {
  return canvas.evaluate(
    (element) =>
      new Promise<boolean>((resolve) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: {
              normal: { x: 0, y: 0, z: 1 },
              near: { x: 13, y: 13, z: 11 },
              select: true,
              resolve: (value: unknown) => resolve(value !== null)
            }
          })
        )
      )
  );
}

test(
  'a Linear pattern repeats a rib along its bracket, picked and dragged',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const { document, ribId } = gussetedBracket();
    const canvas = await openDocument(page, document);

    const bar = await startTool(page, /^Linear pattern/, 'Linear pattern');
    const options = bar.getByLabel('Linear pattern options');
    await options.click();
    await bar.getByRole('radio', { name: 'Features' }).click();
    await bar.getByRole('radio', { name: 'Z', exact: true }).click();
    await options.click();
    await expect.poll(() => pickGusset(canvas), { timeout: 30_000 }).toBe(true);
    await expect(bar).toContainText('tap a copy to skip it');

    // The arrow drags the spacing from 20 back toward the gusset.
    await page.mouse.move(0, 0);
    await page.keyboard.press('f');
    await waitForStillViewport(page);
    const grip = (await commandHandle(canvas, 'spacing'))!;
    expect(grip.value).toBe(20);
    const target = await projected(canvas, [17, 12, 16]);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 16 });
    await page.mouse.up();
    // Two copies (the count's three) past the original at z = 10 stay
    // inside the bracket's 20 of depth, clear of each other's 2 of rib.
    await expect
      .poll(async () => (await commandHandle(canvas, 'spacing'))?.value ?? 20)
      .toBeLessThan(4.5);
    expect((await commandHandle(canvas, 'spacing'))!.value).toBeGreaterThan(2);
    const done = bar.getByRole('button', { name: /Done/ });
    await expect(done).toBeEnabled({ timeout: 60_000 });
    await finishInPlaceCommand(page, 'Linear pattern');
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).not.toContainText(
      /cannot repeat|did not build|Union produced|misses/
    );

    const saved = await exportedDocument(page);
    const [pattern] = patterns(saved);
    expect(pattern?.data).toMatchObject({
      patternKind: 'linear',
      axis: 'z',
      count: 3,
      sourceFeatureIds: [ribId]
    });
    const spacing =
      pattern?.data.featureKind === 'pattern' ? pattern.data.spacing : null;
    expect(typeof spacing === 'number' && spacing > 2 && spacing < 4.5).toBe(
      true
    );
  }
);
