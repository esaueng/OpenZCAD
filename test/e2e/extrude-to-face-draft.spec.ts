import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  addSketchFeature,
  attachDerivedState,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ExtrudeToFaceTarget,
  type ProjectDocument
} from '@openzcad/shared';
import { faceSketchAttachment } from '../../apps/web/src/lib/faceSketchAttachment';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  setInPlaceOptionValues,
  waitForStillViewport,
  barChoice,
  chooseBarOption,
  clickWorldPoint,
  editExtrudeFromHistory,
  chooseInPlaceOption,
  extrudeBar,
  expectFeatureMeasurement,
  setBarValues
} from './openzcad-fixtures';

/**
 * F01 (schema v29): an extrude reaches a face picked in the viewport, with a
 * draft; and a to-face extrude whose face was deleted shows its unresolved
 * state and is repaired by re-picking a face from its History menu. F01
 * (schema v113): an offset from the face stops the extrusion short of it.
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
  await page.getByRole('button', { name: 'New project' }).click();
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

// The edit's bar is its only surface: there is no card to close it from.
for (const action of ['Cancel']) {
  test(`closing an armed extrude editor with ${action} restores viewport selection`, async ({
    page
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const ceiling = slab(
      createProjectDocument('Cancel face pick', toUserId('user_e2e')),
      'Ceiling',
      25
    );
    const sketched = addSketchFeature(ceiling.document, {
      name: 'Post sketch',
      plane: 'XY',
      objects: [SQUARE]
    });
    const document = extrudeSketch(sketched.document, {
      name: 'Post',
      sketchId: sketched.sketchId,
      distance: 5
    }).document;
    const top = await faceOf(document, ceiling.bodyId, 1);
    const canvas = await open(page, document);
    const point = await pointOverFace(page, canvas, top.topologyId);
    const edit = await editExtrudeFromHistory(
      page,
      page.locator('.feature-row-main', { hasText: /^Post$/ }),
      'Post'
    );
    // To face arms the face pick at once.
    await chooseBarOption(edit, 'Extent', 'To face');
    await expect(edit).toContainText('Click a face facing the sketch');
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(edit).toHaveCount(0);
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.click(bounds.x + 10, bounds.y + 10);
    await page.mouse.click(point.x, point.y);
    await expect(canvas).toHaveAttribute(
      'data-e2e-selected-face',
      top.topologyId
    );
    expect(errors).toEqual([]);
    await testInfo.attach('face-selection-after-close', {
      body: await page.screenshot(),
      contentType: 'image/png'
    });
  });
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
  // Opening Extrude glides the post's profile out from under the card. Let
  // it, then find the ceiling's face in the view that leaves: reopened, the
  // profile is already clear and nothing moves.
  const bar = extrudeBar(page);
  await page.locator('.feature-row-main', { hasText: 'Post sketch' }).click();
  await page.keyboard.press('e');
  await expect(bar).toBeVisible();
  await waitForStillViewport(page);
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  const point = await pointOverFace(page, canvas, top.topologyId);

  await page.locator('.feature-row-main', { hasText: 'Post sketch' }).click();
  await page.keyboard.press('e');
  // Explicit: inferred, a post through the ceiling would add to it.
  await chooseInPlaceOption(page, 'Extrude', 'Operation', 'New body');
  // To face arms its face pick at once; Done waits for the face.
  await chooseInPlaceOption(page, 'Extrude', 'Extent', 'To face');
  await expect(bar).toContainText('Click a face facing the sketch');
  await expect(bar.getByRole('button', { name: 'Done' })).toBeDisabled();
  await page.mouse.click(point.x, point.y);
  await expect(bar).toContainText('Up to Ceiling Body · face');
  // The draft on its keypad, from Options; Done creates it.
  await setInPlaceOptionValues(page, 'Extrude', { 'Draft angle': '2' });
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Extruded region up to the face as a new body.',
    { timeout: 60_000 }
  );
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expectBodyCount(page, 2);

  // The history row names the extent and the draft; the edit reopens on
  // what was stored, not the dormant distance.
  const post = page.locator('.feature-row', { hasText: 'Extrude' }).last();
  await expect(post).toContainText('To face · 2° draft');
  const edit = await editExtrudeFromHistory(
    page,
    post.locator('.feature-row-main')
  );
  await expect(barChoice(edit, 'Extent', 'To face')).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(edit).toContainText('Up to Ceiling Body · face');
  await edit.locator('details.in-place-command-options summary').click();
  await expect(
    edit.getByRole('button', { name: 'Draft angle', exact: true })
  ).toHaveText('2°');
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

  await open(page, document);
  // Only the roof is drawn: the post is unresolved, said by name.
  await expectBodyCount(page, 1);
  const row = page.locator('.feature-row', { hasText: 'Post' }).last();
  // The roof can render before the final failed Post result is published.
  // Edit only once History has committed the unresolved feature state.
  await expect(row).toHaveClass(/\bfailed\b/);
  const unresolved = await editExtrudeFromHistory(
    page,
    row.locator('.feature-row-main'),
    'Post'
  );
  await expect(unresolved).toContainText(
    'The target face no longer exists here; pick a face again.'
  );
  await expect(unresolved.getByRole('button', { name: 'Done' })).toBeDisabled();
  await unresolved.getByRole('button', { name: 'Cancel' }).click();
  await expect(unresolved).toHaveCount(0);
  await waitForStillViewport(page);
  await expect(row).toHaveClass(/\bfailed\b/);

  await row
    .getByRole('button', { name: 'More actions for Post', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Re-pick face…' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Re-pick the face "Post" reaches'
  );
  // The roof's top face is centered at (10, 10, 19).
  await clickWorldPoint(page, [10, 10, 19]);
  await expect(page.getByRole('contentinfo')).toContainText(
    '"Post" reaches the re-picked face.',
    { timeout: 60_000 }
  );
  await expectBodyCount(page, 2);
  const repaired = await editExtrudeFromHistory(
    page,
    row.locator('.feature-row-main'),
    'Post'
  );
  await expect(repaired).toContainText('Up to Roof Body · face');
  await expect(repaired).not.toContainText('no longer exists');
});

test('editing an unchanged to-face extrude ignores later target transforms', async ({
  page
}) => {
  test.setTimeout(120_000);
  const ceiling = slab(
    createProjectDocument('History-position reach', toUserId('user_e2e')),
    'Ceiling',
    25
  );
  const { target } = await faceOf(ceiling.document, ceiling.bodyId, -1);
  const sketched = addSketchFeature(ceiling.document, {
    name: 'Profile',
    plane: 'XY',
    offset: 0,
    objects: [SQUARE]
  });
  const post = extrudeSketch(sketched.document, {
    name: 'Post',
    sketchId: sketched.sketchId,
    distance: 1,
    endCondition: 'to-face',
    toFace: target
  });
  const later = transformBody(post.document, {
    name: 'Later tilt',
    targetBodyId: ceiling.bodyId,
    translation: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 90, y: 0, z: 0 }
  });
  await open(page, later.document);
  await expectBodyCount(page, 2);
  const edit = await editExtrudeFromHistory(
    page,
    page.locator('.feature-row-main', { hasText: /^Post$/ }),
    'Post'
  );
  await expect(edit.getByRole('button', { name: 'Done' })).toBeEnabled();
  await edit.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edit Post');
  await expect(edit).toHaveCount(0);
  await expectBodyCount(page, 2);
});

test(
  'offsets a to-face extrude short of its face, refuses an offset past the sketch plane, and undoes',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const ceiling = slab(
      createProjectDocument('Offset from face', toUserId('user_e2e')),
      'Ceiling',
      25
    );
    const { target } = await faceOf(ceiling.document, ceiling.bodyId, -1);
    const sketched = addSketchFeature(ceiling.document, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      objects: [SQUARE]
    });
    const document = extrudeSketch(sketched.document, {
      name: 'Post',
      sketchId: sketched.sketchId,
      distance: 1,
      endCondition: 'to-face',
      toFace: target
    }).document;
    await open(page, document);
    await expectBodyCount(page, 2);
    const row = page.locator('.feature-row', { hasText: /Post/ }).last();
    const rowMain = page.locator('.feature-row-main', { hasText: /^Post$/ });
    await expect(row).toContainText('To face');
    // 4 × 4 up to the underside at z = 25.
    await expectFeatureMeasurement(page, row, '400');

    const edit = await editExtrudeFromHistory(page, rowMain, 'Post');
    await setBarValues(page, edit, { 'Offset from face': '5' });
    await expect(
      edit.getByRole('button', {
        name: 'Offset from face',
        exact: true,
        includeHidden: true
      })
    ).toHaveText('5 mm');
    await edit.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('contentinfo')).toContainText('Edit Post', {
      timeout: 60_000
    });
    await expect(edit).toHaveCount(0);
    await expect(row).toContainText('To face · 5 mm short');
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    // Stopped 5 short: 4 × 4 × 20.
    await expectFeatureMeasurement(page, row, '320');

    // An offset as long as the reach would leave nothing: refused before
    // Done, and nothing is written.
    const again = await editExtrudeFromHistory(page, rowMain, 'Post');
    await setBarValues(page, again, { 'Offset from face': '30' });
    await expect(again).toContainText('reaches the sketch plane');
    await expect(again.getByRole('button', { name: 'Done' })).toBeDisabled();
    await again.getByRole('button', { name: 'Cancel' }).click();
    await expect(again).toHaveCount(0);
    await expect(row).toContainText('To face · 5 mm short');

    // Undo restores the extrude that ends on the face.
    await waitForStillViewport(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(row).not.toContainText('short');
    await expect(row).toContainText('To face');
    await expectFeatureMeasurement(page, row, '400');
    expect(errors).toEqual([]);
  }
);

test(
  'starts a to-face extrude off its sketch plane, refuses a start on the face, and undoes',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const ceiling = slab(
      createProjectDocument('Start offset', toUserId('user_e2e')),
      'Ceiling',
      25
    );
    const { target } = await faceOf(ceiling.document, ceiling.bodyId, -1);
    const sketched = addSketchFeature(ceiling.document, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      objects: [SQUARE]
    });
    const document = extrudeSketch(sketched.document, {
      name: 'Post',
      sketchId: sketched.sketchId,
      distance: 1,
      endCondition: 'to-face',
      toFace: target
    }).document;
    await open(page, document);
    await expectBodyCount(page, 2);
    const row = page.locator('.feature-row', { hasText: /Post/ }).last();
    const rowMain = page.locator('.feature-row-main', { hasText: /^Post$/ });
    await expectFeatureMeasurement(page, row, '400');

    // F01 (v121): starting 5 above the sketch plane, the post still ends on
    // the face: 4 × 4 × 20.
    const edit = await editExtrudeFromHistory(page, rowMain, 'Post');
    await setBarValues(page, edit, { 'Start offset': '5' });
    await expect(
      edit.getByRole('button', {
        name: 'Start offset',
        exact: true,
        includeHidden: true
      })
    ).toHaveText('5 mm');
    await edit.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('contentinfo')).toContainText('Edit Post', {
      timeout: 60_000
    });
    await expect(edit).toHaveCount(0);
    await expect(row).toContainText('To face · starts 5 mm off');
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expectFeatureMeasurement(page, row, '320');

    // A start on the face leaves nothing: refused before Done.
    const again = await editExtrudeFromHistory(page, rowMain, 'Post');
    await setBarValues(page, again, { 'Start offset': '25' });
    await expect(again).toContainText('Start offset reaches the face');
    await expect(again.getByRole('button', { name: 'Done' })).toBeDisabled();
    await again.getByRole('button', { name: 'Cancel' }).click();
    await expect(again).toHaveCount(0);
    await expect(row).toContainText('starts 5 mm off');

    await waitForStillViewport(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(row).not.toContainText('starts');
    await expectFeatureMeasurement(page, row, '400');
    expect(errors).toEqual([]);
  }
);

test(
  'drafts each side of a symmetric extrude from the bar, and undoes',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const sketched = addSketchFeature(
      createProjectDocument('Per-side draft', toUserId('user_e2e')),
      { name: 'Profile', plane: 'XY', offset: 0, objects: [SQUARE] }
    );
    const document = extrudeSketch(sketched.document, {
      name: 'Boss',
      sketchId: sketched.sketchId,
      distance: 10,
      symmetric: true
    }).document;
    await open(page, document);
    await expectBodyCount(page, 1);
    const row = page.locator('.feature-row', { hasText: /Boss/ }).last();
    const rowMain = page.locator('.feature-row-main', { hasText: /^Boss$/ });
    await expectFeatureMeasurement(page, row, '160');

    // F01 (v126): a 2° draft on the front half only: one 4 × 4 frustum of
    // height 5 (73.22) beside a straight 4 × 4 × 5 half (80).
    const edit = await editExtrudeFromHistory(page, rowMain, 'Boss');
    await setBarValues(page, edit, { 'Draft angle': '2' });
    await edit.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('contentinfo')).toContainText('Edit Boss', {
      timeout: 60_000
    });
    await expect(edit).toHaveCount(0);
    await expect(row).toContainText('10 mm symmetric · 2° draft');
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expectFeatureMeasurement(page, row, '153.2');

    // The back half takes its own 2° draft: two frustums (146.44).
    const again = await editExtrudeFromHistory(page, rowMain, 'Boss');
    await setBarValues(page, again, { 'Back draft angle': '2' });
    await again.getByRole('button', { name: 'Done' }).click();
    await expect(again).toHaveCount(0);
    await expect(row).toContainText('2° draft · 2° back draft');
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expectFeatureMeasurement(page, row, '146.4');

    await waitForStillViewport(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(row).not.toContainText('back draft');
    await expectFeatureMeasurement(page, row, '153.2');
    expect(errors).toEqual([]);
  }
);

test(
  'ends a to-face extrude on a slanted face, offsets it square to the face, and undoes',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const ceiling = slab(
      createProjectDocument('Slanted face', toUserId('user_e2e')),
      'Ceiling',
      25
    );
    // The face is named while level, then its lift turns it 10° about X
    // through the middle of its underside, over the post's middle.
    const { target } = await faceOf(ceiling.document, ceiling.bodyId, -1);
    const lift = listFeaturesInOrder(ceiling.document).find(
      (feature) => feature.name === 'Lift Ceiling'
    )!;
    const turned = updateFeature(ceiling.document, {
      featureId: lift.featureId,
      data: {
        transform: {
          translation: { x: 0, y: 0, z: 25 },
          rotationDeg: { x: 10, y: 0, z: 0 },
          pivot: { x: 10, y: 10, z: 0 }
        }
      }
    });
    const sketched = addSketchFeature(turned, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      objects: [SQUARE]
    });
    const document = extrudeSketch(sketched.document, {
      name: 'Post',
      sketchId: sketched.sketchId,
      distance: 1,
      endCondition: 'to-face',
      toFace: target
    }).document;
    await open(page, document);
    await expectBodyCount(page, 2);
    const row = page.locator('.feature-row', { hasText: /Post/ }).last();
    const rowMain = page.locator('.feature-row-main', { hasText: /^Post$/ });
    await expect(row).toContainText('To face');
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    // The slanted top's mean height is 25 over the 4 × 4 profile.
    await expectFeatureMeasurement(page, row, '400');

    // 3 short, square to the face: 3 / cos 10° lower over the middle.
    const edit = await editExtrudeFromHistory(page, rowMain, 'Post');
    await setBarValues(page, edit, { 'Offset from face': '3' });
    await edit.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('contentinfo')).toContainText('Edit Post', {
      timeout: 60_000
    });
    await expect(edit).toHaveCount(0);
    await expect(row).toContainText('To face · 3 mm short');
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expectFeatureMeasurement(page, row, '351.2');

    await waitForStillViewport(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(row).not.toContainText('short');
    await expectFeatureMeasurement(page, row, '400');
    expect(errors).toEqual([]);
  }
);

test(
  'creates an extrude up to a cylindrical face picked in the viewport',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    let document = createProjectDocument(
      'To a curved face',
      toUserId('user_e2e')
    );
    // A log of radius 10 lying along Y, its axis at x = 0, z = 30.
    document = addPrimitiveFeature(document, {
      name: 'Log',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height: 40 }
    });
    const logId = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Lay',
      targetBodyId: logId,
      translation: { x: 0, y: 0, z: 10 },
      rotationDeg: { x: 90, y: 0, z: 0 },
      pivot: { x: 0, y: 0, z: 20 }
    }).document;
    document = addSketchFeature(document, {
      name: 'Post sketch',
      plane: 'XY',
      offset: 0,
      objects: [{ ...SQUARE, centerX: 0, centerY: 0 }]
    }).document;
    const adapter = await createExactKernelAdapter();
    const wall = (await adapter.syncDocument(document)).bodyRepresentations[
      logId
    ]!.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const canvas = await open(page, document);
    const bar = extrudeBar(page);
    await page.locator('.feature-row-main', { hasText: 'Post sketch' }).click();
    await page.keyboard.press('e');
    await expect(bar).toBeVisible();
    await waitForStillViewport(page);
    await page.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
    const point = await pointOverFace(page, canvas, wall.topologyId);

    await page.locator('.feature-row-main', { hasText: 'Post sketch' }).click();
    await page.keyboard.press('e');
    await chooseInPlaceOption(page, 'Extrude', 'Operation', 'New body');
    await chooseInPlaceOption(page, 'Extrude', 'Extent', 'To face');
    await expect(bar).toContainText('Click a face facing the sketch');
    await page.mouse.click(point.x, point.y);
    await expect(bar).toContainText('Up to Log Body · face');
    await bar.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Extruded region up to the face as a new body.',
      { timeout: 60_000 }
    );
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expectBodyCount(page, 2);
    const post = page.locator('.feature-row', { hasText: 'Extrude' }).last();
    await expect(post).toContainText('To face');
    // Up to the log's underside, z = 30 − √(100 − x²), over the 4 × 4.
    await expectFeatureMeasurement(page, post, '321.07');
  }
);
