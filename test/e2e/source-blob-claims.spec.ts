import type { Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

const DATABASE_NAME = 'openzcad-v2';
const VERSION_SEVEN_STORES: Array<{
  name: string;
  keyPath: string;
}> = [
  { name: 'projects', keyPath: 'projectId' },
  { name: 'projectMeta', keyPath: 'projectId' },
  { name: 'projectSync', keyPath: 'projectId' },
  { name: 'sourceBlobs', keyPath: 'checksumSha256' },
  { name: 'projectThumbnails', keyPath: 'projectId' },
  { name: 'projectSummaries', keyPath: 'projectId' },
  { name: 'projectMeasurements', keyPath: 'projectId' }
];

async function waitForSourceStore(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(window.__openzcadE2ESourceBlobStore))
    )
    .toBe(true);
}

test('a version-7 tab closes on versionchange so version 8 starts', async ({
  context
}) => {
  const oldTab = await context.newPage();
  await oldTab.route('**/__e2e/idb-host', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>IDB host</title>'
    })
  );
  await oldTab.goto('/__e2e/idb-host');
  await oldTab.evaluate(
    async ({ databaseName, stores }) => {
      await new Promise<void>((resolve, reject) => {
        const deletion = indexedDB.deleteDatabase(databaseName);
        deletion.onsuccess = () => resolve();
        deletion.onerror = () =>
          reject(deletion.error ?? new Error('Database deletion failed.'));
      });
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(databaseName, 7);
        open.onupgradeneeded = () => {
          for (const store of stores) {
            open.result.createObjectStore(store.name, {
              keyPath: store.keyPath
            });
          }
        };
        open.onsuccess = () => {
          const testWindow = window as typeof window & {
            __versionSevenConnection?: IDBDatabase;
            __versionSevenChangeCount?: number;
          };
          testWindow.__versionSevenConnection = open.result;
          testWindow.__versionSevenChangeCount = 0;
          open.result.onversionchange = () => {
            testWindow.__versionSevenChangeCount =
              (testWindow.__versionSevenChangeCount ?? 0) + 1;
            open.result.close();
          };
          resolve();
        };
        open.onerror = () =>
          reject(open.error ?? new Error('Version-7 database open failed.'));
      });
    },
    { databaseName: DATABASE_NAME, stores: VERSION_SEVEN_STORES }
  );

  const newTab = await context.newPage();
  await stubApi(newTab);
  await newTab.goto('/');
  await waitForSourceStore(newTab);

  await expect(
    newTab.evaluate(() =>
      window.__openzcadE2ESourceBlobStore!.ensureLocalProjectStorage()
    )
  ).resolves.toBe('ready');
  await expect
    .poll(() =>
      oldTab.evaluate(
        () =>
          (
            window as typeof window & {
              __versionSevenChangeCount?: number;
            }
          ).__versionSevenChangeCount ?? 0
      )
    )
    .toBe(1);
  await expect(
    newTab.evaluate(
      (databaseName) =>
        new Promise<boolean>((resolve, reject) => {
          const open = indexedDB.open(databaseName);
          open.onsuccess = () => {
            const hasClaims =
              open.result.objectStoreNames.contains('sourceBlobClaims');
            open.result.close();
            resolve(hasClaims);
          };
          open.onerror = () =>
            reject(open.error ?? new Error('Database inspection failed.'));
        }),
      DATABASE_NAME
    )
  ).resolves.toBe(true);
});

test('same-file claims protect another tab and release abandoned bytes', async ({
  context
}) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await Promise.all([stubApi(tabA), stubApi(tabB)]);
  await Promise.all([tabA.goto('/'), tabB.goto('/')]);
  await Promise.all([waitForSourceStore(tabA), waitForSourceStore(tabB)]);

  const sourceText = 'ISO-10303-21; /* same bytes, two real tabs */';
  const first = await tabA.evaluate((text) => {
    const source = new Blob([text], { type: 'model/step' });
    return window.__openzcadE2ESourceBlobStore!.putSourceBlobIfAbsent(source, {
      claimId: 'tab-a-import'
    });
  }, sourceText);
  const second = await tabB.evaluate((text) => {
    const source = new Blob([text], { type: 'model/step' });
    return window.__openzcadE2ESourceBlobStore!.putSourceBlobIfAbsent(source, {
      claimId: 'tab-b-import'
    });
  }, sourceText);

  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.ref.checksumSha256).toBe(first.ref.checksumSha256);

  await expect(
    tabA.evaluate(
      (checksumSha256) =>
        window.__openzcadE2ESourceBlobStore!.deleteSourceBlobIfUnreferenced({
          checksumSha256,
          claimId: 'tab-a-import'
        }),
      first.ref.checksumSha256
    )
  ).resolves.toBe(false);
  await expect(
    tabB.evaluate(
      (checksumSha256) =>
        window.__openzcadE2ESourceBlobStore!.hasSourceBlob(checksumSha256),
      first.ref.checksumSha256
    )
  ).resolves.toBe(true);

  await tabB.evaluate(
    (checksumSha256) =>
      window.__openzcadE2ESourceBlobStore!.releaseSourceBlobClaim(
        checksumSha256,
        'tab-b-import'
      ),
    first.ref.checksumSha256
  );
  await expect(
    tabA.evaluate(
      (checksumSha256) =>
        window.__openzcadE2ESourceBlobStore!.deleteSourceBlobIfUnreferenced({
          checksumSha256,
          claimId: 'tab-a-import'
        }),
      first.ref.checksumSha256
    )
  ).resolves.toBe(true);
  await expect(
    tabB.evaluate(
      (checksumSha256) =>
        window.__openzcadE2ESourceBlobStore!.hasSourceBlob(checksumSha256),
      first.ref.checksumSha256
    )
  ).resolves.toBe(false);
});
