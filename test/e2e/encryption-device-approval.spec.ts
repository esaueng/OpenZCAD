import type { Browser, Page } from '@playwright/test';
import { requestApproval } from '../../apps/web/src/lib/e2ee/accountKeys';
import { expect, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  E2E_USER_ID,
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

for (const cancellation of ['stop', 'close', 'active'] as const) {
  test(`stops camera tracks when ${cancellation} overlaps capture permission`, async ({
    page
  }) => {
    const server = createE2eeServer();
    const { settings } = await approverWith(page, server);
    await requestApproval(server.nodeDevice(), null, 'Phone');
    await page.evaluate(() => {
      const control = window as typeof window & {
        captureStarted?: boolean;
        stoppedTracks?: number;
        resolveCapture?: () => void;
      };
      control.stoppedTracks = 0;
      Object.defineProperty(window, 'BarcodeDetector', {
        configurable: true,
        value: class {
          detect() {
            return new Promise(() => {});
          }
        }
      });
      HTMLMediaElement.prototype.play = async () => {};
      const media = new MediaStream();
      media.getTracks = () =>
        [0, 1].map(
          () =>
            ({
              stop: () => {
                control.stoppedTracks! += 1;
              }
            }) as MediaStreamTrack
        );
      navigator.mediaDevices.getUserMedia = () => {
        control.captureStarted = true;
        return new Promise((resolve) => {
          control.resolveCapture = () => resolve(media);
        });
      };
    });
    await settings
      .getByRole('button', { name: 'Scan code', exact: true })
      .click({ timeout: 10_000 });
    await settings.getByRole('button', { name: 'Scan with camera' }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { captureStarted?: boolean })
              .captureStarted
        )
      )
      .toBe(true);
    if (cancellation === 'active') {
      await page.evaluate(() =>
        (
          window as typeof window & { resolveCapture?: () => void }
        ).resolveCapture?.()
      );
      await expect
        .poll(() =>
          page
            .getByLabel('Camera')
            .evaluate((video: HTMLVideoElement) => video.srcObject !== null)
        )
        .toBe(true);
    }
    await settings
      .getByRole('button', {
        name: cancellation === 'close' ? 'Cancel' : 'Stop camera',
        exact: true
      })
      .click();
    if (cancellation !== 'active') {
      await page.evaluate(() =>
        (
          window as typeof window & { resolveCapture?: () => void }
        ).resolveCapture?.()
      );
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { stoppedTracks?: number }).stoppedTracks
        )
      )
      .toBe(2);
    await expect(settings.getByLabel('Camera')).toHaveCount(0);
  });
}

test('certifies a new device approved by its full-hash scan code', { tag: '@ci-smoke' }, async ({
  page,
  browser
}) => {
  const server = createE2eeServer();
  const { seeded, settings } = await approverWith(page, server);
  const phone = await secondDevice(browser, server);
  try {
    const phoneSettings = await openEncryptionSettings(phone.page);
    await phoneSettings
      .getByRole('button', { name: 'Ask for approval' })
      .click();
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
    await settings
      .getByLabel('Code from the new device')
      .fill(code.replace(/.$/, code.endsWith('0') ? '1' : '0'));
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

test('two approval tabs retain one staged device and can both unlock it', async ({
  page,
  browser
}) => {
  const server = createE2eeServer();
  const { seeded, settings } = await approverWith(page, server);
  const phone = await secondDevice(browser, server);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    const firstSettings = await openEncryptionSettings(phone.page);
    const other = await phone.context.newPage();
    await stubApi(other);
    await other.goto('/');
    const otherSettings = await openEncryptionSettings(other);
    await phone.page.route('**/api/e2ee/approvals', async (route) => {
      if (route.request().method() === 'POST') {
        started();
        await held;
      }
      await route.fallback();
    });
    await firstSettings
      .getByRole('button', { name: 'Ask for approval' })
      .click();
    await entered;
    const stagedId = await phone.page.evaluate(
      (userId) =>
        new Promise<string | null>((resolve, reject) => {
          const open = indexedDB.open('openzcad-e2ee', 1);
          open.onsuccess = () => {
            const db = open.result;
            const read = db
              .transaction('devices')
              .objectStore('devices')
              .get(userId);
            read.onsuccess = () => {
              db.close();
              resolve(
                (read.result as { deviceId: string } | undefined)?.deviceId ??
                  null
              );
            };
            read.onerror = () => reject(new Error('Device read failed'));
          };
          open.onerror = () =>
            reject(new Error('Device database did not open'));
        }),
      E2E_USER_ID
    );
    expect(stagedId).not.toBeNull();
    await otherSettings
      .getByRole('button', { name: 'Ask for approval' })
      .click();
    release();
    await expect(
      otherSettings.getByRole('img', { name: 'Device approval QR code' })
    ).toBeVisible();
    const code = (await otherSettings
      .getByLabel('Device approval code')
      .textContent())!;
    await settings
      .getByRole('button', { name: 'Refresh', exact: true })
      .click();
    await expect(
      settings.getByRole('button', { name: 'Refresh', exact: true })
    ).toBeEnabled();
    await expect(settings.getByText('None waiting')).toHaveCount(0, {
      timeout: 10_000
    });
    await settings.getByRole('button', { name: 'Scan code' }).click();
    await settings.getByLabel('Code from the new device').fill(code);
    await settings
      .getByLabel('Recovery key to certify the new device')
      .fill(seeded.recoveryKey);
    await settings.getByRole('button', { name: 'Approve device' }).click();
    await expect(
      otherSettings.getByText('Certified', { exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await firstSettings
      .getByRole('button', { name: 'Refresh', exact: true })
      .click();
    for (const panel of [firstSettings, otherSettings]) {
      await expect(panel.getByText('Certified', { exact: true })).toBeVisible();
      await expect(panel.getByText('Unlocked', { exact: true })).toBeVisible();
    }
  } finally {
    release();
    await phone.context.close();
  }
});

test('resumes comparison after an accepted response is lost', async ({
  page,
  browser
}) => {
  const server = createE2eeServer();
  const { settings } = await approverWith(page, server);
  const phone = await secondDevice(browser, server);
  let responses = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/respond')) responses += 1;
  });
  try {
    const phoneSettings = await openEncryptionSettings(phone.page);
    await phoneSettings
      .getByRole('button', { name: 'Ask for approval' })
      .click();
    await expect(
      phoneSettings.getByRole('img', { name: 'Device approval QR code' })
    ).toBeVisible();
    await page.evaluate(() => {
      const fetch = window.fetch.bind(window);
      let dropped = false;
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        const input = args[0];
        const url = input instanceof Request ? input.url : input;
        if (
          !dropped &&
          new URL(url, window.location.href).pathname.endsWith('/respond') &&
          response.ok
        ) {
          dropped = true;
          throw new TypeError('Simulated comparison response loss');
        }
        return response;
      };
    });
    await settings
      .getByRole('button', { name: 'Compare codes' })
      .click({ timeout: 10_000 });
    await expect(
      settings.getByText(
        'Encryption keys are unavailable right now. Check your connection and try again.'
      )
    ).toBeVisible();
    const phoneCode = phoneSettings.getByLabel('Approval code');
    await expect(phoneCode).toHaveText(/^\d{3} \d{3}$/, { timeout: 15_000 });
    const resume = settings.getByRole('button', { name: 'Resume comparison' });
    await expect(resume).toBeEnabled();
    await resume.click();
    const laptopCode = settings.getByLabel('Approval code');
    await expect(laptopCode).toHaveText(/^\d{3} \d{3}$/, { timeout: 15_000 });
    expect(await laptopCode.textContent()).toBe(await phoneCode.textContent());
    await phoneSettings.getByRole('button', { name: 'Codes match' }).click();
    await settings
      .getByRole('button', { name: 'Codes match, approve' })
      .click();
    await expect(phoneSettings.getByText('Approved, read-only')).toBeVisible({
      timeout: 15_000
    });
    await expect(
      phoneSettings.getByText('Unlocked', { exact: true })
    ).toBeVisible();
    expect(responses).toBe(1);
  } finally {
    await phone.context.close();
  }
});

test('restarts comparison after session lock before response delivery', async ({
  page,
  browser
}, testInfo) => {
  const server = createE2eeServer();
  const { settings } = await approverWith(page, server);
  const phone = await secondDevice(browser, server);
  const responses: unknown[] = [];
  await page.route('**/api/e2ee/approvals/*/respond', async (route) => {
    responses.push(route.request().postDataJSON());
    if (responses.length === 1) await route.abort('failed');
    else await route.fallback();
  });
  try {
    const phoneSettings = await openEncryptionSettings(phone.page);
    await phoneSettings
      .getByRole('button', { name: 'Ask for approval' })
      .click();
    await expect(
      phoneSettings.getByRole('img', { name: 'Device approval QR code' })
    ).toBeVisible();
    await settings
      .getByRole('button', { name: 'Compare codes' })
      .click({ timeout: 10_000 });
    await expect(
      settings.getByText(
        'Encryption keys are unavailable right now. Check your connection and try again.'
      )
    ).toBeVisible();
    expect(responses).toHaveLength(1);
    expect(
      server.db.prepare('SELECT state FROM e2ee_device_approvals').get()
    ).toEqual({ state: 'requested' });

    // Deliver the same cross-tab lifecycle notices as session teardown.
    // The ended notice permits reopening only after a fresh session read.
    await page.evaluate(() => {
      const channel = new BroadcastChannel('openzcad:e2ee-key-session:v1');
      channel.postMessage({
        id: 'approval-lock-prepare',
        operation: 'approval-lock',
        phase: 'prepare'
      });
      channel.close();
    });
    await expect(
      settings.getByText(
        'Encryption keys are locked while the account session is checked.'
      )
    ).toBeVisible();
    const rechecked = page.waitForResponse('**/api/session');
    await page.evaluate(() => {
      const channel = new BroadcastChannel('openzcad:e2ee-key-session:v1');
      channel.postMessage({
        id: 'approval-lock-ended',
        operation: 'approval-lock',
        phase: 'ended'
      });
      channel.close();
    });
    await rechecked;
    await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Compare codes' }).click();
    const phoneCode = phoneSettings.getByLabel('Approval code');
    const laptopCode = settings.getByLabel('Approval code');
    await expect(phoneCode).toHaveText(/^\d{3} \d{3}$/, { timeout: 15_000 });
    await expect(laptopCode).toHaveText(/^\d{3} \d{3}$/, { timeout: 15_000 });
    expect(await laptopCode.textContent()).toBe(await phoneCode.textContent());
    expect(responses).toHaveLength(2);
    expect(responses[1]).toEqual(responses[0]);
    await testInfo.attach('restarted-comparison', {
      body: await page.screenshot({
        path: testInfo.outputPath('restarted-comparison.png')
      }),
      contentType: 'image/png'
    });
    await phoneSettings.getByRole('button', { name: 'Codes match' }).click();
    await settings
      .getByRole('button', { name: 'Codes match, approve' })
      .click();
    await expect(phoneSettings.getByText('Approved, read-only')).toBeVisible({
      timeout: 15_000
    });
    await expect(
      phoneSettings.getByText('Unlocked', { exact: true })
    ).toBeVisible();
  } finally {
    await phone.context.close();
  }
});

test('resumes the requesting device comparison after reloading its browser', async ({
  page,
  browser
}) => {
  const server = createE2eeServer();
  const { settings } = await approverWith(page, server);
  const phone = await secondDevice(browser, server);
  try {
    let phoneSettings = await openEncryptionSettings(phone.page);
    await phoneSettings
      .getByRole('button', { name: 'Ask for approval' })
      .click();
    await expect(
      phoneSettings.getByRole('img', { name: 'Device approval QR code' })
    ).toBeVisible();
    await settings
      .getByRole('button', { name: 'Compare codes' })
      .click({ timeout: 10_000 });
    await expect(phoneSettings.getByLabel('Approval code')).toHaveText(
      /^\d{3} \d{3}$/,
      { timeout: 15_000 }
    );
    const original = await phoneSettings
      .getByLabel('Approval code')
      .textContent();
    await phone.page.reload();
    phoneSettings = await openEncryptionSettings(phone.page);
    await phoneSettings
      .getByRole('button', { name: 'Resume approval' })
      .click();
    await expect(phoneSettings.getByLabel('Approval code')).toHaveText(
      original!,
      { timeout: 15_000 }
    );
    await expect(settings.getByLabel('Approval code')).toHaveText(original!);
    await phoneSettings.getByRole('button', { name: 'Codes match' }).click();
    await settings
      .getByRole('button', { name: 'Codes match, approve' })
      .click();
    await expect(phoneSettings.getByText('Approved, read-only')).toBeVisible({
      timeout: 15_000
    });
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
  const { settings, seeded } = await approverWith(page, server);
  await expect(
    settings.getByRole('button', {
      name: 'Revoke read-only devices',
      exact: true
    })
  ).toBeEnabled();
  const phone = await secondDevice(browser, server);
  try {
    const phoneSettings = await openEncryptionSettings(phone.page);
    await phoneSettings
      .getByRole('button', { name: 'Ask for approval' })
      .click();
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
    await settings
      .getByRole('button', { name: 'Codes match, approve' })
      .click();
    await expect(phoneSettings.getByText('Approved, read-only')).toBeVisible({
      timeout: 15_000
    });
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
    await expect(
      settings.getByText('1 approved', { exact: true })
    ).toBeVisible();
    await settings
      .getByRole('button', { name: 'Revoke read-only devices', exact: true })
      .click();
    await expect(
      settings.getByText(
        'All read-only devices will need approval again. Certified devices keep working.'
      )
    ).toBeVisible();
    await settings
      .getByLabel('Recovery key', { exact: true })
      .fill(seeded.recoveryKey);
    await settings
      .getByRole('button', { name: 'Revoke read-only access', exact: true })
      .click();
    await expect(settings.getByText('1 approved', { exact: true })).toHaveCount(
      0
    );
    await expect(
      settings.getByText('1 certified', { exact: true })
    ).toBeVisible();
    expect(
      server.db
        .prepare(
          "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE purpose = 'account-key-approval'"
        )
        .get()
    ).toEqual({ n: 0 });
    await phone.page.reload();
    const reloaded = await openEncryptionSettings(phone.page);
    await expect(reloaded.getByText('Unlocked', { exact: true })).toHaveCount(
      0
    );
    await expect(
      reloaded.getByRole('button', { name: 'Ask for approval' })
    ).toBeVisible();
  } finally {
    await phone.context.close();
  }
});
