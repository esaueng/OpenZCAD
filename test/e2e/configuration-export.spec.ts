import {
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  createConfigurations,
  createProjectDocument,
  listParameters,
  setConfigurationCell,
  setParameter,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type FeatureNode } from '@openzcad/shared';
import type { Download, Page } from '@playwright/test';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';
import { reimportSolids } from '../support/exchange-harness';

/**
 * F06 slice 2: any configuration exports exactly, without being shown. The
 * model shows Small (a 20 mm plate and its lug); Large is a 45 mm plate
 * without the lug, with a tag Small hides.
 */
function bracket() {
  let document = createProjectDocument('Bracket', toUserId('user_e2e'));
  document = setParameter(document, { name: 'width', expression: '20' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 4 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Lug',
    primitiveKind: 'box',
    dimensions: { width: 4, height: 4, depth: 4 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Tag',
    primitiveKind: 'box',
    dimensions: { width: 2, height: 2, depth: 2 }
  });
  const [, lugBody, tag] = document.bodyOrder;
  document = transformBody(document, {
    name: 'Lug placement',
    targetBodyId: lugBody!,
    translation: { x: 0, y: 0, z: 20 }
  }).document;
  document = transformBody(document, {
    name: 'Tag placement',
    targetBodyId: tag!,
    translation: { x: 0, y: 0, z: 40 }
  }).document;
  const width = listParameters(document)[0]!.parameterId;
  const lug = Object.values(document.nodes).find(
    (node): node is FeatureNode =>
      node.kind === 'feature' && node.name === 'Lug'
  )!;
  document = createConfigurations(document, { rowId: 'small', name: 'Small' });
  for (const column of [
    { kind: 'parameter', parameterId: width },
    { kind: 'suppression', featureId: lug.featureId },
    { kind: 'body', bodyId: tag! }
  ] as const)
    document = addConfigurationColumn(document, { column });
  document = setConfigurationCell(document, {
    rowId: 'small',
    column: { kind: 'body', bodyId: tag! },
    value: false
  });
  document = addConfigurationRow(document, { rowId: 'large', name: 'Large' });
  for (const [column, value] of [
    [{ kind: 'parameter', parameterId: width }, '45'],
    [{ kind: 'suppression', featureId: lug.featureId }, true],
    [{ kind: 'body', bodyId: tag! }, true]
  ] as const)
    document = setConfigurationCell(document, {
      rowId: 'large',
      column,
      value
    });
  return document;
}

async function bytes(file: Download): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream())
    chunks.push(chunk as Buffer);
  return Uint8Array.from(Buffer.concat(chunks));
}

async function openProject(page: Page) {
  const document = bracket();
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await createProject(page, document.name);
}

test(
  'exports a configuration that is not shown, as STEP and as 3MF',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openProject(page);
    // Wait for the model to be built before exporting from it.
    await expect(
      page
        .getByRole('group', { name: 'Workspace status' })
        .getByLabel(/ · \d+ features? · \d+ bod(y|ies)\. Sync /)
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('radio', { name: 'Use Small' })).toBeChecked();

    // STEP of Large, straight from its row.
    const step = page.waitForEvent('download');
    await page.getByLabel('Export Large').selectOption('step');
    const stepFile = await step;
    expect(stepFile.suggestedFilename()).toMatch(/Large.*\.step$/i);
    const stepMeasure = await reimportSolids('step', await bytes(stepFile));
    expect(stepMeasure.fileObjects).toBe(2);
    // 45 × 10 × 4 plate and the 2 mm tag; no lug.
    expect(stepMeasure.volume).toBeCloseTo(1800 + 8, 1);

    // The model did not change: Small is still the one shown.
    await expect(page.getByRole('radio', { name: 'Use Small' })).toBeChecked();
    await expect(page.getByLabel('Expression for width')).toHaveValue('20');

    // 3MF of Large through the mesh dialog, which names the row.
    await page.getByLabel('Export Large').selectOption('mesh');
    const dialog = page.getByRole('dialog', { name: 'Export mesh' });
    await expect(
      dialog.getByRole('combobox', { name: 'Configuration to export' })
    ).toHaveValue('large');
    await dialog.getByRole('radio', { name: '3MF' }).check();
    const mesh = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /^Export 3MF/ }).click();
    const meshFile = await mesh;
    expect(meshFile.suggestedFilename()).toMatch(/Large.*\.3mf$/i);
    const meshMeasure = await reimportSolids('3mf', await bytes(meshFile));
    expect(meshMeasure.fileObjects).toBe(2);
    expect(meshMeasure.volume).toBeCloseTo(1808, 0);

    // Switching the dialog back to Small writes the shown model.
    await page.getByLabel('Export Small').selectOption('mesh');
    await expect(
      dialog.getByRole('combobox', { name: 'Configuration to export' })
    ).toHaveValue('small');
    await dialog.getByRole('radio', { name: '3MF' }).check();
    const shown = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /^Export 3MF/ }).click();
    const shownMeasure = await reimportSolids('3mf', await bytes(await shown));
    expect(shownMeasure.fileObjects).toBe(2);
    // 20 × 10 × 4 plate and the 4 mm lug.
    expect(shownMeasure.volume).toBeCloseTo(800 + 64, 0);
    expect(errors).toEqual([]);
  }
);
