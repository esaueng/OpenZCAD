import { test, expect, stubApi } from './openzcad-fixtures';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

test('a member editor saves a named checkpoint through the lease-checked room', async ({
  page
}) => {
  const document = createProjectDocument(
    'Member named save',
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
  for (const endpoint of ['document', 'revisions']) {
    await page.route(
      `**/api/projects/${document.projectId}/${endpoint}`,
      (route) => {
        if (route.request().method() === 'GET')
          return route.fulfill({ json: { revisions: [], maxRevisions: 50 } });
        accountWrites += 1;
        return route.fulfill({
          status: 403,
          json: { error: 'Lease-checked room required.' }
        });
      }
    );
  }
  await page.addInitScript(() => {
    const browser = window as unknown as {
      __checkpointSocket: WebSocket;
      __checkpointFrames: unknown[];
    };
    browser.__checkpointFrames = [];
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        browser.__checkpointSocket = this;
      }
      override send(raw: Parameters<WebSocket['send']>[0]) {
        if (typeof raw === 'string') {
          const frame = JSON.parse(raw) as { type?: string };
          if (frame.type === 'document') browser.__checkpointFrames.push(frame);
        }
        super.send(raw);
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
          (window as unknown as { __checkpointSocket?: WebSocket })
            .__checkpointSocket?.readyState
      )
    )
    .toBe(1);
  await page.evaluate((document) => {
    const socket = (window as unknown as { __checkpointSocket: WebSocket })
      .__checkpointSocket;
    for (const frame of [
      { type: 'state', members: [], document, role: 'editor', lease: null },
      {
        type: 'lease-granted',
        lease: {
          leaseId: 'member_checkpoint_lease',
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
  await page.keyboard.press('ControlOrMeta+Shift+s');
  const dialog = page.getByRole('dialog', { name: 'Name this save' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Save name').fill('Member milestone');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.locator('.revision-row', { hasText: 'Member milestone' })
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __checkpointFrames: unknown[] })
            .__checkpointFrames.length
      )
    )
    .toBe(1);
  const frames = await page.evaluate(
    () =>
      (
        window as unknown as {
          __checkpointFrames: Array<{
            document: ProjectDocument;
            baseVersion: number;
            leaseId: string;
          }>;
        }
      ).__checkpointFrames
  );
  const checkpoint = frames.at(0);
  expect(checkpoint).toBeDefined();
  if (!checkpoint) throw new Error('No checkpoint was published to the room.');
  expect(checkpoint.baseVersion).toBe(document.version);
  expect(checkpoint.leaseId).toBe('member_checkpoint_lease');
  expect(checkpoint.document.checkpoints.at(-1)?.reason).toBe(
    'Member milestone'
  );
  expect(checkpoint.document.version).toBe(document.version + 1);
  expect(checkpoint.document.checkpoints.at(-1)?.documentVersion).toBe(
    checkpoint.document.version
  );
  expect(checkpoint.document.revisions).toHaveLength(
    document.revisions.length + 1
  );
  expect(checkpoint.document.checkpoints.at(-1)?.revisionId).toBe(
    checkpoint.document.revisions.at(-1)?.revisionId
  );
  expect(checkpoint.document.nodes).toEqual(document.nodes);
  expect(checkpoint.document.commandLog).toEqual(document.commandLog);
  await page.evaluate((saved) => {
    const socket = (window as unknown as { __checkpointSocket: WebSocket })
      .__checkpointSocket;
    for (const frame of [
      { type: 'ack', version: saved.version },
      {
        type: 'state',
        members: [],
        document: saved,
        role: 'viewer',
        lease: null
      }
    ])
      socket.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify(frame) })
      );
  }, checkpoint.document);
  const modes = page.getByRole('group', { name: 'Workspace mode' });
  await expect(modes.getByRole('button', { name: 'Build' })).toBeDisabled();
  await expect(modes.getByRole('button', { name: 'View' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(
    page.getByRole('navigation', { name: 'Feature tools' })
  ).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');
  await page.keyboard.press('ControlOrMeta+Shift+s');
  await expect(
    page.getByRole('dialog', { name: 'Name this save' })
  ).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cannot save a named revision'
  );
  await page.waitForTimeout(650);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __checkpointFrames: unknown[] })
          .__checkpointFrames.length
    )
  ).toBe(1);
  expect(accountWrites).toBe(0);
});
