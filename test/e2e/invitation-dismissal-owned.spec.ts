import { test, expect, stubApi } from './openzcad-fixtures';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';

const token = 'd'.repeat(43);

async function ownedLocalWorkspace(page: Page, sharingEnabled = true) {
  await stubApi(page, { collaborationRole: 'owner' });
  await page.route('**/api/collaboration/config', (route) =>
    route.fulfill({
      json: {
        sharingEnabled,
        editLeasesEnforced: false,
        personalSyncEnabled: false,
        canary: false
      }
    })
  );
  let holdAdoption = false;
  let adoptionRequested = false;
  let releaseAdoption!: () => void;
  const adoption = new Promise<void>((resolve) => {
    releaseAdoption = resolve;
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: { projects: [] } });
      return;
    }
    const payload = route.request().postDataJSON() as { document?: unknown };
    if (payload.document && holdAdoption) {
      adoptionRequested = true;
      await adoption;
    }
    await route.fulfill({
      status: 503,
      json: { error: 'Account save unavailable.' }
    });
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Owned local workspace');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('.breadcrumb')).toContainText(
    'Owned local workspace'
  );
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeEnabled();
  return {
    holdAdoption: () => {
      holdAdoption = true;
    },
    adoptionRequested: () => adoptionRequested,
    releaseAdoption
  };
}

async function openSharing(page: Page) {
  await page.getByRole('button', { name: /Open project sharing/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Project sharing' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function heldInvitation(page: Page, rejectImmediately = false) {
  const document = createProjectDocument(
    'Delayed invited project',
    toUserId('other_owner')
  );
  let requested = false;
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/project-invitations/accept', async (route) => {
    requested = true;
    if (rejectImmediately) {
      await route.fulfill({
        status: 503,
        json: { error: 'Invitation unavailable.' }
      });
      return;
    }
    await gate;
    await route.fulfill({
      json: { projectId: document.projectId, role: 'viewer' }
    });
  });
  await page.route(`**/api/projects/${document.projectId}`, (route) => {
    reads += 1;
    return route.fulfill({ json: document });
  });
  await page.evaluate((invite) => {
    window.location.hash = `invite=${invite}`;
  }, token);
  await expect.poll(() => requested).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  return { release, reads: () => reads };
}

async function releaseInvitation(page: Page, release: () => void) {
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/project-invitations/accept'
  );
  release();
  await response;
  await page.waitForTimeout(250);
}

test('dismisses pending acceptance and immediately enables the owned account action', async ({
  page
}) => {
  await ownedLocalWorkspace(page);
  const before = await openSharing(page);
  await expect(
    before.getByRole('button', { name: 'Save to my account', exact: true })
  ).toBeEnabled();
  await before.getByRole('button', { name: 'Close sharing' }).click();
  const invitation = await heldInvitation(page);
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeEnabled();
  try {
    const after = await openSharing(page);
    await expect(
      after.getByRole('button', { name: 'Save to my account', exact: true })
    ).toBeEnabled();
    await releaseInvitation(page, invitation.release);
    expect(invitation.reads()).toBe(0);
    await expect(page.locator('.breadcrumb')).toContainText(
      'Owned local workspace'
    );
    await expect(
      after.getByRole('button', { name: 'Save to my account', exact: true })
    ).toBeEnabled();
  } finally {
    invitation.release();
  }
});

test('disabling cloud features releases a pending invitation navigation', async ({
  page
}) => {
  await ownedLocalWorkspace(page);
  const invitation = await heldInvitation(page);
  try {
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings
      .getByRole('button', { name: 'Account', exact: true })
      .click();
    await settings
      .getByRole('checkbox', { name: 'Cloud features', exact: true })
      .uncheck();
    await settings
      .getByRole('button', { name: 'Back to workspace', exact: true })
      .click();
    await expect(settings).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^Box \(B\)/ })
    ).toBeEnabled();
    invitation.release();
    await page.waitForTimeout(250);
    expect(invitation.reads()).toBe(0);
    await expect(page.locator('.breadcrumb')).toContainText(
      'Owned local workspace'
    );
    await expect(
      page.getByRole('button', { name: /^Box \(B\)/ })
    ).toBeEnabled();
  } finally {
    invitation.release();
  }
});

for (const sharingEnabled of [false, true]) {
  test(`invitation navigation preserves an existing account save with rollout ${sharingEnabled}`, async ({
    page
  }) => {
    const account = await ownedLocalWorkspace(page, sharingEnabled);
    let accepted = 0;
    await page.route('**/api/project-invitations/accept', (route) => {
      accepted++;
      return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    });
    const first = await openSharing(page);
    account.holdAdoption();
    await first
      .getByRole('button', { name: 'Save to my account', exact: true })
      .click();
    let current!: Locator;
    try {
      await expect.poll(account.adoptionRequested).toBe(true);
      await expect(
        first.getByRole('button', {
          name: 'Saving project and sources…',
          exact: true
        })
      ).toBeDisabled();
      await first.getByRole('button', { name: 'Close sharing' }).click();
      await page.evaluate((invite) => {
        window.location.hash = `invite=${invite}`;
      }, token);
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await expect(settings).toBeVisible();
      expect(accepted).toBe(0);
      await settings
        .getByRole('button', { name: 'Back to workspace', exact: true })
        .click();
      await expect(settings).toHaveCount(0);
      current = await openSharing(page);
      await expect(
        current.getByRole('button', {
          name: 'Saving project and sources…',
          exact: true
        })
      ).toBeDisabled();
      expect(accepted).toBe(0);
    } finally {
      account.releaseAdoption();
    }
    if (sharingEnabled) {
      await expect.poll(() => accepted).toBe(1);
    } else {
      await expect(
        current.getByRole('button', { name: 'Save to my account', exact: true })
      ).toBeEnabled();
      expect(accepted).toBe(0);
    }
  });
}

test('late dismissed acceptance cannot release a newer account save or open its project', async ({
  page
}) => {
  const account = await ownedLocalWorkspace(page);
  const invitation = await heldInvitation(page);
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  const dialog = await openSharing(page);
  account.holdAdoption();
  await dialog
    .getByRole('button', { name: 'Save to my account', exact: true })
    .click();
  await expect.poll(account.adoptionRequested).toBe(true);
  await expect(
    dialog.getByRole('button', {
      name: 'Saving project and sources…',
      exact: true
    })
  ).toBeDisabled();
  try {
    await releaseInvitation(page, invitation.release);
    expect(invitation.reads()).toBe(0);
    await expect(page.locator('.breadcrumb')).toContainText(
      'Owned local workspace'
    );
    await expect(
      dialog.getByRole('button', {
        name: 'Saving project and sources…',
        exact: true
      })
    ).toBeDisabled();
  } finally {
    account.releaseAdoption();
    invitation.release();
  }
  await expect(
    dialog.getByRole('button', { name: 'Save to my account', exact: true })
  ).toBeEnabled();
});

test('dismissing a settled invitation failure preserves a newer account save busy state', async ({
  page
}) => {
  const account = await ownedLocalWorkspace(page);
  await heldInvitation(page, true);
  await expect(
    page.getByText(/This invitation could not be accepted/)
  ).toBeVisible();
  await page.keyboard.press('Escape');
  account.holdAdoption();
  const first = await openSharing(page);
  await first
    .getByRole('button', { name: 'Save to my account', exact: true })
    .click();
  await expect.poll(account.adoptionRequested).toBe(true);
  await first.getByRole('button', { name: 'Close sharing' }).click();
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  const current = await openSharing(page);
  try {
    await expect(
      current.getByRole('button', {
        name: 'Saving project and sources…',
        exact: true
      })
    ).toBeDisabled();
    await expect(page.locator('.breadcrumb')).toContainText(
      'Owned local workspace'
    );
  } finally {
    account.releaseAdoption();
  }
  await expect(
    current.getByRole('button', { name: 'Save to my account', exact: true })
  ).toBeEnabled();
});

test('disabling cloud during acceptance releases its busy state across reconnect', async ({
  page
}) => {
  await ownedLocalWorkspace(page);
  const invitation = await heldInvitation(page);
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: /^Account\b/ }).click();
  const cloud = settings.getByRole('checkbox', { name: 'Cloud features' });
  try {
    await cloud.uncheck();
    invitation.release();
    await page.waitForTimeout(250);
    const reconnect = page.waitForResponse((response) =>
      response.url().endsWith('/api/collaboration/config')
    );
    await cloud.check();
    await reconnect;
    await settings.getByRole('button', { name: /^Account\b/ }).click();
    await settings
      .getByRole('button', { name: 'Not now', exact: true })
      .click();
    const sharing = await openSharing(page);
    await expect(
      sharing.getByRole('button', { name: 'Save to my account', exact: true })
    ).toBeEnabled();
    await expect(page.locator('.breadcrumb')).toContainText(
      'Owned local workspace'
    );
    expect(invitation.reads()).toBe(0);
  } finally {
    invitation.release();
  }
});
