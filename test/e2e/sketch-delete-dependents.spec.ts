import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  resolveParamValue
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { expect, revealModelPanel, stubApi, test } from './openzcad-fixtures';

/**
 * Deleting sketch geometry is an edit. It used to skip the downstream check
 * every other sketch edit runs, so deleting one side of an extruded profile
 * committed and left the extrude to fail behind a warning. It now rebuilds
 * the features on the sketch first and refuses by name when one would break,
 * while a delete the dependents survive still commits.
 */

const READ_TIMEOUT = { timeout: 30_000 };

function fixture() {
  const added = addSketchFeature(
    createProjectDocument('QA sketch delete', toUserId('user_e2e')),
    {
      name: 'Profile',
      plane: 'XY',
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: 20, y2: 0 },
        { objectKind: 'line', x1: 20, y1: 0, x2: 20, y2: 12 },
        { objectKind: 'line', x1: 20, y1: 12, x2: 0, y2: 12 },
        { objectKind: 'line', x1: 0, y1: 12, x2: 0, y2: 0 },
        // A stray line outside the closed profile.
        { objectKind: 'line', x1: 40, y1: 0, x2: 50, y2: 0 }
      ]
    }
  );
  const ids = findSketch(added.document, added.sketchId)!.objectIds;
  const objects = ids.map((id) => {
    const node = added.document.nodes[id];
    if (node?.kind !== 'sketch-object')
      throw new Error('Expected sketch object');
    return { id, data: node.data };
  });
  const profile = computeSketchProfileAnalysis(objects, (value) =>
    resolveParamValue(value, {}, 'dimension')
  ).profiles[0]!;
  const document = extrudeSketch(added.document, {
    name: 'Block',
    sketchId: added.sketchId,
    distance: 5,
    profile: {
      profileId: profile.profileId,
      regionFingerprint: profile.regionFingerprint,
      samplePoint: profile.samplePoint,
      sourceArea: profile.area,
      sourceEntityIds: profile.sourceEntityIds
    }
  }).document;
  return { document, sketchId: added.sketchId, ids };
}

async function open(page: Page, document: ProjectDocument) {
  page.setDefaultTimeout(15_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import project', exact: true }).click()
  ]);
  await chooser.setFiles({
    name: 'QA-sketch-delete.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: [],
        sources: [],
        saveStates: []
      })
    )
  });
  await expect(page.locator('.viewer-host canvas')).toBeVisible(READ_TIMEOUT);
  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: 'Profile' }).click();
  await page
    .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
    .click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  const palette = page.getByRole('button', {
    name: 'Sketch palette',
    exact: true
  });
  if ((await palette.getAttribute('aria-expanded')) !== 'true')
    await palette.click();
}

async function exportDocument(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  if ((await menu.getAttribute('open')) === null)
    await menu.locator('summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', READ_TIMEOUT),
    menu.getByRole('button', { name: /^Export project/ }).click()
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

async function deleteGeometry(page: Page, objectId: string) {
  await page
    .getByRole('region', { name: 'Sketch overview' })
    .getByLabel('Selected geometry')
    .selectOption(objectId);
  await page
    .getByRole('form', { name: 'Edit line', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
}

test('a sketch delete that would break a dependent extrude is refused by name', async ({
  page
}) => {
  const { document, sketchId, ids } = fixture();
  await open(page, document);
  // The model builds cleanly before anything is deleted.
  await expect(page.getByText(/^Block: /)).toHaveCount(0);

  await deleteGeometry(page, ids[0]!);
  await expect(
    page.getByText(/^Block: .*The sketch edit was not saved\.$/).first()
  ).toBeVisible(READ_TIMEOUT);
  expect(findSketch(await exportDocument(page), sketchId)!.objectIds).toEqual(
    ids
  );

  // A stray line the extrude does not use deletes as before, undoably.
  await deleteGeometry(page, ids[4]!);
  await expect
    .poll(
      async () => findSketch(await exportDocument(page), sketchId)!.objectIds,
      READ_TIMEOUT
    )
    .toEqual(ids.slice(0, 4));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(
      async () => findSketch(await exportDocument(page), sketchId)!.objectIds,
      READ_TIMEOUT
    )
    .toEqual(ids);
});

test('a construction toggle that would break an extrude reports the refusal and unlocks further edits', async ({
  page
}, testInfo) => {
  test.setTimeout(90_000);
  const { document, ids } = fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, document);
  const before = await exportDocument(page);
  const selection = page
    .getByRole('region', { name: 'Sketch overview' })
    .getByLabel('Selected geometry');
  await selection.selectOption(ids[0]!);
  const editor = page.getByRole('form', { name: 'Edit line', exact: true });
  const toggle = editor.getByRole('button', { name: 'Construction' });
  await toggle.click();
  await expect(editor.getByRole('alert')).toContainText(
    /^Block: .*The sketch edit was not saved\.$/,
    READ_TIMEOUT
  );
  await expect(page.getByRole('contentinfo')).toContainText(
    'The sketch edit was not saved.'
  );
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const refused = await exportDocument(page);
  expect(refused.nodes).toEqual(before.nodes);
  expect(refused.commandLog).toEqual(before.commandLog);
  expect(errors).toEqual([]);

  // The failed validation must release the busy state: a spare line still
  // becomes construction geometry, and undo restores just that valid edit.
  await selection.selectOption(ids[4]!);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.getByRole('alert')).toHaveCount(0);
  const changed = await exportDocument(page);
  const spare = changed.nodes[ids[4]!];
  expect(spare?.kind === 'sketch-object' && spare.data.construction).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const restored = await exportDocument(page);
  expect(restored.nodes).toEqual(before.nodes);
  expect(errors).toEqual([]);
  await testInfo.attach('construction-recovery', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
});
