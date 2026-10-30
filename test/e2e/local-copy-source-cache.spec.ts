import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { ProjectDocument } from '@openzcad/shared';
import { createProjectDocument, importMeshBody } from '@openzcad/document-core';
import { encodeImportedMeshPayload, toUserId } from '@openzcad/shared';
import { expect, stubApi, test } from './openzcad-fixtures';

async function seedDeviceProject(
  page: Page,
  source: ProjectDocument,
  cached?: { checksum: string; bytes: number[] }
) {
  const summary = {
    projectId: source.projectId,
    name: source.name,
    revisionCount: source.checkpoints.length,
    documentVersion: source.version,
    updatedAt: source.derived.updatedAt
  };
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'New project', exact: true })
  ).toBeVisible();
  await page.getByLabel('Project name').fill('Schema warmup');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByTitle('Back to projects').click();
  await page.evaluate(
    async ({ source, summary, cached }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error('Could not read local storage.'));
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          [
            'projects',
            'projectSummaries',
            'accountProjectIdentities',
            'sourceBlobs'
          ],
          'readwrite'
        );
        tx.objectStore('projects').clear();
        tx.objectStore('projectSummaries').clear();
        tx.objectStore('projects').put(source);
        tx.objectStore('projectSummaries').put(summary);
        tx.objectStore('accountProjectIdentities').put({
          projectId: source.projectId
        });
        if (cached)
          tx.objectStore('sourceBlobs').put({
            checksumSha256: cached.checksum,
            body: new Blob([Uint8Array.from(cached.bytes)]),
            logicalBytes: cached.bytes.length,
            createdAt: new Date().toISOString()
          });
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(tx.error ?? new Error('Could not update local storage.'));
      });
      db.close();
    },
    { source, summary, cached }
  );
  await page.reload();
}

for (const [copyStatus, sourceResult] of [
  [401, 'available'],
  [404, 'available'],
  [401, 'unauthorized'],
  [404, 'corrupt']
] as const) {
  test(`local Duplicate after ${copyStatus} ${sourceResult === 'available' ? 'caches its cloud source before localizing' : `refuses an ${sourceResult} cloud source`}`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    const bytes = encodeImportedMeshPayload({
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2]
    });
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const artifactId = 'artifact_original_cloud_mesh';
    const source = importMeshBody(
      createProjectDocument('Uncached cloud mesh', toUserId('user_e2e')),
      {
        name: 'Remote mesh',
        sourceName: 'remote.stl',
        artifactId,
        triangleCount: 1,
        meshPayloadRef: {
          marker: 'openzcad-source-ref',
          version: 1,
          hashAlgorithm: 'sha256',
          checksumSha256: checksum,
          logicalBytes: bytes.byteLength
        }
      }
    ).document;
    const summary = {
      projectId: source.projectId,
      name: source.name,
      revisionCount: source.checkpoints.length,
      documentVersion: source.version,
      updatedAt: source.derived.updatedAt
    };
    await stubApi(page);
    await page.route('**/api/projects', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { projects: [summary] } })
        : route.fallback()
    );
    // The browser builds an account copy from the account's source document
    // (ADR-024 Phase 1), so that read is the request the account refuses.
    let accountReads = 0;
    let duplicateCalls = 0;
    await page.route(`**/api/projects/${source.projectId}`, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      accountReads++;
      return route.fulfill({
        status: copyStatus,
        json: { error: 'Session expired.' }
      });
    });
    await page.route(
      `**/api/projects/${source.projectId}/duplicate`,
      (route) => {
        duplicateCalls++;
        return route.fulfill({
          status: copyStatus,
          json: { error: 'Session expired.' }
        });
      }
    );
    let downloads = 0;
    await page.route(`**/api/artifacts/${artifactId}/download`, (route) => {
      downloads++;
      if (sourceResult === 'unauthorized')
        return route.fulfill({ status: 401 });
      return route.fulfill({
        body:
          sourceResult === 'corrupt'
            ? Buffer.from('wrong bytes')
            : Buffer.from(bytes),
        contentType: 'application/vnd.openzcad.mesh-payload'
      });
    });
    await seedDeviceProject(page, source);
    await page
      .getByRole('button', {
        name: 'Actions for Uncached cloud mesh',
        exact: true
      })
      .click();
    await page
      .getByRole('menuitem', { name: 'Duplicate', exact: true })
      .click();
    if (sourceResult === 'available') {
      await expect(
        page.locator('.start-tile-open', {
          hasText: 'Uncached cloud mesh (copy)'
        })
      ).toBeVisible();
    } else {
      await expect(
        page.getByText(
          'Import source for "remote.stl" is not in local storage and could not be fetched.',
          { exact: true }
        )
      ).toBeVisible();
      await expect(
        page.locator('.start-tile-open', {
          hasText: 'Uncached cloud mesh (copy)'
        })
      ).toHaveCount(0);
    }
    expect(accountReads).toBe(1);
    expect(duplicateCalls).toBe(0);
    const observed = await page.evaluate(
      async ({ projectId, checksum }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('openzcad-v2');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () =>
            reject(request.error ?? new Error('Could not read local storage.'));
        });
        const get = <T>(store: string, key?: string) =>
          new Promise<T>((resolve, reject) => {
            const os = db.transaction(store).objectStore(store);
            const request = key === undefined ? os.getAll() : os.get(key);
            request.onsuccess = () => resolve(request.result as T);
            request.onerror = () =>
              reject(
                request.error ?? new Error('Could not read local storage.')
              );
          });
        const projects =
          await get<Array<{ projectId: string; name: string }>>('projects');
        const blob = await get<unknown>('sourceBlobs', checksum);
        db.close();
        return {
          original: projects.find((p) => p.projectId === projectId),
          copy: projects.find((p) => p.projectId !== projectId),
          cached: Boolean(blob)
        };
      },
      { projectId: source.projectId, checksum }
    );
    expect(observed.original).toEqual(source);
    if (sourceResult === 'available')
      expect(JSON.stringify(observed.copy)).toContain(
        `artifact_local_${checksum}`
      );
    else expect(observed.copy).toBeUndefined();
    console.log(
      'LOCAL_COPY_PROVENANCE',
      JSON.stringify({
        accountReads,
        duplicateCalls,
        downloads,
        cached: observed.cached,
        copyPersisted: Boolean(observed.copy)
      })
    );
    expect(downloads).toBe(1);
    expect(
      observed.cached,
      'only a verified source may be localized in a new copy'
    ).toBe(sourceResult === 'available');
  });
}

for (const imported of [false, true]) {
  test(`local Duplicate works offline without action chunks for ${imported ? 'cached imports' : 'plain models'}`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    await page.route('**/api/session', (route) =>
      route.fulfill({ json: null })
    );
    const bytes = encodeImportedMeshPayload({
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2]
    });
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const base = createProjectDocument(
      'Offline source',
      toUserId('device_owner')
    );
    const source = imported
      ? importMeshBody(base, {
          name: 'Cached mesh',
          sourceName: 'cached.stl',
          artifactId: 'artifact_cloud_cached',
          triangleCount: 1,
          meshPayloadRef: {
            marker: 'openzcad-source-ref',
            version: 1,
            hashAlgorithm: 'sha256',
            checksumSha256: checksum,
            logicalBytes: bytes.byteLength
          }
        }).document
      : base;
    await seedDeviceProject(
      page,
      source,
      imported ? { checksum, bytes: Array.from(bytes) } : undefined
    );
    await expect(
      page.getByRole('button', {
        name: 'Actions for Offline source',
        exact: true
      })
    ).toBeVisible();
    // Only the already loaded initial assets remain; a new action-module
    // dependency would fail here even with a fully verified local blob.
    await page.route('**/*.js', (route) => route.abort('internetdisconnected'));
    await page.context().setOffline(true);
    await page
      .getByRole('button', { name: 'Actions for Offline source', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Duplicate', exact: true })
      .click();
    await expect(
      page.locator('.start-tile-open', { hasText: 'Offline source (copy)' })
    ).toBeVisible();
  });
}
