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
import { test, expect, stubApi, stubAnonymousApi } from './openzcad-fixtures';

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
  await expect(page.locator('.start-account-text')).toHaveText('Signed in');
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
  await expect(page.locator('.start-account-text')).toHaveText(
    '3 parts not saved'
  );
  await page.getByRole('button', { name: /Save.*account/ }).click();
  await expect(page.locator('.start-account-text')).toHaveText(
    'All 3 saved to your account'
  );
  await page.getByRole('button', { name: 'Dismiss sync results' }).click();
  await expect(page.locator('.start-account-text')).toHaveText(
    'All 3 parts saved'
  );
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

for (const destination of ['account', 'device', 'refused'] as const) {
  test(`saves a revisionless recovery from the workspace (${destination})`, async ({
    page
  }) => {
    const manager = new CommandManager(
      createProjectDocument('Part (Recovery)', toUserId('user_local'))
    );
    manager.execute(
      commandFactories.renameNode({
        nodeId: manager.document.rootNodeId,
        name: 'Saved part (Recovery)'
      })
    );
    const recovery = { ...manager.document, revisions: [], checkpoints: [] };
    const saved: ProjectDocument[] = [];
    if (destination === 'device') await stubAnonymousApi(page);
    else await stubApi(page);
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const request = parseCreateProjectRequest(
        route.request().postDataJSON() as unknown
      );
      saved.push(request.document!);
      if (destination === 'refused')
        return route.fulfill({
          status: 400,
          json: { error: 'This account refused the project.' }
        });
      const document = adoptProjectDocument(
        request.document!,
        toUserId('user_e2e')
      );
      return route.fulfill({
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
    });
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Create project' })
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const open = indexedDB.open('openzcad-v2');
            open.onerror = () => reject(new Error('IndexedDB unavailable'));
            open.onsuccess = () => resolve(open.result);
          });
          const ready = database.objectStoreNames.contains('projects');
          database.close();
          return ready;
        })
      )
      .toBe(true);
    await page.evaluate(async (document) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () =>
          reject(new Error(open.error?.message ?? 'IndexedDB open failed'));
        open.onsuccess = () => resolve(open.result);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction('projects', 'readwrite');
          tx.objectStore('projects').put(document);
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(new Error(tx.error?.message ?? 'IndexedDB write failed'));
        });
      } finally {
        database.close();
      }
    }, recovery);
    await page.reload();
    await page.locator('.start-tile-open').first().click();
    if (destination === 'device') {
      await expect(
        page.getByRole('group', { name: 'Workspace actions' })
      ).toBeVisible();
      await page.keyboard.press('ControlOrMeta+s');
    } else {
      const save = page.getByRole('button', {
        name: 'Save to my account',
        exact: true
      });
      await expect(save).toBeEnabled();
      await save.click();
    }
    if (destination === 'account') {
      await expect(
        page.getByRole('status', { name: 'Saved', exact: true })
      ).toBeVisible();
    } else {
      if (destination === 'refused') {
        await expect(
          page.getByText(
            'This account refused the project. Saved on this device.',
            { exact: true }
          )
        ).toBeVisible();
      }
      await expect(
        page.getByRole('group', { name: 'Workspace status' })
      ).toContainText('Local only');
    }
    if (destination !== 'device') {
      expect(saved).toHaveLength(1);
      expect(saved[0]!.version).toBe(recovery.version);
      expect(saved[0]!.editHistory?.entries).toEqual(
        recovery.editHistory?.entries
      );
    }
    // The first explicit save owns a checkpoint even when recovery stripped
    // all prior revisions. Verify the durable device copy, not just the label.
    const durable = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () =>
          reject(new Error(open.error?.message ?? 'IndexedDB open failed'));
        open.onsuccess = () => resolve(open.result);
      });
      try {
        return await new Promise<ProjectDocument[]>((resolve, reject) => {
          const read = database
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          read.onsuccess = () => resolve(read.result as ProjectDocument[]);
          read.onerror = () =>
            reject(new Error(read.error?.message ?? 'IndexedDB read failed'));
        });
      } finally {
        database.close();
      }
    });
    const document = durable.find(
      (document) => document.name === recovery.name
    )!;
    expect(document.version).toBe(recovery.version);
    expect(document.revisions).toHaveLength(1);
    expect(
      document.checkpoints.some(
        (checkpoint) => checkpoint.reason === 'Manual save'
      )
    ).toBe(true);
    expect(document.editHistory?.entries).toEqual(
      recovery.editHistory?.entries
    );
  });
}
