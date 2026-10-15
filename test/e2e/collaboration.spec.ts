import {
  test,
  expect,
  WORKSPACE_SESSION_STORAGE_KEY,
  stubAnonymousApi,
  stubApi,
  stubEmailLoginApi,
  stubTurnstileLoadFailureApi
} from './openzcad-fixtures';
import {
  appendRevision,
  createCheckpoint,
  createProjectDocument
} from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { DEFAULT_APP_SETTINGS, toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { PROJECT_INVITATION_SESSION_KEY } from '../../apps/web/src/lib/projectInvitationLink';

const invitationToken = 'i'.repeat(43);

async function hasCachedProjectThumbnail(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () =>
          reject(new Error(open.error?.message ?? 'IndexedDB unavailable.'));
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('projectThumbnails')) {
            database.close();
            resolve(false);
            return;
          }
          const all = database
            .transaction('projectThumbnails', 'readonly')
            .objectStore('projectThumbnails')
            .getAll();
          all.onerror = () =>
            reject(new Error(all.error?.message ?? 'Thumbnail read failed.'));
          all.onsuccess = () => {
            resolve(
              (all.result as Array<{ source?: unknown }>).some(
                ({ source }) =>
                  typeof source === 'string' && source.startsWith('data:image/')
              )
            );
            database.close();
          };
        };
      })
  );
}

test('loads the OpenZCAD shell', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.getByText('OpenZCAD')).toBeVisible();
  await expect(page.getByText('parametric cad in the browser')).toBeVisible();
});

for (const fromPublicShare of [false, true]) {
  test(`accepts a signed-in invitation from ${fromPublicShare ? 'a public share' : 'Settings'} without reload`, async ({
    page
  }) => {
    const document = createProjectDocument(
      'Invited Link Part',
      toUserId('user_invitation_owner')
    );
    let accepted = false;
    await stubApi(page, {
      collaborationRole: fromPublicShare ? 'editor' : 'viewer'
    });
    if (fromPublicShare) {
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
    }
    const publicDocument = createProjectDocument(
      'Public snapshot',
      toUserId('public_owner')
    );
    await page.route('**/api/share/*', (route) =>
      route.fulfill({
        json: {
          document: publicDocument,
          project: { name: publicDocument.name },
          mode: 'tweak'
        }
      })
    );
    await page.route('**/api/project-invitations/accept', (route) => {
      expect(route.request().postDataJSON()).toEqual({
        token: invitationToken
      });
      accepted = true;
      return route.fulfill({
        json: {
          projectId: document.projectId,
          role: fromPublicShare ? 'editor' : 'viewer'
        }
      });
    });
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        json: {
          projects: accepted
            ? [
                {
                  projectId: document.projectId,
                  name: document.name,
                  revisionCount: 0,
                  documentVersion: document.version,
                  updatedAt: document.derived.updatedAt
                }
              ]
            : []
        }
      })
    );
    await page.route(`**/api/projects/${document.projectId}`, (route) =>
      route.fulfill({ json: document })
    );

    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
    if (fromPublicShare) {
      await page.evaluate(() => {
        window.location.hash = `share=${'p'.repeat(43)}`;
      });
      await expect(
        page.getByRole('button', { name: 'Make a copy', exact: true })
      ).toBeVisible();
    }
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.evaluate((token) => {
      window.location.hash = `invite=${token}`;
    }, invitationToken);

    if (fromPublicShare) {
      await expect(
        page
          .getByRole('group', { name: 'Workspace mode' })
          .getByRole('button', { name: 'Build' })
      ).toBeEnabled();
      await expect(
        page.getByRole('button', { name: 'Make a copy', exact: true })
      ).toHaveCount(0);
    } else {
      await expect(
        page.getByRole('button', { name: 'Rename project' })
      ).toHaveCount(0);
    }
    await expect(page.locator('.breadcrumb')).toContainText(document.name);
    await expect(page.getByRole('contentinfo')).toContainText(
      `Opened ${document.name}`
    );
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    expect(
      await page.evaluate(
        (key) => window.sessionStorage.getItem(key),
        PROJECT_INVITATION_SESSION_KEY
      )
    ).toBeNull();
    if (fromPublicShare) {
      await page.getByTitle('Back to projects').click();
      await expect(
        page.locator('.start-tile-open', { hasText: publicDocument.name })
      ).toHaveCount(0);
      await expect(
        page.locator('.start-tile-open', { hasText: document.name })
      ).toBeVisible();
    }
  });
}

for (const stage of ['accept', 'document', 'public share'] as const) {
  test(`ignores a superseded invitation after delayed ${stage}`, async ({
    page
  }) => {
    await stubApi(page, { collaborationRole: 'viewer' });
    const oldDocument = createProjectDocument(
      'Old invitation',
      toUserId('owner')
    );
    const latest = createProjectDocument(
      'Latest destination',
      toUserId('owner')
    );
    const newerToken = 'n'.repeat(43);
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    let oldRequested = false;
    let newRequested = false;
    await page.route('**/api/project-invitations/accept', async (route) => {
      const payload = route.request().postDataJSON() as { token: string };
      const old = payload.token === invitationToken;
      if (old && stage === 'accept') {
        oldRequested = true;
        await oldGate;
      }
      if (!old) {
        newRequested = true;
        await newGate;
      }
      await route.fulfill({
        json: {
          projectId: (old ? oldDocument : latest).projectId,
          role: 'viewer'
        }
      });
    });
    await page.route(
      `**/api/projects/${oldDocument.projectId}`,
      async (route) => {
        if (stage !== 'accept') {
          oldRequested = true;
          await oldGate;
        }
        await route.fulfill({ json: oldDocument });
      }
    );
    await page.route(`**/api/projects/${latest.projectId}`, (route) =>
      route.fulfill({ json: latest })
    );
    await page.route('**/api/share/*', (route) =>
      route.fulfill({
        json: {
          document: latest,
          project: { name: latest.name },
          mode: 'tweak'
        }
      })
    );
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
    await page.evaluate((token) => {
      window.location.hash = `invite=${token}`;
    }, invitationToken);
    await expect.poll(() => oldRequested).toBe(true);
    await page.evaluate(
      ({ stage, token }) => {
        window.location.hash = `${stage === 'public share' ? 'share' : 'invite'}=${token}`;
      },
      { stage, token: newerToken }
    );
    if (stage === 'public share') {
      await expect(page.locator('.breadcrumb')).toContainText(latest.name);
    } else {
      await expect.poll(() => newRequested).toBe(true);
    }
    const oldResponse = page.waitForResponse((r) =>
      stage === 'accept'
        ? r.url().endsWith('/api/project-invitations/accept') &&
          (r.request().postDataJSON() as { token: string }).token ===
            invitationToken
        : r.url().endsWith(`/api/projects/${oldDocument.projectId}`)
    );
    releaseOld();
    await oldResponse;
    await page.waitForTimeout(250);
    if (stage !== 'public share') {
      expect(
        await page.evaluate(
          (key) => sessionStorage.getItem(key),
          PROJECT_INVITATION_SESSION_KEY
        )
      ).toBe(newerToken);
      await expect(
        page.getByRole('dialog', { name: 'Settings' })
      ).toBeVisible();
      releaseNew();
    }
    await expect(page.locator('.breadcrumb')).toContainText(latest.name);
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByText(oldDocument.name, { exact: true })).toHaveCount(
      0
    );
    expect(
      await page.evaluate(
        (key) => sessionStorage.getItem(key),
        PROJECT_INVITATION_SESSION_KEY
      )
    ).toBeNull();
  });
}

for (const stage of ['accept', 'document'] as const) {
  test(`preserves an identical invitation while its ${stage} request is pending`, async ({
    page
  }) => {
    await stubApi(page, { collaborationRole: 'viewer' });
    const document = createProjectDocument(
      'Repeated invitation',
      toUserId('owner')
    );
    let calls = 0;
    let pending = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/project-invitations/accept', async (route) => {
      calls++;
      if (stage === 'accept' && calls === 1) {
        pending = true;
        await gate;
      }
      await route.fulfill({
        json: { projectId: document.projectId, role: 'viewer' }
      });
    });
    await page.route(`**/api/projects/${document.projectId}`, async (route) => {
      if (stage === 'document') {
        pending = true;
        await gate;
      }
      await route.fulfill({ json: document });
    });
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
    await page.evaluate((token) => {
      window.location.hash = `invite=${token}`;
    }, invitationToken);
    await expect.poll(() => pending).toBe(true);
    await page.evaluate((token) => {
      window.location.hash = `invite=${token}`;
    }, invitationToken);
    await page.waitForTimeout(250);
    expect(calls).toBe(1);
    release();
    await expect(page.locator('.breadcrumb')).toContainText(document.name);
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await page.evaluate((token) => {
      window.location.hash = `invite=${token}`;
    }, invitationToken);
    await expect.poll(() => calls).toBe(2);
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  });
}

for (const stage of ['accept', 'document', 'public share'] as const) {
  test(`dismisses an invitation during ${stage} without blocking the current workspace`, async ({
    page
  }) => {
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
    const invited = createProjectDocument(
      'Dismissed invitation',
      toUserId('other_owner')
    );
    const shared = createProjectDocument(
      'Retained public workspace',
      toUserId('other_owner')
    );
    let release!: () => void;
    let pending = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/project-invitations/accept', async (route) => {
      if (stage !== 'document') {
        pending = true;
        await gate;
      }
      await route.fulfill({
        json: { projectId: invited.projectId, role: 'viewer' }
      });
    });
    await page.route(`**/api/projects/${invited.projectId}`, async (route) => {
      if (stage === 'document') {
        pending = true;
        await gate;
      }
      await route.fulfill({ json: invited });
    });
    await page.route('**/api/share/*', (route) =>
      route.fulfill({
        json: {
          document: shared,
          project: { name: shared.name },
          mode: 'tweak'
        }
      })
    );
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
    if (stage === 'public share') {
      await page.evaluate(() => {
        window.location.hash = `share=${'p'.repeat(43)}`;
      });
      await expect(
        page.getByRole('button', { name: 'Make a copy', exact: true })
      ).toBeVisible();
    } else {
      await page.getByLabel('Project name').fill('Workspace retained');
      await page.getByRole('button', { name: 'Create project' }).click();
      await expect(
        page.getByRole('button', { name: 'Rename project' })
      ).toBeVisible();
    }
    await page.evaluate((token) => {
      window.location.hash = `invite=${token}`;
    }, invitationToken);
    await expect.poll(() => pending).toBe(true);
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    if (stage === 'public share') {
      await expect(
        page.getByRole('button', { name: 'Make a copy', exact: true })
      ).toBeEnabled();
      expect(new URL(page.url()).hash).toBe(`#share=${'p'.repeat(43)}`);
    } else {
      await page.getByRole('button', { name: 'Rename project' }).click();
      await page.getByLabel('Project name').fill('Edits after dismissal');
      await page.getByLabel('Project name').press('Enter');
    }
    const response = page.waitForResponse((r) =>
      stage === 'document'
        ? r.url().endsWith(`/api/projects/${invited.projectId}`)
        : r.url().endsWith('/api/project-invitations/accept')
    );
    release();
    await response;
    await page.waitForTimeout(250);
    await expect(page.locator('.breadcrumb')).toContainText(
      stage === 'public share' ? shared.name : 'Edits after dismissal'
    );
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    expect(
      await page.evaluate(
        (key) => sessionStorage.getItem(key),
        PROJECT_INVITATION_SESSION_KEY
      )
    ).toBeNull();
  });
}

test('retries the same invitation after a failed acceptance', async ({
  page
}) => {
  await stubApi(page, { collaborationRole: 'viewer' });
  const document = createProjectDocument(
    'Retried invitation',
    toUserId('owner')
  );
  let calls = 0;
  await page.route('**/api/project-invitations/accept', (route) => {
    calls++;
    return calls === 1
      ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      : route.fulfill({
          json: { projectId: document.projectId, role: 'viewer' }
        });
  });
  await page.route(`**/api/projects/${document.projectId}`, (route) =>
    route.fulfill({ json: document })
  );
  await page.goto(`/#invite=${invitationToken}`);
  await expect(
    page.getByText(/This invitation could not be accepted/)
  ).toBeVisible();
  await page.evaluate((token) => {
    window.location.hash = `invite=${token}`;
  }, invitationToken);
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator('.breadcrumb')).toContainText(document.name);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
});

test('allows signed-out invitation sign-in while a superseded share request is pending', async ({
  page
}) => {
  await stubEmailLoginApi(page);
  await page.route('**/api/collaboration/config', (route) =>
    route.fulfill({
      json: {
        sharingEnabled: true,
        editLeasesEnforced: true,
        personalSyncEnabled: false,
        canary: false
      }
    })
  );
  const document = createProjectDocument(
    'Pending public share',
    toUserId('owner')
  );
  let release!: () => void;
  let requested = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/share/*', async (route) => {
    requested = true;
    await gate;
    await route.fulfill({
      json: { document, project: { name: document.name }, mode: 'tweak' }
    });
  });
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = `share=${'p'.repeat(43)}`;
  });
  await expect.poll(() => requested).toBe(true);
  await page.evaluate((token) => {
    window.location.hash = `invite=${token}`;
  }, invitationToken);
  await page.getByLabel('Email address').fill('maker@example.com');
  await expect(
    page.getByRole('button', { name: 'Email me a code' })
  ).toBeEnabled();
  const response = page.waitForResponse(/\/api\/share\//);
  release();
  await response;
  await page.waitForTimeout(250);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Email me a code' })
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Create project', exact: true })
  ).toBeEnabled();
});

test('opens a public link instead of resuming an older retained invitation', async ({
  page
}) => {
  await stubApi(page, { collaborationRole: 'viewer' });
  await page.addInitScript(
    ({ key, token }) => sessionStorage.setItem(key, token),
    { key: PROJECT_INVITATION_SESSION_KEY, token: invitationToken }
  );
  const document = createProjectDocument(
    'Explicit public destination',
    toUserId('owner')
  );
  let acceptCalls = 0;
  await page.route('**/api/project-invitations/accept', (route) => {
    acceptCalls++;
    return route.fulfill({ status: 410, json: { error: 'Expired' } });
  });
  await page.route('**/api/share/*', (route) =>
    route.fulfill({
      json: { document, project: { name: document.name }, mode: 'tweak' }
    })
  );
  await page.goto(`/#share=${'p'.repeat(43)}`);
  await expect(page.locator('.breadcrumb')).toContainText(document.name);
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toBeVisible();
  expect(acceptCalls).toBe(0);
  expect(
    await page.evaluate(
      (key) => sessionStorage.getItem(key),
      PROJECT_INVITATION_SESSION_KEY
    )
  ).toBeNull();
});

test('opens and switches public links in an already-open Settings tab', async ({
  page
}) => {
  await stubAnonymousApi(page);
  const first = createProjectDocument('First shared model', toUserId('owner'));
  const second = createProjectDocument(
    'Second shared model',
    toUserId('owner')
  );
  const tokens = ['a'.repeat(43), 'b'.repeat(43)];
  await page.route('**/api/share/*', (route) => {
    const index = tokens.indexOf(route.request().url().split('/').at(-1)!);
    const document = [first, second][index]!;
    return route.fulfill({
      json: {
        document,
        mode: 'tweak',
        project: {
          projectId: document.projectId,
          name: document.name,
          documentVersion: document.version,
          revisionCount: 1,
          updatedAt: document.derived.updatedAt
        }
      }
    });
  });
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.evaluate((token) => {
    window.location.hash = `share=${token}`;
  }, tokens[0]);
  await expect(page.locator('.breadcrumb')).toContainText(first.name);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect(
    page
      .getByRole('group', { name: 'Workspace mode' })
      .getByRole('button', { name: 'Build' })
  ).toBeDisabled();
  await page.evaluate((token) => {
    window.location.hash = `share=${token}`;
  }, tokens[1]);
  await expect(page.locator('.breadcrumb')).toContainText(second.name);
});

for (const active of [false, true]) {
  test(`cleans up an invalid invitation during ${active ? 'an active' : 'a pending'} share`, async ({
    page
  }) => {
    await stubAnonymousApi(page);
    const document = createProjectDocument(
      'Invalid invitation source',
      toUserId('owner')
    );
    let release!: () => void;
    let requested = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/share/*', async (route) => {
      requested = true;
      await gate;
      await route.fulfill({
        json: { document, project: { name: document.name }, mode: 'tweak' }
      });
    });
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
    await page.evaluate(() => {
      window.location.hash = `share=${'c'.repeat(43)}`;
    });
    await expect.poll(() => requested).toBe(true);
    if (active) {
      release();
      await expect(
        page.getByRole('button', { name: 'Make a copy', exact: true })
      ).toBeVisible();
    }
    await page.evaluate(
      ({ key, token }) => {
        sessionStorage.setItem(key, token);
        window.location.hash = 'invite=truncated';
      },
      { key: PROJECT_INVITATION_SESSION_KEY, token: invitationToken }
    );
    if (!active) {
      const response = page.waitForResponse(/\/api\/share\//);
      release();
      await response;
      await page.waitForTimeout(250);
    }
    await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create project', exact: true })
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Make a copy', exact: true })
    ).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('');
    expect(
      await page.evaluate(
        (key) => sessionStorage.getItem(key),
        PROJECT_INVITATION_SESSION_KEY
      )
    ).toBeNull();
  });
}

for (const status of [404, 503]) {
  test(`restores the active model URL when a replacement share returns ${status}`, async ({
    page
  }) => {
    await stubAnonymousApi(page);
    const document = createProjectDocument(
      'Retained shared model',
      toUserId('owner')
    );
    await page.route('**/api/share/*', (route) =>
      route.request().url().endsWith('a'.repeat(43))
        ? route.fulfill({
            json: { document, project: { name: document.name }, mode: 'tweak' }
          })
        : route.fulfill({ status, json: { error: 'Replacement unavailable.' } })
    );
    await page.goto(`/#share=${'a'.repeat(43)}`);
    await expect(
      page.getByRole('button', { name: 'Make a copy', exact: true })
    ).toBeVisible();
    await page.evaluate(() => {
      window.location.hash = `share=${'b'.repeat(43)}`;
    });
    await expect(page.getByRole('contentinfo')).toContainText(
      status === 404
        ? 'This share link is no longer available'
        : 'Replacement unavailable.'
    );
    expect(new URL(page.url()).hash).toBe(`#share=${'a'.repeat(43)}`);
    await expect(page.locator('.breadcrumb')).toContainText(document.name);
    await expect(
      page.getByRole('button', { name: 'Make a copy', exact: true })
    ).toBeEnabled();
    await page.reload();
    await expect(page.locator('.breadcrumb')).toContainText(document.name);
  });
}

for (const status of [404, 503]) {
  test(`clears a failed share URL when opening a normal project after ${status}`, async ({
    page
  }) => {
    await stubAnonymousApi(page);
    await page.goto('/');
    await page
      .getByLabel('Project name')
      .fill('Local project after failed link');
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toBeVisible();
    await page.getByTitle('Back to projects').click();
    await expect(page.getByRole('tab', { name: 'Parts 1' })).toBeVisible();
    let shareReads = 0;
    await page.route('**/api/share/*', (route) => {
      shareReads += 1;
      return route.fulfill({ status, json: { error: 'Unavailable share' } });
    });
    await page.evaluate(() => {
      window.location.hash = `share=${'f'.repeat(43)}`;
    });
    await expect(
      page.getByRole('status').filter({
        hasText:
          status === 404
            ? 'This share link is no longer available'
            : 'Unavailable share'
      })
    ).toBeVisible();
    await page
      .locator('.start-tile-open', {
        hasText: 'Local project after failed link'
      })
      .click();
    await expect(page.locator('.breadcrumb')).toContainText(
      'Local project after failed link'
    );
    expect(new URL(page.url()).hash).toBe('');
    expect(shareReads).toBe(1);
    await page.reload();
    await expect(page.locator('.breadcrumb')).toContainText(
      'Local project after failed link'
    );
    await expect(
      page.getByRole('button', { name: /^Box \(B\)/ })
    ).toBeEnabled();
    expect(new URL(page.url()).hash).toBe('');
    expect(shareReads).toBe(1);
  });
}

for (const action of ['create', 'demo', 'import'] as const) {
  for (const pending of [true, false]) {
    test(`abandons ${pending ? 'a pending' : 'a failed'} share when the shelf opens ${action}`, async ({
      page
    }) => {
      await stubAnonymousApi(page);
      const document = createProjectDocument(
        'Abandoned share',
        toUserId('owner')
      );
      let release!: () => void;
      let requested = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/share/*', async (route) => {
        requested = true;
        if (pending) await gate;
        await route.fulfill(
          pending
            ? {
                json: {
                  document,
                  project: { name: document.name },
                  mode: 'tweak'
                }
              }
            : { status: 404, json: { error: 'Unavailable' } }
        );
      });
      await page.goto('/');
      await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
      await page.evaluate(() => {
        window.location.hash = `share=${'f'.repeat(43)}`;
      });
      await expect.poll(() => requested).toBe(true);
      if (!pending)
        await expect(
          page
            .getByRole('status')
            .filter({ hasText: 'This share link is no longer available' })
        ).toBeVisible();
      try {
        if (action === 'create') {
          await page.getByLabel('Project name').fill('New shelf project');
          await page
            .getByRole('button', { name: 'Create project', exact: true })
            .click();
        } else if (action === 'demo') {
          await page
            .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
            .click();
        } else {
          await page.getByLabel('Import project backup').setInputFiles({
            name: 'shelf.openzcad',
            mimeType: 'application/json',
            buffer: Buffer.from(
              JSON.stringify({
                format: 'openzcad-project',
                version: 1,
                document: createProjectDocument(
                  'Imported shelf project',
                  toUserId('local')
                ),
                files: []
              })
            )
          });
        }
        const name =
          action === 'create'
            ? 'New shelf project'
            : action === 'demo'
              ? 'Mounting Bracket'
              : 'Imported shelf project';
        await expect(page.locator('.breadcrumb')).toContainText(name);
        expect(new URL(page.url()).hash).toBe('');
        if (pending) {
          const response = page.waitForResponse(/\/api\/share\//);
          release();
          await response;
          await page.waitForTimeout(250);
        }
        await expect(page.locator('.breadcrumb')).toContainText(name);
        await expect(
          page.getByRole('button', { name: 'Make a copy', exact: true })
        ).toHaveCount(0);
        await expect(
          page
            .getByRole('group', { name: 'Workspace mode' })
            .getByRole('button', { name: 'Build', exact: true })
        ).toBeEnabled();
      } finally {
        release();
      }
    });
  }
}

test('keeps revoked-link guidance visible after delayed startup completes', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.route('**/api/share/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Unavailable' } })
  );
  await page.route('**/api/session', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ status: 401, json: { error: 'Signed out' } });
  });
  await page.goto(`/#share=${'a'.repeat(43)}`);
  await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'This share link is no longer available' })
  ).toBeVisible();
  // Status lifetime must not erase the explanation before the user reads it.
  await page.waitForTimeout(6500);
  await expect(
    page.getByText(
      'This share link is no longer available. It may have been revoked.'
    )
  ).toBeVisible();
});

test('cancels a pending share on Back and leaves an active share when its fragment is removed', async ({
  page
}) => {
  await stubAnonymousApi(page);
  const document = createProjectDocument('Cancelled share', toUserId('owner'));
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delay = true;
  let requested = false;
  await page.route('**/api/share/*', async (route) => {
    requested = true;
    if (delay) await delayed;
    await route.fulfill({
      json: { document, project: { name: document.name }, mode: 'tweak' }
    });
  });
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = `share=${'c'.repeat(43)}`;
  });
  await expect.poll(() => requested).toBe(true);
  await page.goBack();
  const response = page.waitForResponse(/\/api\/share\//);
  release();
  await response;
  // Let the old loader process its delayed response before checking that it
  // cannot replace the library after navigation has cancelled it.
  await page.waitForTimeout(250);
  await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Create project', exact: true })
  ).toBeEnabled();
  delay = false;
  await page.evaluate(() => {
    window.location.hash = `share=${'c'.repeat(43)}`;
  });
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '';
  });
  await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toHaveCount(0);
});

for (const departure of ['fragment', 'home'] as const) {
  test(`keeps a newer share open when an earlier ${departure} departure finishes later`, async ({
    page
  }) => {
    await stubApi(page);
    const documents = [
      createProjectDocument('First departure share', toUserId('owner')),
      createProjectDocument('Latest navigation share', toUserId('owner'))
    ];
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blockListing = false;
    let listingRequested = false;
    await page.route('**/api/projects', async (route) => {
      if (blockListing) {
        listingRequested = true;
        await delayed;
      }
      await route.fulfill({ json: { projects: [] } });
    });
    await page.route('**/api/share/*', (route) => {
      const document =
        documents[route.request().url().endsWith('a'.repeat(43)) ? 0 : 1]!;
      return route.fulfill({
        json: { document, project: { name: document.name }, mode: 'tweak' }
      });
    });
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Parts 0' })).toBeVisible();
    await page.evaluate(() => {
      window.location.hash = `share=${'a'.repeat(43)}`;
    });
    await expect(page.locator('.breadcrumb')).toContainText(documents[0]!.name);
    blockListing = true;
    if (departure === 'home') await page.getByTitle('Back to projects').click();
    else
      await page.evaluate(() => {
        window.location.hash = '';
      });
    await expect.poll(() => listingRequested).toBe(true);
    await page.evaluate(() => {
      window.location.hash = `share=${'b'.repeat(43)}`;
    });
    await expect(page.locator('.breadcrumb')).toContainText(documents[1]!.name);
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/projects'
    );
    release();
    await response;
    await page.waitForTimeout(250);
    await expect(page.locator('.breadcrumb')).toContainText(documents[1]!.name);
    await expect(page.getByRole('contentinfo')).toContainText(
      `Opened shared model ${documents[1]!.name}`
    );
    expect(new URL(page.url()).hash).toBe(`#share=${'b'.repeat(43)}`);
  });
}

test('makes a durable share copy without storing the owner snapshot', async ({
  page
}) => {
  await stubAnonymousApi(page);
  const document = createProjectDocument('Anonymous source', toUserId('owner'));
  await page.route('**/api/share/*', (route) =>
    route.fulfill({
      json: { document, project: { name: document.name }, mode: 'tweak' }
    })
  );
  await page.goto(`/#share=${'p'.repeat(43)}`);
  await page.getByRole('button', { name: 'Make a copy', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Anonymous source');
  await expect(
    page
      .getByRole('group', { name: 'Workspace mode' })
      .getByRole('button', { name: 'Build' })
  ).toBeEnabled();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByTitle('Back to projects').click();
  await expect(page.getByRole('tab', { name: 'Parts 1' })).toBeVisible();
  const ids = await page.evaluate(
    () =>
      new Promise<IDBValidKey[]>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () =>
          reject(new Error('Unable to inspect stored projects'));
        open.onsuccess = () => {
          const db = open.result;
          const read = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAllKeys();
          read.onsuccess = () => {
            resolve(read.result);
            db.close();
          };
          read.onerror = () => {
            reject(new Error('Unable to inspect stored projects'));
            db.close();
          };
        };
      })
  );
  expect(ids).toHaveLength(1);
  expect(ids).not.toContain(document.projectId);
});

test('saves incoming member updates through the room without refused account writes', async ({
  page
}) => {
  const document = createProjectDocument(
    'Member model',
    toUserId('other_owner')
  );
  const summary = {
    projectId: document.projectId,
    name: document.name,
    revisionCount: 1,
    documentVersion: document.version,
    updatedAt: document.derived.updatedAt
  };
  await stubApi(page, { collaborationRole: 'viewer' });
  await page.route('**/api/projects', (route) =>
    route.fulfill({
      json:
        route.request().method() === 'POST'
          ? { project: summary, document }
          : { projects: [summary] }
    })
  );
  let accountWrites = 0;
  await page.route(
    `**/api/projects/${document.projectId}/document`,
    (route) => {
      accountWrites += 1;
      return route.fulfill({
        status: 404,
        json: { error: 'Lease checked room required' }
      });
    }
  );
  await page.addInitScript(() => {
    const browser = window as unknown as { __memberSocket: WebSocket };
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        browser.__memberSocket = this;
      }
    };
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('button', { name: /Open project sharing/ })
  ).toContainText('Read-only');
  const incoming = {
    ...document,
    name: 'Updated member model',
    version: document.version + 1
  };
  await page.evaluate(
    ({ document, incoming }) => {
      const socket = (window as unknown as { __memberSocket: WebSocket })
        .__memberSocket;
      for (const frame of [
        { type: 'state', members: [], document, role: 'viewer', lease: null },
        { type: 'document', clientId: 'owner', document: incoming }
      ])
        socket.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify(frame) })
        );
    },
    { document, incoming }
  );
  await expect(page.locator('.breadcrumb')).toContainText(incoming.name);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  await page.waitForTimeout(4500);
  expect(accountWrites).toBe(0);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  // Opening this same cached project by a public link must stay session-local,
  // even though the account listing still contains its member project ID.
  for (const frame of [
    { type: 'error', code: 'document-too-large', message: 'Room size limit' },
    { type: 'error', code: 'permission-denied', message: 'Room write refused' },
    {
      type: 'document',
      clientId: 'newer-client',
      document: {
        ...incoming,
        schemaVersion: incoming.schemaVersion + 1,
        version: incoming.version + 1
      }
    }
  ]) {
    await page.evaluate((message) => {
      const socket = (window as unknown as { __memberSocket: WebSocket })
        .__memberSocket;
      socket.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify(message) })
      );
    }, frame);
    await expect(
      page.getByRole('status', { name: 'Local only', exact: true })
    ).toBeVisible();
    await expect(page.locator('.save-state.is-syncing')).toHaveCount(0);
  }
  await page.route('**/api/share/*', (route) =>
    route.fulfill({
      json: { document: incoming, project: summary, mode: 'tweak' }
    })
  );
  await page.evaluate(() => {
    window.location.hash = `share=${'p'.repeat(43)}`;
  });
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('status', { name: 'Local only', exact: true })
  ).toBeVisible();
  expect(accountWrites).toBe(0);
});

test('publishes editor checkpoints through the room without an account revision request', async ({
  page
}) => {
  const document = createProjectDocument(
    'Editor checkpoint',
    toUserId('other_owner')
  );
  const summary = {
    projectId: document.projectId,
    name: document.name,
    revisionCount: 1,
    documentVersion: document.version,
    updatedAt: document.derived.updatedAt
  };
  await stubApi(page, { collaborationRole: 'editor' });
  await page.route('**/api/projects', (route) =>
    route.fulfill({
      json:
        route.request().method() === 'POST'
          ? { project: summary, document }
          : { projects: [summary] }
    })
  );
  let accountWrites = 0;
  await page.route(
    `**/api/projects/${document.projectId}/document`,
    (route) => {
      accountWrites++;
      return route.fulfill({ status: 404, json: { error: 'Room required' } });
    }
  );
  await page.route(
    `**/api/projects/${document.projectId}/revisions`,
    (route) => {
      if (route.request().method() === 'POST') accountWrites++;
      return route.fulfill({ json: { revisions: [] } });
    }
  );
  await page.addInitScript(() => {
    const browser = window as unknown as {
      __checkpointSocket: WebSocket;
      __checkpointDocuments: unknown[];
    };
    browser.__checkpointDocuments = [];
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        browser.__checkpointSocket = this;
      }
      override send(raw: Parameters<WebSocket['send']>[0]) {
        super.send(raw);
        if (typeof raw !== 'string') return;
        const message = JSON.parse(raw) as {
          type?: string;
          document?: { version: number };
        };
        if (message.type !== 'document' || !message.document) return;
        const submitted = message.document;
        browser.__checkpointDocuments.push(submitted);
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'ack',
                version: submitted.version
              })
            })
          )
        );
      }
    };
  });
  await page.route(
    `**/api/projects/${document.projectId}/collaboration`,
    async (route) => {
      const input = route.request().postDataJSON() as {
        document: ProjectDocument;
        checkpointReason: string;
      };
      const saved = createCheckpoint(
        appendRevision(input.document, input.checkpointReason),
        input.checkpointReason
      );
      await page.evaluate((saved) => {
        (
          window as unknown as { __checkpointDocuments: ProjectDocument[] }
        ).__checkpointDocuments.push(saved);
      }, saved);
      return route.fulfill({
        json: { type: 'ack', version: saved.version, document: saved }
      });
    }
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page.locator('.breadcrumb')).toContainText(document.name);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { __checkpointSocket?: WebSocket })
            .__checkpointSocket
        )
      )
    )
    .toBe(true);
  await page.evaluate((document) => {
    const socket = (window as unknown as { __checkpointSocket: WebSocket })
      .__checkpointSocket;
    for (const frame of [
      { type: 'state', members: [], document, role: 'editor' },
      {
        type: 'lease-granted',
        lease: {
          projectId: document.projectId,
          leaseId: 'checkpoint_lease',
          expiresAt: Date.now() + 600000
        }
      }
    ])
      socket.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify(frame) })
      );
  }, document);
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __checkpointDocuments: { checkpoints: { reason: string }[] }[];
          }
        ).__checkpointDocuments.some(
          (d) => d.checkpoints.at(-1)?.reason === 'Manual save'
        )
      )
    )
    .toBe(true);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  expect(accountWrites).toBe(0);
  const sent = await page.evaluate(() =>
    (
      window as unknown as {
        __checkpointDocuments: {
          version: number;
          checkpoints: { reason: string; documentVersion: number }[];
        }[];
      }
    ).__checkpointDocuments.at(-1)!
  );
  expect(sent.version).toBeGreaterThan(document.version);
  expect(sent.checkpoints.at(-1)?.documentVersion).toBe(sent.version);
  await page.reload();
  await expect(
    page.locator('.revision-row', { hasText: 'Manual save' })
  ).toBeVisible();
  expect(accountWrites).toBe(0);
});

test('focuses signed-out invitation links on email sign-in and resumes them', async ({
  page
}) => {
  const document = createProjectDocument(
    'Signed-out Invitation Part',
    toUserId('user_invitation_owner')
  );
  let accepted = false;
  await stubEmailLoginApi(page);
  await page.route('**/api/collaboration/config', (route) =>
    route.fulfill({
      json: {
        sharingEnabled: true,
        editLeasesEnforced: true,
        personalSyncEnabled: false,
        canary: false
      }
    })
  );
  await page.route('**/api/project-invitations/accept', (route) => {
    expect(route.request().postDataJSON()).toEqual({ token: invitationToken });
    accepted = true;
    return route.fulfill({
      json: { projectId: document.projectId, role: 'viewer' }
    });
  });
  await page.route('**/api/projects', (route) =>
    route.fulfill({
      json: {
        projects: accepted
          ? [
              {
                projectId: document.projectId,
                name: document.name,
                revisionCount: 0,
                documentVersion: document.version,
                updatedAt: document.derived.updatedAt
              }
            ]
          : []
      }
    })
  );
  await page.route(`**/api/projects/${document.projectId}`, (route) =>
    route.fulfill({ json: document })
  );

  await page.goto(`/#invite=${invitationToken}`);

  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText(/Project invitation ready/)).toBeVisible();
  await expect(page.getByText('Email sign-in', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.location.hash)).toBe('');
  await page.getByLabel('Email address').fill('maker@example.com');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel('Email sign-in code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toHaveCount(0);
  await expect(page.locator('.breadcrumb')).toContainText(document.name);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  expect(
    await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      PROJECT_INVITATION_SESSION_KEY
    )
  ).toBeNull();
});

test('keeps a shared-project viewer visibly read-only', async ({ page }) => {
  await stubApi(page, { collaborationRole: 'viewer' });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Viewer Role Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const sharingButton = page.getByRole('button', {
    name: 'Open project sharing'
  });
  await expect(sharingButton).toContainText('Read-only');
  // A viewer is held in View mode — `viewMode` is true whenever there is a
  // buildModeDisabledReason, and being a viewer is one — so the whole Feature
  // tools rail is gone rather than present-but-disabled. This assertion used
  // to look for a disabled Box button, which stopped being reachable when View
  // mode landed; the lock it was checking is now one rung further out.
  const workspaceMode = page.getByRole('group', { name: 'Workspace mode' });
  await expect(
    workspaceMode.getByRole('button', { name: 'Build' })
  ).toBeDisabled();
  await expect(
    workspaceMode.getByRole('button', { name: 'View' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('navigation', { name: 'Feature tools' })
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toHaveCount(0);
  await expect(page.getByLabel('Project name')).toHaveCount(0);

  // The parameter field this used to type into is gone with the rest of the
  // build UI, so exercise the guard the hidden UI is backed by: a keyboard
  // shortcut is refused at the same choke point, and it names the reason a
  // viewer can act on rather than telling them to switch to a Build mode
  // their role will never offer.
  await page.keyboard.press('b');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cannot use Box: This shared project is read-only.'
  );
  await expect(page.locator('.feature-row')).toHaveCount(0);

  // Asking for Build outright says the same thing.
  await page.keyboard.press('Meta+Shift+m');
  await expect(page.getByRole('contentinfo')).toContainText(
    'This shared project is read-only'
  );
  await expect(
    workspaceMode.getByRole('button', { name: 'View' })
  ).toHaveAttribute('aria-pressed', 'true');

  await sharingButton.click();
  const dialog = page.getByRole('dialog', { name: 'Project sharing' });
  await expect(dialog).toContainText('you are a viewer');
  await expect(dialog).toContainText(
    'Only the project owner can manage members and invitations.'
  );
});

test('lets the project owner rename from View mode', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Owner View Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const workspaceMode = page.getByRole('group', { name: 'Workspace mode' });
  await workspaceMode.getByRole('button', { name: 'View' }).click();
  await expect(
    workspaceMode.getByRole('button', { name: 'View' })
  ).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Rename project' }).click();
  await page.getByLabel('Project name').fill('Renamed from View');
  await page.getByLabel('Project name').press('Enter');

  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Renamed from View');
  await expect(
    workspaceMode.getByRole('button', { name: 'View' })
  ).toHaveAttribute('aria-pressed', 'true');
});

test('uses a one-use native ticket for desktop collaboration without exposing a bearer', async ({
  page
}) => {
  const document = createProjectDocument(
    'Desktop Ticket Part',
    toUserId('user_e2e')
  );
  const ticket = 'e'.repeat(43);
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  await stubApi(page, { collaborationRole: 'owner' });
  await page.addInitScript(
    ({ document, settings, ticket }) => {
      const browserWindow = window as typeof window & {
        __TAURI_INTERNALS__: {
          invoke(
            command: string,
            args?: Record<string, unknown>
          ): Promise<unknown>;
          transformCallback(
            callback?: (...args: unknown[]) => unknown,
            once?: boolean
          ): number;
          unregisterCallback(id: number): void;
        };
        __desktopInvocations: Array<{
          command: string;
          args?: Record<string, unknown>;
        }>;
        __desktopSocketUrls: string[];
      };
      browserWindow.__desktopInvocations = [];
      browserWindow.__desktopSocketUrls = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          browserWindow.__desktopSocketUrls.push(String(url));
        }
      };

      const jsonResponse = (value: unknown, status = 200) => ({
        status,
        contentType: 'application/json',
        body: Array.from(new TextEncoder().encode(JSON.stringify(value)))
      });
      let callbackId = 0;
      browserWindow.__TAURI_INTERNALS__ = {
        async invoke(command, args) {
          browserWindow.__desktopInvocations.push({ command, args });
          if (command === 'desktop_collaboration_url') {
            return `wss://zcad.app/api/projects/${String(document.projectId)}/collaboration?ticket=${ticket}`;
          }
          if (command !== 'desktop_api_request') {
            return 1;
          }
          const request = (args?.request ?? {}) as {
            method?: string;
            path?: string;
          };
          if (request.path === '/api/health') {
            return jsonResponse({
              status: 'ok',
              environment: 'beta',
              time: new Date().toISOString(),
              projectSharingEnabled: true,
              projectEditLeasesEnforced: true,
              projectPersonalSyncEnabled: false
            });
          }
          if (request.path === '/api/auth/config') {
            return jsonResponse({
              mode: 'email-code',
              emailCodeEnabled: true,
              desktopAuthEnabled: true
            });
          }
          if (request.path === '/api/session') {
            return jsonResponse({
              userId: 'user_e2e',
              displayName: 'E2E user',
              email: 'e2e@example.com',
              mode: 'email-code'
            });
          }
          if (request.path === '/api/collaboration/config') {
            return jsonResponse({
              sharingEnabled: true,
              editLeasesEnforced: true,
              personalSyncEnabled: false,
              canary: true
            });
          }
          if (request.path === '/api/settings') {
            return jsonResponse({
              settings,
              revision: 1,
              synced: true,
              credential: { stored: false, storageAvailable: false },
              effectiveAssistant: {
                configured: false,
                source: 'deployment',
                provider: 'openrouter',
                model: 'openai/gpt-5.6-sol',
                reasoningEffort: 'high'
              }
            });
          }
          if (request.path === '/api/projects' && request.method === 'POST') {
            return jsonResponse(
              {
                project: {
                  projectId: document.projectId,
                  name: document.name,
                  revisionCount: 0,
                  documentVersion: document.version,
                  updatedAt: document.derived.updatedAt
                },
                document
              },
              201
            );
          }
          if (request.path === '/api/projects') {
            return jsonResponse({ projects: [] });
          }
          if (request.path?.endsWith('/document')) {
            return jsonResponse({
              projectId: document.projectId,
              version: document.version,
              updatedAt: new Date().toISOString()
            });
          }
          if (request.path === '/api/account/storage') {
            return jsonResponse({
              projectCount: 1,
              documentBytes: 0,
              revisionBytes: 0,
              revisionCount: 0,
              documentLimitBytes: 1_500_000,
              maxRevisionsPerProject: 50
            });
          }
          return jsonResponse({ error: 'Not found' }, 404);
        },
        transformCallback(callback, once = false) {
          callbackId += 1;
          const key = `_${callbackId}`;
          Object.defineProperty(window, key, {
            value: (...args: unknown[]) => {
              const result = callback?.(...args);
              if (once) {
                delete (window as unknown as Record<string, unknown>)[key];
              }
              return result;
            },
            configurable: true
          });
          return callbackId;
        },
        unregisterCallback(id) {
          delete (window as unknown as Record<string, unknown>)[`_${id}`];
        }
      };
    },
    { document, settings, ticket }
  );

  await page.goto('/');
  await page.getByLabel('Project name').fill('Desktop Ticket Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __desktopSocketUrls: string[] })
            .__desktopSocketUrls
      )
    )
    .toContain(
      `wss://zcad.app/api/projects/${document.projectId}/collaboration?ticket=${ticket}`
    );
  const invocations = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __desktopInvocations: Array<{
            command: string;
            args?: Record<string, unknown>;
          }>;
        }
      ).__desktopInvocations
  );
  expect(invocations).toContainEqual({
    command: 'desktop_collaboration_url',
    args: { projectId: document.projectId }
  });
  expect(JSON.stringify(invocations)).not.toContain('Bearer');
});

test('renders saved part geometry in the project thumbnail', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Thumbnail Box');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expect.poll(() => hasCachedProjectThumbnail(page)).toBe(true);

  await page.getByTitle('Back to projects').click();
  const projectCard = page.locator('.start-tile-project', {
    hasText: 'Thumbnail Box'
  });
  const thumbnail = projectCard.locator('.start-tile-thumb img');
  await expect(thumbnail).toBeVisible({ timeout: 15_000 });
  await expect(thumbnail).toHaveAttribute(
    'src',
    /^data:image\/(webp|png);base64,/
  );
  await expect(projectCard.getByText('No geometry')).toHaveCount(0);

  const nonBackgroundPixels = await thumbnail.evaluate(
    async (element: HTMLImageElement) => {
      await element.decode();
      const canvas = document.createElement('canvas');
      canvas.width = element.naturalWidth;
      canvas.height = element.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        return 0;
      }
      context.drawImage(element, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
      ).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const distanceFromBackground =
          Math.abs(pixels[index]! - 5) +
          Math.abs(pixels[index + 1]! - 8) +
          Math.abs(pixels[index + 2]! - 12);
        if (distanceFromBackground > 36) {
          count += 1;
        }
      }
      return count;
    }
  );
  expect(nonBackgroundPixels).toBeGreaterThan(500);
});

test('restores a remembered local project without flashing the launcher', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Boot Restore Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible({
    timeout: 15_000
  });

  await page.addInitScript(() => {
    const browserWindow = window as typeof window & {
      __openZcadBootStates: string[];
    };
    browserWindow.__openZcadBootStates = [];
    let previous = '';
    const capture = () => {
      const state = document.querySelector('.startup-screen')
        ? 'restoring'
        : document.querySelector('.start-screen')
          ? 'launcher'
          : document.querySelector('.app-shell')
            ? 'workspace'
            : 'shell';
      if (state !== previous) {
        browserWindow.__openZcadBootStates.push(state);
        previous = state;
      }
    };
    new MutationObserver(capture).observe(document, {
      childList: true,
      subtree: true
    });
  });
  await page.unroute('**/api/session');
  await page.route('**/api/session', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 401,
      json: { error: 'Authentication required.', code: 'AUTH_REQUIRED' }
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('status', { name: 'Restoring workspace' })
  ).toBeVisible();
  await page.waitForTimeout(200);
  await expect(page.locator('.start-screen')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.locator('.startup-screen')).toHaveCount(0);

  const bootStates = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __openZcadBootStates: string[];
        }
      ).__openZcadBootStates
  );
  expect(bootStates).toContain('restoring');
  expect(bootStates).not.toContain('launcher');
  expect(bootStates.at(-1)).toBe('workspace');
});

test('flushes the latest edit before returning to the project list', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Autosave Flush Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible({
    timeout: 15_000
  });

  await page.getByRole('button', { name: 'Rename project' }).click();
  await page.getByLabel('Project name').fill('Latest Autosave Name');
  await page.getByLabel('Project name').press('Enter');
  await page.getByTitle('Back to projects').click();

  const savedProject = page.locator('.start-tile-open', {
    hasText: 'Latest Autosave Name'
  });
  await expect(savedProject).toBeVisible();
  await savedProject.click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Latest Autosave Name');
});

test('leaves the restore screen when a remembered project is missing', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        activeProjectId: 'missing-project',
        views: {}
      })
    );
  }, WORKSPACE_SESSION_STORAGE_KEY);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('status', { name: 'Restoring workspace' })
  ).toBeVisible();
  await expect(page.getByLabel('Project name')).toBeVisible();
  await expect(page.locator('.startup-screen')).toHaveCount(0);
  await expect(page.locator('.start-account-text')).toHaveText(
    'On this device only'
  );
});

test('keeps anonymous CAD creation local without calling cloud projects', async ({
  page
}) => {
  await stubAnonymousApi(page);
  let cloudProjectRequests = 0;
  await page.route('**/api/projects', (route) => {
    cloudProjectRequests += 1;
    return route.fulfill({
      status: 500,
      json: { error: 'Cloud projects should not be called while signed out.' }
    });
  });
  await page.goto('/');
  await expect(page.locator('.start-account-text')).toHaveText(
    'On this device only'
  );
  await page.getByLabel('Project name').fill('Anonymous Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible({
    timeout: 15_000
  });
  // "Saving" until the local autosave debounce comes due and the IndexedDB
  // write lands, which on a loaded runner competing with the kernel's cold
  // start crosses the 5 s assertion default. Matching the readiness allowance
  // above waits for that write; it does not excuse one that never happens,
  // because a project that never reaches storage stays on "Saving" forever and
  // still fails here.
  await expect(page.getByRole('status', { name: 'Local only' })).toBeVisible({
    timeout: 15_000
  });
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).toContainText('syncLocal only');
  expect(cloudProjectRequests).toBe(0);
});

test('signs in with an email code only when cloud profile access is requested', async ({
  page
}) => {
  const emailApi = await stubEmailLoginApi(page);
  await page.addInitScript(() => {
    const browserWindow = window as typeof window & {
      __openZcadUnhandledRejections: number;
    };
    browserWindow.__openZcadUnhandledRejections = 0;
    window.addEventListener('unhandledrejection', () => {
      browserWindow.__openZcadUnhandledRejections += 1;
    });
  });
  await page.unroute('**/api/auth/email/verify');
  await page.route('**/api/auth/email/verify', (route) => {
    const payload = route.request().postDataJSON() as { code: string };
    return payload.code === '123456'
      ? route.fulfill({
          json: {
            userId: 'user_email_e2e',
            displayName: 'maker@example.com',
            email: 'maker@example.com',
            mode: 'email-code'
          }
        })
      : route.fulfill({
          status: 401,
          json: { error: 'That sign-in code is invalid.', code: 'AUTH_INVALID' }
        });
  });
  await page.goto('/');
  await expect(page.locator('.start-account-text')).toHaveText(
    'On this device only'
  );

  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByText('Email sign-in', { exact: true })).toBeVisible();
  await expect(page.getByText('Security check complete.')).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveAttribute(
    'type',
    'password'
  );
  await page.getByLabel('Email address').fill('maker@example.com');
  await expect(
    page.getByRole('button', { name: 'Email me a code' })
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Email me a code' }).click();

  await expect(page.getByText('Enter the email code')).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Settings' })
  ).not.toContainText('maker@example.com');
  await page.getByRole('button', { name: 'Show personal info' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText(
    'maker@example.com'
  );
  await page.getByRole('button', { name: 'Hide personal info' }).click();
  await page.getByLabel('Email sign-in code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.settings-save-message')).toContainText(
    'That sign-in code is invalid.'
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __openZcadUnhandledRejections: number;
            }
          ).__openZcadUnhandledRejections
      )
    )
    .toBe(0);

  await page.getByLabel('Email sign-in code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();

  const signOut = page.getByRole('button', { name: 'Sign out' });
  await expect(signOut).toBeVisible();
  await expect(
    page
      .locator('.setting-row', { has: signOut })
      .locator('.setting-title strong')
  ).toHaveText('Name hidden');
  await expect(page.locator('.settings-save-message')).not.toContainText(
    'maker@example.com'
  );
  // The fixture advertises an unsynced account copy, so sign-in first uploads
  // the device settings before the explicit preference change below.
  await expect.poll(emailApi.settingsUpdateCount).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Save to account' })
  ).toHaveCount(0);
  await expect(
    page.locator('.settings-topbar > :last-child')
  ).toHaveAccessibleName('Back to projects');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'Reopen the last project' })
    .uncheck();
  await expect(page.locator('.settings-save-message')).toContainText(
    'Saved to this device and cloud profile.'
  );
  await expect.poll(emailApi.settingsUpdateCount).toBe(2);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Email sign-in', { exact: true })).toBeVisible();
});

test('explains beta auth and Turnstile readiness failures', async ({
  page
}) => {
  await page.route('**/api/auth/config', (route) => route.abort('failed'));
  await page.route('**/api/session', (route) =>
    route.fulfill({
      status: 401,
      json: { error: 'Authentication required.', code: 'AUTH_REQUIRED' }
    })
  );
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        environment: 'beta',
        time: new Date().toISOString()
      }
    })
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Beta sign-in configuration could not be reached'
    })
  ).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(page.locator('.settings-save-message')).toContainText(
    'Beta sign-in unavailable'
  );

  await page.unrouteAll({ behavior: 'wait' });
  await stubTurnstileLoadFailureApi(page);
  await page.reload();
  // Settings now restores its open state across a reload, so this auth failure
  // stays in the same dialog instead of returning to the workspace first.
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Security check could not load'
    })
  ).toBeVisible();
  await page.getByLabel('Email address').fill('maker@example.com');
  await expect(
    page.getByRole('button', { name: 'Email me a code' })
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Security check complete.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Email me a code' })
  ).toBeEnabled();
});
