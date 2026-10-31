import { test, expect, stubApi, stubAnonymousApi } from './openzcad-fixtures';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const width of [1440, 390]) {
  test(`new project immediately shows progress while account creation is pending at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubApi(page);
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    expect(new URL(page.url()).pathname).toBe('/');
    await page.getByLabel('Project name').fill('New blank project');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const session = deferred();
    const create = deferred();
    let configRequested = false;
    let createRequests = 0;
    let viewerRequested = false;
    page.on('request', (request) => {
      if (/\/assets\/ViewerShell-[^/]+\.js$/.test(request.url()))
        viewerRequested = true;
    });
    await page.route('**/api/session', async (route) => {
      await session.promise;
      await route.fallback();
    });
    await page.route('**/api/e2ee/config', async (route) => {
      configRequested = true;
      await route.fulfill({ json: { enabled: false } });
    });
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() === 'POST') {
        createRequests++;
        await create.promise;
      }
      await route.fallback();
    });
    try {
      await page
        .getByRole('button', { name: 'New project', exact: true })
        .click();
      // The account session is still held: feedback cannot depend on any
      // account round-trip, and independent configuration must start too.
      await expect(
        page.getByRole('status', { name: 'Creating project' })
      ).toContainText('New blank project');
      await expect(page.getByText('Creating your project')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'New project', exact: true })
      ).toHaveCount(0);
      await expect.poll(() => configRequested).toBe(true);
      await expect.poll(() => viewerRequested).toBe(true);
      session.resolve();
      await expect.poll(() => createRequests).toBe(1);
      await expect(
        page.getByRole('status', { name: 'Creating project' })
      ).toBeVisible();
      if (process.env.OZ_CREATE_SCREENSHOTS)
        await page.screenshot({
          path: `${process.env.OZ_CREATE_SCREENSHOTS}/new-project-${width}-loading.png`
        });
    } finally {
      session.resolve();
      create.resolve();
    }
    await expect(page.locator('.workspace-reveal')).toHaveClass(/is-ready/, {
      timeout: 30_000
    });
    await expect(page.locator('.breadcrumb')).toContainText(
      'New blank project'
    );
    await expect(
      page.getByRole('combobox', { name: 'Search commands' })
    ).toBeVisible();
    await expect(
      page.getByRole('status', { name: 'Creating project' })
    ).toHaveCount(0);
    expect(createRequests).toBe(1);
    expect(errors).toEqual([]);
    if (process.env.OZ_CREATE_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.OZ_CREATE_SCREENSHOTS}/new-project-${width}-ready.png`
      });
  });
}

test('refused creation returns to the library with the error and allows retry', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Retry project');
  await page.route('**/api/e2ee/config', (route) =>
    route.fulfill({ json: { enabled: false } })
  );
  let refuse = true;
  await page.route('**/api/projects', (route) =>
    refuse && route.request().method() === 'POST'
      ? route.fulfill({
          status: 400,
          json: { error: 'Creation refused for this test.' }
        })
      : route.fallback()
  );
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByText('Creation refused for this test.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New project', exact: true })
  ).toBeEnabled();
  refuse = false;
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('.workspace-reveal')).toHaveClass(/is-ready/, {
    timeout: 30_000
  });
});

test('canceling a pending creation keeps a late response from opening the workspace', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Canceled blank');
  const gate = deferred();
  let requested = false;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'POST') {
      requested = true;
      await gate.promise;
    }
    await route.fallback();
  });
  try {
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await expect.poll(() => requested).toBe(true);
    await page
      .getByRole('button', { name: 'Back to projects', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'New project', exact: true })
    ).toBeEnabled();
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/projects'
    );
    gate.resolve();
    await response;
    // A second create proves the stale navigation has released its busy owner.
    await page.getByLabel('Project name').fill('After cancellation');
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await expect(page.locator('.workspace-reveal')).toHaveClass(/is-ready/, {
      timeout: 30_000
    });
    await expect(page.locator('.breadcrumb')).toContainText(
      'After cancellation'
    );
  } finally {
    gate.resolve();
  }
});

test('a signed-out blank project opens locally without account creation', async ({
  page
}) => {
  await stubAnonymousApi(page);
  let createdInAccount = false;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/projects'
    )
      createdInAccount = true;
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Local blank');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('.workspace-reveal')).toHaveClass(/is-ready/, {
    timeout: 30_000
  });
  await expect(page.locator('.breadcrumb')).toContainText('Local blank');
  expect(createdInAccount).toBe(false);
});
