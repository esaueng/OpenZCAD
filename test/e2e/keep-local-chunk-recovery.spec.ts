import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';
import { STALE_CHUNK_MESSAGE } from '../../apps/web/src/lib/staleChunk';
import {
  TOAST_EXIT_MS,
  TOAST_LIFETIME_MS
} from '../../apps/web/src/lib/toasts';

test('a missing Keep my version chunk preserves conflict work and persistent reload', async ({
  page
}, testInfo) => {
  test.setTimeout(60_000);
  const base = createProjectDocument(
    'Local conflict work',
    toUserId('other_owner')
  );
  const local = addPrimitiveFeature(base, {
    name: 'Local box',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  const remote = {
    ...addPrimitiveFeature(base, {
      name: 'Remote sphere',
      primitiveKind: 'sphere',
      dimensions: { radius: 5 }
    }),
    version: local.version + 3
  };
  await stubApi(page, { collaborationRole: 'editor' });
  const summary = {
    projectId: local.projectId,
    name: local.name,
    revisionCount: local.checkpoints.length,
    documentVersion: local.version,
    updatedAt: local.derived.updatedAt
  };
  await page.route('**/api/projects', (route) =>
    route.fulfill({
      json:
        route.request().method() === 'POST'
          ? { project: summary, document: local }
          : { projects: [] }
    })
  );
  let missingChunks = 0;
  await page.route(/\/assets\/keepLocalRoomVersion-.*\.js$/, (route) => {
    missingChunks++;
    return route.fulfill({
      status: 404,
      contentType: 'text/plain',
      body: 'This old asset is unavailable.'
    });
  });
  await page.addInitScript((initial) => {
    const browser = window as unknown as {
      __conflictSocket: WebSocket;
      __keepRequests: number;
    };
    browser.__keepRequests = 0;
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        browser.__conflictSocket = this;
      }
      override send(raw: Parameters<WebSocket['send']>[0]) {
        if (typeof raw !== 'string') return;
        const frame = JSON.parse(raw) as {
          type: string;
          clientId: string;
          conflictResolution?: string;
        };
        if (frame.type === 'hello')
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'state',
                  members: [],
                  document: initial,
                  role: 'editor',
                  lease: null
                })
              })
            )
          );
        if (frame.type === 'lease-acquire' || frame.type === 'lease-renew')
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'lease-granted',
                  lease: {
                    projectId: initial.projectId,
                    leaseId: 'keep_chunk_lease',
                    clientId: frame.clientId,
                    userId: 'user_e2e',
                    expiresAt: Date.now() + 120_000
                  }
                })
              })
            )
          );
        if (frame.conflictResolution === 'keep-local') browser.__keepRequests++;
      }
    };
  }, local);
  await page.goto('/');
  await expect(page).toHaveTitle(/OpenZCAD/);
  await page.getByLabel('Project name').fill(local.name);
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expectBodyCount(page, 1);
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeEnabled();
  const origin = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate((document) => {
    (
      window as unknown as { __conflictSocket: WebSocket }
    ).__conflictSocket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'conflict', document })
      })
    );
  }, remote);
  const dialog = page.getByRole('dialog', {
    name: 'This project changed in two places'
  });
  const keep = dialog.getByRole('button', {
    name: 'Keep this device’s version'
  });
  await expect(keep).toBeEnabled();
  await keep.click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toBeVisible();
  const error = await alert.textContent();
  expect(missingChunks).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { __keepRequests: number }).__keepRequests
    )
  ).toBe(0);
  await expect(keep).not.toHaveAttribute('aria-disabled');
  await expect(page.locator('.toast')).toContainText(STALE_CHUNK_MESSAGE);
  await expect(
    page.getByText('A newer OpenZCAD build is available.')
  ).toHaveCount(0);
  const stored = await page.evaluate(
    (projectId) =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () =>
          reject(new Error(open.error?.message ?? 'IndexedDB unavailable.'));
        open.onsuccess = () => {
          const db = open.result;
          const read = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .get(projectId);
          read.onsuccess = () => {
            resolve(read.result as ProjectDocument);
            db.close();
          };
          read.onerror = () =>
            reject(new Error(read.error?.message ?? 'Project read failed.'));
        };
      }),
    local.projectId
  );
  expect(stored.nodes).toEqual(local.nodes);
  expect(stored.commandLog).toEqual(local.commandLog);
  await dialog.getByRole('button', { name: 'Decide later' }).click();
  await expect(
    page.locator('.toast').getByRole('button', { name: 'Reload' })
  ).toBeVisible();
  await expectBodyCount(page, 1);
  await expect(
    page.locator('.feature-row', { hasText: 'Local box' })
  ).toBeVisible();
  await expect(page.locator('.error-page, vite-error-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
  await expect(page.locator('.toast')).toHaveCount(0, {
    timeout: TOAST_LIFETIME_MS + TOAST_EXIT_MS + 2000
  });
  await page.getByTitle('Back to projects').click();
  const notice = page.locator('.start-update');
  await expect(notice).toContainText(STALE_CHUNK_MESSAGE);
  await expect(notice.getByRole('button', { name: 'Reload' })).toBeVisible();
  await testInfo.attach('keep-local-persistent-reload', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  expect(error).toBe(STALE_CHUNK_MESSAGE);
});
