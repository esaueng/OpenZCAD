import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

// The save-all results live in the cloud card at the foot of the library
// column, and the column does not scroll. A run with many failures used to
// grow the card past the window's bottom edge, out of reach of the pointer:
// the last parts' Retry buttons could not be clicked at all.
test('a long list of failed saves stays reachable in the cloud card', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const documents = Array.from({ length: 24 }, (_, index) =>
    createProjectDocument(`Unsaved part ${index + 1}`, toUserId('user_local'))
  );
  await stubApi(page);
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, json: { error: 'Storage is down.' } })
      : route.fallback()
  );
  await page.goto('/');
  // The library has settled (and opened its database) once the card speaks.
  await expect(page.locator('.start-account')).toHaveText('Signed in');
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
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(new Error(tx.error?.message ?? 'IndexedDB write failed'));
      });
    } finally {
      database.close();
    }
  }, documents);
  await page.reload();

  const card = page.locator('.start-account');
  await expect(card).toContainText('24 parts not saved');
  await page
    .getByRole('button', { name: 'Save them all to my account' })
    .click();
  await expect(card).toContainText('24 not saved', { timeout: 15_000 });

  const failures = card.locator('.start-sync-failure');
  await expect(failures).toHaveCount(24);
  const inWindow = async (box: { y: number; height: number } | null) => {
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(900);
  };
  // The card itself stays inside the window, with its controls above the
  // list, and the last failure scrolls into reach inside it.
  await inWindow(await card.boundingBox());
  await inWindow(
    await page
      .getByRole('button', { name: 'Dismiss sync results' })
      .boundingBox()
  );
  const lastRetry = page
    .getByRole('button', { name: 'Retry Unsaved part' })
    .last();
  await lastRetry.scrollIntoViewIfNeeded();
  await inWindow(await lastRetry.boundingBox());
  await lastRetry.click({ trial: true });
});
