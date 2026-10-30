import { test, expect, stubAnonymousApi } from './openzcad-fixtures';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';

async function holdRestoreResult(page: Page) {
  await page.addInitScript(() => {
    const browser = window as unknown as {
      __restoreReady: boolean;
      __releaseRestore?: () => void;
    };
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes('projectBackupWorker')) return;
        this.addEventListener('message', (event) => {
          event.stopImmediatePropagation();
          const data: unknown = event.data;
          browser.__restoreReady = true;
          browser.__releaseRestore = () => {
            const deliver = this.onmessage;
            browser.__releaseRestore = undefined;
            deliver?.call(this, new MessageEvent('message', { data }));
          };
        });
      }
    };
  });
}

async function releaseRestore(page: Page) {
  await page.evaluate(() => {
    (
      window as unknown as { __releaseRestore?: () => void }
    ).__releaseRestore?.();
  });
}

for (const action of ['create', 'demo', 'import'] as const) {
  test(`a delayed share cannot replace the ${action} workspace opened from the shelf`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    await stubAnonymousApi(page);
    if (action === 'import') await holdRestoreResult(page);
    const old = createProjectDocument('Superseded share', toUserId('owner'));
    let requested = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/share/*', async (route) => {
      requested = true;
      await gate;
      await route.fulfill({
        json: { document: old, project: { projectId: old.projectId, name: old.name }, mode: 'tweak' }
      });
    });
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Projects 0' })).toBeVisible();
    await page.evaluate(() => {
      window.location.hash = `share=${'s'.repeat(43)}`;
    });
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByRole('main', { name: 'Shared model' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
    const expected =
      action === 'demo'
        ? 'Demo · Mounting Bracket'
        : `${action === 'create' ? 'Created' : 'Imported'} after pending share`;
    try {
      if (action === 'create') {
        await page.getByLabel('Project name').fill(expected);
        await page.getByRole('button', { name: 'Create project' }).click();
      } else if (action === 'demo') {
        await page
          .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
          .click();
      } else {
        const document = createProjectDocument(expected, toUserId('owner'));
        await page
          .getByRole('button', { name: 'Import project…', exact: true })
          .click();
        await page.getByLabel('Import project backup').setInputFiles({
          name: 'shelf-project.openzcad',
          mimeType: 'application/json',
          buffer: Buffer.from(
            JSON.stringify({
              format: 'openzcad-project',
              version: 1,
              document,
              files: []
            })
          )
        });
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as unknown as { __restoreReady?: boolean })
                  .__restoreReady
            )
          )
          .toBe(true);
        const response = page.waitForResponse(/\/api\/share\//);
        release();
        await response;
        await page.waitForTimeout(250);
        await expect(page.getByRole('tab', { name: 'Projects 0' })).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Make a copy', exact: true })
        ).toHaveCount(0);
        await releaseRestore(page);
      }
      await expect(page.locator('.breadcrumb')).toContainText(expected);
      if (action !== 'import') {
        const response = page.waitForResponse(/\/api\/share\//);
        release();
        await response;
        await page.waitForTimeout(250);
      }
      await expect(page.locator('.breadcrumb')).toContainText(expected);
      await expect(
        page.getByRole('button', { name: 'Make a copy', exact: true })
      ).toHaveCount(0);
      expect(new URL(page.url()).hash).toBe('');
    } finally {
      release();
      if (action === 'import') await releaseRestore(page);
    }
  });
}

test('a refused backup import keeps the active share model and URL', async ({
  page
}) => {
  await stubAnonymousApi(page);
  const document = createProjectDocument(
    'Retained active share',
    toUserId('owner')
  );
  await page.route('**/api/share/*', (route) =>
    route.fulfill({
      json: { document, project: { projectId: document.projectId, name: document.name }, mode: 'tweak' }
    })
  );
  const token = 'a'.repeat(43);
  await page.goto(`/#share=${token}`);
  await expect(page.locator('.breadcrumb')).toContainText(document.name);
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'invalid.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from('not a backup')
  });
  await expect(page.getByRole('contentinfo')).toContainText(
    'Project import failed'
  );
  await expect(page.locator('.breadcrumb')).toContainText(document.name);
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toBeEnabled();
  expect(new URL(page.url()).hash).toBe(`#share=${token}`);
});

test('a newer share wins over a held restore that saves locally without opening', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await holdRestoreResult(page);
  const imported = createProjectDocument(
    'Superseded restore',
    toUserId('owner')
  );
  const latest = createProjectDocument(
    'Queued latest share',
    toUserId('owner')
  );
  let requested = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/share/*', async (route) => {
    requested = true;
    await gate;
    await route.fulfill({
      json: {
        document: latest,
        project: { projectId: latest.projectId, name: latest.name },
        mode: 'tweak'
      }
    });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Import project…', exact: true })
    .click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'superseded.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: imported,
        files: []
      })
    )
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __restoreReady?: boolean }).__restoreReady
      )
    )
    .toBe(true);
  const token = 'n'.repeat(43);
  await page.evaluate((token) => {
    window.location.hash = `share=${token}`;
  }, token);
  try {
    await expect.poll(() => requested).toBe(true);
    const response = page.waitForResponse(/\/api\/share\//);
    release();
    await response;
    await expect(page.locator('.breadcrumb')).toContainText(latest.name);
    // The pill mounts with the new workspace. A quiet completion before its
    // display threshold is intentionally invisible, so keep the worker held
    // until this restore is visibly running before asserting its ending.
    const restoring = page.getByRole('region', { name: 'File restore' });
    await expect(restoring).toBeVisible();
    await expect(restoring).toContainText('Reading the file');
    await releaseRestore(page);
    await expect(
      page.getByText('saved on this device', { exact: true })
    ).toBeVisible();
    await expect(page.locator('.breadcrumb')).toContainText(latest.name);
    expect(new URL(page.url()).hash).toBe(`#share=${token}`);
    const deviceProjects = await page.evaluate(
      () =>
        new Promise<{ name: string }[]>((resolve, reject) => {
          const open = indexedDB.open('openzcad-v2');
          open.onerror = () =>
            reject(
              new Error('Project database could not open.', {
                cause: open.error
              })
            );
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('projects', 'readonly');
            const projects = tx.objectStore('projects').getAll();
            tx.oncomplete = () => {
              db.close();
              resolve(projects.result as { name: string }[]);
            };
            tx.onerror = () => {
              db.close();
              reject(new Error('Project read failed.', { cause: tx.error }));
            };
          };
        })
    );
    expect(deviceProjects).toEqual([
      expect.objectContaining({ name: imported.name })
    ]);
    await page.getByTitle('Back to projects').click();
    await expect(page.getByRole('tab', { name: 'Projects 1' })).toBeVisible();
    await expect(
      page.locator('.start-tile-open', { hasText: imported.name })
    ).toHaveCount(1);
  } finally {
    release();
    await releaseRestore(page);
  }
});
