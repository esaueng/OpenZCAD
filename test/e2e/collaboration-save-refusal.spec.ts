import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

for (const refusal of ['oversize', 'rejected', 'update-required'] as const) {
  test(`member Save stops syncing after ${refusal} with an unacknowledged edit`, async ({
    page
  }) => {
    const document = createProjectDocument(
      'Member save refusal',
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
        accountWrites += 1;
        return route.fulfill({
          status: 404,
          json: { error: 'Lease checked room required.' }
        });
      }
    );
    await page.addInitScript(() => {
      const browser = window as unknown as { __saveSocket: WebSocket };
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          browser.__saveSocket = this;
        }
      };
    });
    await page.goto('/');
    await page.getByLabel('Project name').fill(document.name);
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.locator('.breadcrumb')).toContainText(document.name);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __saveSocket?: WebSocket }).__saveSocket
              ?.readyState
        )
      )
      .toBe(1);
    await page.evaluate((document) => {
      const socket = (window as unknown as { __saveSocket: WebSocket })
        .__saveSocket;
      for (const frame of [
        { type: 'state', members: [], document, role: 'editor', lease: null },
        {
          type: 'lease-granted',
          lease: {
            leaseId: 'member_save_lease',
            projectId: document.projectId,
            userId: 'user_e2e',
            clientId: sessionStorage.getItem('openzcad-collaboration-client'),
            expiresAt: Date.now() + 60_000
          }
        }
      ])
        socket.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify(frame) })
        );
    }, document);
    await expect(
      page.getByRole('status', { name: 'Saved', exact: true })
    ).toBeVisible();
    await createPrimitiveInPlace(page, 'box');
    await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
    await expect(
      page.getByRole('status', { name: /^Syncing\b/ })
    ).toBeVisible();
    await page.evaluate(
      ({ refusal, document }) => {
        const frame =
          refusal === 'update-required'
            ? {
                type: 'state',
                members: [],
                document: {
                  ...document,
                  schemaVersion: document.schemaVersion + 1,
                  version: document.version + 20
                },
                role: 'editor',
                lease: null
              }
            : {
                type: 'error',
                code:
                  refusal === 'oversize'
                    ? 'document-too-large'
                    : 'document-rejected',
                message: 'The room refused this edit.'
              };
        (
          window as unknown as { __saveSocket: WebSocket }
        ).__saveSocket.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify(frame) })
        );
      },
      { refusal, document }
    );
    await expect(
      page.getByRole('button', { name: /Open project sharing/ })
    ).toContainText(
      refusal === 'oversize'
        ? 'Local only'
        : refusal === 'rejected'
          ? 'Unavailable'
          : 'Update required'
    );
    const saved = page.getByRole('status', {
      name: 'Local only',
      exact: true
    });
    if (refusal === 'rejected') {
      // The reason opens in the app's own help (hover, keyboard focus or a
      // long-press), not only in a hover-only title (I77).
      await page
        .getByRole('button', { name: 'Open project sharing · Unavailable' })
        .hover();
      await expect(page.getByRole('tooltip')).toContainText(
        'Connection refused: The room refused this edit.'
      );
    }
    await expect(saved).toBeVisible();
    await expect(saved.locator('.spin')).toHaveCount(0);
    await expect(
      page.locator('.feature-row-main').filter({ hasText: /^Box/ })
    ).toHaveCount(1);
    expect(accountWrites).toBe(0);
  });
}

// Design review I10: while the seat waits for its edit lease, one notice says
// "Connecting to the live session…" in plain words; tools keep their own
// descriptions; a refused press is a warning, not a "ready" dot; the notice
// goes once the lease arrives.
test('says plainly that editing waits for the live session', async ({
  page
}) => {
  const document = createProjectDocument(
    'Member waiting for the session',
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
  await page.addInitScript(() => {
    const browser = window as unknown as { __saveSocket: WebSocket };
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        browser.__saveSocket = this;
      }
    };
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.locator('.breadcrumb')).toContainText(document.name);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __saveSocket?: WebSocket }).__saveSocket
            ?.readyState
      )
    )
    .toBe(1);
  await page.evaluate((document) => {
    (
      window as unknown as { __saveSocket: WebSocket }
    ).__saveSocket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'state',
          members: [],
          document,
          role: 'editor',
          lease: null
        })
      })
    );
  }, document);
  const notice = page.locator('.live-session-notice');
  await expect(notice).toContainText('Connecting to the live session…');
  await expect(page.locator('body')).not.toContainText(/edit lease/i);
  // Tools stay greyed (their rows keep their own descriptions: unit-tested
  // in tools.test.ts), and a refused press says why in the same words.
  const box = page.getByRole('button', { name: /^Box\b/ }).first();
  await expect(box).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('b');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Connecting to the live session…'
  );
  await expect(page.getByRole('contentinfo')).not.toContainText(/lease/i);
  await page.evaluate((document) => {
    (
      window as unknown as { __saveSocket: WebSocket }
    ).__saveSocket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'lease-granted',
          lease: {
            leaseId: 'member_waiting_lease',
            projectId: document.projectId,
            userId: 'user_e2e',
            clientId: sessionStorage.getItem('openzcad-collaboration-client'),
            expiresAt: Date.now() + 60_000
          }
        })
      })
    );
  }, document);
  await expect(notice).toHaveCount(0);
  await expect(box).not.toHaveAttribute('aria-disabled', 'true');
});
