import { test, expect, stubApi } from './openzcad-fixtures';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';

const token = 'd'.repeat(43);

async function ownedLocalWorkspace(page: Page) {
  await stubApi(page, { collaborationRole: 'owner' });
  await page.route('**/api/collaboration/config', (route) =>
    route.fulfill({
      json: {
        sharingEnabled: true,
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
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
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
