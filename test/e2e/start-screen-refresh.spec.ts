import { test, expect, stubApi, createProject } from './openzcad-fixtures';

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`library refresh waits for its parts and account at ${viewport.width}px`, async ({
    page
  }) => {
    await page.setViewportSize(viewport);
    if (viewport.width === 390)
      await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubApi(page);
    let projectGate = Promise.resolve();
    await page.route('**/api/projects', async (route) => {
      await projectGate;
      await route.fulfill({
        json: {
          projects: [
            {
              projectId: 'refresh-bracket',
              name: 'Refresh bracket',
              revisionCount: 4,
              updatedAt: '2026-09-29T12:00:00.000Z'
            }
          ]
        }
      });
    });
    await page.goto('/');
    await expect(
      page.locator('.start-tile-open', { hasText: 'Refresh bracket' })
    ).toBeVisible();

    // Capture every committed startup state, including flashes that have
    // disappeared by the time a settled-page assertion runs.
    await page.addInitScript(() => {
      const browserWindow = window as typeof window & {
        __libraryFlashes: string[];
      };
      browserWindow.__libraryFlashes = [];
      new MutationObserver(() => {
        const launcher = document.querySelector('.start-screen');
        if (!launcher) return;
        for (const text of ['No parts yet', 'Signed out']) {
          if (launcher.textContent?.includes(text))
            browserWindow.__libraryFlashes.push(text);
        }
        if (launcher.classList.contains('is-fresh'))
          browserWindow.__libraryFlashes.push('first-run layout');
      }).observe(document, {
        childList: true,
        subtree: true,
        characterData: true
      });
    });
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    let releaseProjects!: () => void;
    projectGate = new Promise<void>((resolve) => {
      releaseProjects = resolve;
    });
    await page.route('**/api/session', async (route) => {
      await sessionGate;
      await route.fulfill({
        json: {
          userId: 'user_e2e',
          displayName: 'E2E user',
          mode: 'development'
        }
      });
    });
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(
        page.getByRole('status', { name: 'Loading library' })
      ).toBeVisible();
      await expect(page.locator('.start-screen')).not.toHaveClass(/is-fresh/);
      await expect(page.locator('.start-account')).toContainText('Checking');
      await expect(
        page.getByRole('button', { name: 'Create project' })
      ).toBeDisabled();
      await expect(
        page.getByRole('button', { name: /^Open demo:/ }).first()
      ).toBeDisabled();
      // A name typed while discovery runs must survive the ready transition.
      await page.getByLabel('Project name').fill('Name kept during refresh');
      const listingRequest = page.waitForRequest('**/api/projects');
      releaseSession();
      await listingRequest;
      // Knowing the session alone still does not establish the library.
      await expect(
        page.getByRole('status', { name: 'Loading library' })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Create project' })
      ).toBeDisabled();
    } finally {
      releaseSession();
      releaseProjects();
    }
    await expect(
      page.locator('.start-tile-open', { hasText: 'Refresh bracket' })
    ).toBeVisible();
    await expect(page.locator('.start-account')).toContainText('1 / 1 saved');
    await expect(page.getByLabel('Project name')).toHaveValue(
      'Name kept during refresh'
    );
    await expect(
      page.getByRole('button', { name: 'Create project' })
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __libraryFlashes: string[] })
            .__libraryFlashes
      )
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
    await page.getByRole('tab', { name: /^Archive/ }).click();
    await expect(
      page.getByText('Nothing archived.', { exact: true })
    ).toBeVisible();
  });
}

test('failed account listing finishes refresh with the saved device library', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Device refresh part');
  await page.getByTitle('Back to projects').click();
  await expect(
    page.locator('.start-tile-open', { hasText: 'Device refresh part' })
  ).toBeVisible();
  await page.route('**/api/projects', (route) =>
    route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } })
  );
  await page.reload();
  await expect(
    page.locator('.start-tile-open', { hasText: 'Device refresh part' })
  ).toBeVisible();
  await expect(
    page.getByText('Cloud project status is temporarily unavailable.', {
      exact: false
    })
  ).toBeVisible();
  await expect(
    page.getByRole('status', { name: 'Loading library' })
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Create project' })
  ).toBeEnabled();
});
