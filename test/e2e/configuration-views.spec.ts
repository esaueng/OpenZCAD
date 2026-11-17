import type { Page } from '@playwright/test';
import {
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  createConfigurations,
  createProjectDocument,
  listParameters,
  setConfigurationCell,
  setParameter
} from '@openzcad/document-core';
import { toUserId, type FeatureNode } from '@openzcad/shared';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * F06 slice 4b: one configuration per drawing view. The model's active row
 * is Small (a 20 mm plate); its front view is set to draw Large (45 mm), and
 * the top view projected from it follows, while the model stays Small.
 */
function bracket() {
  let document = createProjectDocument('Bracket', toUserId('test'));
  document = setParameter(document, { name: 'width', expression: '20' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 4 }
  });
  const width = listParameters(document)[0]!.parameterId;
  document = createConfigurations(document, { rowId: 'small', name: 'Small' });
  document = addConfigurationColumn(document, {
    column: { kind: 'parameter', parameterId: width }
  });
  document = addConfigurationRow(document, { rowId: 'large', name: 'Large' });
  return setConfigurationCell(document, {
    rowId: 'large',
    column: { kind: 'parameter', parameterId: width },
    value: '45'
  });
}

/**
 * Built on Large (45 mm, with a 2 mm tag); Small is 20 mm and suppresses
 * the tag, so its build has no tag body at all.
 */
function taggedBracket() {
  let document = createProjectDocument('Tagged', toUserId('test'));
  document = setParameter(document, { name: 'width', expression: '45' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 4 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Tag',
    primitiveKind: 'box',
    dimensions: { width: 2, height: 2, depth: 2 }
  });
  const width = listParameters(document)[0]!.parameterId;
  const tag = Object.values(document.nodes).find(
    (node): node is FeatureNode =>
      node.kind === 'feature' && node.name === 'Tag'
  )!;
  document = createConfigurations(document, { rowId: 'large', name: 'Large' });
  for (const column of [
    { kind: 'parameter', parameterId: width },
    { kind: 'suppression', featureId: tag.featureId }
  ] as const)
    document = addConfigurationColumn(document, { column });
  document = addConfigurationRow(document, { rowId: 'small', name: 'Small' });
  document = setConfigurationCell(document, {
    rowId: 'small',
    column: { kind: 'parameter', parameterId: width },
    value: '20'
  });
  return setConfigurationCell(document, {
    rowId: 'small',
    column: { kind: 'suppression', featureId: tag.featureId },
    value: true
  });
}

async function importProject(page: Page, document: object, name: string) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Import target');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'project.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: []
      })
    )
  });
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(name);
}

function mode(page: Page, name: 'Build' | 'Draw') {
  return page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name, exact: true });
}

test(
  'a drawing view draws its own configuration, and its projected views follow',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Import target');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'bracket.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: bracket(),
          files: []
        })
      )
    });
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Bracket');

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    for (const orientation of ['front', 'top'])
      await expect(
        canvas.locator(`[data-view="${orientation}"]:not(.is-placeholder)`)
      ).toHaveCount(1, { timeout: 30_000 });
    const panel = drawings.getByRole('complementary', {
      name: 'Drawing properties'
    });
    // At 1:1, a view's hit box is its drawn span plus 3 mm each side.
    await panel.getByLabel('Scale').selectOption('1:1');
    const span = (orientation: string) => async () =>
      Number(
        await canvas
          .locator(`[data-view="${orientation}"] .drawing-view-hit`)
          .getAttribute('width')
      ) - 6;
    await expect.poll(span('front'), { timeout: 30_000 }).toBeCloseTo(20, 2);
    await expect.poll(span('top')).toBeCloseTo(20, 2);

    // The front view draws Large; the top view, projected from it, follows.
    await canvas.getByRole('button', { name: 'Front view' }).click();
    const picker = panel.getByLabel('Configuration');
    await expect(picker).toHaveValue('');
    await picker.selectOption({ label: 'Large' });
    await expect.poll(span('front'), { timeout: 30_000 }).toBeCloseTo(45, 2);
    await expect.poll(span('top'), { timeout: 30_000 }).toBeCloseTo(45, 2);
    await canvas.getByRole('button', { name: 'Top view' }).click();
    await expect(
      panel.getByText('Draws its source view’s configuration.')
    ).toBeVisible();

    // The model being edited is still Small.
    await mode(page, 'Build').click();
    await expect(
      page.getByLabel('Expression for width', { exact: true })
    ).toHaveValue('20');

    // Back on the active row: the views draw the model again.
    await mode(page, 'Draw').click();
    await canvas.getByRole('button', { name: 'Front view' }).click();
    await panel.getByLabel('Configuration').selectOption({ value: '' });
    await expect.poll(span('front'), { timeout: 30_000 }).toBeCloseTo(20, 2);
    await expect.poll(span('top')).toBeCloseTo(20, 2);
    expect(errors).toEqual([]);
  }
);

test(
  'a view on another row draws bodies the active row does not build',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await importProject(page, taggedBracket(), 'Tagged');
    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      canvas.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });
    const panel = drawings.getByRole('complementary', {
      name: 'Drawing properties'
    });
    await panel.getByLabel('Scale').selectOption('1:1');
    const span = async () =>
      Number(
        await canvas
          .locator('[data-view="front"] .drawing-view-hit')
          .getAttribute('width')
      ) - 6;
    await expect.poll(span, { timeout: 30_000 }).toBeCloseTo(45, 2);
    // Every base view draws Large; the views folded from them follow.
    for (const name of ['Front view', 'Isometric view']) {
      await canvas.getByRole('button', { name }).click();
      await panel.getByLabel('Configuration').selectOption({ label: 'Large' });
      await page.keyboard.press('Escape');
    }

    // The model becomes Small: no tag body in its build at all.
    await mode(page, 'Build').click();
    await page.getByRole('radio', { name: 'Use Small', exact: true }).check();
    await expect(
      page.getByLabel('Expression for width', { exact: true })
    ).toHaveValue('20');

    // The sheet still draws Large, tag and all, from Large's own build.
    await mode(page, 'Draw').click();
    await expect.poll(span, { timeout: 30_000 }).toBeCloseTo(45, 2);
    // No body is reported missing from the sheet.
    await expect(drawings.getByText(/no longer exists as a body/)).toHaveCount(
      0
    );
    expect(errors).toEqual([]);
  }
);
