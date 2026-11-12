import type { Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  test,
  expect,
  createProject,
  createPrimitiveInPlace,
  expectBodyCount,
  stubAnonymousApi
} from './openzcad-fixtures';

/**
 * Persisted kernel sessions are a plaintext snapshot of the whole model, so
 * only the user's own local projects get one (`kernelSessionPolicy.ts`). A
 * shared link's model is ephemeral until the visitor makes a copy (ADR-024):
 * its viewer must never find the owner's model on their device.
 */

const DATABASE = 'openzcad-kernel-sessions';
const token = 's'.repeat(43);

/**
 * The stored sessions' index rows. Never opens a database that does not
 * exist: an open here would create it without its stores.
 */
function storedSessions(page: Page) {
  return page.evaluate(async (name) => {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === name)) return [];
    return new Promise<{ projectId: string; marker?: string }[]>(
      (resolve, reject) => {
        const opening = indexedDB.open(name);
        opening.onerror = () =>
          reject(
            opening.error ?? new Error('Could not open the session database.')
          );
        opening.onsuccess = () => {
          const database = opening.result;
          if (!database.objectStoreNames.contains('sessionIndex')) {
            database.close();
            resolve([]);
            return;
          }
          const read = database
            .transaction('sessionIndex', 'readonly')
            .objectStore('sessionIndex')
            .getAll();
          read.onerror = () =>
            reject(
              read.error ?? new Error('Could not read the session index.')
            );
          read.onsuccess = () => {
            database.close();
            resolve(read.result as { projectId: string; marker?: string }[]);
          };
        };
      }
    );
  }, DATABASE);
}

// Runs in the smoke set beside the share case: it proves capture works in
// this build, so the share case's empty database cannot pass vacuously.
test(
  'the own local project persists its kernel session',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubAnonymousApi(page);
    await createProject(page, 'Session owner');
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    // Idle capture: 1.5 s after the last live result.
    await expect
      .poll(
        async () =>
          (await storedSessions(page)).filter((row) => !row.marker).length,
        { timeout: 20_000 }
      )
      .toBe(1);
  }
);

test(
  'a shared link’s model is never persisted on the viewer’s device',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubAnonymousApi(page);
    const document = addPrimitiveFeature(
      createProjectDocument('Owner’s bracket', toUserId('user_share_owner')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 24, depth: 10 }
      }
    );
    await page.route('**/api/share/*', (route) =>
      route.fulfill({
        json: {
          document,
          project: { projectId: document.projectId, name: document.name },
          mode: 'tweak'
        }
      })
    );
    await page.goto(`/#share=${token}`);
    await expect(page.locator('.breadcrumb')).toContainText(document.name);
    await expectBodyCount(page, 1);
    // Well past the idle capture and the warm-up.
    await page.waitForTimeout(6_000);
    expect(await storedSessions(page)).toEqual([]);
  }
);
