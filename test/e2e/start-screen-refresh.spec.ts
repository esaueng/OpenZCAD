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
        for (const text of ['No projects yet', 'On this device only']) {
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
    await expect(page.locator('.start-account')).toContainText(
      '1 project saved'
    );
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
  await expect(page.getByText('Account status unavailable')).toHaveAttribute(
    'title',
    /Cloud project status is temporarily unavailable\./
  );
  await expect(
    page.getByRole('status', { name: 'Loading library' })
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Create project' })
  ).toBeEnabled();
});

for (const layout of ['grid', 'list']) {
  for (const width of [1440, 390]) {
    test(`reload preserves pinned sections and ${layout} geometry at ${width}px`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) await page.emulateMedia({ reducedMotion: 'reduce' });
      await stubApi(page);
      await page.addInitScript(
        (layout) => localStorage.setItem('openzcad.start.layout', layout),
        layout
      );
      let release = () => {};
      let gate = Promise.resolve();
      await page.route('**/api/projects', async (route) => {
        await gate;
        await route.fulfill({
          json: {
            projects: [
              {
                projectId: 'pinned-part',
                name: 'Pinned part',
                revisionCount: 4,
                updatedAt: '2026-10-27T12:00:00Z',
                organization: { status: 'active', pinned: true, sortOrder: 0 }
              },
              {
                projectId: 'regular-part',
                name: 'Regular part',
                revisionCount: 2,
                updatedAt: '2026-10-27T12:00:00Z'
              },
              {
                projectId: 'recovery-part',
                name: 'Pinned part (Recovery)',
                revisionCount: 1,
                updatedAt: '2026-10-27T12:00:00Z'
              }
            ]
          }
        });
      });
      await page.goto('/');
      await expect(page.locator('.start-tile-project')).toHaveCount(3);
      const positions = () =>
        page.locator('.start-shelf-group').evaluateAll((headings) =>
          headings.map((heading) => ({
            x: heading.getBoundingClientRect().x,
            y: heading.getBoundingClientRect().y
          }))
        );
      const before = await positions();
      const firstTile = await page
        .locator('.start-tile-project')
        .first()
        .boundingBox();
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(
          page.getByRole('status', { name: 'Loading library' })
        ).toBeVisible();
        await expect(page.locator('.start-tile-placeholder')).toHaveCount(3);
        const during = await positions();
        expect(during).toHaveLength(before.length);
        during.forEach((position, index) => {
          expect(position.x).toBeCloseTo(before[index]!.x, 0);
          expect(position.y).toBeCloseTo(before[index]!.y, 0);
        });
        const placeholder = await page
          .locator('.start-tile-placeholder')
          .first()
          .boundingBox();
        expect(placeholder?.height).toBeCloseTo(firstTile!.height, 0);
        expect(placeholder?.width).toBeCloseTo(firstTile!.width, 0);
        if (process.env.OZ_RELOAD_SCREENSHOTS)
          await page.screenshot({
            path: `${process.env.OZ_RELOAD_SCREENSHOTS}/library-${layout}-${width}-loading.png`
          });
      } finally {
        release();
      }
      await expect(page.locator('.start-tile-project')).toHaveCount(3);
      expect(await positions()).toEqual(before);
    });
  }
}

for (const width of [1440, 390]) {
  test(`reload keeps a known-empty library free of placeholder cards at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page);
    let release = () => {};
    let gate = Promise.resolve();
    await page.route('**/api/projects', async (route) => {
      await gate;
      await route.fulfill({ json: { projects: [] } });
    });
    await page.goto('/');
    await expect(
      page.getByText('No projects yet', { exact: true })
    ).toBeVisible();
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(
        page.getByRole('status', { name: 'Loading library' })
      ).toBeVisible();
      await expect(page.locator('.start-tile-placeholder')).toHaveCount(0);
      await expect(
        page.getByText('No projects yet', { exact: true })
      ).toHaveCount(0);
    } finally {
      release();
    }
    await expect(
      page.getByText('No projects yet', { exact: true })
    ).toBeVisible();
    await expect(page.locator('.start-tile-placeholder')).toHaveCount(0);
  });
}
