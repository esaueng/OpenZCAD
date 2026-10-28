import { test, expect, stubApi, createProject } from './openzcad-fixtures';
import type { Page } from '@playwright/test';
import type { ProjectSummary } from '@openzcad/shared';
import { toUserId } from '@openzcad/shared';
import { createProjectDocument } from '@openzcad/document-core';

async function createListedProject(page: Page, name: string) {
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/projects') &&
      response.request().method() === 'POST'
  );
  await createProject(page, name);
  const { project } = (await (await response).json()) as {
    project: ProjectSummary;
  };
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { projects: [project] } })
      : route.fallback()
  );
  await page.getByTitle('Back to projects').click();
  return project;
}

test(
  'cached names and decoded thumbnails survive provisional encrypted listings',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    const project = await createListedProject(page, 'Recognizable bracket');
    await expect(
      page.locator('.start-tile-open', { hasText: 'Recognizable bracket' })
    ).toBeVisible();
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 16;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'blue';
      context.fillRect(0, 0, 16, 16);
      return canvas.toDataURL('image/webp');
    });
    await page.evaluate(
      async ({ project, source }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('openzcad-v2');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () =>
            reject(request.error ?? new Error('Cache open failed'));
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('projectThumbnails', 'readwrite');
            tx.objectStore('projectThumbnails').put({
              projectId: project.projectId,
              source,
              version: 0,
              updatedAt: project.updatedAt
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () =>
              reject(tx.error ?? new Error('Cache write failed'));
          });
        } finally {
          db.close();
        }
      },
      { project, source }
    );
    const listing = gate();
    let listingReturned = false;
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await listing.promise;
      listingReturned = true;
      await route.fulfill({
        json: {
          projects: [
            {
              ...project,
              name: 'Encrypted project',
              storageFormat: 2,
              updatedAt: '2030-10-28T12:00:00Z',
              documentVersion: 9
            }
          ]
        }
      });
    });
    const card = page.locator('.start-tile', {
      hasText: 'Recognizable bracket'
    });
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const image = card.locator('.start-tile-thumb img');
      await expect(image).toHaveAttribute('src', source);
      // Record every mutation, including a placeholder removed in the same frame
      // that a promise resolves; a final screenshot alone misses that flash.
      await card.evaluate((tile) => {
        const browser = window as typeof window & {
          __thumbnailRegressions?: string[];
        };
        browser.__thumbnailRegressions = [];
        new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const removed of mutation.removedNodes) {
              if (removed instanceof HTMLImageElement)
                browser.__thumbnailRegressions!.push('image removed');
            }
          }
          if (tile.textContent?.includes('Encrypted project'))
            browser.__thumbnailRegressions!.push('name reset');
          if (!tile.querySelector('.start-tile-thumb img'))
            browser.__thumbnailRegressions!.push('preview missing');
        }).observe(tile, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true
        });
      });
      listing.release();
      await expect.poll(() => listingReturned).toBe(true);
      await expect(card.locator('.start-tile-open')).toBeEnabled();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      );
      await expect(image).toHaveAttribute('src', source);
      expect(
        await page.evaluate(
          () =>
            (window as typeof window & { __thumbnailRegressions?: string[] })
              .__thumbnailRegressions
        )
      ).toEqual([]);
      await expect(
        page.locator('.start-tile', { hasText: 'Encrypted project' })
      ).toHaveCount(0);
    } finally {
      listing.release();
    }
  }
);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const width of [1440, 390]) {
  test(
    `library does not wait for optional startup services at ${width}px`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubApi(page);
      const optional = gate();
      for (const path of [
        'health',
        'auth/config',
        'settings',
        'collaboration/config'
      ]) {
        await page.route(`**/api/${path}`, async (route) => {
          await optional.promise;
          await route.fallback();
        });
      }
      try {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveTitle('OpenZCAD');
        await expect(
          page.getByRole('button', { name: 'Create project', exact: true })
        ).toBeEnabled();
        await expect(
          page.getByRole('status', { name: 'Loading library' })
        ).toHaveCount(0);
        await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      } finally {
        optional.release();
      }
    }
  );
}

test('cached cards appear while account discovery is held, with actions still fenced', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Cached bracket');
  await page.getByTitle('Back to projects').click();
  const card = page.locator('.start-tile-open', { hasText: 'Cached bracket' });
  await expect(card).toBeVisible();
  const listing = gate();
  await page.route('**/api/projects', async (route) => {
    await listing.promise;
    await route.fallback();
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(card).toBeVisible();
    await expect(card).toBeDisabled();
    await expect(
      page.getByRole('status', { name: 'Loading library' })
    ).toBeAttached();
    await expect(page.locator('.start-account')).toContainText(
      'Checking account'
    );
    await expect(
      page.getByRole('button', { name: 'Create project', exact: true })
    ).toBeDisabled();
  } finally {
    listing.release();
  }
  await expect(card).toBeEnabled();
});

test('settings edited during startup survive a late account-settings response', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  const session = gate();
  const settings = gate();
  await page.route('**/api/session', async (route) => {
    await session.promise;
    await route.fallback();
  });
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'GET') await settings.promise;
    await route.fallback();
  });
  try {
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Create project', exact: true })
    ).toBeDisabled();
    await page
      .getByRole('button', { name: 'Open settings', exact: true })
      .click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: 'Light', exact: true })
      .click();
    session.release();
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings') &&
        response.request().method() === 'GET'
    );
    settings.release();
    await response;
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally {
    session.release();
    settings.release();
  }
});

for (const cachedNames of [false, true])
  test(
    `150 encrypted cards ${cachedNames ? 'show known names before decryption' : 'do not wait for the encryption account read'}`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      await stubApi(page);
      const encryption = gate();
      const projects = Array.from({ length: 150 }, (_, index) => ({
        projectId: `proj_encrypted_${index}`,
        name: 'Encrypted project',
        storageFormat: 2,
        revisionCount: 1,
        updatedAt: '2026-10-28T12:00:00Z'
      }));
      if (cachedNames)
        await page.addInitScript((projects) => {
          localStorage.setItem(
            'openzcad:shelf-names:v1:user_e2e',
            JSON.stringify(
              projects.map((project, index) => [
                project.projectId,
                `Verified part ${index}`,
                project.updatedAt
              ])
            )
          );
        }, projects);
      await page.route('**/api/projects', (route) =>
        route.fulfill({
          json: {
            projects,
            encryptedProjectInfo: projects.map((project) => ({
              projectId: project.projectId,
              kind: 'project-info',
              envelope: '',
              signature: '',
              wrappedVersionKey: '',
              signerDeviceId: 'device_fixture',
              sequence: 1,
              keyEpoch: 0
            }))
          }
        })
      );
      await page.route('**/api/e2ee/account', async (route) => {
        await encryption.promise;
        await route.fulfill({ json: { current: null, previous: [] } });
      });
      try {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.start-tile-project')).toHaveCount(150);
        await expect(
          page.getByRole('button', { name: 'Create project', exact: true })
        ).toBeEnabled();
        await expect(
          page.getByRole('status', { name: 'Loading library' })
        ).toHaveCount(0);
        await expect(page.locator('.start-tile-project').first()).toContainText(
          cachedNames ? 'Verified part' : 'Encrypted project'
        );
        if (cachedNames)
          await expect(
            page.locator('.start-tile-name', { hasText: /^Encrypted project$/ })
          ).toHaveCount(0);
      } finally {
        encryption.release();
      }
    }
  );

test(
  'selection shows a loading page before the document arrives; cancel fences its late result',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await createListedProject(page, 'Selected bracket');
    const card = page.locator('.start-tile-open', {
      hasText: 'Selected bracket'
    });
    await expect(card).toBeVisible();
    const first = gate();
    const second = gate();
    let reads = 0;
    await page.route(/\/api\/projects\/[^/]+$/, async (route) => {
      await (reads++ === 0 ? first.promise : second.promise);
      await route.fallback();
    });
    try {
      await card.click();
      await expect(
        page.getByRole('status', { name: 'Opening project', exact: true })
      ).toBeVisible();
      await expect(
        page.getByText('Opening Selected bracket…', { exact: true })
      ).toBeVisible();
      await expect.poll(() => reads).toBe(1);
      await expect(page.locator('.start-screen')).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath('project-opening.png')
      });
      await page
        .getByRole('button', { name: 'Back to parts', exact: true })
        .click();
      await expect(card).toBeVisible();
      await card.click();
      await expect.poll(() => reads).toBe(2);
      const oldResponse = page.waitForResponse((response) =>
        /\/api\/projects\/[^/]+$/.test(response.url())
      );
      first.release();
      await oldResponse;
      // The canceled read and its finally block cannot replace or dismiss the
      // successor's loading page while its own document is still held.
      await expect(
        page.getByRole('status', { name: 'Opening project', exact: true })
      ).toBeVisible();
      await expect(page.locator('.breadcrumb')).toHaveCount(0);
    } finally {
      first.release();
      second.release();
    }
    await expect(page.locator('.breadcrumb')).toContainText('Selected bracket');
    expect(errors).toEqual([]);
  }
);

test('a slow file count does not block the model workspace', async ({
  page
}) => {
  await stubApi(page);
  await createListedProject(page, 'Files load later');
  const files = gate();
  await page.route('**/api/projects/*/artifacts', async (route) => {
    await files.promise;
    await route.fallback();
  });
  try {
    await page
      .locator('.start-tile-open', { hasText: 'Files load later' })
      .click();
    await expect(page.locator('.breadcrumb')).toContainText('Files load later');
    await expect(
      page.getByRole('status', { name: 'Opening project', exact: true })
    ).toHaveCount(0);
  } finally {
    files.release();
  }
});

test('a shared viewer stays read-only before and after delayed capability discovery', async ({
  page
}) => {
  await stubApi(page, { collaborationRole: 'viewer' });
  const document = createProjectDocument(
    'Shared viewer part',
    toUserId('user_other_owner')
  );
  const capabilities = gate();
  await page.route('**/api/collaboration/config', async (route) => {
    await capabilities.promise;
    await route.fallback();
  });
  await page.route('**/api/projects', (route) =>
    route.fulfill({
      json: {
        projects: [
          {
            projectId: document.projectId,
            name: document.name,
            revisionCount: 0,
            updatedAt: document.derived.updatedAt
          }
        ]
      }
    })
  );
  await page.route(`**/api/projects/${document.projectId}`, (route) =>
    route.fulfill({ json: document })
  );
  try {
    await page.goto('/');
    await page.locator('.start-tile-open', { hasText: document.name }).click();
    await expect(page.locator('.breadcrumb')).toContainText(document.name);
    const mode = page.getByRole('group', { name: 'Workspace mode' });
    await expect(
      mode.getByRole('button', { name: 'Build', exact: true })
    ).toBeDisabled();
    await expect(
      mode.getByRole('button', { name: 'View', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('b');
    await expect(page.getByRole('contentinfo')).toContainText(
      'Waiting for project access'
    );
    capabilities.release();
    await expect(
      page.getByRole('button', { name: 'Open project sharing' })
    ).toContainText('Read-only');
    await expect(
      mode.getByRole('button', { name: 'Build', exact: true })
    ).toBeDisabled();
    await expect(page.locator('.feature-row')).toHaveCount(0);
  } finally {
    capabilities.release();
  }
});

for (const store of ['projects', 'projectSync']) {
  test(`cancel returns to the library while the ${store} write is still pending`, async ({
    page
  }) => {
    await stubApi(page);
    const document = createProjectDocument(
      'Write-gated part',
      toUserId('user_e2e')
    );
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        json: {
          projects: [
            {
              projectId: document.projectId,
              name: document.name,
              revisionCount: 0,
              updatedAt: document.derived.updatedAt
            }
          ]
        }
      })
    );
    await page.route(`**/api/projects/${document.projectId}`, (route) =>
      route.fulfill({ json: document })
    );
    await page.goto('/');
    const card = page.locator('.start-tile-open', { hasText: document.name });
    await expect(card).toBeEnabled();
    await page.evaluate((store) => {
      const browser = window as typeof window & {
        __projectWriteHeld?: boolean;
        __releaseProjectWrite?: () => void;
      };
      const transact = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (names, mode, options) {
        const tx = transact.call(this, names, mode, options);
        const stores = typeof names === 'string' ? [names] : Array.from(names);
        if (
          mode === 'readwrite' &&
          stores.includes(store) &&
          !browser.__projectWriteHeld
        ) {
          tx.addEventListener('complete', (event) => {
            if (browser.__projectWriteHeld) return;
            event.stopImmediatePropagation();
            browser.__projectWriteHeld = true;
            browser.__releaseProjectWrite = () => {
              tx.oncomplete?.call(tx, new Event('complete'));
            };
          });
        }
        return tx;
      };
    }, store);
    try {
      await card.click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { __projectWriteHeld?: boolean })
                .__projectWriteHeld
          )
        )
        .toBe(true);
      await expect(
        page.getByRole('status', { name: 'Opening project', exact: true })
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'Back to parts', exact: true })
        .click();
      await expect(card.first()).toBeVisible();
    } finally {
      await page.evaluate(() =>
        (
          window as typeof window & { __releaseProjectWrite?: () => void }
        ).__releaseProjectWrite?.()
      );
    }
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(card.first()).toBeVisible();
    await expect(page.locator('.breadcrumb')).toHaveCount(0);
    await expect(
      page.getByRole('status', { name: 'Opening project', exact: true })
    ).toHaveCount(0);
  });
}

for (const changeMode of [false, true]) {
  test(`late startup auth cannot replace a newer settings read${changeMode ? ' across cloud off then on' : ''}`, async ({
    page
  }) => {
    await stubApi(page);
    await page.route('**/api/session', (route) =>
      route.fulfill({ json: null })
    );
    let requests = 0;
    await page.route('**/api/auth/config', (route) =>
      route.fulfill({
        json: {
          mode: 'development',
          emailCodeEnabled: requests++ > 0,
          turnstileSiteKey: '1x00000000000000000000AA'
        }
      })
    );
    await page.addInitScript(() => {
      const browser = window as typeof window & {
        __authHeld?: boolean;
        __releaseStaleAuth?: () => void;
      };
      const fetchResponse = window.fetch.bind(window);
      let captured = false;
      window.fetch = async (...args) => {
        const response = await fetchResponse(...args);
        const input = args[0];
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (!captured && url.endsWith('/api/auth/config')) {
          captured = true;
          const read = response.json.bind(response);
          response.json = async () => {
            const payload: unknown = await read();
            browser.__authHeld = true;
            // Hold decoding after transport completed, so aborting fetch does
            // not itself hide a stale callback after a cloud-mode change.
            await new Promise<void>((resolve) => {
              browser.__releaseStaleAuth = resolve;
            });
            return payload;
          };
        }
        return response;
      };
    });
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Create project', exact: true })
    ).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as typeof window & { __authHeld?: boolean }).__authHeld
        )
      )
      .toBe(true);
    await page
      .getByRole('button', { name: 'Open settings', exact: true })
      .click();
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    if (changeMode) {
      const cloud = page.getByRole('checkbox', {
        name: 'Cloud features',
        exact: true
      });
      await cloud.uncheck();
      await cloud.check();
    }
    await expect(
      page.getByRole('textbox', { name: 'Email address', exact: true })
    ).toBeVisible();
    await page.evaluate(async () => {
      (
        window as typeof window & { __releaseStaleAuth?: () => void }
      ).__releaseStaleAuth?.();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
    });
    await expect(
      page.getByRole('textbox', { name: 'Email address', exact: true })
    ).toBeVisible();
  });
}
