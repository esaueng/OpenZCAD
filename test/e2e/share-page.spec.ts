import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { ENCRYPTED_INVITATION_SESSION_KEY } from '../../apps/web/src/lib/e2ee/encryptedInvitationLink';
import {
  test,
  expect,
  stubAnonymousApi,
  stubApi,
  stubAssistant,
  openAssistant,
  askAssistant
} from './openzcad-fixtures';

const token = 'a'.repeat(43);
const encrypted = `${token}.${'k'.repeat(43)}.${'o'.repeat(43)}`;

test('a failed replacement preserves the previous workspace and its pending assistant response', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await stubAssistant(page, gate);
  let requested = false;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/assistant/proposals')) requested = true;
  });
  await page.route('**/api/share/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Unavailable' } })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill('My ongoing model');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await openAssistant(page);
  await askAssistant(page, 'Add a 10 mm cube');
  await expect.poll(() => requested).toBe(true);
  const workspace = await page.locator('.workspace-reveal').elementHandle();
  try {
    await page.evaluate((link) => {
      window.location.hash = `share=${link}`;
    }, token);
    await expect(
      page.getByRole('heading', { name: 'This share link is unavailable' })
    ).toBeVisible();
    expect(await workspace.evaluate((element) => element.isConnected)).toBe(
      true
    );
    await expect(page.locator('.workspace-reveal')).toHaveAttribute('inert');
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toHaveCount(0);
    const response = page.waitForResponse(/\/api\/assistant\/proposals/);
    release();
    await response;
    await page
      .getByRole('button', { name: 'Return to previous model' })
      .click();
    await expect(page.locator('.breadcrumb')).toContainText('My ongoing model');
    await openAssistant(page);
    await expect(page.locator('.assistant-card.proposal.open')).toContainText(
      'Add a 10 mm cube.'
    );
    expect(await workspace.evaluate((element) => element.isConnected)).toBe(
      true
    );
  } finally {
    release();
  }
});

for (const pending of [false, true]) {
  test(`an encrypted invitation leaves ${pending ? 'a loading' : 'a failed'} share page and cancels the old load`, async ({
    page
  }) => {
    await stubAnonymousApi(page);
    const document = createProjectDocument(
      'Superseded model',
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
                project: { projectId: document.projectId, name: document.name },
                mode: 'tweak'
              }
            }
          : { status: 404, json: { error: 'Unavailable' } }
      );
    });
    await page.goto(`/#share=${token}`);
    await expect.poll(() => requested).toBe(true);
    await expect(
      page.getByRole('heading', {
        name: pending
          ? 'Opening shared model…'
          : 'This share link is unavailable'
      })
    ).toBeVisible();
    try {
      const invitation = 'i'.repeat(43);
      await page.evaluate((value) => {
        window.location.hash = `encrypted-invite=${value}`;
      }, invitation);
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await expect(settings).toBeVisible();
      await expect(
        page.getByRole('main', { name: 'Shared model' })
      ).toHaveCount(0);
      expect(
        await page.evaluate(
          (key) => sessionStorage.getItem(key),
          ENCRYPTED_INVITATION_SESSION_KEY
        )
      ).toBe(invitation);
      if (pending) {
        const response = page.waitForResponse(/\/api\/share\//);
        release();
        await response;
        // The superseded request must get a chance to process its response.
        await page.waitForTimeout(250);
      }
      await expect(settings).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Make a copy', exact: true })
      ).toHaveCount(0);
      expect(new URL(page.url()).hash).toBe('');
    } finally {
      release();
    }
  });
}

test('an incomplete link closes Settings and leaves the share actions keyboard accessible', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = 'share=incomplete';
  });
  await expect(
    page.getByRole('heading', { name: 'This share link is incomplete' })
  ).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Back to projects' })
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Projects 0' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
});

for (const link of [
  '',
  'truncated',
  `${token}.missing-key`,
  `${encrypted}.extra`
]) {
  test(`an incomplete share stays on its own page (${link.length} characters)`, async ({
    page
  }) => {
    await stubAnonymousApi(page);
    const shareReads: string[] = [];
    page.on('request', (request) => {
      if (/\/api\/(e2ee\/)?share\//.test(request.url()))
        shareReads.push(request.url());
    });
    await page.goto(`/#share=${link}`);
    await expect(
      page.getByRole('heading', { name: 'This share link is incomplete' })
    ).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Projects/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(
      0
    );
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(
      0
    );
    expect(shareReads).toEqual([]);
    expect(new URL(page.url()).hash).toBe(`#share=${link}`);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'This share link is incomplete' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Back to projects' }).click();
    await expect(page.getByRole('tab', { name: 'Projects 0' })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
  });
}

for (const link of [token, encrypted]) {
  test(`an unavailable ${link === token ? 'plaintext' : 'encrypted'} share has a persistent destination`, async ({
    page
  }) => {
    await stubAnonymousApi(page);
    await page.route('**/api/**/share/*', (route) =>
      route.fulfill({ status: 404, json: { error: 'Unavailable' } })
    );
    await page.route('**/api/share/*', (route) =>
      route.fulfill({ status: 404, json: { error: 'Unavailable' } })
    );
    await page.goto(`/#share=${link}`);
    await expect(
      page.getByRole('heading', { name: 'This share link is unavailable' })
    ).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Ask the owner');
    await expect(page.getByRole('tab', { name: /^Projects/ })).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'This share link is unavailable' })
    ).toBeVisible();
    expect(new URL(page.url()).hash).toBe(`#share=${link}`);
  });
}

test('a network failure can be retried into the shared model without going home', async ({
  page
}) => {
  await stubAnonymousApi(page);
  const document = createProjectDocument(
    'Recovered shared model',
    toUserId('owner')
  );
  let reads = 0;
  await page.route('**/api/share/*', (route) => {
    reads++;
    return reads === 1
      ? route.abort('internetdisconnected')
      : route.fulfill({
          json: {
            document,
            project: { projectId: document.projectId, name: document.name },
            mode: 'tweak'
          }
        });
  });
  await page.goto(`/#share=${token}`);
  await expect(
    page.getByRole('heading', { name: 'We couldn’t open this shared model' })
  ).toBeVisible();
  await expect(page.getByRole('main')).toContainText('Check your connection');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.breadcrumb')).toContainText(document.name);
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('main', { name: 'Shared model' })).toHaveCount(0);
  expect(reads).toBe(2);
  expect(new URL(page.url()).hash).toBe(`#share=${token}`);
});

test('loading a share hides the shelf and Back cancels a late completion', async ({
  page
}) => {
  await stubAnonymousApi(page);
  const document = createProjectDocument(
    'Cancelled shared model',
    toUserId('owner')
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('**/api/share/*', async (route) => {
    requested = true;
    await gate;
    await route.fulfill({
      json: {
        document,
        project: { projectId: document.projectId, name: document.name },
        mode: 'tweak'
      }
    });
  });
  await page.goto(`/#share=${token}`);
  try {
    await expect(
      page.getByRole('heading', { name: 'Opening shared model…' })
    ).toBeVisible();
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByRole('tab', { name: /^Projects/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to projects' }).click();
    const response = page.waitForResponse(/\/api\/share\//);
    release();
    await response;
    await expect(page.getByRole('tab', { name: 'Projects 0' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Make a copy', exact: true })
    ).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('');
  } finally {
    release();
  }
});

test('a newer share replaces an error and ignores an older delayed failure', async ({
  page
}) => {
  await stubAnonymousApi(page);
  const document = createProjectDocument(
    'Latest shared model',
    toUserId('owner')
  );
  const latest = 'b'.repeat(43);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('**/api/share/*', async (route) => {
    if (route.request().url().endsWith(token)) {
      requested = true;
      await gate;
      await route.fulfill({ status: 503, json: { error: 'Old failure' } });
    } else {
      await route.fulfill({
        json: {
          document,
          project: { projectId: document.projectId, name: document.name },
          mode: 'tweak'
        }
      });
    }
  });
  await page.goto('/#share=incomplete');
  await expect(
    page.getByRole('heading', { name: 'This share link is incomplete' })
  ).toBeVisible();
  await page.evaluate((link) => {
    window.location.hash = `share=${link}`;
  }, token);
  await expect.poll(() => requested).toBe(true);
  try {
    await page.evaluate((link) => {
      window.location.hash = `share=${link}`;
    }, latest);
    await expect(page.locator('.breadcrumb')).toContainText(document.name);
    const response = page.waitForResponse(/\/api\/share\/a+/);
    release();
    await response;
    await expect(page.locator('.breadcrumb')).toContainText(document.name);
    await expect(page.getByRole('main', { name: 'Shared model' })).toHaveCount(
      0
    );
    expect(new URL(page.url()).hash).toBe(`#share=${latest}`);
  } finally {
    release();
  }
});

test('an incomplete share takes precedence over automatic project restore', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('My existing part');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('.breadcrumb')).toContainText('My existing part');
  await page.goto('/#share=');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'This share link is incomplete' })
  ).toBeVisible();
  await expect(page.locator('.breadcrumb')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to projects' }).click();
  await expect(page.getByRole('tab', { name: 'Projects 1' })).toBeVisible();
  await page
    .locator('.start-tile-open', { hasText: 'My existing part' })
    .click();
  await expect(page.locator('.breadcrumb')).toContainText('My existing part');
});
