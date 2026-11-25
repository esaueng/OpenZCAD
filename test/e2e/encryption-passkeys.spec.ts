import type { Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  E2E_USER_ID,
  finishSetupDialog,
  installE2eeServer,
  lastRecoveryGroup,
  openEncryptionSettings,
  seedE2eeDevice
} from './e2ee-fixtures';

test('enrolls, unlocks and revokes with a real WebAuthn PRF virtual authenticator', { tag: '@ci-smoke' }, async ({
  page,
  context,
  baseURL
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true
    }
  });
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  const appUrl = new URL(baseURL!);
  appUrl.hostname = 'localhost';
  await page.goto(appUrl.href);
  const seeded = await seedE2eeDevice(page, server);
  let settings = await openEncryptionSettings(page);
  await settings.getByText('Advanced encryption settings').click();
  const fingerprint = await settings
    .getByLabel('Your fingerprint')
    .textContent();
  await settings
    .getByRole('button', { name: 'Add passkey', exact: true })
    .click();
  await settings
    .getByLabel('Recovery key', { exact: true })
    .fill(seeded.recoveryKey);
  await settings
    .getByRole('button', { name: 'Create passkey', exact: true })
    .click();
  await expect(
    settings.getByRole('button', { name: 'Remove passkey 1', exact: true })
  ).toBeVisible();
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  await expect(page).toHaveTitle(/OpenZCAD/);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  if (process.env.PASSKEY_QA_SCREENSHOTS) {
    await page.screenshot({
      path: `${process.env.PASSKEY_QA_SCREENSHOTS}/passkey-enrolled.png`
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await settings
      .getByRole('button', { name: 'Remove passkey 1', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${process.env.PASSKEY_QA_SCREENSHOTS}/passkey-mobile.png`
    });
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  // Retain only the rollback pin and authenticator: reload loses the page's
  // account cache. PRF must open its target and certify fresh device keys.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('openzcad-e2ee', 1);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('devices', 'readwrite');
          tx.objectStore('devices').clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () =>
            reject(
              new Error(tx.error?.message ?? 'Device-key transaction failed')
            );
        };
        request.onerror = () =>
          reject(
            new Error(
              request.error?.message ?? 'Device-key database did not open'
            )
          );
      })
  );
  await page.reload();
  settings = await openEncryptionSettings(page);
  // A fresh browser of an account with a passkey offers it to unlock.
  await settings
    .getByRole('button', { name: 'Unlock with passkey', exact: true })
    .click();
  await settings
    .getByRole('dialog', { name: 'Unlock this device' })
    .getByRole('button', { name: 'Confirm with passkey', exact: true })
    .click();
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  await expect(settings.getByText('Encryption is on')).toBeVisible();
  await settings.getByText('Advanced encryption settings').click();
  await expect(settings.getByLabel('Your fingerprint')).toHaveText(
    fingerprint!
  );

  await settings
    .getByRole('button', { name: 'Remove passkey 1', exact: true })
    .click();
  const removal = settings.getByRole('dialog', { name: 'Remove passkey' });
  await removal
    .getByRole('button', { name: 'Confirm with passkey', exact: true })
    .click();
  // The modal hides the page from the accessibility tree until it closes.
  await expect(removal).toHaveCount(0, { timeout: 15_000 });
  await expect(
    settings.getByRole('button', { name: 'Remove passkey 1', exact: true })
  ).toHaveCount(0);
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  expect(
    server.db
      .prepare(
        "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE target_id LIKE 'pk_%'"
      )
      .get()
  ).toEqual({ n: 0 });
  expect(
    server.db
      .prepare('SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      .get()
  ).toEqual({ n: 4 });
  expect(errors).toEqual([]);
});

// L11 plan 2026-11-25 §5 (D2, D3): setup makes the passkey first (create,
// plus an assertion where PRF needs one), saves the recovery key without
// typing it, and a fresh browser then unlocks with that passkey first.
test('sets up with a passkey first, no retype, and unlocks a fresh browser passkey-first', { tag: '@ci-smoke' }, async ({
  page,
  context,
  baseURL
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: true,
        automaticPresenceSimulation: true
      }
    }
  );
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  const appUrl = new URL(baseURL!);
  appUrl.hostname = 'localhost';
  await page.goto(appUrl.href);
  let settings = await openEncryptionSettings(page);
  await settings.getByRole('button', { name: 'Set up encryption' }).click();
  await settings
    .getByRole('dialog', { name: 'Turn on encryption' })
    .getByRole('button', { name: 'Continue with passkey', exact: true })
    .click();

  const save = settings.getByRole('dialog', { name: 'Save your recovery key' });
  const recoveryKey = save.getByLabel('Recovery key', { exact: true });
  await expect(recoveryKey).toHaveText(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
  // The key is shown and acknowledged before any passkey or key exists.
  expect(
    (await cdp.send('WebAuthn.getCredentials', { authenticatorId }))
      .credentials
  ).toHaveLength(0);
  expect(
    server.db.prepare('SELECT COUNT(*) AS n FROM e2ee_identities').get()
  ).toEqual({ n: 0 });
  const create = save.getByRole('button', {
    name: 'Create passkey and turn on encryption'
  });
  await expect(create).toBeDisabled();
  await save.getByRole('checkbox', { name: /I saved my recovery key/ }).check();
  // D2: nothing to type back on the passkey path.
  await expect(save.getByLabel('Last group of your recovery key')).toHaveCount(
    0
  );
  await expect(recoveryKey).not.toContainText('•');
  await create.click();
  await expect(save).toHaveCount(0, { timeout: 30_000 });
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  await expect(
    settings.getByRole('button', { name: 'Remove passkey 1', exact: true })
  ).toBeVisible();
  // One credential, certified by the second device-list entry with its
  // target, identity and account wraps.
  const { credentials } = await cdp.send('WebAuthn.getCredentials', {
    authenticatorId
  });
  expect(credentials).toHaveLength(1);
  expect(
    server.db
      .prepare('SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      .get()
  ).toEqual({ n: 2 });
  expect(
    server.db
      .prepare(
        "SELECT purpose FROM e2ee_key_wraps WHERE target_id LIKE 'pk_%' ORDER BY purpose"
      )
      .all()
  ).toEqual([
    { purpose: 'account-key' },
    { purpose: 'identity-key' },
    { purpose: 'unlock-target-key' }
  ]);

  // A fresh browser (this one with its device keys gone) is offered the
  // passkey first, then approval, then the recovery key (D3).
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('openzcad-e2ee', 1);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('devices', 'readwrite');
          tx.objectStore('devices').clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(new Error('Device-key clear failed'));
        };
        request.onerror = () => reject(new Error('Device-key open failed'));
      })
  );
  await page.reload();
  settings = await openEncryptionSettings(page);
  const unlock = settings.getByRole('button', {
    name: /^(Unlock with passkey|Ask for approval|Enter recovery key)$/
  });
  await expect(unlock).toHaveCount(3);
  expect(await unlock.allTextContents()).toEqual([
    'Unlock with passkey',
    'Ask for approval',
    'Enter recovery key'
  ]);
  await expect(unlock.first()).toHaveClass('primary');
  await unlock.first().click();
  await settings
    .getByRole('dialog', { name: 'Unlock this device' })
    .getByRole('button', { name: 'Confirm with passkey', exact: true })
    .click();
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('falls back to the recovery key alone, committing nothing, when the passkey has no PRF', async ({
  page,
  context,
  baseURL
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: false,
        automaticPresenceSimulation: true
      }
    }
  );
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  const appUrl = new URL(baseURL!);
  appUrl.hostname = 'localhost';
  await page.goto(appUrl.href);
  const settings = await openEncryptionSettings(page);
  await settings.getByRole('button', { name: 'Set up encryption' }).click();
  await settings
    .getByRole('dialog', { name: 'Turn on encryption' })
    .getByRole('button', { name: 'Continue with passkey', exact: true })
    .click();
  const save = settings.getByRole('dialog', { name: 'Save your recovery key' });
  const recoveryKey = (await save
    .getByLabel('Recovery key', { exact: true })
    .textContent())!;
  await save.getByRole('checkbox', { name: /I saved my recovery key/ }).check();
  await save
    .getByRole('button', { name: 'Create passkey and turn on encryption' })
    .click();
  const notice = save.getByRole('status');
  await expect(notice).toContainText('No passkey was added.');
  await expect(notice).toContainText('does not support PRF');
  // The credential the provider kept is named, so it can be deleted there.
  const { credentials } = await cdp.send('WebAuthn.getCredentials', {
    authenticatorId
  });
  expect(credentials).toHaveLength(1);
  await expect(notice).toContainText(credentials[0]!.userDisplayName!);
  expect(
    server.db.prepare('SELECT COUNT(*) AS n FROM e2ee_identities').get()
  ).toEqual({ n: 0 });

  // Recovery key only now: its last group, then turn on.
  await save
    .getByLabel('Last group of your recovery key')
    .fill(lastRecoveryGroup(recoveryKey));
  await save.getByRole('button', { name: 'Turn on encryption' }).click();
  await finishSetupDialog(settings);
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  expect(
    server.db
      .prepare('SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      .get()
  ).toEqual({ n: 1 });
  expect(
    server.db
      .prepare(
        "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE target_id LIKE 'pk_%'"
      )
      .get()
  ).toEqual({ n: 0 });
});

for (const failure of ['unsupported PRF', 'append conflict'] as const) {
  test(`reports ${failure} and keeps recovery enrollment intact`, async ({
    page,
    context,
    baseURL
  }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send(
      'WebAuthn.addVirtualAuthenticator',
      {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          hasPrf: failure !== 'unsupported PRF'
        }
      }
    );
    const server = createE2eeServer();
    await stubApi(page);
    await installE2eeServer(context, server);
    const appendRoute = '**/api/e2ee/device-list';
    if (failure === 'append conflict') {
      await page.route(appendRoute, (route) =>
        route.fulfill({
          status: 409,
          json: { error: 'Device list changed', code: 'E2EE_HEAD_CONFLICT' }
        })
      );
    }
    const appUrl = new URL(baseURL!);
    appUrl.hostname = 'localhost';
    await page.goto(appUrl.href);
    const seeded = await seedE2eeDevice(page, server);
    const settings = await openEncryptionSettings(page);
    await settings
      .getByRole('button', { name: 'Add passkey', exact: true })
      .click();
    await settings
      .getByLabel('Recovery key', { exact: true })
      .fill(seeded.recoveryKey);
    await settings
      .getByRole('button', { name: 'Create passkey', exact: true })
      .click();
    await expect(settings.getByRole('alert')).toContainText(
      failure === 'unsupported PRF'
        ? 'does not support PRF'
        : 'Device list changed'
    );
    await expect(settings.getByRole('alert')).toContainText(
      'Before creating another passkey, remove only'
    );
    const { credentials } = await cdp.send('WebAuthn.getCredentials', {
      authenticatorId
    });
    expect(credentials).toHaveLength(1);
    const saved = credentials[0]!;
    expect(saved.userDisplayName).toMatch(/^OpenZCAD encryption [0-9a-f]{12}$/);
    expect(saved.userName).toBe(saved.userDisplayName);
    await expect(settings.getByRole('alert')).toContainText(
      saved.userDisplayName!
    );
    expect(
      server.db
        .prepare('SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
        .get()
    ).toEqual({ n: 1 });
    if (failure === 'append conflict') {
      // Follow the cleanup advice using the provider, then retry with the same recovery key.
      await cdp.send('WebAuthn.removeCredential', {
        authenticatorId,
        credentialId: saved.credentialId
      });
      await page.unroute(appendRoute);
      await settings
        .getByRole('button', { name: 'Create passkey', exact: true })
        .click();
      await expect(
        settings.getByRole('button', { name: 'Remove passkey 1', exact: true })
      ).toBeVisible();
      const retried = await cdp.send('WebAuthn.getCredentials', {
        authenticatorId
      });
      expect(retried.credentials).toHaveLength(1);
      expect(retried.credentials[0]!.credentialId).not.toBe(saved.credentialId);
      expect(retried.credentials[0]!.userDisplayName).not.toBe(
        saved.userDisplayName
      );
    } else {
      await settings
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
    }
    // Recovery stays intact: the key can still be replaced, and this
    // device stays unlocked.
    await expect(
      settings.getByRole('button', { name: 'Replace…', exact: true })
    ).toBeVisible();
    await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  });
}

test('disables passkeys when WebAuthn is unavailable', async ({
  page,
  context
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'PublicKeyCredential', { value: undefined });
  });
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  await page.goto('/');
  await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  await expect(
    settings.getByRole('button', { name: 'Add passkey', exact: true })
  ).toBeDisabled();
  await expect(
    settings.getByText(/^Not available in this browser\./)
  ).toBeVisible();
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
});

test('cross-tab sign-out aborts a pending real WebAuthn prompt before releasing the device lock', async ({
  page,
  context,
  baseURL
}) => {
  let signedIn = true;
  const session = async (tab: Page) => {
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
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: false
    }
  });
  await page.addInitScript(() => {
    const probe = { started: 0, aborted: 0 };
    (
      window as Window & { passkeyPromptProbe?: typeof probe }
    ).passkeyPromptProbe = probe;
    const create = navigator.credentials.create.bind(navigator.credentials);
    Object.defineProperty(navigator.credentials, 'create', {
      configurable: true,
      value: (options: CredentialCreationOptions) => {
        probe.started++;
        options.signal?.addEventListener(
          'abort',
          () => {
            probe.aborted++;
          },
          { once: true }
        );
        return create(options);
      }
    });
  });
  const server = createE2eeServer();
  await installE2eeServer(context, server);
  await session(page);
  const appUrl = new URL(baseURL!);
  appUrl.hostname = 'localhost';
  await page.goto(appUrl.href);
  const seeded = await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  const other = await context.newPage();
  await session(other);
  await other.route('**/api/auth/logout', async (route) => {
    signedIn = false;
    await route.fulfill({ json: { ok: true } });
  });
  await other.goto(appUrl.href);
  const otherSettings = await openEncryptionSettings(other);
  await settings
    .getByRole('button', { name: 'Add passkey', exact: true })
    .click();
  await settings
    .getByLabel('Recovery key', { exact: true })
    .fill(seeded.recoveryKey);
  await settings
    .getByRole('button', { name: 'Create passkey', exact: true })
    .click();
  const probe = () =>
    page.evaluate(
      () =>
        (
          window as Window & {
            passkeyPromptProbe?: { started: number; aborted: number };
          }
        ).passkeyPromptProbe
    );
  await expect.poll(async () => (await probe())?.started).toBe(1);
  await otherSettings
    .getByRole('button', { name: 'Account', exact: true })
    .click();
  await otherSettings
    .getByRole('button', { name: 'Sign out', exact: true })
    .click();
  await otherSettings
    .getByRole('button', { name: 'Keep unlocked', exact: true })
    .click();
  await expect.poll(() => signedIn).toBe(false);
  await expect.poll(async () => (await probe())?.aborted).toBe(1);
  await expect(settings.getByText('Unlocked', { exact: true })).toHaveCount(0);
  expect(
    server.db
      .prepare('SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      .get()
  ).toEqual({ n: 1 });
});
