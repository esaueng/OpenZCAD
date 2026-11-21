import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder,
  resolveParamValue,
  wrapBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  toUserId,
  type FeatureNode,
  type ProjectDocument,
  type SketchProfileReference
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  clickWorldPoint,
  enterCommandValue,
  expectBodyCount,
  finishInPlaceCommand,
  MODEL_ONLY,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M02 patterns of wraps, with U11's pick-and-drag interaction: a Circular
 * pattern set to Repeat Features takes an embossed badge from a click on its
 * raised face, turns about the Z axis line clicked above the post, and its
 * rig drags the step. Every copy is embossed round the post.
 */

const R = 10;
const HEIGHT = 20;

/** A radius-10 post with a 6 × 4 badge embossed 1 deep on its +X side. */
async function badgedPost(): Promise<{
  document: ProjectDocument;
  wrapId: string;
}> {
  const start = addPrimitiveFeature(
    createProjectDocument('Wrap pattern', toUserId('user_e2e')),
    {
      name: 'Post',
      primitiveKind: 'cylinder',
      dimensions: { radius: R, height: HEIGHT }
    }
  );
  const postId = start.bodyOrder.at(-1)!;
  const adapter = await createExactKernelAdapter();
  const first = await adapter.syncDocument(start);
  adapter.dispose();
  const side = first.bodyRepresentations[postId]!.topology!.faces.find(
    (face) => face.geometry?.surfaceType === 'cylinder'
  )!;
  const sketch = addSketchFeature(start, {
    name: 'Label',
    plane: 'YZ',
    offset: R,
    objects: [
      { objectKind: 'rectangle', width: 6, height: 4, centerX: 0, centerY: 10 }
    ]
  });
  const node = findSketch(sketch.document, sketch.sketchId)!;
  const analysis = computeSketchProfileAnalysis(
    node.objectIds.map((id) => {
      const object = sketch.document.nodes[id];
      if (object?.kind !== 'sketch-object')
        throw new Error('Expected an object.');
      return { id, data: object.data };
    }),
    (value) => resolveParamValue(value, {}, 'dimension')
  );
  const profiles: SketchProfileReference[] = analysis.profiles.map((p) => ({
    profileId: p.profileId,
    regionFingerprint: p.regionFingerprint,
    samplePoint: p.samplePoint,
    sourceArea: p.area,
    sourceEntityIds: p.sourceEntityIds
  }));
  const document = wrapBody(sketch.document, {
    name: 'Badge',
    targetBodyId: postId,
    faceReference: side.reference!,
    sketchId: sketch.sketchId,
    profiles,
    depth: 1,
    mode: 'emboss'
  }).document;
  return {
    document,
    wrapId: listFeaturesInOrder(document).at(-1)!.featureId
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

/** Clicks the badge's raised face, a cylinder of radius 11. */
async function pickBadge(canvas: Locator): Promise<boolean> {
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
    R + 1
  );
}

test(
  'a Circular pattern repeats a wrapped badge round its post, picked and dragged',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const { document, wrapId } = await badgedPost();
    const canvas = await openDocument(page, document);

    const bar = await startTool(page, /^Circular pattern/, 'Circular pattern');
    const options = bar.getByLabel('Circular pattern options');
    await options.click();
    await bar.getByRole('radio', { name: 'Features' }).click();
    // Fixed step: the rig's ball stands one step round the ring.
    await bar.getByRole('radio', { name: 'Fixed step' }).click();
    await options.click();
    await expect.poll(() => pickBadge(canvas), { timeout: 30_000 }).toBe(true);
    await expect(bar).toContainText('Pick an axis');
    // The Z axis line, above the post: a drawn axis line takes the click.
    await clickWorldPoint(page, [0, 0, HEIGHT + 4]);
    await expect(bar).toContainText('Drag the step');

    // The rig drags the step off its first 60°.
    await page.mouse.move(0, 0);
    await page.keyboard.press('f');
    await waitForStillViewport(page);
    const grip = (await commandHandle(canvas, 'step'))!;
    expect(grip.value).toBe(60);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 40, grip.y + 30, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandle(canvas, 'step'))?.value ?? 60)
      .not.toBe(60);

    // Then four copies a quarter turn apart: a whole turn.
    await enterCommandValue(page, 'step', '90');
    await enterCommandValue(page, 'count', '4');
    const done = bar.getByRole('button', { name: /Done/ });
    await expect(done).toBeEnabled({ timeout: 60_000 });
    await finishInPlaceCommand(page, 'Circular pattern');
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).not.toContainText(
      /cannot repeat|did not build|Union produced/
    );

    const saved = await exportedDocument(page);
    const [pattern] = patterns(saved);
    expect(pattern?.data).toMatchObject({
      patternKind: 'circular',
      count: 4,
      angleDeg: 360,
      sourceFeatureIds: [wrapId]
    });
  }
);
