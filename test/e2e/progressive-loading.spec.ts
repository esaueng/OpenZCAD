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
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const width of [1440, 390]) {
  test(`library does not wait for optional startup services at ${width}px`, async ({
    page
  }) => {
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
  });
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

test('150 encrypted cards do not wait for the encryption account read', async ({
  page
}) => {
  await stubApi(page);
  const encryption = gate();
  const projects = Array.from({ length: 150 }, (_, index) => ({
    projectId: `proj_encrypted_${index}`,
    name: 'Encrypted project',
    storageFormat: 2,
    revisionCount: 1,
    updatedAt: '2026-10-28T12:00:00Z'
  }));
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
      'Encrypted project'
    );
  } finally {
    encryption.release();
  }
});

test('selection shows a loading page before the document arrives; cancel fences its late result', async ({
  page
}, testInfo) => {
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
    await page.screenshot({ path: testInfo.outputPath('project-opening.png') });
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
});

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
