import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  WORKSPACE_SESSION_STORAGE_KEY,
  createPrimitiveInPlace,
  createProject,
  expectBodyCount,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * Opening a project awaits storage before it records itself as the one to
 * reopen. A pointer written in that window by a newer navigation in the same
 * tab is the newer choice, and
 * the open used to overwrite it, so the reload opened the wrong project.
 */
test('a project open keeps a reopen pointer written while it was in flight', async ({
  page
}) => {
  const older = createProjectDocument('Pointer target', toUserId('user_e2e'));
  await stubApi(page);
  await page.goto('/');
  await page.evaluate(
    ({ legacy, key }) => {
      // The new project's device write is the await between the open
      // starting and it recording itself. Store the other project and move
      // this tab's pointer to it exactly there, as a newer navigation would.
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore['put']>
      ) {
        const [value] = args as [{ name?: unknown }];
        if (this.name === 'projects' && value?.name === 'Pointer newcomer') {
          IDBObjectStore.prototype.put = put;
          put.call(this, legacy);
          sessionStorage.setItem(
            key,
            JSON.stringify({
              version: 1,
              activeProjectId: legacy.projectId,
              views: {}
            })
          );
        }
        return put.apply(this, args);
      };
    },
    { legacy: older, key: WORKSPACE_SESSION_STORAGE_KEY }
  );

  await page.getByLabel('Project name').fill('Pointer newcomer');
  await page.getByRole('button', { name: 'New project' }).click();
  const topbar = page.locator('.topbar');
  await expect(topbar.getByText('Pointer newcomer')).toBeVisible({
    timeout: 30_000
  });
  await expect(
    topbar.locator('.topbar-identity').getByRole('status', { name: 'Saved' })
  ).toBeVisible({ timeout: 15_000 });
  const pointer = () =>
    page.evaluate(
      (key) =>
        (
          JSON.parse(sessionStorage.getItem(key) ?? '{}') as {
            activeProjectId?: string | null;
          }
        ).activeProjectId ?? null,
      WORKSPACE_SESSION_STORAGE_KEY
    );
  expect(await pointer()).toBe(older.projectId);

  await page.reload();
  await expect(topbar.getByText('Pointer target')).toBeVisible({
    timeout: 30_000
  });
  expect(await pointer()).toBe(older.projectId);
});

for (const signedIn of [true, false]) {
  test(
    `different projects stay in their own tabs after reload (${signedIn ? 'account' : 'local'})`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      // Two live geometry workspaces and five cold reloads share this budget.
      test.setTimeout(120_000);
      const errors: string[] = [];
      const prepare = async (tab: typeof page) => {
        tab.on('pageerror', (error) => errors.push(error.message));
        tab.on('console', (message) => {
          if (message.type() !== 'error') return;
          // The signed-out fixture deliberately refuses session reads.
          if (
            !signedIn &&
            message.location().url.endsWith('/api/session') &&
            message.text().includes('401')
          )
            return;
          errors.push(message.text());
        });
        await stubApi(tab);
        if (!signedIn)
          await tab.route('**/api/session', (route) =>
            route.fulfill({ status: 401, json: { error: 'Signed out' } })
          );
      };
      await prepare(page);
      await createProject(page, 'Tab A box');
      await createPrimitiveInPlace(page, 'box');
      await expectBodyCount(page, 1);
      await expect(
        page.getByRole('status', {
          name: signedIn ? 'Saved' : 'Local only',
          exact: true
        })
      ).toBeVisible();

      const second = await page.context().newPage();
      try {
        await prepare(second);
        // A fresh tab retains the existing last-project fallback. It cannot
        // edit the first tab's project, but can return home and open its own.
        // Both tabs use the real shared IndexedDB, sessionStorage and Web Locks.
        // Supply the first account head to the second tab's isolated API stub.
        await page.bringToFront();
        const firstDocument = await page.evaluate(
          () =>
            new Promise<unknown>((resolve, reject) => {
              const open = indexedDB.open('openzcad-v2');
              open.onerror = () =>
                reject(
                  open.error ?? new Error('Could not open project storage')
                );
              open.onsuccess = () => {
                const db = open.result;
                const read = db
                  .transaction('projects')
                  .objectStore('projects')
                  .getAll();
                read.onsuccess = () => {
                  resolve(read.result[0]);
                  db.close();
                };
                read.onerror = () => {
                  reject(
                    read.error ?? new Error('Could not read project storage')
                  );
                  db.close();
                };
              };
            })
        );
        await second.route('**/api/projects/*', (route) => {
          const document = firstDocument as { projectId: string };
          return route.request().method() === 'GET' &&
            new URL(route.request().url()).pathname ===
              `/api/projects/${document.projectId}`
            ? route.fulfill({ json: document })
            : route.fallback();
        });
        await second.bringToFront();
        await second.goto('/');
        await expect(second.getByRole('banner')).toContainText('Tab A box');
        await second.getByTitle('Back to projects').click();
        await second.getByLabel('Project name').fill('Tab B cylinder');
        await second
          .getByRole('button', { name: 'New project', exact: true })
          .click();
        await createPrimitiveInPlace(second, 'cylinder');
        await expectBodyCount(second, 1);
        await expect(
          second.getByRole('status', {
            name: signedIn ? 'Saved' : 'Local only',
            exact: true
          })
        ).toBeVisible();

        for (const [tab, name, feature] of [
          [page, 'Tab A box', 'Box'],
          [second, 'Tab B cylinder', 'Cylinder'],
          [page, 'Tab A box', 'Box']
        ] as const) {
          await tab.bringToFront();
          await tab.reload({ waitUntil: 'domcontentloaded' });
          await expect(tab).toHaveTitle('OpenZCAD');
          await expect(
            tab.getByRole('button', { name: 'Rename project' })
          ).toContainText(name);
          await expect(
            tab.getByRole('button', { name: /^Box \(B\)/ })
          ).toBeEnabled();
          await expectBodyCount(tab, 1);
          await expect(
            tab.locator('.feature-row-main', { hasText: feature })
          ).toBeVisible();
          await expect(tab.locator('vite-error-overlay')).toHaveCount(0);
        }
        if (process.env.OZ_TAB_SCREENSHOTS) {
          await page.bringToFront();
          await page.screenshot({
            animations: 'disabled',
            path: `${process.env.OZ_TAB_SCREENSHOTS}/tab-a-${signedIn ? 'account' : 'local'}.png`
          });
          await second.bringToFront();
          await second.screenshot({
            animations: 'disabled',
            path: `${process.env.OZ_TAB_SCREENSHOTS}/tab-b-${signedIn ? 'account' : 'local'}.png`
          });
        }

        await second.bringToFront();
        await second.getByTitle('Back to projects').click();
        await expect(
          second.getByRole('button', { name: 'New project', exact: true })
        ).toBeVisible();
        await page.bringToFront();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(
          page.getByRole('button', { name: 'Rename project' })
        ).toContainText('Tab A box');
        await second.bringToFront();
        await second.reload({ waitUntil: 'domcontentloaded' });
        await expect(
          second.getByRole('button', { name: 'New project', exact: true })
        ).toBeVisible();
        expect(errors).toEqual([]);
      } finally {
        await second.close();
      }
    }
  );
}
