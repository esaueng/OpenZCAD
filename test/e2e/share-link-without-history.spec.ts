import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import {
  createProjectDocument,
  frozenShareDocument,
  isSharedWithoutHistory
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  expect,
  expectBodyCount,
  stubAnonymousApi,
  test
} from './openzcad-fixtures';

async function localDocuments(page: Page): Promise<ProjectDocument[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openzcad-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB request failed'));
    });
    try {
      return await new Promise<ProjectDocument[]>((resolve, reject) => {
        const request = db
          .transaction('projects')
          .objectStore('projects')
          .getAll();
        request.onsuccess = () => resolve(request.result as ProjectDocument[]);
        request.onerror = () =>
          reject(request.error ?? new Error('IndexedDB request failed'));
      });
    } finally {
      db.close();
    }
  });
}

// L08: what a link without history serves is the frozen model alone. The
// Worker's side (never the project, never its sources) is covered against
// the real routes in test/share-link-without-history.test.ts; here a
// visitor's browser opens exactly that answer.
test(
  'a visitor of a link without history gets the finished solid, and copies only that',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const stepText = await readFile(
      new URL('../parity/corpus/b-unit-mm-cube.step', import.meta.url),
      'utf8'
    );
    const frozen = frozenShareDocument(
      createProjectDocument('Bracket', toUserId('share_owner')),
      [{ name: 'Plate', stepText, color: null, opacity: null }]
    );
    await stubAnonymousApi(page);
    const requests: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/api/share')) requests.push(pathname);
    });
    await page.route('**/api/share', (route) =>
      route.fulfill({
        json: {
          project: {
            projectId: frozen.projectId,
            name: frozen.name,
            mode: 'view',
            history: false
          },
          document: frozen
        }
      })
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/#share=${'s'.repeat(43)}`);
    await expectBodyCount(page, 1);

    // The visitor is told, not shown an empty or failed history.
    await expect(page.getByRole('contentinfo')).toContainText(
      'The owner shared it without its history.'
    );
    await expect(
      page.getByRole('status', {
        name: 'Shared model · View only · No history'
      })
    ).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    // The model came whole: no source file or asset was asked for.
    expect(requests).toEqual(['/api/share']);
    expect(await localDocuments(page)).toEqual([]);

    await page
      .getByRole('button', { name: 'Make a copy', exact: true })
      .click();
    await expect.poll(async () => (await localDocuments(page)).length).toBe(1);
    const copy = (await localDocuments(page))[0]!;
    expect(copy.projectId).not.toBe(frozen.projectId);
    expect(isSharedWithoutHistory(copy)).toBe(false);
    const features = Object.values(copy.nodes).filter(
      (node) => node.kind === 'feature'
    );
    expect(features.map((node) => [node.name, node.featureKind])).toEqual([
      ['Plate', 'imported-step']
    ]);
    expect(copy.sketchOrder).toEqual([]);
    expect(copy.parameterOrder).toEqual([]);
    await expectBodyCount(page, 1);
  }
);
