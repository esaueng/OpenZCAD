import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  clickWorldPoint,
  enterCommandValue,
  expectBodyCount,
  finishInPlaceCommand,
  MODEL_ONLY,
  pickObjectsBody,
  revealModelPanel,
  setSelectionFilter,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U09: a turn or a ring takes its axis from the model — a straight edge, a
 * cylinder, a world axis — with no datum made first; a linear pattern takes
 * its direction from an edge or a flat face. A picked line is stored as a
 * datum axis Done adds in the same step, so the turn still follows it.
 * Picks are clicks, numbers go in through the chips' keypad.
 */

/** Serves `document` as the project the start screen's Create returns. */
async function openDocument(page: Page, document: ProjectDocument) {
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
}

async function openBodies(
  page: Page,
  name: string,
  build: (document: ProjectDocument) => ProjectDocument,
  bodies: number
) {
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openDocument(
    page,
    build(createProjectDocument(name, toUserId('user_e2e')))
  );
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute(
    'data-e2e-rendered-bodies',
    String(bodies),
    { timeout: 30_000 }
  );
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  // The extra tools' flyout stands over the left of the stage.
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
}

function block(document: ProjectDocument, size = 10): ProjectDocument {
  return addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: size, height: size, depth: size }
  });
}

async function startTool(page: Page, tool: RegExp, title: string) {
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: tool }).click();
  const bar = page.getByRole('group', { name: `${title} command` });
  await expect(bar).toBeVisible();
  await expect(page.locator('form.feature-form')).toHaveCount(0);
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

function features(document: ProjectDocument): FeatureNode[] {
  return listFeaturesInOrder(document);
}

test('Revolve turns about a body edge in its sketch plane', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openBodies(
    page,
    'Revolve about an edge',
    (document) =>
      // A 6 mm block whose front right edge runs up Z at x = 6, in the
      // Front plane the profile is drawn on.
      addSketchFeature(block(document, 6), {
        name: 'Profile',
        plane: 'XZ',
        offset: 0,
        objects: [
          { objectKind: 'line', x1: -10, y1: 0, x2: -20, y2: 0 },
          { objectKind: 'line', x1: -20, y1: 0, x2: -20, y2: 10 },
          { objectKind: 'line', x1: -20, y1: 10, x2: -10, y2: 10 },
          { objectKind: 'line', x1: -10, y1: 10, x2: -10, y2: 0 }
        ]
      }).document,
    1
  );
  const canvas = page.locator('.viewer-host canvas');
  await page.keyboard.press('r');
  const bar = page.getByRole('group', { name: 'Revolve command' });
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-profile', {
            detail: { index: 0, additive: false }
          })
        )
      );
      return bar.textContent();
    })
    .toContain('Pick the axis');
  await expect(bar).toContainText('an edge');
  await setSelectionFilter(page, 'Edge');
  await clickWorldPoint(page, [6, 0, 3]);
  await expect(bar).toContainText('Drag the angle');
  await enterCommandValue(page, 'angle', '90');
  await finishInPlaceCommand(page, 'Revolve');
  await setSelectionFilter(page, 'Any');
  await expectBodyCount(page, 2);

  const saved = features(await exportedDocument(page));
  const axis = saved.find(
    (feature) => feature.data.featureKind === 'datum-axis'
  );
  const revolve = saved.find(
    (feature) => feature.data.featureKind === 'revolve'
  );
  // The edge is a datum axis, added just before the revolve that turns
  // about it.
  expect(axis?.data).toMatchObject({
    definition: { kind: 'edge', source: { type: 'edge' } }
  });
  expect(saved.indexOf(axis!)).toBe(saved.indexOf(revolve!) - 1);
  expect(revolve?.data).toMatchObject({
    angleDeg: 90,
    axisRef: { type: 'datum-axis', datumFeatureId: axis!.featureId }
  });

  // Re-armed from History, its own result is no axis: a datum before the
  // revolve could not find the ring it makes. The edge refuses by name and
  // the axis stays.
  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row', { hasText: 'Revolve' })
    .locator('.feature-row-main')
    .click();
  const edit = page.getByRole('group', { name: /^Edit Revolve.* command$/ });
  await expect(edit).toContainText('Drag the angle');
  await expect(edit.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  // The ring's outer face, halfway round (the profile hangs below the
  // Front plane's origin: z −10..0).
  await clickWorldPoint(page, [-12.4, -18.4, -5]);
  await expect(page.getByRole('contentinfo')).toContainText(
    'can only turn about a line on what is built before it'
  );
  await expect(edit).toContainText('Drag the angle');
  await edit.getByRole('button', { name: /Cancel/ }).click();
  await setSelectionFilter(page, 'Any');
});

test('Rotate about axis turns a body about a cylinder, no datum made first', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openBodies(
    page,
    'Rotate about a cylinder',
    (document) =>
      addPrimitiveFeature(block(document), {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 10 }
      }),
    2
  );
  const bar = await startTool(page, /^Rotate about axis/, 'Rotate about axis');
  await pickObjectsBody(page, 'Block');
  await expect(bar).toContainText('a cylinder');
  // The post's side, in front of the block's corner it stands on.
  await setSelectionFilter(page, 'Face');
  await clickWorldPoint(page, [0, -5, 5]);
  await expect(bar).toContainText('Drag the angle');
  await enterCommandValue(page, 'angle', '90');
  await finishInPlaceCommand(page, 'Rotate about axis');
  await setSelectionFilter(page, 'Any');

  const saved = features(await exportedDocument(page));
  const axis = saved.find(
    (feature) => feature.data.featureKind === 'datum-axis'
  );
  expect(axis?.name).toBe('Axis 1');
  expect(axis?.data).toMatchObject({
    definition: { kind: 'cylinder', source: { type: 'face' } }
  });
  const rotate = saved.find(
    (feature) => feature.data.featureKind === 'transform'
  );
  expect(rotate?.data).toMatchObject({
    axisRotation: {
      axis: { type: 'datum-axis', datumFeatureId: axis!.featureId },
      angleDeg: 90
    }
  });
});

test('Rotate about axis turns about a world axis, added as a datum', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openBodies(page, 'Rotate about Z', (document) => block(document), 1);
  const bar = await startTool(page, /^Rotate about axis/, 'Rotate about axis');
  await pickObjectsBody(page, 'Block');
  // The Z axis line, up through the origin along the block's corner edge:
  // a drawn axis line takes the click before the model under it.
  await clickWorldPoint(page, [0, 0, 5]);
  await expect(bar).toContainText('Drag the angle');
  await enterCommandValue(page, 'angle', '-90');
  await finishInPlaceCommand(page, 'Rotate about axis');

  const saved = features(await exportedDocument(page));
  const axis = saved.find(
    (feature) => feature.data.featureKind === 'datum-axis'
  );
  expect(axis?.data).toMatchObject({
    definition: { kind: 'plane-intersection' }
  });
  expect(
    saved.find((feature) => feature.data.featureKind === 'transform')?.data
  ).toMatchObject({
    axisRotation: { axis: { datumFeatureId: axis!.featureId }, angleDeg: -90 }
  });

  // Re-armed from History, it takes another line the same way: the X axis,
  // now along the turned block's front edge. Its datum goes in before the
  // turn, which may only use what is built before it.
  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row', { hasText: 'Rotate' })
    .locator('.feature-row-main')
    .click();
  const edit = page.getByRole('group', { name: 'Edit Rotate command' });
  await expect(edit).toBeVisible();
  await clickWorldPoint(page, [5, 0, 0]);
  await finishInPlaceCommand(page, 'Edit Rotate');
  const edited = features(await exportedDocument(page));
  const axes = edited.filter(
    (feature) => feature.data.featureKind === 'datum-axis'
  );
  expect(axes.map((feature) => feature.name)).toEqual(['Axis 1', 'Axis 2']);
  const rotate = edited.find(
    (feature) => feature.data.featureKind === 'transform'
  )!;
  expect(edited.indexOf(rotate)).toBe(edited.indexOf(axes[1]!) + 1);
  expect(rotate.data).toMatchObject({
    axisRotation: {
      axis: { datumFeatureId: axes[1]!.featureId },
      angleDeg: -90
    }
  });
});

test('Circular pattern rings copies about an edge at a fixed step', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openBodies(
    page,
    'Ring about an edge',
    (document) => block(document),
    1
  );
  const bar = await startTool(page, /^Circular pattern/, 'Circular pattern');
  await pickObjectsBody(page, 'Block');
  await setSelectionFilter(page, 'Edge');
  // The block's front right edge, up Z at x = 10.
  await clickWorldPoint(page, [10, 0, 5]);
  await expect(bar).toContainText('Drag the total angle');
  // Fixed step: each copy turns 90° from the one before.
  await bar.locator('summary').click();
  await bar.getByRole('radio', { name: 'Fixed step' }).click();
  await bar.locator('summary').click();
  await expect(bar).toContainText('Drag the step');
  await enterCommandValue(page, 'step', '90');
  await enterCommandValue(page, 'count', '3');
  await finishInPlaceCommand(page, 'Circular pattern');
  await setSelectionFilter(page, 'Any');

  const saved = features(await exportedDocument(page));
  const axis = saved.find(
    (feature) => feature.data.featureKind === 'datum-axis'
  );
  expect(axis?.data).toMatchObject({ definition: { kind: 'edge' } });
  expect(
    saved.find((feature) => feature.data.featureKind === 'pattern')?.data
  ).toMatchObject({
    patternKind: 'circular',
    count: 3,
    // Three copies a quarter turn apart span half a turn.
    angleDeg: 180,
    axisRef: { type: 'datum-axis', datumFeatureId: axis!.featureId }
  });
});

test('Linear pattern repeats along a picked face normal', async ({ page }) => {
  test.setTimeout(120_000);
  await openBodies(
    page,
    'Repeat along a face',
    (document) => block(document),
    1
  );
  const bar = await startTool(page, /^Linear pattern/, 'Linear pattern');
  await pickObjectsBody(page, 'Block');
  await expect(bar).toContainText('sets the direction');
  // The front face: its normal points down −Y, which no world axis is.
  await setSelectionFilter(page, 'Face');
  await clickWorldPoint(page, [5, 0, 5]);
  await expect(page.getByTestId('command-handle-dirY')).toHaveText(/-1/);
  await enterCommandValue(page, 'spacing', '15');
  await enterCommandValue(page, 'count', '2');
  await finishInPlaceCommand(page, 'Linear pattern');
  await setSelectionFilter(page, 'Any');

  const saved = features(await exportedDocument(page));
  // A direction is stored as its numbers: no datum is added for it.
  expect(
    saved.some((feature) => feature.data.featureKind === 'datum-axis')
  ).toBe(false);
  expect(
    saved.find((feature) => feature.data.featureKind === 'pattern')?.data
  ).toMatchObject({
    patternKind: 'linear',
    count: 2,
    spacing: 15,
    direction: { x: 0, y: -1, z: 0 }
  });
});
