import type { Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  isSharedWithoutHistory,
  setParameter,
  tweakableShareDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  expect,
  expectBodyCount,
  stubAnonymousApi,
  test
} from './openzcad-fixtures';

const SECRET = 'Secret boss';

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

// L08: a Tweak link without history serves the recipe with its features
// and sketches unnamed and no history (test/share-link-without-history.test.ts
// covers the Worker). The visitor changes a parameter without ever seeing
// the feature list, and a copy keeps only the solids, as tweaked.
test(
  'a visitor of a Tweak link without history changes parameters and copies only the solids',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    let owner = createProjectDocument('Bracket', toUserId('share_owner'));
    owner = setParameter(owner, { name: 'width', expression: '20' });
    owner = addPrimitiveFeature(owner, {
      name: SECRET,
      primitiveKind: 'box',
      dimensions: { width: 'width', height: 10, depth: 4 }
    });
    // The body keeps a name of its own: bodies are named on every link.
    for (const node of Object.values(owner.nodes))
      if (node.kind === 'body') node.name = 'Plate';
    const recipe = tweakableShareDocument(owner);
    await stubAnonymousApi(page);
    await page.route('**/api/share', (route) =>
      route.fulfill({
        json: {
          project: {
            projectId: recipe.projectId,
            name: recipe.name,
            mode: 'tweak',
            history: false
          },
          document: recipe
        }
      })
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/#share=${'t'.repeat(43)}`);
    await expectBodyCount(page, 1);
    await expect(page.getByRole('contentinfo')).toContainText(
      'adjust its parameters and export. The owner shared it without its history.'
    );
    await expect(
      page.getByRole('status', {
        name: 'Shared model · Tweak only · No history'
      })
    ).toBeVisible();

    const width = page.getByLabel('Expression for width', { exact: true });
    await expect(width).toHaveValue('20');
    // No feature list is offered anywhere, and no feature name is shown.
    await expect(
      page.getByRole('button', { name: 'History panel' })
    ).toHaveCount(0);
    await expect(page.getByText(SECRET)).toHaveCount(0);

    await width.fill('30');
    await width.press('Enter');
    await expect(width).toHaveValue('30');
    await expectBodyCount(page, 1);

    await page
      .getByRole('button', { name: 'Make a copy', exact: true })
      .click();
    await expect.poll(async () => (await localDocuments(page)).length).toBe(1);
    const copy = (await localDocuments(page))[0]!;
    expect(copy.projectId).not.toBe(recipe.projectId);
    expect(isSharedWithoutHistory(copy)).toBe(false);
    const features = Object.values(copy.nodes).filter(
      (node) => node.kind === 'feature'
    );
    expect(features.map((node) => node.featureKind)).toEqual(['imported-step']);
    expect(copy.parameterOrder).toEqual([]);
    expect(copy.sketchOrder).toEqual([]);
    expect(JSON.stringify(copy)).not.toContain(SECRET);
    await expectBodyCount(page, 1);
  }
);
