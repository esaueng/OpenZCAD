import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  addSketchFeature,
  attachDerivedState,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ExtrudeToFaceTarget,
  type ProjectDocument
} from '@openzcad/shared';
import { faceSketchAttachment } from '../../apps/web/src/lib/faceSketchAttachment';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

/**
 * F01 (schema v29): an extrude reaches a face picked in the viewport, with a
 * draft; and a to-face extrude whose face was deleted shows its unresolved
 * state and is repaired by re-picking a face from its History menu.
 */

/** The 4 × 4 profile at (10, 10) on XY that every extrude here sweeps. */
const SQUARE = {
  objectKind: 'rectangle' as const,
  width: 4,
  height: 4,
  centerX: 10,
  centerY: 10
};

/** A 20 × 20 × 1 slab named `name`, its underside lifted to `z`. */
function slab(document: ProjectDocument, name: string, z: number) {
  const made = addPrimitiveFeature(document, {
    name,
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 1 }
  });
  const bodyId = made.bodyOrder.at(-1)!;
  return {
    document: transformBody(made, {
      name: `Lift ${name}`,
      targetBodyId: bodyId,
      translation: { x: 0, y: 0, z }
    }).document,
    bodyId
  };
}

/** The topology id and target of `bodyId`'s face whose normal is `nz` on Z. */
async function faceOf(
  document: ProjectDocument,
  bodyId: BodyId,
  nz: 1 | -1
): Promise<{ topologyId: string; target: ExtrudeToFaceTarget }> {
  const adapter = await createExactKernelAdapter();
  const built = attachDerivedState(
    document,
    await adapter.syncDocument(document)
  );
  const face = built.derived.bodyRepresentations[bodyId]!.topology!.faces.find(
    (candidate) => (candidate.geometry?.normal?.z ?? 0) * nz > 0.99
  )!;
  const attachment = faceSketchAttachment({
    bodyId,
    pickedHash: face.hash,
    face
  });
  if (!attachment.ok || attachment.attachment !== 'associative') {
    throw new Error('Expected an associative planar face.');
  }
  return {
    topologyId: face.topologyId,
    target: attachment.planeRef as ExtrudeToFaceTarget
  };
}

async function open(page: Page, document: ProjectDocument) {
  await stubApi(page);
  // Served as a saved document: canonical content only, no derived meshes.
  const served = {
    ...document,
    derived: createProjectDocument(document.name, toUserId('user_e2e')).derived
  };
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            project: {
              projectId: served.projectId,
              name: served.name,
              revisionCount: 1,
              updatedAt: new Date().toISOString()
            },
            document: served
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
  await expect(page.getByRole('contentinfo')).not.toContainText('Rebuilding', {
    timeout: 60_000
  });
  return canvas;
}

/** A viewport point whose click selects the face `topologyId`. */
async function pointOverFace(
  page: Page,
  canvas: Locator,
  topologyId: string
): Promise<{ x: number; y: number }> {
  const bounds = (await canvas.boundingBox())!;
  for (let row = 2; row < 9; row += 1) {
    for (let column = 2; column < 9; column += 1) {
      const x = bounds.x + (bounds.width * column) / 10;
      const y = bounds.y + (bounds.height * row) / 10;
      await page.mouse.click(x, y);
      await page.waitForTimeout(120);
      if (
        (await canvas.getAttribute('data-e2e-selected-face')) === topologyId
      ) {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        return { x, y };
      }
    }
  }
  throw new Error(`No viewport point selects face ${topologyId}.`);
}

test('creates a drafted extrude up to a face picked in the viewport', async ({
  page
}) => {
  test.setTimeout(180_000);
  let document = createProjectDocument('To face', toUserId('user_e2e'));
  const ceiling = slab(document, 'Ceiling', 25);
  document = addSketchFeature(ceiling.document, {
    name: 'Post sketch',
    plane: 'XY',
    offset: 0,
    objects: [SQUARE]
  }).document;
  // From the default view the ceiling's top face (z = 26) is the one in sight.
  const top = await faceOf(document, ceiling.bodyId, 1);
  const canvas = await open(page, document);
  const point = await pointOverFace(page, canvas, top.topologyId);

  await page.locator('.feature-row-main', { hasText: 'Post sketch' }).click();
  await page.keyboard.press('e');
  const card = page.getByRole('region', { name: 'Extrude operation' });
  // Explicit: inferred, a post through the ceiling would add to it.
  await page
    .getByRole('combobox', { name: 'Extrude operation', exact: true })
    .selectOption('new-body');
  await card.getByLabel('Extent').selectOption('to-face');
  await expect(card).toContainText('No face picked yet.');
  await expect(
    card.getByRole('button', { name: 'Create', exact: true })
  ).toBeDisabled();
  await card.getByRole('button', { name: 'Pick face' }).click();
  await expect(card).toContainText(
    'Click a planar face parallel to the sketch'
  );
  await page.mouse.click(point.x, point.y);
  await expect(card).toContainText('Up to Ceiling Body · face');
  await card.getByRole('textbox', { name: 'Draft angle' }).fill('2');
  await card.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Extruded region up to the face as a new body.',
    { timeout: 60_000 }
  );
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expectBodyCount(page, 2);

  // The history row names the extent and the draft; the card reopens on
  // what was stored, not the dormant distance.
  const post = page.locator('.feature-row', { hasText: 'Extrude' }).last();
  await expect(post).toContainText('To face · 2° draft');
  await post.locator('.feature-row-main').click();
  await expect(page.getByLabel('Extent')).toHaveValue('to-face');
  await expect(page.locator('.panel-body')).toContainText(
    'Up to Ceiling Body · face'
  );
  await expect(page.getByRole('textbox', { name: 'Draft angle' })).toHaveValue(
    '2'
  );
});

test('shows an unresolved to-face extrude and repairs it by re-picking a face', async ({
  page
}) => {
  test.setTimeout(180_000);
  let document = createProjectDocument('To face repair', toUserId('user_e2e'));
  const roof = slab(document, 'Roof', 18);
  const ceiling = slab(roof.document, 'Ceiling', 25);
  const sketched = addSketchFeature(ceiling.document, {
    name: 'Post sketch',
    plane: 'XY',
    offset: 0,
    objects: [SQUARE]
  });
  const underside = await faceOf(sketched.document, ceiling.bodyId, -1);
  document = extrudeSketch(sketched.document, {
    name: 'Post',
    sketchId: sketched.sketchId,
    distance: 25,
    endCondition: 'to-face',
    toFace: underside.target
  }).document;
  // The roof's top face (z = 19) is what the re-pick will reach.
  const roofTop = await faceOf(document, roof.bodyId, 1);
  const ceilingFeature = listFeaturesInOrder(document).find(
    (feature) => feature.name === 'Ceiling'
  )!;
  const liftCeiling = listFeaturesInOrder(document).find(
    (feature) => feature.name === 'Lift Ceiling'
  )!;
  document = deleteFeature(
    deleteFeature(document, { featureId: liftCeiling.featureId }),
    { featureId: ceilingFeature.featureId }
  );

  const canvas = await open(page, document);
  // Only the roof is drawn: the post is unresolved, said by name.
  await expectBodyCount(page, 1);
  const row = page.locator('.feature-row', { hasText: 'Post' }).last();
  await row.locator('.feature-row-main').click();
  await expect(page.locator('.panel-body')).toContainText(
    'Target face is unresolved'
  );
  await page.getByRole('button', { name: 'Close panel' }).click();
  const point = await pointOverFace(page, canvas, roofTop.topologyId);

  await row.locator('.feature-row-main').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Re-pick face…' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Re-pick the face "Post" reaches'
  );
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole('contentinfo')).toContainText(
    '"Post" reaches the re-picked face.',
    { timeout: 60_000 }
  );
  await expectBodyCount(page, 2);
  await row.locator('.feature-row-main').click();
  await expect(page.locator('.panel-body')).toContainText(
    'Up to Roof Body · face'
  );
  await expect(page.locator('.panel-body')).not.toContainText('unresolved');
});
