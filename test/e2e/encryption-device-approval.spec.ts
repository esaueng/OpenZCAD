import type { Browser, Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  installE2eeServer,
  openEncryptionSettings,
  seedE2eeDevice,
  type E2eeServer
} from './e2ee-fixtures';

/** A second browser profile of the same account, with its own IndexedDB. */
async function secondDevice(browser: Browser, server: E2eeServer) {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  await stubApi(page);
  await installE2eeServer(context, server);
  await page.goto('/');
  return { context, page };
}

async function approverWith(page: Page, server: E2eeServer) {
  await stubApi(page);
  await installE2eeServer(page.context(), server);
  await page.goto('/');
  const seeded = await seedE2eeDevice(page, server, { label: 'Laptop' });
  const settings = await openEncryptionSettings(page);
  await expect(settings.getByText('Certified', { exact: true })).toBeVisible();
  return { seeded, settings };
}

test('certifies a new device approved by its full-hash scan code', async ({
  page,
  browser
}) => {
  const server = createE2eeServer();
  const { seeded, settings } = await approverWith(page, server);
  const phone = await secondDevice(browser, server);
  try {
    const phoneSettings = await openEncryptionSettings(phone.page);
    await phoneSettings.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(
      phoneSettings.getByRole('img', { name: 'Device approval QR code' })
    ).toBeVisible();
    const code = (await phoneSettings
      .getByLabel('Device approval code')
      .textContent())!;
    expect(code).toMatch(/^OZD1:[0-9A-Z]{52}$/);

    // The approver sees the request and checks the code it scans or types.
    await expect(settings.getByText('None waiting')).toHaveCount(0, {
      timeout: 10_000
    });
    await settings.getByRole('button', { name: 'Scan code' }).click();
    await settings.getByLabel('Code from the new device').fill(
      code.replace(/.$/, code.endsWith('0') ? '1' : '0')
    );
    await settings
      .getByLabel('Recovery key to certify the new device')
      .fill(seeded.recoveryKey);
    await settings.getByRole('button', { name: 'Approve device' }).click();
    await expect(settings.getByRole('alert')).toContainText(
      'does not match the device asking for approval'
    );
    await settings.getByLabel('Code from the new device').fill(code);
    await settings.getByRole('button', { name: 'Approve device' }).click();
    await expect(settings.getByText('2 certified')).toBeVisible();

    // The phone verifies the signed grant and unlocks, certified.
    await expect(
      phoneSettings.getByText('Certified', { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      phoneSettings.getByText('Unlocked', { exact: true })
    ).toBeVisible();
  } finally {
    await phone.context.close();
  }
});

test('approves read-only after both devices show the same six digits', async ({
  page,
  browser
}) => {
  const server = createE2eeServer();
  const { settings } = await approverWith(page, server);
  const phone = await secondDevice(browser, server);
  try {
    const phoneSettings = await openEncryptionSettings(phone.page);
    await phoneSettings.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(
      phoneSettings.getByRole('img', { name: 'Device approval QR code' })
    ).toBeVisible();

    await settings
      .getByRole('button', { name: 'Compare codes' })
      .click({ timeout: 10_000 });
    const phoneCode = phoneSettings.getByLabel('Approval code');
    const laptopCode = settings.getByLabel('Approval code');
    await expect(phoneCode).toHaveText(/^\d{3} \d{3}$/, { timeout: 15_000 });
    await expect(laptopCode).toHaveText(/^\d{3} \d{3}$/, { timeout: 15_000 });
    expect(await laptopCode.textContent()).toBe(await phoneCode.textContent());

    // Both sides confirm: the phone accepts a grant only from the approver
    // whose digits it showed.
    await phoneSettings.getByRole('button', { name: 'Codes match' }).click();
    await expect(
      phoneSettings.getByText('Confirmed. Waiting for the other device')
    ).toBeVisible();
    await settings.getByRole('button', { name: 'Codes match, approve' }).click();
    await expect(
      phoneSettings.getByText('Approved, read-only')
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      phoneSettings.getByText('Unlocked', { exact: true })
    ).toBeVisible();
    expect(
      server.db
        .prepare(
          `SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE purpose = 'account-key-approval'`
        )
        .get()
    ).toEqual({ n: 1 });
  } finally {
    await phone.context.close();
  }
});
