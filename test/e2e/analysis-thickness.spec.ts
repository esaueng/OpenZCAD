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
 * M09 wall thickness in a real browser, on the same query and overlay path as
 * draft (`analysis-overlays.spec.ts`): the ray method on the exact solid,
 * labelled approximate except where parallel planar walls make it exact.
 */
function plateAndPin(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    bodyName: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 30, depth: 2 }
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
    translation: { x: 60, y: 0, z: 0 },
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
  'measures wall thickness on the exact solid, flags walls below the minimum, and labels what is approximate (M09)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const document = plateAndPin('Wall thickness');
    await openDocument(page, document);
    await expectBodyCount(page, 2);

    await switchAnalysis(page, 'Thickness analysis');
    const panel = page.getByRole('region', { name: 'Thickness analysis' });
    const status = panel.getByRole('status');
    // The default minimum is 1 mm: the 2 mm plate passes it.
    await expect(status).toHaveText(
      /^Thinnest wall 2 mm \(exact\) on Plate, face \d+\. Every face at least 1 mm\.$/,
      { timeout: 60_000 }
    );
    // Parallel planes are exact; the pin's wall is traced through its axis.
    // The notes wait behind Details, closed by default.
    await expect(panel.getByRole('note')).toBeHidden();
    await panel.getByText('Details', { exact: true }).click();
    const note = panel.getByRole('note');
    await expect(note).toContainText('Approximate: ');
    await expect(note).toContainText('8 of 9 faces exact.');
    await expect(note).toContainText('Resolution ');
    await expect(panel).toContainText('not a slicer’s or a simulation’s check');
    await expect
      .poll(async () =>
        (await renderState(page)).analysisOverlays
          .map((overlay) => overlay.bodyId)
          .sort()
      )
      .toEqual([document.bodyOrder[0], document.bodyOrder.at(-1)].sort());

    // A 3 mm print minimum: the plate's two broad faces fall below it,
    // recoloured from the same measurement.
    await panel.getByRole('spinbutton', { name: 'Min wall' }).fill('3');
    await expect(status).toHaveText(
      /^Thinnest wall 2 mm \(exact\) on Plate, face \d+\. 2 faces below the 3 mm minimum\.$/
    );
    await expect(panel.getByRole('list', { name: 'Legend' })).toContainText(
      '< 3 mm · 2'
    );

    await panel.getByRole('button', { name: 'Turn off' }).click();
    await expect(panel).toHaveCount(0);
    await expect
      .poll(async () => (await renderState(page)).analysisOverlays.length)
      .toBe(0);
  }
);
