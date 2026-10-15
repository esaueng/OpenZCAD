import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';

async function storedCheckpoints(page: Page) {
  return page.evaluate(
    () =>
      new Promise<Array<{ reason: string; document: ProjectDocument }>>(
        (resolve, reject) => {
          const open = indexedDB.open('openzcad-v2');
          open.onerror = () =>
            reject(new Error(open.error?.message ?? 'IndexedDB unavailable.'));
          open.onsuccess = () => {
            const database = open.result;
            const transaction = database.transaction(
              'projectCheckpointDocuments',
              'readonly'
            );
            const all = transaction
              .objectStore('projectCheckpointDocuments')
              .getAll();
            all.onerror = () =>
              reject(
                new Error(all.error?.message ?? 'Checkpoint read failed.')
              );
            all.onsuccess = () => {
              database.close();
              resolve(all.result);
            };
          };
        }
      )
  );
}

for (const fault of ['missing', 'stalled'] as const) {
  test(`the first member named save survives a ${fault} checkpoint module on this device`, async ({
    page
  }) => {
    const document = addPrimitiveFeature(
      createProjectDocument(
        'Offline member checkpoint',
        toUserId('other_owner')
      ),
      {
        name: 'Clicked box',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 3, depth: 4 }
      }
    );
    const summary = {
      projectId: document.projectId,
      name: document.name,
      revisionCount: document.revisions.length,
      documentVersion: document.version,
      updatedAt: document.derived.updatedAt
    };
    await stubApi(page, { collaborationRole: 'editor' });
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        json:
          route.request().method() === 'POST'
            ? { project: summary, document }
            : { projects: [summary] }
      })
    );
    await page.route(`**/api/projects/${document.projectId}`, (route) =>
      route.fulfill({ json: document })
    );
    let roomWrites = 0;
    await page.route(
      `**/api/projects/${document.projectId}/collaboration`,
      (route) => {
        roomWrites += 1;
        return route.fulfill({ status: 503, json: { error: 'Offline room.' } });
      }
    );
    await page.route(
      `**/api/projects/${document.projectId}/revisions`,
      (route) => route.fulfill({ json: { revisions: [], maxRevisions: 50 } })
    );
    let moduleRequests = 0;
    let release!: () => void;
    const moduleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      '**/assets/collaborationCheckpoint-*.js*',
      async (route) => {
        moduleRequests += 1;
        if (fault === 'stalled') {
          await moduleGate;
          return route.continue();
        }
        return route.abort('failed');
      }
    );
    await page.addInitScript((initial) => {
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        override send(raw: Parameters<WebSocket['send']>[0]) {
          if (typeof raw !== 'string') return;
          const frame = JSON.parse(raw) as {
            type: string;
            clientId: string;
            document?: ProjectDocument;
          };
          const message =
            frame.type === 'hello'
              ? {
                  type: 'state',
                  members: [],
                  document: initial,
                  role: 'editor',
                  lease: null
                }
              : frame.type === 'lease-acquire' || frame.type === 'lease-renew'
                ? {
                    type: 'lease-granted',
                    lease: {
                      leaseId: 'offline_checkpoint_lease',
                      projectId: initial.projectId,
                      clientId: frame.clientId,
                      userId: 'user_e2e',
                      expiresAt: Date.now() + 120_000
                    }
                  }
                : frame.type === 'document' && frame.document
                  ? { type: 'ack', version: frame.document.version }
                  : null;
          if (message)
            queueMicrotask(() =>
              this.dispatchEvent(
                new MessageEvent('message', { data: JSON.stringify(message) })
              )
            );
        }
      };
    }, document);
    try {
      await page.goto('/');
      await page.getByLabel('Project name').fill(document.name);
      await page.getByRole('button', { name: 'Create project' }).click();
      await expectBodyCount(page, 1);
      await expect(
        page.getByRole('status', { name: 'Saved', exact: true })
      ).toBeVisible();
      expect(moduleRequests).toBe(0);
      await page.keyboard.press('ControlOrMeta+Shift+s');
      const dialog = page.getByRole('dialog', { name: 'Name this save' });
      await dialog.getByLabel('Save name').fill('Offline milestone');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => moduleRequests).toBe(1);
      await expect(
        page.locator('.revision-row', { hasText: 'Offline milestone' })
      ).toBeVisible({ timeout: fault === 'stalled' ? 20_000 : 10_000 });
      await expect(page.getByRole('contentinfo')).toContainText(
        'The named save is stored on this device.'
      );
      await expect
        .poll(async () =>
          (await storedCheckpoints(page)).map((checkpoint) => checkpoint.reason)
        )
        .toContain('Offline milestone');
      expect(roomWrites).toBe(0);
      if (fault === 'stalled') {
        const loaded = page.waitForResponse(
          '**/assets/collaborationCheckpoint-*.js*'
        );
        release();
        await (await loaded).finished();
        await page.waitForTimeout(250);
        expect(roomWrites).toBe(0);
        expect(
          (await storedCheckpoints(page)).filter(
            (checkpoint) => checkpoint.reason === 'Offline milestone'
          )
        ).toHaveLength(1);
      }
      await page.reload();
      const saved = (await storedCheckpoints(page)).find(
        (checkpoint) => checkpoint.reason === 'Offline milestone'
      );
      expect(saved?.document.nodes).toEqual(document.nodes);
      expect(saved?.document.editHistory).toEqual(document.editHistory);
      expect(saved?.document.checkpoints.at(-1)?.reason).toBe(
        'Offline milestone'
      );
      expect(roomWrites).toBe(0);
    } finally {
      release();
    }
  });
}
