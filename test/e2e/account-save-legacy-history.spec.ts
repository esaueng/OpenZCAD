import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  adoptProjectDocument,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  HttpError,
  parseCreateProjectRequest
} from '../../apps/web/worker/validation';
import { test, expect, stubApi } from './openzcad-fixtures';

test('saves unopened legacy projects with undo history from the library', async ({
  page
}) => {
  const documents = ['Older part', 'Recovery part', 'Redo part'].map((name) => {
    const manager = new CommandManager(
      createProjectDocument(name, toUserId('user_local'))
    );
    manager.execute(
      commandFactories.renameNode({
        nodeId: manager.document.rootNodeId,
        name: `${name} edited`
      })
    );
    if (name === 'Redo part') manager.undo();
    return {
      ...manager.document,
      schemaVersion: 14
    } as unknown as ProjectDocument;
  });
  const saved: ProjectDocument[] = [];
  await stubApi(page);
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    try {
      // Use the real edge validator: the usual API fixture normalizes before
      // validation and would hide this refusal from an old IndexedDB snapshot.
      const request = parseCreateProjectRequest(
        route.request().postDataJSON() as unknown
      );
      const document = adoptProjectDocument(
        request.document!,
        toUserId('user_e2e')
      );
      saved.push(document);
      await route.fulfill({
        status: 201,
        json: {
          document,
          project: {
            projectId: document.projectId,
            name: document.name,
            revisionCount: document.revisions.length,
            documentVersion: document.version,
            updatedAt: document.derived.updatedAt
          }
        }
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      await route.fulfill({
        status: error.status,
        json: { error: error.message }
      });
    }
  });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Create project' })
  ).toBeVisible();
  await expect(page.locator('.start-account-count')).toHaveText('0 / 0 saved');
  await page.evaluate(async (snapshots) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('openzcad-v2');
      open.onerror = () =>
        reject(new Error(open.error?.message ?? 'IndexedDB open failed'));
      open.onsuccess = () => resolve(open.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('projects', 'readwrite');
        for (const snapshot of snapshots)
          tx.objectStore('projects').put(snapshot);
        tx.oncomplete = () => {
          resolve();
        };
        tx.onerror = () => {
          reject(new Error(tx.error?.message ?? 'IndexedDB write failed'));
        };
      });
    } finally {
      database.close();
    }
  }, documents);
  // Reloading refreshes the shelf; no project has been opened or edited.
  await page.reload();
  await expect(page.locator('.start-account-count')).toHaveText('0 / 3 saved');
  await page.getByRole('button', { name: /Save.*account/ }).click();
  await expect(page.locator('.start-sync-title')).toHaveText(
    'All 3 projects saved to your account'
  );
  await expect(page.locator('.start-account-count')).toHaveText('3 / 3 saved');
  expect(saved.map((document) => document.projectId).sort()).toEqual(
    documents.map((document) => document.projectId).sort()
  );
  for (const document of saved) {
    const original = documents.find(
      (snapshot) => snapshot.projectId === document.projectId
    )!;
    expect(document.editHistory?.cursor).toBe(original.editHistory?.cursor);
    expect(document.editHistory?.entries).toEqual(
      original.editHistory?.entries
    );
  }
});
