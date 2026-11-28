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
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { revealModelPanel } from './openzcad-fixtures';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * K10: a chamfer's rebuild refusal quotes its sizes bare ("with distance
 * 1.5. … distance 0.985 builds here."). The command bar puts the document's
 * unit after them; the Resume dialog and History's failing-step card showed
 * the numbers with no unit (preview re-check of #2278). Both now read the
 * refusal as the bar does. The block and its chamfer are invented: a 1-unit
 * cube whose first edge refuses a 1.5 chamfer and builds 0.985.
 */

const CHAMFER = 'Corner chamfer';
/** The cube's first edge on the pinned kernel. */
const FIRST_EDGE = 3231434560;

/** A cube and a suppressed, oversized chamfer, as a new project. */
async function openSuppressedChamfer(
  page: Page,
  units: UnitSystem
): Promise<void> {
  const base = addPrimitiveFeature(
    createProjectDocument('Chamfer refusal units', toUserId('user_e2e'), units),
    {
      name: 'Block',
      bodyName: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    }
  );
  let document: ProjectDocument = chamferEdges(base, {
    name: CHAMFER,
    targetBodyId: base.bodyOrder[0]!,
    edgeHashes: [FIRST_EDGE],
    size: 1.5
  }).document;
  const chamfer = listFeaturesInOrder(document).find(
    (feature) => feature.name === CHAMFER
  )!;
  document = setNodeMetadata(document, {
    nodeId: chamfer.id,
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

for (const [units, unit] of [
  ['mm', 'mm'],
  ['inch', 'in']
] as const) {
  test(`puts the ${units} unit after a refused chamfer's sizes in Resume and History`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openSuppressedChamfer(page, units);
    await revealModelPanel(page, 'History');
    const row = page.locator('.feature-row', { hasText: CHAMFER });
    await expect(row).toContainText('suppressed', { timeout: 30_000 });
    const sentence = `Chamfer could not be created on 1 selected edge with distance 1.5 ${unit}. Try a smaller distance: distance 0.985 ${unit} builds here.`;

    await row.hover();
    await row
      .getByRole('button', { name: `Resume ${CHAMFER}`, exact: true })
      .click();
    const dialog = page.getByRole('alertdialog', {
      name: `Resume ${CHAMFER}?`
    });
    await expect(dialog).toContainText('1 feature would not rebuild', {
      timeout: 30_000
    });
    await expect(dialog.getByRole('listitem')).toHaveText(
      `${CHAMFER}: ${sentence}`
    );
    await dialog.getByRole('button', { name: 'Resume anyway' }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toHaveClass(/\b(failed|needs-repair)\b/, {
      timeout: 30_000
    });

    await row.locator('.feature-row-main').click();
    await revealModelPanel(page, 'History');
    const details = page.getByRole('region', { name: 'History details' });
    await expect(details).toContainText('Needs repair', { timeout: 30_000 });
    await expect(details.getByRole('alert')).toHaveText(sentence);
    expect(errors).toEqual([]);
  });
}
