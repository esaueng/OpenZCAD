import { test, expect, stubApi, createProject } from './openzcad-fixtures';
import type { Route } from '@playwright/test';

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
        page.getByRole('button', { name: 'New project' })
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
        page.getByRole('button', { name: 'New project' })
      ).toBeDisabled();
    } finally {
      releaseSession();
      releaseProjects();
    }
    await expect(
      page.locator('.start-tile-open', { hasText: 'Refresh bracket' })
    ).toBeVisible();
    await expect(page.locator('.start-account')).toContainText('1 saved');
    await expect(page.getByLabel('Project name')).toHaveValue(
      'Name kept during refresh'
    );
    await expect(
      page.getByRole('button', { name: 'New project' })
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
  await expect(page.getByText('Account unavailable')).toHaveAttribute(
    'title',
    /Cloud project status is temporarily unavailable\./
  );
  await expect(
    page.getByRole('status', { name: 'Loading library' })
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New project' })).toBeEnabled();
});

test('a failed account listing clears once the library poll reaches the account', async ({
  page
}) => {
  // The poll waits ten seconds after the shelf opens before it may run.
  test.setTimeout(60_000);
  await stubApi(page);
  await createProject(page, 'Recovering part');
  await page.getByTitle('Back to projects').click();
  await expect(
    page.locator('.start-tile-open', { hasText: 'Recovering part' })
  ).toBeVisible();
  const failing = (route: Route) =>
    route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
  await page.route('**/api/projects', failing);
  await page.reload();
  await expect(page.getByText('Account unavailable')).toBeVisible();

  // The account answers again with the same projects the device already
  // showed: the shelf is unchanged, but the account is reachable.
  await page.unroute('**/api/projects', failing);
  const listed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/projects' &&
      response.request().method() === 'GET' &&
      response.ok()
  );
  await page.waitForTimeout(10_500);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await listed;
  await expect(page.getByText('Account unavailable')).toHaveCount(0);
  await expect(page.locator('.start-account')).toContainText(
    '1 on this device only'
  );
});

// The reported bug: a signed-in account whose session read was refused
// (here a rate limit) reloaded into the signed-out, device-only shelf with
// "Sign in", as if it had been logged out.
test(
  'a rate-limited session read on reload never reads as signed out',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await createProject(page, 'Still signed in part');
    await page.getByTitle('Back to projects').click();
    await expect(
      page.locator('.start-tile-open', { hasText: 'Still signed in part' })
    ).toBeVisible();
    let refuseSession = true;
    let sessionReads = 0;
    await page.route('**/api/session', (route) => {
      sessionReads += 1;
      return refuseSession
        ? route.fulfill({
            status: 429,
            json: { error: 'API request limit reached. Try again later.' }
          })
        : route.fallback();
    });
    await page.reload();
    const account = page.locator('.start-account');
    await expect(account).toContainText('Cloud unavailable');
    await expect(account).not.toContainText('On this device only');
    await expect(account.getByRole('button', { name: 'Sign in' })).toHaveCount(
      0
    );
    // The startup read retried before giving up.
    expect(sessionReads).toBeGreaterThan(1);

    // Retry asks again and finds the account still signed in.
    refuseSession = false;
    await page
      .getByRole('button', { name: 'Retry the cloud connection' })
      .click();
    await expect(account).not.toContainText('Cloud unavailable');
    await expect(account).not.toContainText('On this device only');
  }
);

test('Retry on Account unavailable lists the account again', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Retried part');
  await page.getByTitle('Back to projects').click();
  await expect(
    page.locator('.start-tile-open', { hasText: 'Retried part' })
  ).toBeVisible();
  const failing = (route: Route) =>
    route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
  await page.route('**/api/projects', failing);
  await page.reload();
  await expect(page.getByText('Account unavailable')).toBeVisible();
  const retry = page.getByRole('button', {
    name: 'Retry reaching the account'
  });

  // Still unreachable: the card stays, and says so.
  await retry.click();
  await expect(
    page
      .getByText('Your account still could not be reached.', { exact: false })
      .first()
  ).toBeVisible();
  await expect(page.getByText('Account unavailable')).toBeVisible();

  await page.unroute('**/api/projects', failing);
  await retry.click();
  await expect(page.getByText('Account unavailable')).toHaveCount(0);
  await expect(page.locator('.start-account')).toContainText(
    '1 on this device only'
  );
});

test('Retry warns in a toast only while the account stays unreachable', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Toasted part');
  await page.getByTitle('Back to projects').click();
  await expect(
    page.locator('.start-tile-open', { hasText: 'Toasted part' })
  ).toBeVisible();
  let listings = 0;
  const failing = (route: Route) => {
    listings += 1;
    return route.fulfill({
      status: 503,
      json: { error: 'Temporarily unavailable' }
    });
  };
  await page.route('**/api/projects', failing);
  await page.reload();
  await expect(page.getByText('Account unavailable')).toBeVisible();
  const retry = page.getByRole('button', {
    name: 'Retry reaching the account'
  });
  const toast = page.locator('.toast');

  // Nothing is announced before Retry asks.
  await expect(toast).toHaveCount(0);
  const asked = listings;
  await retry.click();
  await expect(toast).toHaveClass(/\bwarning\b/);
  await expect(toast.locator('.toast-message')).toHaveText(
    'Your account still could not be reached. Your projects remain saved on this device.'
  );
  // Retry listed again rather than repeating what it already knew.
  expect(listings).toBeGreaterThan(asked);
  // Screen readers hear it through the toast's live region.
  await expect(
    page.getByRole('status').filter({
      hasText: 'Your account still could not be reached.'
    })
  ).toHaveCount(1);
});

test('Retry that reaches the account shows no toast', async ({ page }) => {
  await stubApi(page);
  await createProject(page, 'Quiet part');
  await page.getByTitle('Back to projects').click();
  await expect(
    page.locator('.start-tile-open', { hasText: 'Quiet part' })
  ).toBeVisible();
  const failing = (route: Route) =>
    route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
  await page.route('**/api/projects', failing);
  await page.reload();
  await expect(page.getByText('Account unavailable')).toBeVisible();

  await page.unroute('**/api/projects', failing);
  await page
    .getByRole('button', { name: 'Retry reaching the account' })
    .click();
  await expect(page.getByText('Account unavailable')).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(0);
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
        page.locator('.start-body > .start-tile-grid').evaluateAll((grids) =>
          grids.map((grid) => ({
            x: grid.getBoundingClientRect().x,
            y: grid.getBoundingClientRect().y
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

// The account's read budget is shared by every browser it is open in, and a
// listing of an encrypted library spends about two reads per project. A
// shelf covered by Settings re-listed every minute regardless, so
// Settings › Encryption › Refresh met the account's rate limit.
test('the library poll waits while Settings covers the shelf and lists once on close', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await createProject(page, 'Covered part');
  await page.getByTitle('Back to projects').click();
  await expect(
    page.locator('.start-tile-open', { hasText: 'Covered part' })
  ).toBeVisible();
  const isListing = (request: { url(): string; method(): string }) =>
    new URL(request.url()).pathname === '/api/projects' &&
    request.method() === 'GET';
  // Opening Settings reconnects the account, which lists once itself.
  const opened = page.waitForResponse((response) =>
    isListing(response.request())
  );
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await opened;
  let listings = 0;
  page.on('request', (request) => {
    if (isListing(request)) listings += 1;
  });
  await page.waitForTimeout(10_500);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  expect(listings).toBe(0);

  const listed = page.waitForRequest(isListing);
  await page
    .getByRole('button', { name: 'Close settings and go back to projects' })
    .click();
  await listed;
  await page.waitForTimeout(500);
  expect(listings).toBe(1);
});

test('a rate-limited library poll keeps the shelf and waits before asking again', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await createProject(page, 'Patient part');
  await page.getByTitle('Back to projects').click();
  await expect(
    page.locator('.start-tile-open', { hasText: 'Patient part' })
  ).toBeVisible();
  let listings = 0;
  const limited = (route: Route) => {
    listings += 1;
    return route.fulfill({
      status: 429,
      json: { error: 'API request limit reached. Try again later.' }
    });
  };
  await page.route('**/api/projects', limited);
  await page.waitForTimeout(10_500);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => listings).toBe(1);

  // Past the usual gap, focus would list again; after a 429 it waits.
  await page.waitForTimeout(10_500);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  expect(listings).toBe(1);
  await expect(
    page.locator('.start-tile-open', { hasText: 'Patient part' })
  ).toBeVisible();
  const account = page.locator('.start-account');
  await expect(account).not.toContainText('On this device only');
  await expect(account.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
});
