import type { Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findFeature
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  expect,
  expectBodyCount,
  locateEdge,
  setSelectionFilter,
  stubApi,
  test
} from './openzcad-fixtures';

async function makePart(page: Page, name: string) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  for (const label of ['Width (X)', 'Depth (Y)', 'Height (Z)']) {
    await inspector.getByLabel(label).fill('60');
  }
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expectBodyCount(page, 1);
  await expect(inspector).toHaveCount(0);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible();
  return {
    canvas,
    inspector,
    move: page.getByRole('form', { name: 'Move controls' }),
    ask: page.getByRole('alertdialog', { name: 'Apply the Move first?' }),
    moveRows: page.locator('.feature-row', { hasText: /^Move/ })
  };
}

async function startMove(page: Page) {
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const move = page.getByRole('form', { name: 'Move controls' });
  await move.getByLabel('Move X in mm').fill('5');
  // A single target is named in a paragraph; the selector exists only when
  // the document offers several bodies. Keep the actual displayed target.
  const target = move.locator('p').first();
  await expect(target).not.toHaveText('');
  return target.innerText();
}

/** Use the manual Q route, including while the Move card owns selection. */
async function cycleSelectionFilter(page: Page, mode: 'Face' | 'Sketch') {
  const filter = page.getByRole('button', { name: /^Selection filter:/ });
  await filter.focus();
  for (let step = 0; step < 8; step += 1) {
    const label = (await filter.getAttribute('aria-label'))!;
    if (label.includes(`: ${mode}.`)) break;
    await page.keyboard.press('q');
    await expect(filter).not.toHaveAttribute('aria-label', label);
  }
  await expect(filter).toHaveAttribute(
    'aria-label',
    new RegExp(`: ${mode}\\.`)
  );
}

async function backupProject(page: Page): Promise<ProjectDocument> {
  // This static fixture has no account-side archives or stored revisions.
  // Match the routes used by the other complete-project export suites.
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download');
  await menu.getByRole('button', { name: /Export project/ }).click();
  const download = await pending;
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

/** Observe every layout update, including a transient second card. */
async function watchCardCount(page: Page) {
  await page.evaluate(() => {
    const scope = window as typeof window & { __ozMaxCards?: number };
    const count = () =>
      document.querySelectorAll('.command-float > *').length +
      document.querySelectorAll('.inspector-float:not(.closing)').length;
    scope.__ozMaxCards = count();
    new MutationObserver(() => {
      scope.__ozMaxCards = Math.max(scope.__ozMaxCards ?? 0, count());
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class']
    });
  });
  return () =>
    page.evaluate(
      () =>
        (window as typeof window & { __ozMaxCards?: number }).__ozMaxCards ?? 0
    );
}

test('a viewport body pick settles the typed Move once before changing selection', async ({
  page
}) => {
  const { canvas, inspector, move, ask, moveRows } = await makePart(
    page,
    'Viewport Move guard'
  );
  await setSelectionFilter(page, 'Body');
  const maxCards = await watchCardCount(page);
  const target = await startMove(page);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', /.+/);
  const selected = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
  const area = (await canvas.boundingBox())!;
  // On the box's upper half, above the Move gizmo.
  const pickBody = () =>
    page.mouse.click(area.x + area.width * 0.5, area.y + area.height * 0.3);

  // Empty clicks preserve the typed values and their selected target.
  await page.mouse.click(
    area.x + area.width * 0.65,
    area.y + area.height * 0.08
  );
  await expect(ask).toHaveCount(0);
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);

  await pickBody();
  await expect(ask).toContainText('before the selection changes');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(move.locator('p').first()).toHaveText(target);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);
  await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /.+/);
  await expect(inspector).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);

  await pickBody();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(move).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await expect(moveRows).toHaveCount(0);
  await page.keyboard.press('Escape');

  await startMove(page);
  await pickBody();
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(1);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Zero Move gives way without asking or adding a history step.
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await pickBody();
  await expect(ask).toHaveCount(0);
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);
  expect(await maxCards()).toBe(1);
});

test('a connected edge run settles the typed Move before replacing its target', async ({
  page
}) => {
  test.setTimeout(90_000);
  const { canvas, inspector, move, ask, moveRows } = await makePart(
    page,
    'Edge run Move guard'
  );
  await page.getByRole('button', { name: /^Fillet/ }).click();
  await inspector.getByRole('button', { name: 'Select all 12 edges' }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expect(inspector).toHaveCount(0);
  await page.keyboard.press('Escape');
  await setSelectionFilter(page, 'Edge');
  const status = page.getByRole('contentinfo');
  await expect(status).not.toContainText(
    /Rebuilding|Waiting for exact geometry|Loading exact Remus kernel/i,
    { timeout: 30_000 }
  );
  const maxCards = await watchCardCount(page);
  const target = await startMove(page);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', /.+/);
  const selected = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
  const pickRun = async () => {
    const edge = await locateEdge(page);
    // The actual canvas double-click path measures its smooth topology run;
    // no first click can open a chip that intercepts the second click.
    await canvas.dispatchEvent('dblclick', {
      button: 0,
      clientX: edge.x,
      clientY: edge.y
    });
  };

  await pickRun();
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(move.locator('p').first()).toHaveText(target);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);
  await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /.+/);
  await expect(inspector).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);

  await pickRun();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(move).toHaveCount(0);
  await expect(page.locator('.selection-callout-name')).toHaveText('8 edges');
  await expect(moveRows).toHaveCount(0);

  await startMove(page);
  await pickRun();
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(moveRows).toHaveCount(1);
  await expect(move).toHaveCount(0);
  await expect(status).toContainText(
    'pick the face or edge again where it is now'
  );
  await expect(page.getByTestId('direct-manipulation-value')).toBeHidden();
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expect(status).not.toContainText(
    /Rebuilding|Waiting for exact geometry/i,
    { timeout: 30_000 }
  );

  // Zero Move closes, then the complete eight-edge run lands without a question.
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await pickRun();
  await expect(ask).toHaveCount(0);
  await expect(move).toHaveCount(0);
  await expect(page.locator('.selection-callout-name')).toHaveText('8 edges');
  expect(await maxCards()).toBe(1);
});

test('a right-click waits for the Move answer and retains its requested menu', async ({
  page
}) => {
  const { canvas, inspector, move, ask, moveRows } = await makePart(
    page,
    'Menu Move guard'
  );
  await setSelectionFilter(page, 'Body');
  const maxCards = await watchCardCount(page);
  const target = await startMove(page);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', /.+/);
  const selected = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
  const area = (await canvas.boundingBox())!;
  const rightClick = () =>
    page.mouse.click(area.x + area.width * 0.5, area.y + area.height * 0.3, {
      button: 'right'
    });
  const menu = page.locator('.context-menu');

  await rightClick();
  await expect(ask).toBeVisible();
  await expect(menu).toHaveCount(0);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(menu).toHaveCount(0);
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(move.locator('p').first()).toHaveText(target);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);
  await expect(inspector).toHaveCount(0);

  await rightClick();
  await expect(menu).toHaveCount(0);
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(move).toHaveCount(0);
  // The original right-click opens its menu without requiring another click.
  await expect(menu).toBeVisible();
  await expect(menu.locator('.context-menu-heading')).toHaveText(target);
  await expect(menu.getByRole('menuitem', { name: 'Hide Body' })).toBeVisible();
  await expect(moveRows).toHaveCount(0);
  await page.keyboard.press('Escape');

  await startMove(page);
  await rightClick();
  await expect(menu).toBeHidden();
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(1);
  // Body IDs survive Move, so the requested body's menu is still safe.
  await expect(menu).toBeVisible();
  await expect(menu.locator('.context-menu-heading')).toHaveText(target);
  // Once the current exact result is ready, the retained menu acts on its
  // current publisher. Its old render must not refuse the newer document.
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: /^Delete/ })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: /^Edit Move\b/ }).click();
  const editedFeature = page.getByRole('region', { name: 'Feature inspector' });
  await editedFeature.getByLabel('More actions').click();
  await editedFeature
    .getByRole('button', { name: 'Delete feature', exact: true })
    .click();
  await expect(ask).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await expect(
    page.locator('.feature-row-main', { hasText: /^Box$/ })
  ).toBeVisible();
  await expectBodyCount(page, 1);
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(moveRows).toHaveCount(1);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expectBodyCount(page, 1);
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(1);

  // A face address on the moved body needs a new pick; its old menu waits too.
  await setSelectionFilter(page, 'Face');
  await startMove(page);
  await rightClick();
  await expect(ask).toBeVisible();
  await expect(menu).toBeHidden();
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(moveRows).toHaveCount(1);
  await expect(menu).toBeHidden();
  await expect(page.getByRole('contentinfo')).toContainText(
    'pick the face or edge again where it is now'
  );
  expect(await maxCards()).toBe(1);
});

test('a deferred edge menu opens Fillet after Discard without asking about the old Move', async ({
  page
}) => {
  const { inspector, move, ask, moveRows } = await makePart(
    page,
    'Deferred edge menu action'
  );
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await setSelectionFilter(page, 'Edge');
  const maxCards = await watchCardCount(page);
  await startMove(page);
  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y, { button: 'right' });
  const menu = page.locator('.context-menu');
  await expect(ask).toBeVisible();
  await expect(menu).toHaveCount(0);
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(ask).toHaveCount(0);
  await expect(move).toHaveCount(0);
  await expect(menu).toBeVisible();
  await expect(moveRows).toHaveCount(0);

  await menu
    .getByRole('menuitem', { name: 'Fillet Edge…', exact: true })
    .click();
  await expect(inspector).toBeVisible();
  await expect(inspector.getByLabel('Radius', { exact: true })).toBeVisible();
  await expect(ask).toHaveCount(0);
  await expect(menu).toBeHidden();
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  expect(await maxCards()).toBe(1);
});

test('a nonempty box sweep asks before replacing a typed Move target', async ({
  page
}) => {
  const { canvas, inspector, move, ask, moveRows } = await makePart(
    page,
    'Box Move guard'
  );
  const maxCards = await watchCardCount(page);
  const target = await startMove(page);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', /.+/);
  const selected = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
  const area = (await canvas.boundingBox())!;

  async function sweep(fromX: number, fromY: number, toX: number, toY: number) {
    let from = {
      x: area.x + area.width * fromX,
      y: area.y + area.height * fromY
    };
    // Floating chrome can cover the press; pointer capture owns the release.
    for (let step = 0; step < 12; step += 1) {
      if (
        await page.evaluate(
          (point) =>
            document.elementFromPoint(point.x, point.y)?.tagName === 'CANVAS',
          from
        )
      )
        break;
      from = {
        x: from.x + (area.x + area.width / 2 - from.x) * 0.15,
        y: from.y + (area.y + area.height / 2 - from.y) * 0.15
      };
    }
    const to = { x: area.x + area.width * toX, y: area.y + area.height * toY };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
    await expect(page.locator('.selection-band')).toBeVisible();
    await page.mouse.move(to.x, to.y);
    await page.mouse.up();
  }
  const pickBody = () => sweep(0.85, 0.05, 0.01, 0.95);
  await sweep(0.6, 0.04, 0.72, 0.14);
  await expect(ask).toHaveCount(0);
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);

  await pickBody();
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(move.locator('p').first()).toHaveText(target);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);
  await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /.+/);
  await expect(inspector).toHaveCount(0);

  await pickBody();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);
  await page.keyboard.press('Escape');

  await startMove(page);
  await pickBody();
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(1);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  expect(await maxCards()).toBe(1);
});

test('applying a Move requires a fresh pick instead of arming a face at its old pose', async ({
  page
}) => {
  const { canvas, inspector, move, ask, moveRows } = await makePart(
    page,
    'Face after Move'
  );
  await startMove(page);
  const pickFace = () =>
    canvas.evaluate(
      (element) =>
        new Promise<boolean>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-planar-face', {
              detail: {
                normal: { x: 0, y: 0, z: 1 },
                resolve: (face: unknown) => resolve(face !== null)
              }
            })
          );
        })
    );
  await expect.poll(pickFace).toBe(true);
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(inspector).toHaveCount(0);
  expect(await pickFace()).toBe(true);
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(moveRows).toHaveCount(1);
  await expect(move).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText(
    'pick the face or edge again where it is now'
  );
  await expect(page.getByTestId('direct-manipulation-value')).toBeHidden();
  await expect(canvas).not.toHaveAttribute('data-e2e-selected-face', /.+/);
  await expect(inspector).toHaveCount(0);

  // Tool availability proves the current document's exact rebuild is published.
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  // A fresh pick resolves against the rebuilt body's current pose and re-arms it.
  await expect.poll(pickFace).toBe(true);
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
  await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();
  await expect(ask).toHaveCount(0);
  await expect(moveRows).toHaveCount(1);
});

test('a manual Sketch-filter profile pick settles the body Move before taking its card', async ({
  page
}) => {
  const sketch = addSketchFeature(
    createProjectDocument('Sketch pick over Move', toUserId('user_e2e')),
    {
      name: 'Source profile',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 100,
        height: 100,
        centerX: 15,
        centerY: 9
      }
    }
  );
  const document = addPrimitiveFeature(sketch.document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 30, height: 18, depth: 24 }
  });
  const bodyId = document.bodyOrder[0]!;
  await stubApi(page);
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
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expectBodyCount(page, 1);
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await page.keyboard.press('Escape');
  const canvas = page.locator('.viewer-host canvas');
  const move = page.getByRole('form', { name: 'Move controls' });
  const ask = page.getByRole('alertdialog', { name: 'Apply the Move first?' });
  const profileCard = page.getByRole('region', { name: 'Extrude operation' });
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  const moveRows = page.locator('.feature-row', { hasText: /^Move/ });
  const maxCards = await watchCardCount(page);
  const target = await startMove(page);
  await cycleSelectionFilter(page, 'Sketch');
  const area = (await canvas.boundingBox())!;
  // Q deliberately makes the real canonical sketch behind the solid pickable.
  const pickProfile = () =>
    page.mouse.click(area.x + area.width * 0.5, area.y + area.height * 0.3);

  await pickProfile();
  await expect(ask).toBeVisible();
  await expect(profileCard).toHaveCount(0);
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(move.locator('p').first()).toHaveText(target);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', bodyId);
  await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /.+/);
  await expect(profileCard).toHaveCount(0);
  await expect(inspector).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);

  await pickProfile();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(move).toHaveCount(0);
  await expect(profileCard).toBeVisible();
  await expect(canvas).not.toHaveAttribute('data-e2e-selected-bodies', /.+/);
  await expect(moveRows).toHaveCount(0);
  await page.keyboard.press('Escape');

  await startMove(page);
  await cycleSelectionFilter(page, 'Sketch');
  await pickProfile();
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(ask).toHaveCount(0);
  await expect(move).toHaveCount(0);
  await expect(profileCard).toBeVisible();
  await expect(moveRows).toHaveCount(1);
  await expect(page.locator('.feature-row')).toHaveCount(3);
  await expectBodyCount(page, 1);
  const applied = await backupProject(page);
  const moved = findFeature(applied, applied.featureOrder.at(-1)!);
  expect(moved).toMatchObject({
    kind: 'feature',
    data: {
      featureKind: 'transform',
      targetBodyId: bodyId,
      transform: { translation: { x: 5, y: 0, z: 0 } }
    }
  });
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expectBodyCount(page, 1);
  expect(await maxCards()).toBe(1);
});

test('an Items body pick settles the original Move and preserves Shift selection', async ({
  page
}) => {
  const { canvas, inspector, move, ask, moveRows } = await makePart(
    page,
    'Items Move guard'
  );
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Other');
  for (const label of ['Width (X)', 'Depth (Y)', 'Height (Z)']) {
    await inspector.getByLabel(label).fill('60');
  }
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expectBodyCount(page, 2);
  await expect(inspector).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await page.keyboard.press('Escape');
  const bodyRows = page.locator('.body-row-main');
  await expect(bodyRows).toHaveCount(2);
  await bodyRows.last().click();
  const otherId = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
  await bodyRows.first().click();
  const originalId = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
  expect(originalId).not.toBe(otherId);
  const maxCards = await watchCardCount(page);
  const startOriginalMove = async () => {
    await page.getByRole('button', { name: /^Move \(M\)/ }).click();
    await expect(
      move.getByRole('combobox', { name: 'Body', exact: true })
    ).toHaveValue(originalId);
    await move.getByLabel('Move X in mm').fill('5');
  };
  await startOriginalMove();
  await bodyRows.last().click({ modifiers: ['Shift'] });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(
    move.getByRole('combobox', { name: 'Body', exact: true })
  ).toHaveValue(originalId);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', originalId);
  await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /.+/);
  await expect(inspector).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);

  await bodyRows.last().click({ modifiers: ['Shift'] });
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${originalId},${otherId}`
  );
  await bodyRows.first().click();
  await startOriginalMove();
  await bodyRows.last().click();
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(ask).toHaveCount(0);
  await expect(move).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', otherId);
  await expect(moveRows).toHaveCount(1);
  await expect(page.locator('.feature-row')).toHaveCount(3);
  const applied = await backupProject(page);
  expect(findFeature(applied, applied.featureOrder.at(-1)!)).toMatchObject({
    kind: 'feature',
    data: {
      featureKind: 'transform',
      targetBodyId: originalId,
      transform: { translation: { x: 5, y: 0, z: 0 } }
    }
  });
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expectBodyCount(page, 2);
  expect(await maxCards()).toBe(1);
});

test('a manual Face-filter drag cannot resize the primitive beneath an open Move', async ({
  page
}) => {
  const { canvas, inspector, move, ask, moveRows } = await makePart(
    page,
    'Face drag Move ownership'
  );
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  const maxCards = await watchCardCount(page);
  const target = await startMove(page);
  const selected = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
  await cycleSelectionFilter(page, 'Face');
  const area = (await canvas.boundingBox())!;
  // This upper face enabled the legacy resize cursor before the guard. The
  // press and drag stay above the Move gizmo and use the actual pointer path.
  const point = {
    x: area.x + area.width * 0.5,
    y: area.y + area.height * 0.3
  };
  expect(
    await page.evaluate(
      (p) => document.elementFromPoint(p.x, p.y)?.tagName,
      point
    )
  ).toBe('CANVAS');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 72, point.y - 54, { steps: 6 });
  await page.mouse.up();
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(move.locator('p').first()).toHaveText(target);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);
  await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /.+/);
  await expect(ask).toHaveCount(0);
  await expect(inspector).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  const unchanged = await backupProject(page);
  expect(findFeature(unchanged, unchanged.featureOrder[0]!)).toMatchObject({
    kind: 'feature',
    data: {
      featureKind: 'primitive',
      dimensions: { width: 60, height: 60, depth: 60 }
    }
  });
  await move.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);
  await expectBodyCount(page, 1);

  // The reverse transition must cancel the *preview*, too. A legacy resize
  // does not arm the interaction reducer, so pressing M while still holding
  // the pointer used to leave its captured face drag running under the Move.
  const worldBounds = () =>
    canvas.evaluate(
      (element) =>
        new Promise<{ min: number[]; max: number[] }[]>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-render-policy', {
              detail: {
                resolve: (scene: {
                  bodyFaces: {
                    worldBounds: { min: number[]; max: number[] };
                  }[];
                }) => resolve(scene.bodyFaces.map((face) => face.worldBounds))
              }
            })
          );
        })
    );
  const baseline = [{ min: [0, 0, 0], max: [60, 60, 60] }];
  await expect.poll(worldBounds).toEqual(baseline);
  let facePoint: { x: number; y: number } | null = null;
  for (const [xRatio, yRatio] of [
    [0.5, 0.3],
    [0.5, 0.4],
    [0.4, 0.4],
    [0.6, 0.4],
    [0.5, 0.6]
  ]) {
    const candidate = {
      x: area.x + area.width * xRatio!,
      y: area.y + area.height * yRatio!
    };
    await page.mouse.move(candidate.x, candidate.y);
    if ((await canvas.evaluate((element) => element.style.cursor)) === 'grab') {
      facePoint = candidate;
      break;
    }
  }
  expect(facePoint).not.toBeNull();
  await page.mouse.down();
  await page.mouse.move(facePoint!.x + 24, facePoint!.y - 18, { steps: 2 });
  expect(await worldBounds()).not.toEqual(baseline);
  await page.keyboard.press('m');
  await expect(move).toBeVisible();
  await move.getByLabel('Move X in mm').fill('5');
  const movedBounds = [{ min: [5, 0, 0], max: [65, 60, 60] }];
  await expect.poll(worldBounds).toEqual(movedBounds);
  await page.mouse.move(facePoint!.x + 96, facePoint!.y - 72, { steps: 6 });
  expect(await worldBounds()).toEqual(movedBounds);
  await page.mouse.up();
  await expect.poll(worldBounds).toEqual(movedBounds);
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(move.locator('p').first()).toHaveText(target);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);
  await expect(ask).toHaveCount(0);
  await expect(inspector).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);
  const afterRelease = await backupProject(page);
  expect(
    findFeature(afterRelease, afterRelease.featureOrder[0]!)
  ).toMatchObject({
    kind: 'feature',
    data: {
      featureKind: 'primitive',
      dimensions: { width: 60, height: 60, depth: 60 }
    }
  });
  await move.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(move).toHaveCount(0);
  await expect.poll(worldBounds).toEqual(baseline);
  expect(await maxCards()).toBe(1);
});
