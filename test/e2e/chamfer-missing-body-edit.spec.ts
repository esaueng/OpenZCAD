import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  listFeaturesInOrder,
  setNodeMetadata
} from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { revealModelPanel } from './openzcad-fixtures';
import { test, expect, stubApi } from './openzcad-fixtures';
import { editTargetMissingSentence } from '../../apps/web/src/lib/refusalLanguage';

/**
 * A Chamfer whose body is not built (the box that makes it is suppressed)
 * carries the adapter's typed `target_body_unavailable`. Opening its edit
 * from History used to arm edge picking and ask for edges on a body the
 * viewport does not have. It now says, from the code, that the body is not
 * built and how to recover, asks for no pick, and leaves Done disabled. A
 * second box keeps the viewport from being empty. Both boxes are invented.
 */

const SENTENCE = editTargetMissingSentence(
  { code: 'target_body_unavailable' },
  'chamfer'
)!;

/** A suppressed box with a Chamfer on it, beside a live plate. */
async function openChamferWithoutBody(page: Page): Promise<void> {
  let document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument('Chamfer without body', toUserId('user_e2e')),
    {
      name: 'Box',
      bodyName: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 6, height: 6, depth: 6 }
    }
  );
  const box = listFeaturesInOrder(document)[0]!;
  document = chamferEdges(document, {
    name: 'Chamfer',
    targetBodyId: document.bodyOrder[0]!,
    edgeHashes: [1, 2],
    size: 1
  }).document;
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    bodyName: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 12, height: 12, depth: 2 }
  });
  document = setNodeMetadata(document, {
    nodeId: box.id,
    metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
  });
  await stubApi(page);
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

test(
  'opens the edit of a Chamfer whose body is not built with a typed refusal, not an edge pick',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openChamferWithoutBody(page);
    await revealModelPanel(page, 'History');
    const chamfer = page.locator('.feature-row', { hasText: /^Chamfer/ });
    await expect(chamfer).toHaveClass(/\b(failed|needs-repair)\b/, {
      timeout: 30_000
    });

    await chamfer.locator('.feature-row-main').click();
    const edit = page.getByRole('group', { name: 'Edit Chamfer command' });
    await expect(edit).toBeVisible({ timeout: 30_000 });
    const status = edit.getByRole('status');
    await expect(status).toContainText(SENTENCE, { timeout: 30_000 });
    await expect(status).not.toContainText(/click the edges/i);
    await expect(edit).toContainText('Needs attention');
    await expect(edit.getByRole('button', { name: 'Done' })).toBeDisabled();
    // No "pick it again" on the status line either.
    await expect(page.getByText(/no longer resolves/)).toHaveCount(0);

    await edit.getByRole('button', { name: 'Cancel' }).click();
    await expect(edit).toHaveCount(0);
    expect(errors).toEqual([]);
  }
);
