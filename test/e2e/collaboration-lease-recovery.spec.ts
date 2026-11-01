import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  createPrimitiveInPlace,
  expectBodyCount,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

for (const outcome of ['unconfirmed', 'accepted', 'read-only'] as const) {
  test(
    `lease recovery reconciles ${outcome} work without reload`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      const accepted = outcome === 'accepted';
      const viewer = outcome === 'read-only';
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      const document = createProjectDocument(
        'Lease recovery',
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
      await page.setViewportSize({ width: 1440, height: 1000 });
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
          return route.fulfill({
            status: 404,
            json: { error: 'Room lease required.' }
          });
        }
      );
      await page.addInitScript(() => {
        const scope = window as unknown as {
          __leaseSockets: WebSocket[];
          __leaseFrames: Array<{
            socket: number;
            frame: {
              type: string;
              leaseId?: string;
              document?: ProjectDocument;
            };
          }>;
        };
        scope.__leaseSockets = [];
        scope.__leaseFrames = [];
        const Original = window.WebSocket;
        window.WebSocket = class extends Original {
          readonly inspectionIndex: number;
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.inspectionIndex = scope.__leaseSockets.length;
            scope.__leaseSockets.push(this);
          }
          override send(raw: Parameters<WebSocket['send']>[0]) {
            if (typeof raw === 'string')
              scope.__leaseFrames.push({
                socket: this.inspectionIndex,
                frame: JSON.parse(raw) as {
                  type: string;
                  leaseId?: string;
                  document?: ProjectDocument;
                }
              });
            super.send(raw);
          }
        };
      });
      await page.goto('/');
      await page.getByLabel('Project name').fill(document.name);
      await page.getByRole('button', { name: 'New project' }).click();
      await expect(page.locator('.breadcrumb')).toContainText(document.name);
      const offerHead = async (
        index: number,
        head: ProjectDocument,
        leaseId: string,
        role: 'editor' | 'viewer' = 'editor'
      ) => {
        await expect
          .poll(() =>
            page.evaluate(
              (index) =>
                (window as unknown as { __leaseSockets: WebSocket[] })
                  .__leaseSockets[index]?.readyState,
              index
            )
          )
          .toBe(1);
        await page.evaluate(
          ({ index, head, leaseId, role }) => {
            const socket = (
              window as unknown as { __leaseSockets: WebSocket[] }
            ).__leaseSockets[index]!;
            for (const frame of [
              {
                type: 'state',
                members: [],
                document: head,
                role,
                lease: null
              },
              {
                type: 'lease-granted',
                lease: {
                  leaseId,
                  projectId: head.projectId,
                  userId: 'user_e2e',
                  clientId: sessionStorage.getItem(
                    'openzcad-collaboration-client'
                  ),
                  expiresAt: Date.now() + 60_000
                }
              }
            ]) {
              if (role === 'viewer' && frame.type === 'lease-granted') continue;
              socket.dispatchEvent(
                new MessageEvent('message', { data: JSON.stringify(frame) })
              );
            }
          },
          { index, head, leaseId, role }
        );
      };
      const publications = (index: number) =>
        page.evaluate(
          (index) =>
            (
              window as unknown as {
                __leaseFrames: Array<{
                  socket: number;
                  frame: {
                    type: string;
                    leaseId?: string;
                    document: ProjectDocument;
                  };
                }>;
              }
            ).__leaseFrames
              .filter(
                (entry) =>
                  entry.socket === index && entry.frame.type === 'document'
              )
              .map((entry) => entry.frame),
          index
        );
      await offerHead(0, document, 'lease_before');
      await expect(
        page.getByRole('status', { name: 'Saved', exact: true })
      ).toBeVisible();
      await createPrimitiveInPlace(page, 'box');
      await expectBodyCount(page, 1);
      await expect.poll(async () => (await publications(0)).length).toBe(1);
      const submitted = (await publications(0))[0]!.document;
      await expect(
        page.getByRole('status', { name: /^Syncing\b/ })
      ).toBeVisible();
      await page.evaluate(() =>
        (
          window as unknown as { __leaseSockets: WebSocket[] }
        ).__leaseSockets[0]!.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'lease-lost', reason: 'expired' })
          })
        )
      );
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __leaseSockets: WebSocket[] })
                .__leaseSockets.length
          )
        )
        .toBe(2);
      await offerHead(
        1,
        accepted ? submitted : document,
        'lease_after',
        viewer ? 'viewer' : 'editor'
      );
      if (viewer) {
        expect(await publications(1)).toHaveLength(0);
        await expect(
          page.getByRole('button', { name: /Open project sharing/ })
        ).toContainText('Conflict');
        await expect(
          page.getByRole('heading', { name: 'Choose a version to keep' })
        ).toBeVisible();
        await page
          .getByRole('button', { name: 'Decide later', exact: true })
          .click();
        await expect(
          page.getByRole('button', { name: 'Build', exact: true })
        ).toBeDisabled();
      } else if (accepted) {
        expect(await publications(1)).toHaveLength(0);
      } else {
        await expect.poll(async () => (await publications(1)).length).toBe(1);
        const retried = (await publications(1))[0]!;
        expect(retried.leaseId).toBe('lease_after');
        expect(retried.document.nodes).toEqual(submitted.nodes);
        await page.evaluate(
          (version) =>
            (
              window as unknown as { __leaseSockets: WebSocket[] }
            ).__leaseSockets[0]!.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({ type: 'ack', version })
              })
            ),
          submitted.version
        );
        await expect(
          page.getByRole('status', { name: /^Syncing\b/ })
        ).toBeVisible();
        await page.evaluate(
          (version) =>
            (
              window as unknown as { __leaseSockets: WebSocket[] }
            ).__leaseSockets[1]!.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({ type: 'ack', version })
              })
            ),
          retried.document.version
        );
      }
      if (!viewer) {
        await expect(
          page.getByRole('status', { name: 'Saved', exact: true })
        ).toBeVisible();
      } else {
        await expect(
          page.getByRole('status', { name: 'Saved', exact: true })
        ).toBeHidden();
      }
      await expect(
        page.getByRole('button', { name: /Open project sharing/ })
      ).not.toContainText('Unavailable');
      if (viewer) {
        // Read-only mode hides the editing history panel. Its canonical
        // feature count still proves the unconfirmed operation was retained.
        await expect(
          page.locator('.workspace-status-summary [title]')
        ).toHaveAttribute('title', / · 1 feature · /);
      } else {
        await expect(
          page.locator('.feature-row-main').filter({ hasText: /^Box/ })
        ).toHaveCount(1);
      }
      await expectBodyCount(page, 1);
      expect(accountWrites).toBe(0);
      expect(errors).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath(`lease-${outcome}.png`)
      });
    }
  );
}
