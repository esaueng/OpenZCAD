import type { Browser, Page } from '@playwright/test';
import type {
  LibraryFolderSnapshot,
  SaveLibraryFolderRequest
} from '../../apps/web/src/lib/libraryFolderCloudSync';
import type { FolderSet } from '../../apps/web/src/lib/libraryFolderSync';
import { expect, stubApi, test } from './openzcad-fixtures';

const PROJECT_ID = 'project_folder_sync_e2e';
const PROJECT_NAME = 'Folder sync part';
const FOLDER_NAME = 'Sync fixtures';
const RENAMED_FOLDER = 'Renamed fixtures';
const SYNC_BUDGET_MS = process.env.CI ? 30_000 : 10_000;

/** One account's CAS store, shared only by the two mocked HTTP services. */
class SharedFolderApi {
  snapshot: LibraryFolderSnapshot = {
    revision: 0,
    format: null,
    record: null,
    updatedAt: null
  };
  reads = 0;
  writes = 0;
  conflicts = 0;
  private barrier: {
    remaining: number;
    ready: Promise<void>;
    release(): void;
  } | null = null;

  constructor(readonly disabled = false) {}

  /** Both devices must read the same revision before either PUT commits. */
  raceNextWrites(): () => void {
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.barrier = { remaining: 2, ready, release };
    return release;
  }

  set(): FolderSet | null {
    return this.snapshot.record
      ? (JSON.parse(this.snapshot.record) as FolderSet)
      : null;
  }

  folder() {
    const set = this.set();
    return set ? Object.values(set.folders)[0] : undefined;
  }

  async install(page: Page) {
    await stubApi(page);
    // Both contexts use stubApi's same user_e2e session, with no encryption.
    await page.route('**/api/e2ee/config', (route) =>
      route.fulfill({
        json: { enabled: false, projectsEnabled: false, defaultOn: false }
      })
    );
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        json: {
          projects: [
            {
              projectId: PROJECT_ID,
              name: PROJECT_NAME,
              revisionCount: 1,
              updatedAt: '2026-10-30T12:00:00.000Z',
              organization: { status: 'active', pinned: false, sortOrder: 0 }
            }
          ]
        }
      })
    );
    await page.route('**/api/library-folders', async (route) => {
      const method = route.request().method();
      if (method === 'GET') this.reads++;
      if (method === 'PUT') this.writes++;
      if (this.disabled) {
        return route.fulfill({
          status: 501,
          json: {
            code: 'LIBRARY_FOLDERS_DISABLED',
            error: 'Library folder sync is disabled.'
          }
        });
      }
      if (method === 'GET') {
        return route.fulfill({ json: this.snapshot });
      }
      expect(method).toBe('PUT');
      const input = route.request().postDataJSON() as SaveLibraryFolderRequest;
      expect(input.format).toBe(1);
      const record = JSON.parse(input.record) as { version?: number };
      expect(record.version).toBe(2);
      const barrier = this.barrier;
      if (barrier) {
        if (--barrier.remaining === 0) {
          this.barrier = null;
          barrier.release();
        }
        await barrier.ready;
      }
      // Like libraryFolderSets.ts, compare and update without an await in
      // between. A stale writer receives the latest copy, then merges/retries.
      if (input.expectedRevision !== this.snapshot.revision) {
        this.conflicts++;
        return route.fulfill({
          status: 409,
          json: {
            code: 'LIBRARY_FOLDERS_REVISION_CONFLICT',
            error: 'Another device changed these folders.',
            current: this.snapshot
          }
        });
      }
      this.snapshot = {
        revision: this.snapshot.revision + 1,
        format: input.format,
        record: input.record,
        updatedAt: new Date().toISOString()
      };
      return route.fulfill({ json: this.snapshot });
    });
  }
}

async function openDevice(
  browser: Browser,
  baseURL: string | undefined,
  api: SharedFolderApi
) {
  const context = await browser.newContext({
    baseURL,
    colorScheme: 'dark',
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Chromium logs HTTP failures even when the application handles them.
    // Only this spec's deliberate conflict/disabled responses are expected.
    if (
      message.location().url.endsWith('/api/library-folders') &&
      /status of (409|501)\b/.test(message.text())
    )
      return;
    errors.push(message.text());
  });
  try {
    await api.install(page);
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(
      page.getByRole('checkbox', { name: `Select ${PROJECT_NAME}` })
    ).toBeVisible();
    return { context, page, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function createFolderWithProject(page: Page) {
  await page.getByRole('checkbox', { name: `Select ${PROJECT_NAME}` }).check();
  await page.getByRole('button', { name: 'Move to', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New folder', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Folder name' });
  await field.fill(FOLDER_NAME);
  await field.press('Enter');
  await expect(folderButton(page, FOLDER_NAME)).toBeVisible();
}

function folderButton(page: Page, name: string) {
  return page.getByRole('button', {
    name: `Open folder ${name}, 1 project`,
    exact: true
  });
}

async function expectFolderWithProject(
  page: Page,
  name: string,
  pinned: boolean
) {
  await expect(folderButton(page, name)).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: `${pinned ? 'Unpin' : 'Pin'} folder ${name}`,
      exact: true
    })
  ).toHaveAttribute('aria-pressed', String(pinned));
  await folderButton(page, name).click();
  await expect(
    page.getByRole('checkbox', { name: `Select ${PROJECT_NAME}` })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
}

test(
  'syncs a populated folder and merges a concurrent rename and pin across two contexts',
  { tag: '@ci-smoke' },
  async ({ browser, baseURL }, testInfo) => {
    const api = new SharedFolderApi();
    const a = await openDevice(browser, baseURL, api);
    let b: Awaited<ReturnType<typeof openDevice>> | undefined;
    let releaseWrites = () => {};
    try {
      b = await openDevice(browser, baseURL, api);
      await expect.poll(() => api.reads).toBeGreaterThanOrEqual(2);
      await createFolderWithProject(a.page);
      await expect
        .poll(() => api.folder()?.name, { timeout: SYNC_BUDGET_MS })
        .toBe(FOLDER_NAME);

      // B's separate context has no localStorage/IndexedDB from A. Its reload
      // must fetch both the folder and its membership through the account API.
      await b.page.reload();
      await expectFolderWithProject(b.page, FOLDER_NAME, false);

      releaseWrites = api.raceNextWrites();
      await b.page
        .getByRole('button', { name: `Actions for folder ${FOLDER_NAME}` })
        .click();
      await b.page
        .getByRole('menuitem', { name: 'Rename', exact: true })
        .click();
      const field = b.page.getByRole('textbox', { name: 'Folder name' });
      await field.fill(RENAMED_FOLDER);
      await field.press('Enter');
      await a.page
        .getByRole('button', { name: `Pin folder ${FOLDER_NAME}`, exact: true })
        .click();

      await expect
        .poll(() => api.conflicts, { timeout: SYNC_BUDGET_MS })
        .toBeGreaterThanOrEqual(1);
      await expect
        .poll(
          () => ({ name: api.folder()?.name, pinned: api.folder()?.pinned }),
          {
            timeout: SYNC_BUDGET_MS
          }
        )
        .toEqual({ name: RENAMED_FOLDER, pinned: true });
      const set = api.set()!;
      expect(set.members[PROJECT_ID]?.folderId).toBe(
        Object.keys(set.folders)[0]
      );

      await Promise.all([a.page.reload(), b.page.reload()]);
      for (const device of [a, b]) {
        await expectFolderWithProject(device.page, RENAMED_FOLDER, true);
        expect(device.errors).toEqual([]);
      }
      await a.page.screenshot({
        path: testInfo.outputPath('folder-device-a.png')
      });
      await b.page.screenshot({
        path: testInfo.outputPath('folder-device-b.png')
      });
    } finally {
      releaseWrites();
      await Promise.all([a.context.close(), b?.context.close()]);
    }
  }
);

test(
  'keeps folders local without application errors when library folder sync is disabled',
  { tag: '@ci-smoke' },
  async ({ browser, baseURL }) => {
    const api = new SharedFolderApi(true);
    const a = await openDevice(browser, baseURL, api);
    let b: Awaited<ReturnType<typeof openDevice>> | undefined;
    try {
      b = await openDevice(browser, baseURL, api);
      await expect.poll(() => api.reads).toBeGreaterThanOrEqual(2);
      await createFolderWithProject(a.page);
      await a.page
        .getByRole('button', { name: `Pin folder ${FOLDER_NAME}`, exact: true })
        .click();
      await a.page.reload();
      await expectFolderWithProject(a.page, FOLDER_NAME, true);
      await b.page.reload();
      await expect(
        b.page.getByRole('checkbox', { name: `Select ${PROJECT_NAME}` })
      ).toBeVisible();
      await expect(b.page.locator('.start-tile-folder')).toHaveCount(0);
      expect(api.snapshot.revision).toBe(0);
      expect(api.writes).toBe(0);
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
    } finally {
      await Promise.all([a.context.close(), b?.context.close()]);
    }
  }
);
