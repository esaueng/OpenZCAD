import type { Page } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

const rows = Array.from({ length: 20 }, (_, index) => ({
  projectId: `proj_background_${index}`,
  name: `Background part ${index}`,
  revisionCount: 1,
  updatedAt: '2026-10-21T12:00:00Z',
  organization: { status: 'active', pinned: false, sortOrder: index }
}));
async function seedPending(page: Page, expired = false) {
  await page.evaluate(
    async ({ projects, expired }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(new Error(request.error?.message ?? 'Open failed'));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('projectMeta', 'readwrite');
          for (const project of projects)
            tx.objectStore('projectMeta').put({
              projectId: project.projectId,
              ...project.organization,
              pinned: true,
              mirrorPending: true,
              organizationRevision: crypto.randomUUID(),
              ...(expired && project.projectId === 'proj_background_19'
                ? { status: 'deleted', deletedAt: '2020-01-01T00:00:00Z' }
                : {})
            });
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(new Error(tx.error?.message ?? 'Write failed'));
        });
      } finally {
        db.close();
      }
    },
    { projects: rows, expired }
  );
}
async function pending(page: Page, id = rows[0]!.projectId) {
  return page.evaluate(async (projectId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openzcad-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error(request.error?.message ?? 'Open failed'));
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = db
          .transaction('projectMeta')
          .objectStore('projectMeta')
          .get(projectId);
        request.onsuccess = () =>
          resolve(
            (request.result as { mirrorPending?: boolean } | undefined)
              ?.mirrorPending === true
          );
        request.onerror = () =>
          reject(new Error(request.error?.message ?? 'Read failed'));
      });
    } finally {
      db.close();
    }
  }, id);
}
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

test('two tabs share background pacing without delaying the library or fresh actions', async ({
  page,
  context
}, testInfo) => {
  const second = await context.newPage(),
    held = gate();
  const calls: { id: string; pinned: boolean; time: number }[] = [];
  const errors: string[] = [];
  for (const tab of [page, second]) {
    tab.on('pageerror', (error) => errors.push(error.message));
    await stubApi(tab);
    await tab.route('**/api/projects', (route) =>
      route.fulfill({ json: { projects: rows } })
    );
    await tab.route('**/api/projects/proj_background_*', async (route) => {
      const body = route.request().postDataJSON() as {
        projectId: string;
        pinned: boolean;
      };
      calls.push({ id: body.projectId, pinned: body.pinned, time: Date.now() });
      if (calls.length === 1) await held.wait;
      await route
        .fulfill({
          json: {
            project: {
              ...rows.find((row) => row.projectId === body.projectId),
              organization: {
                status: 'active',
                pinned: body.pinned,
                sortOrder: 0
              }
            }
          }
        })
        .catch(() => undefined);
    });
  }
  await page.goto('/');
  await expect(page.locator('.start-tile-open')).toHaveCount(20);
  await seedPending(page);
  await page.reload();
  await expect.poll(() => calls.length).toBe(1);
  // Both launchers settle while the first account response is still held.
  await expect(
    page.getByRole('status', { name: 'Loading library' })
  ).toHaveCount(0);
  await second.goto('/');
  await expect(second.locator('.start-tile-open')).toHaveCount(20);
  await expect(
    second.getByRole('status', { name: 'Loading library' })
  ).toHaveCount(0);
  await expect.poll(() => Date.now() - calls[0]!.time).toBeGreaterThan(1_100);
  expect(calls).toHaveLength(1);
  try {
    await page
      .getByRole('button', { name: 'Unpin Background part 19', exact: true })
      .click();
  } finally {
    held.open();
  }
  await expect.poll(() => calls[1]?.id).toBe('proj_background_19');
  expect(calls[1]?.pinned).toBe(false);
  await expect
    .poll(() => calls.filter((call) => call.pinned).length)
    .toBeGreaterThanOrEqual(3);
  const background = calls.filter((call) => call.pinned);
  for (let i = 1; i < background.length; i++)
    expect(
      background[i]!.time - background[i - 1]!.time
    ).toBeGreaterThanOrEqual(900);
  await expect.poll(() => pending(page, 'proj_background_19')).toBe(false);
  await second.screenshot({ path: testInfo.outputPath('second-tab.png') });
  expect(errors).toEqual([]);
  await second.close();
});

test('signing out in another tab cancels queued work and leaves an in-flight edit pending', async ({
  page,
  context
}) => {
  const second = await context.newPage(),
    held = gate();
  const calls: string[] = [];
  for (const tab of [page, second]) {
    await stubApi(tab);
    await tab.route('**/api/projects', (route) =>
      route.fulfill({ json: { projects: rows } })
    );
    await tab.route('**/api/auth/logout', (route) =>
      route.fulfill({ json: { ok: true } })
    );
    await tab.route('**/api/projects/proj_background_*', async (route) => {
      calls.push(route.request().url());
      await held.wait;
      await route
        .fulfill({ json: { project: rows[0] } })
        .catch(() => undefined);
    });
  }
  await page.goto('/');
  await expect(page.locator('.start-tile-open')).toHaveCount(20);
  await seedPending(page, true);
  await page.reload();
  await expect.poll(() => calls.length).toBe(1);
  await second.goto('/');
  await expect(second.locator('.start-tile-open')).toHaveCount(19);
  const cancelled = page.waitForEvent('requestfailed', {
    predicate: (request) =>
      request.url().includes('/api/projects/proj_background_')
  });
  await second.getByRole('button', { name: 'Open settings' }).click();
  await second.getByRole('button', { name: 'Account', exact: true }).click();
  await second.getByRole('button', { name: 'Sign out', exact: true }).click();
  await cancelled;
  held.open();
  const stoppedAt = Date.now();
  await expect.poll(() => Date.now() - stoppedAt).toBeGreaterThan(1_100);
  expect(calls).toHaveLength(1);
  expect(await pending(page)).toBe(true);
  expect(await pending(page, 'proj_background_19')).toBe(true);
  await second.close();
});
