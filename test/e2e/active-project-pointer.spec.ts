import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  WORKSPACE_SESSION_STORAGE_KEY,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * Opening a project awaits storage before it records itself as the one to
 * reopen. A pointer written in that window — by another tab, or by a test
 * seeding the session right after Create project — is the newer choice, and
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
      // the pointer to it exactly there, as another tab would.
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore['put']>
      ) {
        const [value] = args as [{ name?: unknown }];
        if (this.name === 'projects' && value?.name === 'Pointer newcomer') {
          IDBObjectStore.prototype.put = put;
          put.call(this, legacy);
          localStorage.setItem(
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
          JSON.parse(localStorage.getItem(key) ?? '{}') as {
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
