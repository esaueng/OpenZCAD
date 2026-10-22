import { parseRecoveryKey } from '@openzcad/crypto';
import {
  enrollWithRecoveryKey,
  loadEncryption
} from '../../apps/web/src/lib/e2ee/accountKeys';
import { expect, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  E2E_USER_ID,
  installE2eeServer,
  openEncryptionSettings,
  seedE2eeDevice
} from './e2ee-fixtures';

test('a delayed tab cannot overwrite the device-list pin advanced by another tab', async ({
  page,
  context
}) => {
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  await page.goto('/');
  const seeded = await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  const other = await context.newPage();
  await stubApi(other);
  await other.goto('/');
  const otherSettings = await openEncryptionSettings(other);
  await expect(
    otherSettings.getByText('Unlocked', { exact: true })
  ).toBeVisible();

  // Pause verification after the first tab read pin 0. This leaves the
  // crypto and real IndexedDB persistence code untouched under test.
  await page.evaluate(() => {
    const control = window as typeof window & {
      pinCheckPaused?: boolean;
      releasePinCheck?: () => void;
    };
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    crypto.subtle.verify = async (
      ...args: Parameters<SubtleCrypto['verify']>
    ) => {
      const valid = await verify(...args);
      crypto.subtle.verify = verify;
      control.pinCheckPaused = true;
      await new Promise<void>((resolve) => {
        control.releasePinCheck = resolve;
      });
      return valid;
    };
  });
  await settings.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { pinCheckPaused?: boolean })
            .pinCheckPaused
      )
    )
    .toBe(true);

  const nodeDevice = server.nodeDevice();
  const state = await loadEncryption(nodeDevice);
  if (state.kind !== 'ready')
    throw new Error('Expected an initialized account');
  await enrollWithRecoveryKey(
    nodeDevice,
    state.account,
    await parseRecoveryKey(seeded.recoveryKey),
    'Another browser'
  );
  await otherSettings
    .getByRole('button', { name: 'Refresh', exact: true })
    .click();
  await expect(otherSettings.getByText('2 certified')).toBeVisible();

  const readSequence = () =>
    page.evaluate(
      (userId) =>
        new Promise<number | null>((resolve, reject) => {
          const open = indexedDB.open('openzcad-e2ee', 1);
          open.onsuccess = () => {
            const db = open.result;
            const read = db.transaction('pins').objectStore('pins').get(userId);
            read.onsuccess = () => {
              db.close();
              // The persisted record also retains retired identity hashes.
              // Read its active pin while still accepting the legacy layout.
              const stored = read.result as
                | { pin: { sequence: number } | null }
                | { sequence: number }
                | undefined;
              const pin = stored && 'pin' in stored ? stored.pin : stored;
              resolve(pin?.sequence ?? null);
            };
            read.onerror = () => reject(new Error('Pin read failed'));
          };
          open.onerror = () => reject(new Error('Pin database did not open'));
        }),
      E2E_USER_ID
    );
  expect(await readSequence()).toBe(1);
  await page.evaluate(() =>
    (
      window as typeof window & { releasePinCheck?: () => void }
    ).releasePinCheck?.()
  );
  await expect(settings.getByRole('alert')).toContainText(
    'older or different device list'
  );
  expect(await readSequence()).toBe(1);
  await expect(settings.getByText('Unlocked', { exact: true })).toHaveCount(0);
  await other.close();
});

test('the saved recovery key restores a certified browser after its replacement pin loses a race', async ({
  page,
  context
}) => {
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  await page.goto('/');
  const seeded = await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  await expect(settings.getByText('1 certified')).toBeVisible();
  const other = await context.newPage();
  await stubApi(other);
  await other.goto('/');
  const otherSettings = await openEncryptionSettings(other);
  await expect(otherSettings.getByText('1 certified')).toBeVisible();
  const nodeDevice = server.nodeDevice();
  const state = await loadEncryption(nodeDevice);
  if (state.kind !== 'ready')
    throw new Error('Expected an initialized account');
  await enrollWithRecoveryKey(
    nodeDevice,
    state.account,
    await parseRecoveryKey(seeded.recoveryKey),
    'Another browser'
  );
  // The first tab still holds its earlier AccountView; the other tab moves
  // the shared pin forward before the explicit replacement starts.
  await otherSettings
    .getByRole('button', { name: 'Refresh', exact: true })
    .click();
  await expect(otherSettings.getByText('2 certified')).toBeVisible();
  await settings.getByRole('button', { name: 'Replace…', exact: true }).click();
  const newKey = (await settings
    .getByLabel('Recovery key', { exact: true })
    .textContent())!;
  await settings
    .getByRole('checkbox', { name: 'I saved my recovery key' })
    .check();
  await settings.getByRole('button', { name: 'Continue', exact: true }).click();
  await settings.getByLabel('Confirm recovery key').fill(newKey);
  await settings.getByLabel('Current recovery key').fill(seeded.recoveryKey);
  await settings
    .getByRole('button', { name: 'Replace recovery key', exact: true })
    .click();
  await expect(settings.getByRole('alert')).toContainText(
    'changed in another tab'
  );
  await settings.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText(
    'replaced on another device'
  );
  await settings
    .getByRole('button', { name: 'Enter recovery key', exact: true })
    .click();
  await settings.getByLabel('Recovery key', { exact: true }).fill(newKey);
  await settings
    .getByRole('button', { name: 'Unlock this device', exact: true })
    .click();
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  await expect(settings.getByText('1 certified')).toBeVisible();
  expect(
    server.db
      .prepare(
        'SELECT COUNT(*) AS n FROM e2ee_device_list_entries WHERE generation = 2'
      )
      .get()
  ).toEqual({ n: 1 });
  await other.close();
});
