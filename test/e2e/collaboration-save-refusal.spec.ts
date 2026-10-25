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
    await page.getByRole('button', { name: 'Create project' }).click();
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
          ? 'Not shared'
          : 'Update required'
    );
    const saved = page.getByRole('status', {
      name: 'Local only',
      exact: true
    });
    await expect(saved).toBeVisible();
    await expect(saved.locator('.spin')).toHaveCount(0);
    await expect(
      page.locator('.feature-row-main').filter({ hasText: /^Box/ })
    ).toHaveCount(1);
    expect(accountWrites).toBe(0);
  });
}
