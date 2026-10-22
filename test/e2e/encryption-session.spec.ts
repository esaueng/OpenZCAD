import type { Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  E2E_USER_ID,
  installE2eeServer,
  openEncryptionSettings,
  seedE2eeDevice
} from './e2ee-fixtures';

for (const keepDevice of [true, false]) {
  test(`sign-out locks the other tab when device keys are ${keepDevice ? 'kept' : 'removed'}`, async ({
    page,
    context
  }) => {
    let signedIn = true;
    const sessionRoute = async (tab: Page) => {
      await stubApi(tab);
      await tab.route('**/api/session', (route) =>
        route.fulfill({
          json: signedIn
            ? {
                userId: E2E_USER_ID,
                displayName: 'E2E user',
                mode: 'development'
              }
            : null
        })
      );
    };
    await sessionRoute(page);
    const server = createE2eeServer();
    await installE2eeServer(context, server);
    await context.route('**/api/e2ee/**', async (route) => {
      if (!signedIn)
        await route.fulfill({
          status: 401,
          json: { error: 'Signed out', code: 'UNAUTHENTICATED' }
        });
      else await route.fallback();
    });
    await page.route('**/api/auth/logout', async (route) => {
      signedIn = false;
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/');
    await seedE2eeDevice(page, server);
    const settings = await openEncryptionSettings(page);
    const other = await context.newPage();
    await sessionRoute(other);
    await other.goto('/');
    const otherSettings = await openEncryptionSettings(other);
    for (const panel of [settings, otherSettings])
      await expect(panel.getByText('Unlocked', { exact: true })).toBeVisible();
    await settings
      .getByRole('button', { name: 'Account', exact: true })
      .click();
    await settings
      .getByRole('button', { name: 'Sign out', exact: true })
      .click();
    await settings
      .getByRole('button', {
        name: keepDevice ? 'Keep unlocked' : 'Remove device keys',
        exact: true
      })
      .click();
    await expect(
      otherSettings.getByText('Unlocked', { exact: true })
    ).toHaveCount(0);
    await expect(
      otherSettings.getByText('Your fingerprint', { exact: true })
    ).toHaveCount(0);
  });
}
