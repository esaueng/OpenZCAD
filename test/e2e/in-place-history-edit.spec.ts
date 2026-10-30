import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  listFeaturesInOrder,
  patternBody
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type FeatureData,
  type ProjectDocument
} from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  createShellInPlace,
  enterCommandValue,
  finishInPlaceCommand,
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U09 phase 7: a History row re-arms the in-place command that made its
 * feature, seeded from what it stores. No form opens; Done writes the
 * feature back through `updateFeature`, and an untouched Done changes
 * nothing. Each spec reads what the export stored.
 */

function boxes(name: string): { document: ProjectDocument; ids: BodyId[] } {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 30, depth: 20 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 40 }
  });
  const ids = listFeaturesInOrder(document).flatMap((feature) =>
    feature.bodyId ? [feature.bodyId] : []
  );
  return { document, ids };
}

async function openDocument(
  page: Page,
  document: ProjectDocument,
  bodies: string
) {
  await stubApi(page, { panelLayout: MODEL_ONLY });
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
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    bodies,
    { timeout: 30_000 }
  );
  await page.keyboard.press('f');
  await waitForStillViewport(page);
}

async function exportedFeatures(page: Page): Promise<FeatureData[]> {
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
  const { document } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    document: ProjectDocument;
  };
  return listFeaturesInOrder(document).map((feature) => feature.data);
}

async function editFromHistory(page: Page, name: string) {
  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row', { hasText: name })
    .locator('.feature-row-main')
    .click();
  const bar = page.getByRole('group', { name: `Edit ${name} command` });
  await expect(bar).toBeVisible();
  await expect(page.locator('form.feature-form')).toHaveCount(0);
  return bar;
}

test('Subtract re-arms with its bodies, and its operation changes in Options', async ({
  page
}) => {
  test.setTimeout(120_000);
  const { document: seeded, ids } = boxes('History subtract');
  const { document } = booleanBodies(seeded, {
    name: 'Cut',
    bodyName: 'Cut body',
    operation: 'subtract',
    targetBodyIds: ids
  });
  await openDocument(page, document, '1');
  const bar = await editFromHistory(page, 'Cut');
  await bar.locator('summary').click();
  await expect(bar.getByRole('radio', { name: 'Subtract' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await bar.getByRole('radio', { name: 'Union' }).click();
  await bar.locator('summary').click();
  await finishInPlaceCommand(page, 'Edit Cut');
  await expect(page.getByRole('contentinfo')).toContainText('Edited Cut');
  const booleans = (await exportedFeatures(page)).filter(
    (data) => data.featureKind === 'boolean'
  );
  expect(booleans).toEqual([
    { featureKind: 'boolean', operation: 'union', targetBodyIds: ids }
  ]);
});

test('Linear pattern re-arms its count and spacing on chips', async ({
  page
}) => {
  test.setTimeout(120_000);
  let document = createProjectDocument('History pattern', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  const [target] = listFeaturesInOrder(document).flatMap((feature) =>
    feature.bodyId ? [feature.bodyId] : []
  );
  ({ document } = patternBody(document, {
    name: 'Row',
    targetBodyId: target!,
    patternKind: 'linear',
    count: 3,
    axis: 'x',
    spacing: 20
  }));
  await openDocument(page, document, '1');
  await editFromHistory(page, 'Row');
  await expect(page.getByTestId('command-handle-count')).toHaveText('3 count');
  await expect(page.getByTestId('command-handle-spacing')).toHaveText(
    'Spacing 20 mm'
  );
  await enterCommandValue(page, 'count', '4');
  await finishInPlaceCommand(page, 'Edit Row');
  await expect(page.getByRole('contentinfo')).toContainText('Edited Row', {
    timeout: 30_000
  });
  const patterns = (await exportedFeatures(page)).filter(
    (data) => data.featureKind === 'pattern'
  );
  expect(patterns).toHaveLength(1);
  expect(patterns[0]).toMatchObject({
    patternKind: 'linear',
    count: 4,
    axis: 'x',
    spacing: 20
  });
});

test('Linear pattern edits its stored vector part by part', async ({ page }) => {
  test.setTimeout(120_000);
  let document = createProjectDocument('Diagonal row', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  const [target] = listFeaturesInOrder(document).flatMap((feature) =>
    feature.bodyId ? [feature.bodyId] : []
  );
  ({ document } = patternBody(document, {
    name: 'Row',
    targetBodyId: target!,
    patternKind: 'linear',
    count: 3,
    axis: 'x',
    spacing: 20,
    direction: { x: 1, y: 1, z: 0 }
  }));
  await openDocument(page, document, '1');
  const bar = await editFromHistory(page, 'Row');
  // The stored vector is a custom one, each part on its own chip.
  await bar.locator('summary').click();
  await expect(bar.getByRole('radio', { name: 'Custom vector' })).toBeChecked();
  await bar.locator('summary').click();
  await expect(page.getByTestId('command-handle-dirY')).toBeVisible();
  await enterCommandValue(page, 'dirY', '2');
  await finishInPlaceCommand(page, 'Edit Row');
  await expect(page.getByRole('contentinfo')).toContainText('Edited Row', {
    timeout: 30_000
  });
  const [pattern] = (await exportedFeatures(page)).filter(
    (data) => data.featureKind === 'pattern'
  );
  expect(pattern).toMatchObject({ direction: { x: 1, y: 2, z: 0 } });
});

test('Shell: an untouched Done stores it unchanged, and Escape leaves it', async ({
  page
}) => {
  test.setTimeout(120_000);
  let document = createProjectDocument('History shell', toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 30, depth: 20 }
  });
  await openDocument(page, document, '1');
  await createShellInPlace(page, {
    normals: [{ x: 0, y: 0, z: 1 }],
    thickness: '2'
  });
  const shellOf = async () =>
    (await exportedFeatures(page)).filter(
      (data) => data.featureKind === 'shell'
    );
  const [created] = await shellOf();

  await editFromHistory(page, 'Shell');
  await expect(page.getByTestId('command-handle-thickness')).toHaveText(
    'Wall 2 mm'
  );
  await finishInPlaceCommand(page, 'Edit Shell');
  await expect(page.getByRole('contentinfo')).toContainText('Edited Shell', {
    timeout: 30_000
  });
  expect(await shellOf()).toEqual([created]);

  await editFromHistory(page, 'Shell');
  await enterCommandValue(page, 'thickness', '4');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('group', { name: 'Edit Shell command' })
  ).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Edit canceled; Shell is unchanged.'
  );
  expect(await shellOf()).toEqual([created]);

  await editFromHistory(page, 'Shell');
  await enterCommandValue(page, 'thickness', '3');
  await finishInPlaceCommand(page, 'Edit Shell');
  await expect(page.getByRole('contentinfo')).toContainText('Edited Shell', {
    timeout: 30_000
  });
  // The status already reads "Edited Shell" from the first Done: wait for
  // the stored value itself.
  await expect
    .poll(shellOf, { timeout: 30_000 })
    .toEqual([{ ...created, thickness: 3 }]);
});
