import type { Page } from '@playwright/test';
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
 * M09 curvature and zebra overlays in a real browser, on the same query and
 * overlay path as draft (`analysis-overlays.spec.ts`).
 */
function blockAndBall(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    bodyName: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 30, height: 20, depth: 10 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Ball',
    bodyName: 'Ball',
    primitiveKind: 'sphere',
    dimensions: { radius: 8 }
  });
  return transformBody(document, {
    name: 'Place the ball',
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

test(
  'maps exact curvature and reflects zebra stripes from exact normals, each with its provenance and limits (M09)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const document = blockAndBall('Curvature and zebra');
    await openDocument(page, document);
    await expectBodyCount(page, 2);
    const onScreen = [document.bodyOrder[0], document.bodyOrder.at(-1)].sort();

    await switchAnalysis(page, 'Curvature analysis');
    const curvature = page.getByRole('region', { name: 'Curvature analysis' });
    // Mean curvature: the ball is 1/8 mm⁻¹ everywhere, the block flat.
    await expect(curvature.getByRole('status')).toHaveText(
      'Tightest radius 8 mm (exact) on Ball, face 1. Mean curvature 0 1/mm to 0.125 1/mm.',
      { timeout: 60_000 }
    );
    await expect(curvature.getByRole('list', { name: 'Legend' })).toContainText(
      'Convex · 0.125 1/mm'
    );
    await expect(curvature.getByRole('note')).toContainText(
      '8 of 8 face ranges exact.'
    );
    await expect(curvature).toContainText('one tight face mutes the rest');
    await expect
      .poll(async () =>
        (await renderState(page)).analysisOverlays
          .map((overlay) => overlay.bodyId)
          .sort()
      )
      .toEqual(onScreen);

    // Gaussian measures again: 1/64 mm⁻² on the ball.
    await curvature
      .getByRole('combobox', { name: 'Measure' })
      .selectOption('gaussian');
    await expect(curvature.getByRole('status')).toHaveText(
      /Gaussian curvature 0 1\/mm² to 0\.0156 1\/mm²\.$/,
      { timeout: 60_000 }
    );

    // Zebra replaces it: one analysis at a time.
    await switchAnalysis(page, 'Zebra analysis');
    await expect(curvature).toHaveCount(0);
    const zebra = page.getByRole('region', { name: 'Zebra analysis' });
    await expect(zebra.getByRole('status')).toHaveText(
      /^[\d,]+ exact normals on 8 faces\.$/,
      { timeout: 60_000 }
    );
    await expect(zebra).toContainText('read by eye');
    await expect
      .poll(async () => (await renderState(page)).analysisOverlays.length)
      .toBe(2);
    await zebra.getByRole('spinbutton', { name: 'Stripes' }).fill('20');
    await expect(zebra.getByRole('status')).toHaveText(
      /exact normals on 8 faces\.$/
    );

    await zebra.getByRole('button', { name: 'Turn off' }).click();
    await expect(zebra).toHaveCount(0);
    await expect
      .poll(async () => (await renderState(page)).analysisOverlays.length)
      .toBe(0);
  }
);
