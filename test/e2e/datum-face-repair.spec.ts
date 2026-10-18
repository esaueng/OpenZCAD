import {
  addDatumPlane,
  addPrimitiveFeature,
  attachDerivedState,
  createProjectDocument,
  deleteFeature,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type FacePlaneSource,
  type ProjectDocument
} from '@openzcad/shared';
import type { Locator } from '@playwright/test';
import { faceSketchAttachment } from '../../apps/web/src/lib/faceSketchAttachment';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * R01: an offset plane whose source face was deleted is re-attached from its
 * History menu. While the re-pick is armed, starting Measure takes viewport
 * clicks over, so a face click measures instead of repairing the plane.
 */

async function brokenDatumDocument(): Promise<ProjectDocument> {
  const adapter = await createExactKernelAdapter();
  const synced = async (document: ProjectDocument) =>
    attachDerivedState(document, await adapter.syncDocument(document));
  let document = createProjectDocument('Datum repair', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'First',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 5 }
  });
  const first = document.bodyOrder[0]!;
  document = addPrimitiveFeature(document, {
    name: 'Second',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 8 }
  });
  const second = document.bodyOrder[1]!;
  document = transformBody(document, {
    name: 'Beside',
    targetBodyId: second,
    translation: { x: 30, y: 0, z: 0 }
  }).document;
  document = await synced(document);
  const face = document.derived.bodyRepresentations[
    first
  ]!.topology!.faces.find(
    (candidate) => (candidate.geometry?.normal?.z ?? 0) > 0.99
  )!;
  const attachment = faceSketchAttachment({
    bodyId: first,
    pickedHash: face.hash,
    face
  });
  if (!attachment.ok) throw new Error(attachment.reason);
  document = addDatumPlane(document, {
    name: 'Lid plane',
    definition: {
      kind: 'offset',
      source: attachment.planeRef as FacePlaneSource,
      offset: 2
    }
  }).document;
  const firstFeature = listFeaturesInOrder(document).find(
    (feature) => feature.name === 'First'
  )!;
  // Served as a saved document: canonical content only, no derived meshes.
  const fresh = createProjectDocument('Datum repair', toUserId('user_e2e'));
  return {
    ...deleteFeature(document, { featureId: firstFeature.featureId }),
    derived: fresh.derived
  };
}

async function drawnDatumCount(canvas: Locator): Promise<number> {
  const raw = await canvas.getAttribute('data-e2e-datum-planes');
  return raw ? (JSON.parse(raw) as unknown[]).length : 0;
}

test('re-picks a lost datum face, and Measure takes the click over while armed', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  const document = await brokenDatumDocument();
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
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', /./, {
    timeout: 60_000
  });
  expect(await drawnDatumCount(canvas)).toBe(0);

  // Find a point over the remaining block: a click there selects a face.
  await expect(page.getByRole('contentinfo')).not.toContainText('Rebuilding', {
    timeout: 60_000
  });
  const bounds = (await canvas.boundingBox())!;
  let target: { x: number; y: number } | null = null;
  for (let row = 3; row < 8 && !target; row += 1) {
    for (let column = 3; column < 8 && !target; column += 1) {
      const x = bounds.x + (bounds.width * column) / 10;
      const y = bounds.y + (bounds.height * row) / 10;
      await page.mouse.click(x, y);
      await page.waitForTimeout(150);
      if (await canvas.getAttribute('data-e2e-selected-face')) {
        target = { x, y };
      }
    }
  }
  expect(target).not.toBeNull();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const point = target!;

  const arm = async () => {
    await page
      .locator('.feature-row-main', { hasText: 'Lid plane' })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Re-pick source face…' }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Re-pick the face for "Lid plane"'
    );
  };

  // Armed, then Measure: the face click measures, the plane stays broken.
  await arm();
  const measure = page
    .getByRole('button', { name: 'Measure', exact: true })
    .first();
  await measure.click();
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(3_000);
  expect(await drawnDatumCount(canvas)).toBe(0);
  await measure.click();
  await page.keyboard.press('Escape');

  // Armed again with nothing else in the way, the same click repairs it.
  await arm();
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => drawnDatumCount(canvas), { timeout: 30_000 }).toBe(1);
  await expect(page.getByRole('contentinfo')).toContainText(
    '"Lid plane" follows the re-picked face.'
  );
});
