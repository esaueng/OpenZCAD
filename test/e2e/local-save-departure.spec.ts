import type { Dialog, Page, Request } from '@playwright/test';
import type { ProjectDocument } from '@openzcad/shared';
import {
  createPrimitiveInPlace,
  createProject,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';

const SAVE_BUDGET_MS = process.env.CI ? 30_000 : 10_000;

/**
 * Reload the real page, cancelling any native warning. Edge can leave the
 * Playwright reload command pending after cancellation, so observe the actual
 * browser outcome instead of waiting on that command's navigation promise.
 */
async function attemptReload(page: Page): Promise<boolean> {
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  type Departure = { dialog: Dialog } | { loaded: true };
  let onDialog!: (dialog: Dialog) => void;
  let onLoad!: () => void;
  let onRequestFailed!: (request: Request) => void;
  let timer!: ReturnType<typeof setTimeout>;
  const outcome = new Promise<Departure>((resolve, reject) => {
    onDialog = (dialog) => resolve({ dialog });
    onLoad = () => resolve({ loaded: true });
    onRequestFailed = (request) => {
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        reject(
          new Error(
            `Reload failed: ${request.failure()?.errorText ?? 'unknown navigation failure'}`
          )
        );
      }
    };
    page.on('dialog', onDialog);
    page.on('load', onLoad);
    page.on('requestfailed', onRequestFailed);
    timer = setTimeout(
      () =>
        reject(
          new Error('Reload produced neither a load nor a native warning.')
        ),
      SAVE_BUDGET_MS
    );
  });
  let result: Departure;
  try {
    // The timer lets evaluation return before native beforeunload runs. This
    // is an actual reload, not a synthetic lifecycle event or app hook.
    await page.evaluate(() => {
      window.setTimeout(() => window.location.reload(), 0);
    });
    result = await outcome;
  } finally {
    clearTimeout(timer);
    page.off('dialog', onDialog);
    page.off('load', onLoad);
    page.off('requestfailed', onRequestFailed);
  }
  if ('dialog' in result) {
    const type = result.dialog.type();
    await result.dialog.dismiss();
    expect(type).toBe('beforeunload');
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    return true;
  }
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(
    timeOrigin
  );
  return false;
}

async function prepareLocalBox(page: Page, name: string) {
  await stubApi(page);
  await page.route('**/api/session', (route) => route.fulfill({ json: null }));
  await createProject(page, name);
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await expect(
    page.getByRole('status', { name: 'Local only', exact: true })
  ).toBeVisible({ timeout: SAVE_BUDGET_MS });
  await expect
    .poll(async () => (await storedProject(page))?.featureOrder.length)
    .toBe(1);
}

async function expectBoxAndSphere(page: Page) {
  await expectBodyCount(page, 2);
  await expect(
    page.getByRole('heading', { name: 'History 2', exact: true })
  ).toBeVisible();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toHaveCount(1);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Sphere' })
  ).toHaveCount(1);
}

/** Reads the committed document, independently of the workspace save chip. */
async function storedProject(page: Page): Promise<ProjectDocument | null> {
  return page.evaluate(
    () =>
      new Promise<ProjectDocument | null>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () =>
          reject(open.error ?? new Error('IndexedDB could not open.'));
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction('projects', 'readonly');
          const all = transaction.objectStore('projects').getAll();
          let document: ProjectDocument | null = null;
          all.onsuccess = () => {
            document = (all.result as ProjectDocument[])[0] ?? null;
          };
          transaction.oncomplete = () => {
            database.close();
            resolve(document);
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error ?? new Error('Project read aborted.'));
          };
        };
      })
  );
}

for (const connectivity of ['online', 'offline edit'] as const) {
  test(`preserves an accepted Sphere through an immediate reload (${connectivity})`, async ({
    page
  }) => {
    await prepareLocalBox(page, `Local departure ${connectivity}`);
    // Open the Sphere command before disconnecting: this isolates device
    // saving from fetching its lazy UI chunk and building its preview.
    await page.getByRole('button', { name: /^Sphere/ }).click();
    const create = page
      .getByRole('group', { name: 'Sphere command' })
      .getByRole('button', { name: /Done/ });
    await expect(create).toBeEnabled({ timeout: 30_000 });
    if (connectivity === 'offline edit') {
      await page.context().setOffline(true);
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    }
    try {
      await create.click();
      await expectBoxAndSphere(page);
      // No save-indicator wait or grace period before departing. Static
      // preview has no offline app-shell cache, so reconnect for the reload
      // itself; the accepted edit was made with real networking disabled.
      if (connectivity === 'offline edit') {
        await page.context().setOffline(false);
      }
      const warned = await attemptReload(page);
      test.info().annotations.push({
        type: 'local-save-departure',
        description: `${connectivity}: ${Number(warned)} native unload warning(s)`
      });
      if (warned) {
        // Work still in flight is protected by cancelling the departure, then
        // departing once the device confirms it has actually saved the edit.
        await expectBoxAndSphere(page);
        await expect(
          page.getByRole('status', { name: 'Local only', exact: true })
        ).toBeVisible({ timeout: SAVE_BUDGET_MS });
        expect(await attemptReload(page)).toBe(false);
      }
      await expectBoxAndSphere(page);
      expect((await storedProject(page))?.featureOrder).toHaveLength(2);
      await expect(
        page.getByRole('button', { name: 'Undo', exact: true })
      ).toBeEnabled();
    } finally {
      await page.context().setOffline(false);
    }
  });
}

/**
 * Keep an actual IndexedDB writer ahead of the app's save. Repeated requests
 * keep this transaction alive without changing data or replacing app APIs.
 * The extra page serves only this fixture, so it never claims project ownership.
 */
async function holdProjectStorage(page: Page, projectId: string) {
  await page.route('**/__local-save-storage-blocker', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Storage gate</title>'
    })
  );
  await page.goto('/__local-save-storage-blocker');
  await page.evaluate(
    (id) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () =>
          reject(open.error ?? new Error('IndexedDB could not open.'));
        open.onsuccess = () => {
          const database = open.result;
          const transaction = database.transaction('projects', 'readwrite');
          const store = transaction.objectStore('projects');
          let holding = true;
          let acquired = false;
          const completed = new Promise<void>((finish, fail) => {
            transaction.oncomplete = () => {
              database.close();
              finish();
            };
            transaction.onabort = () => {
              database.close();
              fail(transaction.error ?? new Error('Storage gate aborted.'));
            };
          });
          const fixtureWindow = window as typeof window & {
            releaseProjectStorage: () => Promise<void>;
          };
          fixtureWindow.releaseProjectStorage = () => {
            holding = false;
            return completed;
          };
          const pulse = () => {
            if (!holding) return;
            const request = store.get(id);
            request.onsuccess = () => {
              if (!acquired) {
                acquired = true;
                resolve();
              }
              pulse();
            };
            request.onerror = () =>
              reject(request.error ?? new Error('Storage gate read failed.'));
          };
          pulse();
        };
      }),
    projectId
  );
}

async function releaseProjectStorage(page: Page) {
  await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      releaseProjectStorage?: () => Promise<void>;
    };
    return fixtureWindow.releaseProjectStorage?.();
  });
}

for (const connectivity of ['online', 'offline edit'] as const) {
  test(`warns before reload while a device save is blocked and keeps work after cancellation (${connectivity})`, async ({
    page
  }) => {
    await prepareLocalBox(page, `Blocked local departure ${connectivity}`);
    const baseline = await storedProject(page);
    expect(baseline).not.toBeNull();
    const blocker = await page.context().newPage();
    try {
      await holdProjectStorage(blocker, baseline!.projectId);
      await page.bringToFront();
      // Open the command before disconnecting so the offline case exercises
      // saving and departure, independently of fetching the tool's UI chunk.
      await page.getByRole('button', { name: /^Sphere/ }).click();
      const done = page
        .getByRole('group', { name: 'Sphere command' })
        .getByRole('button', { name: /Done/ });
      await expect(done).toBeEnabled({ timeout: 30_000 });
      if (connectivity === 'offline edit') {
        await page.context().setOffline(true);
      }
      await done.click();
      await expectBoxAndSphere(page);
      await expect(page.getByRole('status', { name: /^Saving/ })).toBeVisible();

      // A real navigation exercises the browser's native unload decision; a
      // synthetic pagehide leaves JavaScript alive and cannot prove this guard.
      expect(await attemptReload(page)).toBe(true);
      await expectBoxAndSphere(page);

      await releaseProjectStorage(blocker);
      await expect(
        page.getByRole('status', { name: 'Local only', exact: true })
      ).toBeVisible({ timeout: SAVE_BUDGET_MS });
      const committed = await storedProject(page);
      expect(committed?.featureOrder).toHaveLength(2);
      expect(committed?.projectId).toBe(baseline!.projectId);
      if (connectivity === 'offline edit') {
        // The edit, native warning, cancellation and device commit all happen
        // offline. Reconnect only to fetch the app shell for the actual reload.
        expect(await page.evaluate(() => navigator.onLine)).toBe(false);
        await page.context().setOffline(false);
      }
      expect(await attemptReload(page)).toBe(false);
      await expectBoxAndSphere(page);
      expect((await storedProject(page))?.featureOrder).toEqual(
        committed!.featureOrder
      );
      // The accepted edit's replay history must survive alongside its geometry.
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expectBodyCount(page, 1);
      await expect(
        page.locator('.feature-row-main', { hasText: 'Sphere' })
      ).toHaveCount(0);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expectBoxAndSphere(page);
    } finally {
      await page.context().setOffline(false);
      await releaseProjectStorage(blocker);
      await blocker.close();
    }
  });
}

test('keeps the failed workspace open on internal departure and retries before reload', async ({
  page
}) => {
  const name = 'Failed local departure';
  await prepareLocalBox(page, name);
  // Fail the browser's real document write, without replacing the app's save
  // controller. Metadata/thumbnail writes remain available, as with a device
  // that cannot fit the next project snapshot.
  await page.evaluate(() => {
    const nativePut = IDBObjectStore.prototype.put;
    const fixtureWindow = window as typeof window & {
      failProjectWrites: boolean;
      projectWriteFailures: number;
    };
    fixtureWindow.failProjectWrites = true;
    fixtureWindow.projectWriteFailures = 0;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ) {
      if (this.name === 'projects' && fixtureWindow.failProjectWrites) {
        fixtureWindow.projectWriteFailures += 1;
        throw new DOMException(
          'Test device storage is full.',
          'QuotaExceededError'
        );
      }
      return key === undefined
        ? nativePut.call(this, value)
        : nativePut.call(this, value, key);
    };
  });
  const writeFailures = () =>
    page.evaluate(
      () =>
        (window as typeof window & { projectWriteFailures: number })
          .projectWriteFailures
    );
  await createPrimitiveInPlace(page, 'sphere');
  await expectBoxAndSphere(page);
  await expect(
    page.getByRole('status', { name: 'Not saved', exact: true })
  ).toBeVisible();
  const failuresBeforeLeaving = await writeFailures();

  // An internal departure must await the failed retry and leave the only
  // unsaved document in place rather than replacing it with the project shelf.
  await page
    .getByRole('button', { name: 'OpenZCAD Beta', exact: true })
    .click();
  await expect.poll(writeFailures).toBeGreaterThan(failuresBeforeLeaving);
  await expectBoxAndSphere(page);
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(name);
  await expect(
    page.getByRole('button', { name: 'New project', exact: true })
  ).toHaveCount(0);

  const cancelDeparture = async () => {
    expect(await attemptReload(page)).toBe(true);
    await expectBoxAndSphere(page);
  };
  await cancelDeparture();
  await expect(
    page.getByRole('status', { name: 'Not saved', exact: true })
  ).toBeVisible();

  await page.evaluate(() => {
    (
      window as typeof window & { failProjectWrites: boolean }
    ).failProjectWrites = false;
  });
  // beforeunload retries the re-parked write. Cancelling its native warning
  // gives the actual device transaction time to commit before departure.
  await cancelDeparture();
  await expect(
    page.getByRole('status', { name: 'Local only', exact: true })
  ).toBeVisible({ timeout: SAVE_BUDGET_MS });
  expect((await storedProject(page))?.featureOrder).toHaveLength(2);
  expect(await attemptReload(page)).toBe(false);
  await expectBoxAndSphere(page);
});
