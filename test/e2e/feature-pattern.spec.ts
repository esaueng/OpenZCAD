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
  enterCommandValue,
  expectBodyCount,
  finishInPlaceCommand,
  MODEL_ONLY,
  pickPlanarFace,
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M02 feature patterns, with U11's pick-and-drag interaction: a Linear
 * pattern set to Repeat Features takes the hole a click on its bore names,
 * its spacing is the arrow's drag, and each copy wears a chip a click skips.
 * Reopened from History, the same chip brings the copy back. Beyond the
 * hole's own diameter, nothing is typed.
 */

const PLATE = { x: 100, y: 40, z: 10 };

async function openPlate(page: Page): Promise<Locator> {
  const document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument('Feature pattern', toUserId('user_e2e')),
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
  'a Linear pattern repeats a hole, skips a copy by its chip, and brings it back',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const canvas = await openPlate(page);

    // The hole, at the middle of the top face.
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

    // Repeat: Features, then a click on the bore names the hole.
    const bar = await startTool(page, /^Linear pattern/, 'Linear pattern');
    await bar.locator('summary').click();
    await bar.getByRole('radio', { name: 'Features' }).click();
    await bar.locator('summary').click();
    await expect(bar).toContainText('Click a hole, boss or cut to repeat');
    await expect.poll(() => pickBore(canvas), { timeout: 30_000 }).toBe(true);
    await expect(bar).toContainText('tap a copy to skip it');
    const done = bar.getByRole('button', { name: /Done/ });
    await expect(done).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByTestId('command-handle-instance:1')).toBeVisible();
    await expect(page.getByTestId('command-handle-instance:2')).toBeVisible();

    // Drag the spacing arrow from 20 back to about 15 along X.
    await waitForStillViewport(page);
    const grip = (await commandHandle(canvas, 'spacing'))!;
    expect(grip.value).toBe(20);
    const centre = PLATE.x / 2;
    const target = await projected(canvas, [centre + 15, PLATE.y / 2, 5]);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 16 });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandle(canvas, 'spacing'))?.value ?? 0)
      .toBeLessThan(18);
    await expect(done).toBeEnabled({ timeout: 60_000 });

    // A click on copy 1's chip skips it; the chip stays to bring it back.
    const first = page.getByTestId('command-handle-instance:1');
    await first.click();
    await expect(page.getByTestId('command-handle-instance:1')).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await expect(done).toBeEnabled({ timeout: 60_000 });
    await finishInPlaceCommand(page, 'Linear pattern');
    await expectBodyCount(page, 1);

    const saved = await exportedDocument(page);
    const holeFeature = listFeaturesInOrder(saved).find(
      (feature) => feature.data.featureKind === 'hole'
    )!;
    const [pattern] = patterns(saved);
    expect(pattern?.data).toMatchObject({
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      sourceFeatureIds: [holeFeature.featureId],
      skippedInstances: ['1']
    });
    const spacing =
      pattern?.data.featureKind === 'pattern' ? pattern.data.spacing : null;
    expect(typeof spacing === 'number' && spacing < 18 && spacing > 10).toBe(
      true
    );
    await revealModelPanel(page, 'History');
    const row = page.locator('.feature-row', { hasText: '1 skipped' });
    await expect(row).toBeVisible();

    // Reopened from History, the same chip brings copy 1 back.
    await row.locator('.feature-row-main').click();
    const edit = page.getByRole('group', {
      name: 'Edit Linear pattern command'
    });
    await expect(edit).toBeVisible();
    const skipped = page.getByTestId('command-handle-instance:1');
    await expect(skipped).toHaveAttribute('aria-pressed', 'false', {
      timeout: 60_000
    });
    await skipped.click();
    await expect(page.getByTestId('command-handle-instance:1')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await finishInPlaceCommand(page, 'Edit Linear pattern');
    const edited = patterns(await exportedDocument(page))[0]!;
    expect(edited.data).toMatchObject({
      sourceFeatureIds: [holeFeature.featureId]
    });
    expect(edited.data).not.toHaveProperty('skippedInstances');
  }
);
