import {
  test,
  expect,
  shareLoadResponse,
  stubAnonymousApi,
  stubApi,
  promptField,
  createPrimitiveInPlace
} from './openzcad-fixtures';
import {
  createProjectDocument,
  sharedProjectSnapshotDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
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
    await page.route('**/api/share', async (route) => {
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
        await page.getByRole('button', { name: 'New project' }).click();
      } else if (action === 'demo') {
        await page
          .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
          .click();
      } else {
        const document = createProjectDocument(expected, toUserId('owner'));
        await page
          .getByRole('button', { name: 'Import project', exact: true })
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
        const response = shareLoadResponse(page);
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
        const response = shareLoadResponse(page);
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
  await page.route('**/api/share', (route) =>
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
  await page.route('**/api/share', async (route) => {
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
    .getByRole('button', { name: 'Import project', exact: true })
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
    const response = shareLoadResponse(page);
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

test('the owner opening their own share link is offered the project, not a copy', async ({
  page
}) => {
  await stubApi(page);
  let own: ProjectDocument | null = null;
  page.on('response', async (response) => {
    if (
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/projects' &&
      response.ok()
    ) {
      own = ((await response.json()) as { document: ProjectDocument })
        .document;
    }
  });
  // The account lists the owner's project with its live link, as the
  // Worker marks it (`withProjectSharing`).
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'GET' && own
      ? route.fulfill({
          json: {
            projects: [
              {
                projectId: own.projectId,
                name: own.name,
                revisionCount: 1,
                updatedAt: new Date().toISOString(),
                sharing: { role: 'owner', linkCount: 1 }
              }
            ]
          }
        })
      : route.fallback()
  );
  await page.route('**/api/share', (route) =>
    own
      ? route.fulfill({
          json: {
            // What the Worker serves: the owner's id taken out.
            document: sharedProjectSnapshotDocument(own),
            project: { projectId: own.projectId, name: own.name },
            mode: 'tweak'
          }
        })
      : route.fulfill({ status: 404, json: { error: 'Unavailable' } })
  );
  // Nothing the public session holds is saved over the project.
  const snapshotWrites: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      new URL(request.url()).pathname.startsWith('/api/projects') &&
      (request.postData() ?? '').includes('user_shared')
    )
      snapshotWrites.push(request.url());
  });
  // The project's view as this device remembers it.
  const rememberedProjection = () =>
    page.evaluate((projectId) => {
      const stored = JSON.parse(
        localStorage.getItem('openzcad-workspace-session:v1') ?? '{}'
      ) as { views?: Record<string, { projection?: string }> };
      return stored.views?.[projectId]?.projection ?? null;
    }, own!.projectId);
  const orthographic = page.getByRole('button', {
    name: /^Orthographic projection/
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Own shared bracket');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('.breadcrumb')).toContainText('Own shared bracket');
  await expect.poll(() => own !== null).toBe(true);
  // A body gives the project a camera, which this device remembers.
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '30', depth: '20', height: '10' }
  });
  await expect.poll(rememberedProjection).toBe('perspective');

  // Pasted into a fresh load, as a link is opened: the account listing
  // read on the way in is the one that marks the project as the owner's.
  const token = 'o'.repeat(43);
  await page.goto('about:blank');
  const opened = shareLoadResponse(page, token);
  await page.goto(`/#share=${token}`);
  await opened;
  await expect(
    page.getByRole('status', { name: 'Shared model · Tweak only' })
  ).toBeVisible();
  const openOwn = page.getByRole('button', {
    name: 'Open your project',
    exact: true
  });
  await expect(openOwn).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toHaveCount(0);
  // Build's commands point the owner to the project, not to a copy.
  const field = promptField(page);
  await field.fill('/Extrude');
  const extrude = page
    .getByRole('listbox', { name: 'Commands' })
    .getByRole('option')
    .filter({
      has: page.locator('.palette-label', { hasText: /^Extrude$/ })
    });
  await expect(extrude).toHaveAttribute('aria-disabled', 'true');
  await expect(extrude.locator('.palette-reason')).toHaveText(
    'This is your project’s share link — Open your project to open Build mode'
  );
  await page.keyboard.press('Escape');
  // The link's view is not remembered as the project's: the project reopens
  // as the owner left it, as the Shared-model tooltip promises.
  await orthographic.click();
  await expect(orthographic).toHaveAttribute('aria-pressed', 'true');
  // Past the effect that would have saved it.
  await page.waitForTimeout(500);
  expect(await rememberedProjection()).toBe('perspective');

  await openOwn.click();
  await expect(
    page.getByRole('status', { name: 'Shared model · Tweak only' })
  ).toHaveCount(0);
  await expect(page.locator('.breadcrumb')).toContainText('Own shared bracket');
  await expect(
    page.getByRole('button', { name: 'Build', exact: true })
  ).toBeEnabled();
  expect(new URL(page.url()).hash).toBe('');
  expect(snapshotWrites).toEqual([]);
  await expect(orthographic).toHaveAttribute('aria-pressed', 'false');
  expect(await rememberedProjection()).toBe('perspective');
});
