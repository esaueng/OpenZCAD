import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  createProject,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * M09 analysis overlays in a real browser. The Display menu switches an
 * analysis on; the geometry worker runs the exact kernel query on the bodies
 * on screen; the viewport draws the coloured overlay over each body; the
 * panel gives the legend, where the numbers come from and what they do not
 * cover. Turning it off clears the overlay.
 */
function blockAndPin(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    bodyName: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 30, height: 20, depth: 10 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Pin',
    bodyName: 'Pin',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: 20 }
  });
  return transformBody(document, {
    name: 'Place the pin',
    targetBodyId: document.bodyOrder.at(-1) as BodyId,
    translation: { x: 40, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  }).document;
}

async function openDocument(page: Page, document: ProjectDocument) {
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
  await createProject(page, document.name);
}

interface AnalysisRenderState {
  analysisOverlays: { bodyId: string; vertices: number }[];
}

async function renderState(page: Page): Promise<AnalysisRenderState> {
  return page.locator('.viewer-host canvas').evaluate(
    (canvas: HTMLCanvasElement) =>
      new Promise<AnalysisRenderState>((resolve) => {
        canvas.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: { resolve }
          })
        );
      })
  );
}

async function switchAnalysis(page: Page, name: string) {
  await page.getByRole('button', { name: /^Display mode \(W\)/ }).click();
  await page
    .getByRole('group', { name: 'Display' })
    .getByRole('button', { name })
    .click();
}

async function expectBesideDisplayButton(page: Page, panel: Locator) {
  const trigger = page.getByRole('button', { name: /^Display mode \(W\)/ });
  await expect
    .poll(async () => {
      const card = await panel.boundingBox();
      const button = await trigger.boundingBox();
      if (!card || !button) return 'unmeasured';
      const gap = button.x - (card.x + card.width);
      const level = Math.abs(card.y + 6 - button.y);
      return gap > 0 && gap < 32 && level < 4 ? 'beside' : { gap, level };
    })
    .toBe('beside');
}

test(
  'draws an exact draft analysis over the bodies, with its legend, provenance and limits (M09)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const document = blockAndPin('Draft analysis');
    await openDocument(page, document);
    await expectBodyCount(page, 2);

    await switchAnalysis(page, 'Draft analysis');
    const panel = page.getByRole('region', { name: 'Draft analysis' });
    const status = panel.getByRole('status');
    // Pull +Z: each top drafts toward it and each bottom away; the block's
    // four walls and the pin's wall are vertical.
    await expect(status).toHaveText(
      '2 faces drafted away, 5 faces below the minimum.',
      { timeout: 60_000 }
    );
    await expect(panel.getByRole('note')).toBeHidden();
    await panel.getByText('Details', { exact: true }).click();
    await expect(panel.getByRole('note')).toContainText(
      'Exact at sample points'
    );
    await expect(panel.getByRole('note')).toContainText('8 of 9 faces exact.');
    await expect(panel).toContainText('not a parting-line check');
    await expect
      .poll(async () =>
        (await renderState(page)).analysisOverlays
          .map((overlay) => overlay.bodyId)
          .sort()
      )
      .toEqual([document.bodyOrder[0], document.bodyOrder.at(-1)].sort());
    for (const overlay of (await renderState(page)).analysisOverlays)
      expect(overlay.vertices).toBeGreaterThan(0);

    // A stricter minimum recolours what was measured, and a pull along X
    // measures again: the pin's wall now runs from −90° to 90° and its ends
    // are vertical.
    const minimum = panel.getByRole('spinbutton', {
      name: 'Min draft (°)'
    });
    await minimum.fill('5');
    await expect(panel.getByRole('list', { name: 'Legend' })).toContainText(
      '≥ 5° · 2'
    );
    await panel.getByRole('radio', { name: '+X' }).click();
    await expect(status).toHaveText(
      /^1 face drafted away, 6 faces below the minimum, 1 face crossing bands\./,
      { timeout: 60_000 }
    );

    // The card stands beside the Display button, in Build's rail and in
    // Tweak's bar (which sits outside the viewer), not over the model.
    await expectBesideDisplayButton(page, panel);
    await page.getByRole('button', { name: 'Tweak', exact: true }).click();
    await expectBesideDisplayButton(page, panel);

    // Off from the panel: the overlay goes with it.
    await panel.getByRole('button', { name: 'Turn off' }).click();
    await expect(panel).toHaveCount(0);
    await expect
      .poll(async () => (await renderState(page)).analysisOverlays.length)
      .toBe(0);
  }
);
