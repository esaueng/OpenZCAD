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
import type { Download } from '@playwright/test';
import { expect, stubAnonymousApi, test } from './openzcad-fixtures';
import { reimportSolids } from '../support/exchange-harness';

/**
 * F06 slice 3: a Tweak link that names a configuration. The model is saved
 * on Small (a 20 mm plate and its lug, the tag hidden); the link opens it on
 * Large (a 45 mm plate without the lug, the tag shown). The visitor exports
 * Large as 3MF, switches to Small in Tweak and exports that as STL.
 */
function bracket() {
  let document = createProjectDocument('Bracket', toUserId('owner'));
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
  const feature = (name: string) =>
    Object.values(document.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.name === name
    )!;
  // Large leaves out the lug and its placement, which would have no target.
  const lug = feature('Lug');
  const placement = feature('Lug placement');
  document = createConfigurations(document, { rowId: 'small', name: 'Small' });
  for (const column of [
    { kind: 'parameter', parameterId: width },
    { kind: 'suppression', featureId: lug.featureId },
    { kind: 'suppression', featureId: placement.featureId },
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
    [{ kind: 'suppression', featureId: placement.featureId }, true],
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

test(
  'a Tweak link opens on its configuration, switches rows and exports 3MF and STL',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    const document = bracket();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubAnonymousApi(page);
    await page.route('**/api/share', (route) =>
      route.fulfill({
        json: {
          document,
          project: { projectId: document.projectId, name: document.name },
          mode: 'tweak'
        }
      })
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/#share=${'a'.repeat(43)}&configuration=large`);
    await expect(page.getByRole('contentinfo')).toContainText(
      'Opened shared model Bracket',
      { timeout: 30_000 }
    );
    await expect(page.getByRole('contentinfo')).toContainText('Showing Large.');

    // The link chose Large; the Tweak picker and the knobs say so.
    const picker = page.getByRole('combobox', {
      name: 'Configuration',
      exact: true
    });
    await expect(picker).toHaveValue('large');
    await expect(
      page.getByLabel('Expression for width', { exact: true })
    ).toHaveValue('45');

    const meshButton = page.getByRole('button', { name: /^Export mesh…/ });
    await expect(meshButton).toBeEnabled({ timeout: 30_000 });
    await meshButton.click();
    const dialog = page.getByRole('dialog', { name: 'Export mesh' });
    await dialog.getByRole('radio', { name: /^3MF/ }).check();
    const large = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /^Export 3MF/ }).click();
    const largeMeasure = await reimportSolids('3mf', await bytes(await large));
    // 45 × 10 × 4 plate and the 2 mm tag; no lug.
    expect(largeMeasure.fileObjects).toBe(2);
    expect(largeMeasure.volume).toBeCloseTo(1808, 0);
    await expect(dialog).toBeHidden();

    // Switching rows in Tweak rebuilds as Small.
    await picker.selectOption({ label: 'Small' });
    await expect(picker).toHaveValue('small');
    await expect(
      page.getByLabel('Expression for width', { exact: true })
    ).toHaveValue('20');
    await expect(meshButton).toBeEnabled({ timeout: 30_000 });
    await meshButton.click();
    await dialog.getByRole('radio', { name: /^STL \(binary\)/ }).check();
    const small = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /^Export STL/ }).click();
    const smallFile = await small;
    expect(smallFile.suggestedFilename()).toMatch(/\.stl$/i);
    const smallMeasure = await reimportSolids(
      'stl-binary',
      await bytes(smallFile)
    );
    // 20 × 10 × 4 plate and the 4 mm lug; the tag stays hidden.
    expect(smallMeasure.volume).toBeCloseTo(800 + 64, 0);

    // The switch is a Tweak step: undo (the shared view's keyboard undo)
    // returns to Large.
    await page.evaluate(() =>
      (globalThis.document.activeElement as HTMLElement | null)?.blur()
    );
    await page.keyboard.press('Control+z');
    await expect(picker).toHaveValue('large');
    await expect(
      page.getByLabel('Expression for width', { exact: true })
    ).toHaveValue('45');
    expect(errors).toEqual([]);
  }
);
