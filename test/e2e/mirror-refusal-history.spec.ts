import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  mirrorBody,
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
import { MIRROR_SOURCE_UNAVAILABLE } from '../../apps/web/src/lib/refusalLanguage';

/**
 * K10: a Mirror whose source body is suppressed is refused with the adapter's
 * typed `mirror_source_unavailable`, and every surface words it from that
 * code: the Resume dialog that asks first, and the History card of the
 * failed step once it is resumed anyway. The Mirror is named "Body no longer
 * exists", the name that once tripped the lost-selection text rule ahead of
 * the code. The box is invented.
 */

const MIRROR = 'Body no longer exists';

/** A box and its Mirror, both suppressed, as a new project. */
async function openSuppressedMirror(page: Page): Promise<void> {
  let document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument('Mirror refusal history', toUserId('user_e2e')),
    {
      name: 'Box',
      bodyName: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 6, height: 6, depth: 6 }
    }
  );
  document = mirrorBody(document, {
    name: MIRROR,
    targetBodyId: document.bodyOrder[0]!,
    plane: { origin: { x: 10, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
  }).document;
  for (const feature of listFeaturesInOrder(document)) {
    document = setNodeMetadata(document, {
      nodeId: feature.id,
      metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
    });
  }
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

test('words a resumed Mirror with a suppressed source from its typed code in Resume and History', async ({
  page
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openSuppressedMirror(page);
  await revealModelPanel(page, 'History');
  const mirror = page.locator('.feature-row', { hasText: MIRROR });
  await expect(mirror).toContainText('suppressed', { timeout: 30_000 });

  // Resume the Mirror alone: its source stays suppressed, so it asks first.
  await mirror.hover();
  await mirror
    .getByRole('button', { name: `Resume ${MIRROR}`, exact: true })
    .click();
  const dialog = page.getByRole('alertdialog', {
    name: `Resume ${MIRROR}?`
  });
  await expect(dialog).toContainText('1 feature would not rebuild', {
    timeout: 30_000
  });
  await expect(dialog.getByRole('listitem')).toHaveText(
    `${MIRROR}: ${MIRROR_SOURCE_UNAVAILABLE}`
  );
  await dialog.getByRole('button', { name: 'Resume anyway' }).click();
  await expect(dialog).toBeHidden();
  await expect(mirror).toHaveClass(/\b(failed|needs-repair)\b/, {
    timeout: 30_000
  });

  // The failed step's History card says the same, not the adapter's words.
  await mirror.locator('.feature-row-main').click();
  await revealModelPanel(page, 'History');
  const details = page.getByRole('region', { name: 'History details' });
  await expect(details).toContainText('Needs repair', { timeout: 30_000 });
  await expect(details).toContainText(MIRROR_SOURCE_UNAVAILABLE);
  await expect(details).not.toContainText('Mirror target is unavailable.');
  expect(errors).toEqual([]);
});
