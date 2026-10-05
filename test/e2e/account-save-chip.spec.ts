import {
  adoptProjectDocument,
  createProjectDocument,
  reidentifyProjectDocument
} from '@openzcad/document-core';
import { toProjectId, toUserId, type ProjectDocument } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * A conflict recovery copy used to be written with no revisions at all, and
 * the top bar's "Save to my account" makes a save point before it uploads.
 * The checkpoint refused ("Cannot create a checkpoint without a revision"),
 * the catch reported it as an offline save, and the project never reached the
 * account. Copies made before the fix are still on devices in that state, so
 * this plants one directly rather than going through a conflict.
 */
test('Save to my account uploads a device project that has no revisions', async ({
  page
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page, { collaborationRole: 'owner' });
  await page.route('**/api/collaboration/config', (route) =>
    route.fulfill({
      json: {
        sharingEnabled: true,
        editLeasesEnforced: false,
        personalSyncEnabled: true,
        canary: false
      }
    })
  );
  const accountProjectId = toProjectId('proj_account_recovery');
  let posted: ProjectDocument | undefined;
  let adopted: ProjectDocument | undefined;
  await page.route('**/api/projects', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const payload = route.request().postDataJSON() as {
      name: string;
      document?: ProjectDocument;
    };
    if (!payload.document) return route.fallback();
    posted = payload.document;
    adopted = adoptProjectDocument(
      reidentifyProjectDocument(payload.document, accountProjectId),
      toUserId('user_e2e'),
      payload.name
    );
    return route.fulfill({
      status: 201,
      json: {
        document: adopted,
        project: {
          projectId: accountProjectId,
          name: adopted.name,
          revisionCount: adopted.revisions.length,
          updatedAt: adopted.derived.updatedAt
        }
      }
    });
  });
  await page.route(`**/api/projects/${accountProjectId}`, (route) =>
    route.fulfill({ json: adopted })
  );
  // What the worker answers for a project the account does not hold.
  await page.route('**/api/projects/proj_recovery_e2e', (route) =>
    route.fulfill({ status: 404, json: { error: 'Project not found.' } })
  );

  const recovery = createProjectDocument(
    'Bracket (Recovery)',
    toUserId('user_e2e')
  );
  recovery.projectId = toProjectId('proj_recovery_e2e');
  const root = recovery.nodes[recovery.rootNodeId];
  if (root?.kind === 'project') root.projectId = recovery.projectId;
  recovery.revisions = [];
  recovery.checkpoints = [];

  await page.goto('/');
  await expect(page.getByLabel('Project name')).toBeVisible();
  // Opening the database before the app has created it would create an empty
  // one at version 1, without the stores, and break the app's own upgrade.
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await indexedDB.databases()).some(
          (database) => database.name === 'openzcad-v2'
        )
      )
    )
    .toBe(true);
  await page.evaluate(async (document) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('openzcad-v2');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error('Local storage open failed'));
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('projects', 'readwrite');
      transaction.objectStore('projects').put(document);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onabort = () => {
        db.close();
        reject(new Error('Local storage write failed'));
      };
    });
  }, recovery);
  await page.reload();
  await page
    .locator('.start-tile-open', { hasText: 'Bracket (Recovery)' })
    .click();
  await expect(page.getByRole('button', { name: 'Rename project' })).toHaveText(
    'Bracket (Recovery)'
  );
  // Not being in the account yet is not an outage.
  await expect(page.getByText('Opened Bracket (Recovery).')).toBeVisible();
  await expect(page.getByText(/currently unreachable/)).toHaveCount(0);
  await expect(page.locator('.save-state')).not.toHaveClass(/is-offline/);
  await expect(
    page.getByRole('button', { name: 'Open project sharing · Not shared' })
  ).toBeVisible();

  await page
    .getByRole('button', { name: 'Save to my account', exact: true })
    .click();

  // Adoption, the account echo and the rebuild it triggers take several
  // seconds on software GL when shards run in parallel.
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/, {
    timeout: 20_000
  });
  await expect(
    page.getByRole('button', { name: 'Save to my account', exact: true })
  ).toHaveCount(0);
  expect(posted?.projectId).toBe(recovery.projectId);
  // The save point the chip made travelled with the upload.
  expect(posted?.revisions.length).toBeGreaterThan(0);
  expect(posted?.checkpoints.length).toBeGreaterThan(0);
  await expect(page.getByText(/Cannot create a checkpoint/)).toHaveCount(0);
  expect(errors).toEqual([]);
});
