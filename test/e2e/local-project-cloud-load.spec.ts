import { createProject, expect, stubApi, test } from './openzcad-fixtures';

test('reopening a signed-in local project does not request a missing account copy', async ({
  page
}) => {
  await stubApi(page);
  let signedIn = false;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: signedIn
        ? { userId: 'user_e2e', displayName: 'E2E user', mode: 'development' }
        : null
    })
  );
  await page.addInitScript(() => {
    localStorage.setItem('openzcad.glimpse.consent.v1', 'granted-v2');
  });
  let documentReads = 0;
  const diagnosticEvents: string[] = [];
  await page.route(/\/api\/projects\/[^/?]+$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    documentReads += 1;
    return route.fulfill({
      status: 404,
      json: { error: 'Project not found.' }
    });
  });
  await page.route('**/api/glimpse/usage', (route) => {
    const payload = route.request().postDataJSON() as { event: string };
    diagnosticEvents.push(payload.event);
    return route.fulfill({ status: 204 });
  });

  await createProject(page, 'Device-only part');
  await expect(
    page.getByRole('status', { name: 'Local only', exact: true })
  ).toBeVisible();
  signedIn = true;
  await page.reload();
  await expect(
    page.getByRole('button', {
      name: 'Rename project Device-only part',
      exact: true
    })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save to my account', exact: true })
  ).toBeVisible();
  await expect
    .poll(() => diagnosticEvents.includes('workspace_opened'))
    .toBe(true);
  expect(documentReads).toBe(0);

  await page
    .getByRole('button', { name: 'OpenZCAD Beta', exact: true })
    .click();
  await page
    .locator('.start-tile-open', { hasText: 'Device-only part' })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Rename project Device-only part',
      exact: true
    })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save to my account', exact: true })
  ).toBeVisible();
  expect(documentReads).toBe(0);
  expect(diagnosticEvents).not.toContain('error_cloud_load');
});
