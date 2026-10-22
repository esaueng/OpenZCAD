import type { Page } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

const projectId = 'shelf-race-project';
const name = 'Shelf race part';
const active = { status: 'active', pinned: false, sortOrder: 0 };
const project = (organization = active) => ({
  projectId,
  name,
  revisionCount: 1,
  updatedAt: '2026-10-21T12:00:00.000Z',
  organization
});

interface Metadata {
  pinned: boolean;
  status: string;
  mirrorPending?: boolean;
}

async function readMetadata(page: Page) {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openzcad-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error(request.error?.message ?? 'IndexedDB open failed'));
    });
    try {
      return await new Promise<Metadata | undefined>((resolve, reject) => {
        const request = db
          .transaction('projectMeta')
          .objectStore('projectMeta')
          .get(id);
        request.onsuccess = () =>
          resolve(request.result as Metadata | undefined);
        request.onerror = () =>
          reject(new Error(request.error?.message ?? 'IndexedDB read failed'));
      });
    } finally {
      db.close();
    }
  }, projectId);
}

for (const width of [1440, 390]) {
  test(`account shelf changes render on the first refresh at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let organization = active;
    await page.route('**/api/projects', (route) =>
      route.fulfill({ json: { projects: [project(organization)] } })
    );
    await page.goto('/');
    await expect(
      page.locator('.start-tile-open', { hasText: name })
    ).toBeVisible();
    await expect.poll(() => readMetadata(page)).toMatchObject(active);
    organization = { ...active, status: 'archived' };
    await page.reload();
    await expect(
      page.getByRole('status', { name: 'Loading library' })
    ).toHaveCount(0);
    await expect(
      page.locator('.start-tile-open', { hasText: name })
    ).toHaveCount(0);
    await page.getByRole('tab', { name: /^Archive/ }).click();
    await expect(
      page.locator('.start-tile-open', { hasText: name })
    ).toBeVisible();
    expect(await page.title()).toContain('OpenZCAD');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('a slow pin acknowledgement cannot clear a later failed unpin', async ({
  page
}) => {
  await stubApi(page);
  let organization = active;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const writes: boolean[] = [];
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: { projects: [project(organization)] } })
  );
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    const payload = route.request().postDataJSON() as { pinned: boolean };
    writes.push(payload.pinned);
    if (writes.length === 1) {
      await firstGate;
      organization = { ...active, pinned: payload.pinned };
      await route.fulfill({ json: { project: project(organization) } });
    } else {
      await route.fulfill({
        status: 503,
        json: { error: 'Temporary shelf failure' }
      });
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: `Pin ${name}`, exact: true }).click();
  await expect.poll(() => writes).toEqual([true]);
  try {
    await page
      .getByRole('button', { name: `Unpin ${name}`, exact: true })
      .click();
    await expect
      .poll(() => readMetadata(page))
      .toMatchObject({ pinned: false, mirrorPending: true });
  } finally {
    releaseFirst();
  }
  await expect.poll(() => writes).toEqual([true, false]);
  await expect(
    page.getByText(`Unpinned ${name}.`, { exact: true })
  ).toBeVisible();
  await expect
    .poll(() => readMetadata(page))
    .toMatchObject({ pinned: false, mirrorPending: true });
  await expect(
    page.getByRole('button', { name: `Pin ${name}`, exact: true })
  ).toBeVisible();
  // The account still has the successful pin; a reload must retain the
  // durable pending unpin even when retrying it fails again.
  await page.reload();
  await expect(
    page.getByRole('button', { name: `Pin ${name}`, exact: true })
  ).toBeVisible();
  await expect
    .poll(() => readMetadata(page))
    .toMatchObject({ pinned: false, mirrorPending: true });
});
