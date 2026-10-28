import { expect, expectBodyCount, test } from './openzcad-fixtures';
import {
  COMMIT_BUDGET_MS,
  PROJECT_NAME,
  SYNC_BUDGET_MS
} from './encrypted-members-fixtures';
import {
  installAnonymousShareRoutes,
  openAsVisitor,
  ownerWithShareLink
} from './encrypted-share-links-fixtures';

const DAY = 86_400_000;

test('a signed-in visitor can retry an unavailable account encryption check', async ({
  browser
}) => {
  test.setTimeout(240_000);
  const owner = await ownerWithShareLink(browser);
  const page = owner.alice;
  await installAnonymousShareRoutes(owner.context, owner.server);
  await page.goto(owner.link);
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  let checks = 0;
  await page.route('**/api/e2ee/project-preferences', async (route) => {
    checks++;
    if (checks === 1)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unavailable' })
      });
    else await route.fallback();
  });
  await page.getByRole('button', { name: 'Make a copy', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Make a copy', exact: true });
  await expect(
    dialog.getByRole('button', { name: 'Retry account check' })
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Copy to your account' })
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Keep on this device only' })
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Retry account check' }).click();
  await expect(dialog).toContainText('end-to-end encrypted under your keys');
  await expect(
    dialog.getByRole('button', { name: 'Copy to your account' })
  ).toBeEnabled();
  await dialog
    .getByRole('button', { name: 'Keep on this device only' })
    .click();
  await expect(dialog).toHaveCount(0);
  await expectBodyCount(page, 1);
  expect(owner.errors).toEqual([]);
  await owner.context.close();
});

/**
 * ADR-024 Phase 5, slice 5-11: the visitor page of an end-to-end encrypted
 * share link. The owner (slice 5-10's flow) imports a STEP file into an
 * encrypted project, confirms sharing and creates a link; a visitor in a
 * fresh, signed-out context opens it: the snapshot is verified in the
 * ADR's order and decrypted in the decode worker, the STEP file arrives
 * through the anonymous blob route and is decrypted against the
 * snapshot's reference, and the model rebuilds, pinned to View because the
 * link is view only. The visitor makes a device copy. A visitor whose
 * clock is past the statement's seven days sees that the owner has not
 * recently confirmed the link; after the owner revokes it, a visitor sees
 * the refusal.
 */
test('a visitor opens an encrypted share link, copies it, and is refused once it lapses or is revoked', { tag: '@ci-smoke' }, async ({
  browser
}) => {
  test.setTimeout(300_000);
  const owner = await ownerWithShareLink(browser, { content: 'step' });

  const visitor = await openAsVisitor(browser, owner.server, owner.link);
  const page = visitor.page;
  await expect(page.locator('.breadcrumb')).toContainText(PROJECT_NAME, {
    timeout: SYNC_BUDGET_MS
  });
  await expectBodyCount(page, 1);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: `Opened shared model ${PROJECT_NAME} · view only` })
  ).toBeVisible();
  // A view-only link pins the visitor to View.
  const modes = page.getByRole('group', { name: 'Workspace mode' });
  await expect(modes.getByRole('button', { name: 'Tweak' })).toBeDisabled();
  await expect(modes.getByRole('button', { name: 'Build' })).toBeDisabled();
  // The visitor reached only the anonymous encrypted routes: the snapshot
  // and the one content blob it names. Never a plaintext share route.
  const e2ee = visitor.requests.filter((path) => path.startsWith('/api/e2ee/'));
  expect(e2ee.length).toBeGreaterThanOrEqual(2);
  expect(e2ee.every((path) => path.startsWith('/api/e2ee/share/'))).toBe(true);
  expect(e2ee.filter((path) => path.includes('/blobs/'))).toHaveLength(1);
  expect(visitor.requests.some((path) => path.startsWith('/api/share/'))).toBe(
    false
  );

  // Make a copy: a signed-out visitor's copy is a project on this device.
  await page.getByRole('button', { name: 'Make a copy', exact: true }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /is yours now — saved on this device/ })
  ).toBeVisible();
  await expect(modes.getByRole('button', { name: 'Build' })).toBeEnabled();
  expect(new URL(page.url()).hash).toBe('');
  await expectBodyCount(page, 1);

  // A clock past the statement's seven days: not recently confirmed.
  const late = await openAsVisitor(browser, owner.server, owner.link, {
    clockOffsetMs: 8 * DAY
  });
  await expect(
    late.page
      .getByRole('status')
      .filter({ hasText: "The owner hasn't recently confirmed this link" })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(
    late.page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toHaveCount(0);

  // The owner revokes the link; the visitor's next visit is refused.
  await page.goto(owner.link);
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await owner.links
    .getByRole('button', { name: 'Revoke View only link' })
    .click();
  await expect(owner.links.getByText('No links yet.')).toBeVisible({
    timeout: COMMIT_BUDGET_MS
  });
  await page.reload();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'This share link is no longer available' })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toHaveCount(0);

  expect(owner.errors).toEqual([]);
  expect(visitor.errors).toEqual([]);
  expect(late.errors).toEqual([]);
  await late.context.close();
  await visitor.context.close();
  await owner.context.close();
});
