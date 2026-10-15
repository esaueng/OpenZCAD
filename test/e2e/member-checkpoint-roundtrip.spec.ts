import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';
import {
  appendRevision,
  createCheckpoint,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import { reconcileCopiedImportSources } from '@openzcad/persistence';
import { toArtifactId, toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';

function roomFixture(ackFault?: 'lost' | 'late', copiedImport = false) {
  let document = createProjectDocument(
    'Durable member checkpoint',
    toUserId('owner')
  );
  const source = readFileSync('test/parity/corpus/b-unit-mm-cube.step');
  const checksumSha256 = createHash('sha256').update(source).digest('hex');
  const localSourceId = 'artifact_local_checkpoint_copy';
  const archive = {
    projectId: document.projectId,
    kind: 'step-import' as const,
    checksumSha256,
    logicalBytes: source.length,
    artifactId: toArtifactId('artifact_checkpoint_copy')
  };
  if (copiedImport)
    document = importStepBody(document, {
      name: 'Copied cube',
      artifactId: localSourceId,
      sourceName: 'cube.step',
      stepSourceRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256,
        logicalBytes: source.length
      }
    }).document;
  let stored: ProjectDocument | null = null;
  let checkpointRequested = false;
  let checkpointInput: ProjectDocument | null = null;
  let accountWrites = 0;
  let revisionReads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseAck!: () => void;
  const ackGate = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let sourceWritePending = false;
  let releaseSourceWrite!: () => void;
  const sourceWriteGate = new Promise<void>((resolve) => {
    releaseSourceWrite = resolve;
  });
  const summary = () => ({
    projectId: document.projectId,
    name: document.name,
    revisionCount: document.checkpoints.length,
    documentVersion: document.version,
    updatedAt: document.derived.updatedAt
  });
  return {
    release,
    releaseAck,
    releaseSourceWrite,
    sourceWritePending: () => sourceWritePending,
    source: { checksumSha256, text: source.toString('utf8') },
    read: () => document,
    stored: () => stored,
    requested: () => checkpointRequested,
    input: () => checkpointInput,
    accountWrites: () => accountWrites,
    revisionReads: () => revisionReads,
    async install(page: Page) {
      await stubApi(page, { collaborationRole: 'editor' });
      await page.route('**/api/projects', (route) =>
        route.fulfill({
          json:
            route.request().method() === 'POST'
              ? { project: summary(), document }
              : { projects: [summary()] }
        })
      );
      await page.route(`**/api/projects/${document.projectId}`, (route) =>
        route.fulfill({ json: document })
      );
      await page.route(
        `**/api/projects/${document.projectId}/document`,
        (route) => {
          accountWrites += 1;
          return route.fulfill({
            status: 403,
            json: { error: 'Member writes require the room.' }
          });
        }
      );
      await page.route(
        `**/api/projects/${document.projectId}/revisions`,
        (route) => {
          if (route.request().method() === 'POST') {
            accountWrites += 1;
            return route.fulfill({
              status: 403,
              json: { error: 'Member writes require the room.' }
            });
          }
          const revision = stored?.revisions.at(-1);
          return route.fulfill({
            json: {
              revisions: revision
                ? [
                    {
                      ...revision,
                      projectId: document.projectId,
                      authorUserId: 'user_e2e',
                      documentBytes: JSON.stringify(stored).length
                    }
                  ]
                : [],
              maxRevisions: 50
            }
          });
        }
      );
      await page.route(
        `**/api/projects/${document.projectId}/revisions/*`,
        (route) => {
          revisionReads += 1;
          return stored &&
            route.request().url().endsWith(stored.revisions.at(-1)!.revisionId)
            ? route.fulfill({ json: stored })
            : route.fulfill({
                status: 404,
                json: { error: 'No stored revision.' }
              });
        }
      );
      await page.route(
        `**/api/projects/${document.projectId}/collaboration`,
        async (route) => {
          const input = route.request().postDataJSON() as {
            document: ProjectDocument;
            checkpointReason: string;
            leaseId: string;
            clientId: string;
          };
          checkpointRequested = true;
          checkpointInput = input.document;
          expect(input.leaseId).toBe('browser_checkpoint_lease');
          await gate;
          stored = createCheckpoint(
            appendRevision(
              copiedImport
                ? reconcileCopiedImportSources(input.document, [archive])
                : input.document,
              input.checkpointReason
            ),
            input.checkpointReason
          );
          document = stored;
          if (ackFault) {
            await page.evaluate(
              ({ saved, clientId }) => {
                const socket = (
                  window as unknown as {
                    __checkpointRoundtripSocket: WebSocket;
                  }
                ).__checkpointRoundtripSocket;
                socket.dispatchEvent(
                  new MessageEvent('message', {
                    data: JSON.stringify({
                      type: 'document',
                      document: saved,
                      clientId
                    })
                  })
                );
              },
              { saved: stored, clientId: input.clientId }
            );
            await ackGate;
            if (ackFault === 'lost') return route.abort('failed');
          }
          return route.fulfill({
            json: { type: 'ack', version: stored.version, document: stored }
          });
        }
      );
      await page.exposeFunction(
        '__recordCheckpointRoomDocument',
        async (next: ProjectDocument) => {
          if (copiedImport && JSON.stringify(next).includes(localSourceId)) {
            sourceWritePending = true;
            await sourceWriteGate;
            document = reconcileCopiedImportSources(next, [archive]);
            return document;
          }
          document = next;
          return null;
        }
      );
      await page.addInitScript((initial) => {
        const browser = window as unknown as {
          __recordCheckpointRoomDocument(
            document: ProjectDocument
          ): Promise<ProjectDocument | null>;
        };
        const Original = window.WebSocket;
        window.WebSocket = class extends Original {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            (
              window as unknown as {
                __checkpointRoundtripSocket: WebSocket;
              }
            ).__checkpointRoundtripSocket = this;
          }
          override send(raw: Parameters<WebSocket['send']>[0]) {
            if (typeof raw !== 'string') return;
            const frame = JSON.parse(raw) as {
              type: string;
              clientId: string;
              document?: ProjectDocument;
            };
            if (frame.type === 'hello') {
              queueMicrotask(() =>
                this.dispatchEvent(
                  new MessageEvent('message', {
                    data: JSON.stringify({
                      type: 'state',
                      members: [],
                      document: initial,
                      role: 'editor',
                      lease: null
                    })
                  })
                )
              );
            } else if (
              frame.type === 'lease-acquire' ||
              frame.type === 'lease-renew'
            ) {
              queueMicrotask(() =>
                this.dispatchEvent(
                  new MessageEvent('message', {
                    data: JSON.stringify({
                      type: 'lease-granted',
                      lease: {
                        projectId: initial.projectId,
                        leaseId: 'browser_checkpoint_lease',
                        clientId: frame.clientId,
                        userId: 'user_e2e',
                        expiresAt: Date.now() + 120_000
                      }
                    })
                  })
                )
              );
            } else if (frame.type === 'document' && frame.document) {
              const submitted = frame.document;
              void browser
                .__recordCheckpointRoomDocument(submitted)
                .then((canonical) =>
                  this.dispatchEvent(
                    new MessageEvent('message', {
                      data: JSON.stringify({
                        type: 'ack',
                        version: canonical?.version ?? submitted.version,
                        ...(canonical ? { document: canonical } : {})
                      })
                    })
                  )
                );
            }
          }
        };
      }, document);
    }
  };
}

async function addPrimitive(page: Page, name: RegExp) {
  await page.getByRole('button', { name }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
}

async function startNamedSave(page: Page) {
  await page.keyboard.press('ControlOrMeta+Shift+s');
  const dialog = page.getByRole('dialog', { name: 'Name this save' });
  await dialog.getByLabel('Save name').fill('Clicked box');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
}

test('a clicked member checkpoint survives buffered edits and restores through the account on a fresh device', async ({
  page,
  browser
}) => {
  test.setTimeout(90_000);
  const server = roomFixture();
  await server.install(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(server.read().name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  await startNamedSave(page);
  await expect.poll(server.requested).toBe(true);
  try {
    await addPrimitive(page, /^Cylinder/);
    await expectBodyCount(page, 2);
    await page.waitForTimeout(650);
    expect(server.input()?.bodyOrder).toHaveLength(1);
    expect(server.read().bodyOrder).toHaveLength(1);
    server.release();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Saved revision.'
    );
    await expectBodyCount(page, 2);
    await expect(
      page.getByRole('status', { name: 'Saved', exact: true })
    ).toBeVisible();
    expect(server.stored()?.bodyOrder).toHaveLength(1);
    expect(server.read().bodyOrder).toHaveLength(2);
    expect(server.read().version).toBeGreaterThan(server.stored()!.version);
    await page.keyboard.press('ControlOrMeta+z');
    await expectBodyCount(page, 1);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expectBodyCount(page, 2);
    await expect(
      page.getByRole('status', { name: 'Saved', exact: true })
    ).toBeVisible();
    await expect(
      page.locator('.revision-row', { hasText: 'Clicked box' })
    ).toBeVisible();
    const fresh = await browser.newContext({ colorScheme: 'dark' });
    try {
      const other = await fresh.newPage();
      await server.install(other);
      await other.goto(new URL('/', page.url()).toString());
      await expect(other.getByRole('tab', { name: 'Parts 1' })).toBeVisible();
      await other
        .locator('.start-tile-open', { hasText: server.read().name })
        .click();
      await expectBodyCount(other, 2);
      const named = other.locator('.revision-row', { hasText: 'Clicked box' });
      await named.hover();
      const restore = named.getByRole('button', {
        name: 'Restore Clicked box'
      });
      await expect(restore).toBeEnabled();
      await restore.click();
      await expectBodyCount(other, 1);
      expect(server.revisionReads()).toBe(1);
      await other.keyboard.press('ControlOrMeta+z');
      await expectBodyCount(other, 2);
      expect(server.accountWrites()).toBe(0);
    } finally {
      await fresh.close();
    }
  } finally {
    server.release();
  }
});

test('a late member checkpoint leaves the newer share navigation and status unchanged', async ({
  page
}) => {
  const server = roomFixture();
  await server.install(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(server.read().name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  await startNamedSave(page);
  await expect.poll(server.requested).toBe(true);
  const shared = createProjectDocument('Newer public share', toUserId('owner'));
  let releaseShare!: () => void;
  const shareGate = new Promise<void>((resolve) => {
    releaseShare = resolve;
  });
  let shareRequested = false;
  await page.route('**/api/share/*', async (route) => {
    shareRequested = true;
    await shareGate;
    return route.fulfill({
      json: { document: shared, project: { name: shared.name }, mode: 'tweak' }
    });
  });
  await page.evaluate(() => {
    window.location.hash = `share=${'n'.repeat(43)}`;
  });
  await expect.poll(() => shareRequested).toBe(true);
  const pendingStatus = await page.getByRole('contentinfo').textContent();
  try {
    server.release();
    await page.waitForTimeout(350);
    await expect(page.getByRole('contentinfo')).toHaveText(pendingStatus ?? '');
    await expect(page.locator('.breadcrumb')).toContainText(
      'Durable member checkpoint'
    );
    await expect(
      page.locator('.revision-row', { hasText: 'Clicked box' })
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Make a copy', exact: true })
    ).toHaveCount(0);
    releaseShare();
    await expect(page.locator('.breadcrumb')).toContainText(shared.name);
    await expect(
      page.getByRole('button', { name: 'Make a copy', exact: true })
    ).toBeEnabled();
    await expect(
      page.locator('.revision-row', { hasText: 'Clicked box' })
    ).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe(`#share=${'n'.repeat(43)}`);
    expect(server.accountWrites()).toBe(0);
  } finally {
    server.release();
    releaseShare();
  }
});

for (const ackFault of ['lost', 'late'] as const) {
  test(`an adopted member checkpoint keeps its server identity after a ${ackFault} HTTP acknowledgement`, async ({
    page
  }) => {
    test.setTimeout(60_000);
    const server = roomFixture(ackFault);
    await server.install(page);
    try {
      await page.goto('/');
      await page.getByLabel('Project name').fill(server.read().name);
      await page.getByRole('button', { name: 'Create project' }).click();
      await addPrimitive(page, /^Box \(B\)/);
      await expectBodyCount(page, 1);
      await expect(
        page.getByRole('status', { name: 'Saved', exact: true })
      ).toBeVisible();
      await startNamedSave(page);
      await expect.poll(server.requested).toBe(true);
      server.release();
      const named = page.locator('.revision-row', { hasText: 'Clicked box' });
      await expect(named).toHaveCount(1);
      await addPrimitive(page, /^Cylinder/);
      await expectBodyCount(page, 2);
      if (ackFault === 'lost') server.releaseAck();
      await expect(page.getByRole('contentinfo')).toContainText(
        'The named save is stored on this device.',
        { timeout: ackFault === 'late' ? 20_000 : 10_000 }
      );
      await expect(named).toHaveCount(1);
      await expect.poll(() => server.read().bodyOrder.length).toBe(2);
      expect(server.read().checkpoints).toEqual(server.stored()!.checkpoints);
      expect(server.read().revisions).toEqual([
        ...server.stored()!.revisions,
        expect.objectContaining({ reason: 'Add cylinder', commandCount: 2 })
      ]);
      expect(server.stored()!.bodyOrder).toHaveLength(1);
      expect(server.accountWrites()).toBe(0);
      if (ackFault === 'late') {
        server.releaseAck();
        await page.waitForTimeout(250);
        await expect(named).toHaveCount(1);
        expect(server.read().checkpoints).toEqual(server.stored()!.checkpoints);
      }
    } finally {
      server.release();
      server.releaseAck();
    }
  });
}

for (const ackFault of [undefined, 'lost'] as const) {
  test(`a member checkpoint accepts the drained copied-source rewrite with a ${ackFault ?? 'confirmed'} HTTP acknowledgement`, async ({
    page
  }) => {
    test.setTimeout(60_000);
    const server = roomFixture(ackFault, true);
    await server.install(page);
    try {
      await page.goto('/');
      await expect(page.getByRole('tab', { name: 'Parts 1' })).toBeVisible();
      await page.evaluate(
        ({ checksumSha256, text }) =>
          new Promise<void>((resolve, reject) => {
            const open = indexedDB.open('openzcad-v2');
            open.onerror = () =>
              reject(
                new Error('Could not open the source cache.', {
                  cause: open.error
                })
              );
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction('sourceBlobs', 'readwrite');
              tx.objectStore('sourceBlobs').put({
                checksumSha256,
                logicalBytes: new TextEncoder().encode(text).length,
                body: new Blob([text]),
                createdAt: new Date().toISOString()
              });
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onabort = () => {
                db.close();
                reject(
                  new Error('Could not cache the copied source.', {
                    cause: tx.error
                  })
                );
              };
            };
          }),
        server.source
      );
      await page
        .locator('.start-tile-open', { hasText: server.read().name })
        .click();
      await expectBodyCount(page, 1);
      await expect(
        page.getByRole('group', { name: 'Workspace status' })
      ).toContainText('syncLocal source only');
      await addPrimitive(page, /^Box \(B\)/);
      await expectBodyCount(page, 2);
      await expect.poll(server.sourceWritePending).toBe(true);
      await startNamedSave(page);
      server.releaseSourceWrite();
      await expect.poll(server.requested).toBe(true);
      expect(server.input()?.bodyOrder).toHaveLength(2);
      expect(JSON.stringify(server.input())).not.toContain(
        'artifact_local_checkpoint_copy'
      );
      server.release();
      if (ackFault === 'lost') server.releaseAck();
      await expect(page.getByRole('contentinfo')).toContainText(
        ackFault === 'lost'
          ? 'The named save is stored on this device.'
          : 'Saved revision.'
      );
      await expect(
        page.locator('.revision-row', { hasText: 'Clicked box' })
      ).toHaveCount(1);
      expect(JSON.stringify(server.stored())).not.toContain(
        'artifact_local_checkpoint_copy'
      );
      expect(JSON.stringify(server.stored())).toContain(
        'artifact_checkpoint_copy'
      );
      await addPrimitive(page, /^Cylinder/);
      await expectBodyCount(page, 3);
      await expect.poll(() => server.read().bodyOrder.length).toBe(3);
      expect(server.read().checkpoints).toEqual(server.stored()!.checkpoints);
      expect(server.read().revisions).toEqual([
        ...server.stored()!.revisions,
        expect.objectContaining({ reason: 'Add cylinder', commandCount: 3 })
      ]);
      expect(JSON.stringify(server.read())).not.toContain(
        'artifact_local_checkpoint_copy'
      );
      expect(server.accountWrites()).toBe(0);
      await page.keyboard.press('ControlOrMeta+z');
      await expectBodyCount(page, 2);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expectBodyCount(page, 3);
    } finally {
      server.releaseSourceWrite();
      server.release();
      server.releaseAck();
    }
  });
}
