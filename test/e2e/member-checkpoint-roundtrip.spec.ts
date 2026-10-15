import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';
import {
  appendRevision,
  addPrimitiveFeature,
  createCheckpoint,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import { reconcileCopiedImportSources } from '@openzcad/persistence';
import { toArtifactId, toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';

function roomFixture(
  ackFault?: 'lost' | 'late',
  copiedImport = false,
  sourceArchived = true
) {
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
  let checkpointBroadcasted = false;
  let checkpointInput: ProjectDocument | null = null;
  let accountWrites = 0;
  let revisionReads = 0;
  let lastWriteBase: number | null = null;
  let lastWriteLease: string | null = null;
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
    broadcasted: () => checkpointBroadcasted,
    input: () => checkpointInput,
    accountWrites: () => accountWrites,
    revisionReads: () => revisionReads,
    lastWriteBase: () => lastWriteBase,
    lastWriteLease: () => lastWriteLease,
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
              copiedImport && sourceArchived
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
            checkpointBroadcasted = true;
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
        async (
          next: ProjectDocument,
          baseVersion: number | null,
          leaseId: string | null
        ) => {
          lastWriteBase = baseVersion;
          lastWriteLease = leaseId;
          if (copiedImport && JSON.stringify(next).includes(localSourceId)) {
            sourceWritePending = true;
            await sourceWriteGate;
            document = sourceArchived
              ? reconcileCopiedImportSources(next, [archive])
              : next;
            return document;
          }
          document = next;
          return null;
        }
      );
      await page.addInitScript((initial) => {
        const browser = window as unknown as {
          __recordCheckpointRoomDocument(
            document: ProjectDocument,
            baseVersion: number | null,
            leaseId: string | null
          ): Promise<ProjectDocument | null>;
        };
        let leaseNumber = 0;
        let leaseId = 'browser_checkpoint_lease';
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
              baseVersion?: number | null;
              leaseId?: string;
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
              if (frame.type === 'lease-acquire') {
                leaseNumber++;
                leaseId =
                  leaseNumber === 1
                    ? 'browser_checkpoint_lease'
                    : `browser_checkpoint_lease_${leaseNumber}`;
              }
              queueMicrotask(() =>
                this.dispatchEvent(
                  new MessageEvent('message', {
                    data: JSON.stringify({
                      type: 'lease-granted',
                      lease: {
                        projectId: initial.projectId,
                        leaseId,
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
                .__recordCheckpointRoomDocument(
                  submitted,
                  frame.baseVersion ?? null,
                  frame.leaseId ?? null
                )
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

test('restoring a device-only member point syncs the model without publishing private checkpoint rows', async ({
  page
}) => {
  const server = roomFixture();
  await server.install(page);
  await page.route(
    `**/api/projects/${server.read().projectId}/collaboration`,
    (route) =>
      route.fulfill({ status: 503, json: { error: 'Checkpoint unavailable.' } })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill(server.read().name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);
  await startNamedSave(page);
  await expect(page.getByRole('contentinfo')).toContainText(
    'The named save is stored on this device.'
  );
  await addPrimitive(page, /^Cylinder/);
  await expectBodyCount(page, 2);
  await expect.poll(() => server.read().bodyOrder.length).toBe(2);
  const checkpoints = server.read().checkpoints;
  const savedRow = page.locator('.revision-row', { hasText: 'Clicked box' });
  await savedRow.hover();
  await savedRow.getByRole('button', { name: 'Restore Clicked box' }).click();
  await expectBodyCount(page, 1);
  await expect.poll(() => server.read().bodyOrder.length).toBe(1);
  expect(server.read().checkpoints).toEqual(checkpoints);
  expect(
    server
      .read()
      .revisions.some((revision) =>
        /Before restore|Restored|Clicked box/.test(revision.reason)
      )
  ).toBe(false);
  await expect(
    page.locator('.revision-row', { hasText: 'Before restore' })
  ).toBeVisible();
  await page.keyboard.press('ControlOrMeta+z');
  await expectBodyCount(page, 2);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expectBodyCount(page, 1);
  await expect.poll(() => server.read().bodyOrder.length).toBe(1);
  expect(server.read().checkpoints).toEqual(checkpoints);
  expect(server.accountWrites()).toBe(0);
});

test('does not record a restore when the room changes while its saved revision loads', async ({
  page
}) => {
  const server = roomFixture();
  await server.install(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(server.read().name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);
  await startNamedSave(page);
  await expect.poll(server.requested).toBe(true);
  server.release();
  await expect(page.getByRole('contentinfo')).toContainText('Saved revision.');
  await addPrimitive(page, /^Cylinder/);
  await expectBodyCount(page, 2);
  await expect.poll(() => server.read().bodyOrder.length).toBe(2);
  const saved = server.stored()!;
  await page.evaluate(
    ({ projectId, checkpointId }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () =>
          reject(request.error ?? new Error('Storage unavailable'));
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('projectCheckpointDocuments', 'readwrite');
          tx.objectStore('projectCheckpointDocuments').delete([
            projectId,
            checkpointId
          ]);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error ?? new Error('Delete failed'));
          };
        };
      }),
    {
      projectId: saved.projectId,
      checkpointId: saved.checkpoints.at(-1)!.checkpointId
    }
  );
  let requested = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/projects/*/revisions/*', async (route) => {
    requested = true;
    await pending;
    return route.fulfill({ json: saved });
  });
  try {
    const row = page.locator('.revision-row', { hasText: 'Clicked box' });
    await row.hover();
    await row.getByRole('button', { name: 'Restore Clicked box' }).click();
    await expect.poll(() => requested).toBe(true);
    const incoming = addPrimitiveFeature(server.read(), {
      name: 'Incoming sphere',
      primitiveKind: 'sphere',
      dimensions: { radius: 2 }
    });
    await page.evaluate((document) => {
      const socket = (
        window as unknown as { __checkpointRoundtripSocket: WebSocket }
      ).__checkpointRoundtripSocket;
      socket.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'document',
            clientId: 'other_restore_client',
            document
          })
        })
      );
    }, incoming);
    await expectBodyCount(page, 3);
    release();
    await expect(page.getByRole('contentinfo')).toContainText(
      'The project changed while loading that save. Please retry.'
    );
    await expectBodyCount(page, 3);
    await expect(
      page.locator('.revision-row', { hasText: 'Before restore' })
    ).toHaveCount(0);
    await expect(
      page.locator('.revision-row', { hasText: 'Restored “Clicked box”' })
    ).toHaveCount(0);
  } finally {
    release();
  }
});

test('branches a device-only member point while the account cannot be reached', async ({
  page
}) => {
  const server = roomFixture();
  await server.install(page);
  await page.route(
    `**/api/projects/${server.read().projectId}/collaboration`,
    (route) =>
      route.fulfill({ status: 503, json: { error: 'Checkpoint unavailable.' } })
  );
  let remoteCopies = 0;
  await page.route('**/api/projects/*/duplicate', (route) => {
    remoteCopies += 1;
    return route.abort('internetdisconnected');
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill(server.read().name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await addPrimitive(page, /^Box \(B\)/);
  await expectBodyCount(page, 1);
  await startNamedSave(page);
  await expect(page.getByRole('contentinfo')).toContainText(
    'The named save is stored on this device.'
  );
  await addPrimitive(page, /^Cylinder/);
  await expectBodyCount(page, 2);
  const row = page.locator('.revision-row', { hasText: 'Clicked box' });
  await row.hover();
  await row
    .getByRole('button', { name: 'Branch Clicked box into a new project' })
    .click();
  await expect(page.getByRole('contentinfo')).toContainText('Branched');
  expect(remoteCopies).toBe(0);
  await expectBodyCount(page, 2);
  await page.getByTitle('Back to projects').click();
  const branch = page.locator('.start-tile-open', {
    hasText: `${server.read().name} (copy)`
  });
  await expect(branch).toBeVisible();
  await branch.click();
  await expectBodyCount(page, 1);
});

for (const roomStored of [true, false]) {
  test(`a failed device checkpoint reports ${roomStored ? 'room-only storage' : 'an unconfirmed named save'} without claiming a local copy`, async ({
    page
  }) => {
    const server = roomFixture();
    await server.install(page);
    if (!roomStored) {
      await page.route(
        `**/api/projects/${server.read().projectId}/collaboration`,
        (route) =>
          route.fulfill({
            status: 503,
            json: { error: 'The room checkpoint is unavailable.' }
          })
      );
    }
    try {
      await page.goto('/');
      await page.getByLabel('Project name').fill(server.read().name);
      await page.getByRole('button', { name: 'Create project' }).click();
      await addPrimitive(page, /^Box \(B\)/);
      await expectBodyCount(page, 1);
      await expect(
        page.getByRole('status', { name: 'Saved', exact: true })
      ).toBeVisible();
      await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (
          value: unknown,
          key?: IDBValidKey
        ) {
          if (this.name === 'projectCheckpointDocuments') {
            throw new DOMException(
              'Checkpoint storage is full.',
              'QuotaExceededError'
            );
          }
          return key === undefined
            ? put.call(this, value)
            : put.call(this, value, key);
        };
      });
      await startNamedSave(page);
      if (roomStored) {
        await expect.poll(server.requested).toBe(true);
        server.release();
      }
      await expect(page.getByRole('contentinfo')).toContainText(
        'The named save could not be stored on this device.'
      );
      if (roomStored) {
        expect(server.stored()?.bodyOrder).toHaveLength(1);
        await expect(page.getByRole('contentinfo')).toContainText(
          'The revision is stored in the room.'
        );
      } else {
        expect(server.stored()).toBeNull();
      }
      await expect(page.locator('.save-state')).not.toHaveAttribute(
        'title',
        /Saved on this device\. Not in your account\./
      );
      await expect(page.locator('.save-state')).toHaveAttribute(
        'aria-label',
        roomStored ? 'Room only' : 'Save unconfirmed'
      );
      if (roomStored) {
        // A failed retry does not invalidate proof for the unchanged live head.
        let retryRequested = false;
        await page.route(
          `**/api/projects/${server.read().projectId}/collaboration`,
          (route) => {
            retryRequested = true;
            return route.fulfill({
              status: 503,
              json: { error: 'The checkpoint retry is unavailable.' }
            });
          }
        );
        await startNamedSave(page);
        await expect.poll(() => retryRequested).toBe(true);
        await expect(page.getByRole('contentinfo')).toContainText(
          'The room did not confirm a durable named revision. Please retry.'
        );
        await expect(page.locator('.save-state')).toHaveAttribute(
          'aria-label',
          'Room only'
        );
        await expect(page.locator('.save-state')).not.toHaveAttribute(
          'title',
          /exists only in this tab/
        );
      }
      await expectBodyCount(page, 1);
      expect(server.accountWrites()).toBe(0);
    } finally {
      server.release();
      server.releaseAck();
    }
  });
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

for (const timing of ['after adoption', 'before broadcast'] as const) {
  for (const ackFault of ['lost', 'late'] as const) {
    test(`a member checkpoint keeps its server identity with edits ${timing} and a ${ackFault} HTTP acknowledgement`, async ({
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
        const named = page.locator('.revision-row', { hasText: 'Clicked box' });
        if (timing === 'after adoption') {
          server.release();
          await expect(named).toHaveCount(1);
        }
        await addPrimitive(page, /^Cylinder \(C\)/);
        await expectBodyCount(page, 2);
        if (timing === 'before broadcast') {
          expect(server.stored()).toBeNull();
          expect(server.input()?.bodyOrder).toHaveLength(1);
          server.release();
          await expect.poll(() => server.stored()?.bodyOrder.length).toBe(1);
          await expectBodyCount(page, 2);
        }
        if (ackFault === 'lost') server.releaseAck();
        await expect(page.getByRole('contentinfo')).toContainText(
          'The named save is stored on this device.',
          { timeout: ackFault === 'late' ? 20_000 : 10_000 }
        );
        await expect(named).toHaveCount(1);
        await expect.poll(() => server.read().bodyOrder.length).toBe(2);
        await expect
          .poll(() => server.read().checkpoints)
          .toEqual(server.stored()!.checkpoints);
        await expect
          .poll(() => server.read().revisions)
          .toEqual([
            ...server.stored()!.revisions,
            expect.objectContaining({ reason: 'Add cylinder', commandCount: 2 })
          ]);
        expect(server.lastWriteBase()).toBe(server.stored()!.version);
        expect(server.read().version).toBeGreaterThan(server.stored()!.version);
        expect(server.stored()!.bodyOrder).toHaveLength(1);
        expect(server.accountWrites()).toBe(0);
        await page.keyboard.press('ControlOrMeta+z');
        await expectBodyCount(page, 1);
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expectBodyCount(page, 2);
        if (ackFault === 'late') {
          server.releaseAck();
          await page.waitForTimeout(250);
          await expect(named).toHaveCount(1);
          expect(server.read().checkpoints).toEqual(
            server.stored()!.checkpoints
          );
        }
      } finally {
        server.release();
        server.releaseAck();
      }
    });
  }
}

test('a committed member checkpoint fences buffered edits after a new lease replaces the lost lease', async ({
  page
}) => {
  test.setTimeout(60_000);
  const server = roomFixture('late');
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
    await addPrimitive(page, /^Cylinder/);
    await expectBodyCount(page, 2);
    expect(server.input()?.bodyOrder).toHaveLength(1);
    server.release();
    await expect.poll(server.broadcasted).toBe(true);
    await page.evaluate(() => {
      (
        window as unknown as { __checkpointRoundtripSocket: WebSocket }
      ).__checkpointRoundtripSocket.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'lease-lost', reason: 'expired' })
        })
      );
    });
    await expect.poll(server.lastWriteLease).toBe('browser_checkpoint_lease_2');
    expect(server.lastWriteBase()).toBe(server.stored()!.version);
    expect(server.read().version).toBeGreaterThan(server.stored()!.version);
    await expect
      .poll(() => server.read().checkpoints)
      .toEqual(server.stored()!.checkpoints);
    await expect
      .poll(() => server.read().revisions)
      .toEqual([
        ...server.stored()!.revisions,
        expect.objectContaining({ reason: 'Add cylinder', commandCount: 2 })
      ]);
    await expect(page.getByRole('contentinfo')).toContainText(
      'The revision is stored in the room.'
    );
    await expectBodyCount(page, 2);
    await page.keyboard.press('ControlOrMeta+z');
    await expectBodyCount(page, 1);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expectBodyCount(page, 2);
    expect(server.accountWrites()).toBe(0);
  } finally {
    server.release();
    server.releaseAck();
  }
});

for (const [sendTiming, ackFault, sourceArchived] of [
  ['pending', undefined, true],
  ['pending', 'lost', true],
  ['scheduled', undefined, true],
  ['scheduled', 'lost', true],
  ['scheduled-buffered', undefined, true],
  ['scheduled-buffered', undefined, false]
] as const) {
  test(`a member checkpoint accepts the drained copied-source rewrite with a ${ackFault ?? 'confirmed'} HTTP acknowledgement ${sendTiming === 'pending' ? 'after a pending write' : 'before the room-send timer'}${sendTiming === 'scheduled-buffered' ? ` with buffered edits ${sourceArchived ? 'and a server archive' : 'without a server archive'}` : ''}`, async ({
    page
  }) => {
    test.setTimeout(60_000);
    const server = roomFixture(ackFault, true, sourceArchived);
    const buffered = sendTiming === 'scheduled-buffered';
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
      if (sendTiming !== 'pending') {
        expect(server.sourceWritePending()).toBe(false);
        // Hold the actual debounce rather than racing clicks against 500 ms.
        await page.evaluate(() => {
          const nativeTimeout = window.setTimeout.bind(window);
          (
            window as unknown as { __restoreCheckpointSendTimer(): void }
          ).__restoreCheckpointSendTimer = () => {
            window.setTimeout = nativeTimeout;
          };
          window.setTimeout = ((
            handler: TimerHandler,
            delay?: number,
            ...args: unknown[]
          ) =>
            nativeTimeout(
              handler,
              delay === 500 ? 30_000 : delay,
              ...args
            )) as typeof window.setTimeout;
        });
      }
      await addPrimitive(page, /^Box \(B\)/);
      await expectBodyCount(page, 2);
      if (sendTiming === 'pending')
        await expect.poll(server.sourceWritePending).toBe(true);
      else expect(server.sourceWritePending()).toBe(false);
      await startNamedSave(page);
      if (buffered) {
        await expect.poll(server.sourceWritePending).toBe(true);
        await addPrimitive(page, /^Cylinder/);
        await expectBodyCount(page, 3);
        expect(server.requested()).toBe(false);
        expect(server.read().bodyOrder).toHaveLength(1);
      }
      server.releaseSourceWrite();
      await expect.poll(server.requested).toBe(true);
      expect(server.input()?.bodyOrder).toHaveLength(2);
      server.release();
      if (ackFault === 'lost') server.releaseAck();
      await expect.poll(() => server.stored()?.bodyOrder.length).toBe(2);
      expect(
        JSON.stringify(server.stored()).includes(
          'artifact_local_checkpoint_copy'
        )
      ).toBe(!sourceArchived);
      expect(
        JSON.stringify(server.input()).includes(
          'artifact_local_checkpoint_copy'
        )
      ).toBe(!sourceArchived);
      // A full ordinary ACK can replace the toast after naming an unarchived
      // source. Verify the durable server identity as well as the visible row.
      if (sourceArchived)
        await expect(page.getByRole('contentinfo')).toContainText(
          ackFault === 'lost'
            ? 'The named save is stored on this device.'
            : 'Saved revision.'
        );
      await expect(
        page.locator('.revision-row', { hasText: 'Clicked box' })
      ).toHaveCount(1);
      await expect
        .poll(() =>
          page.evaluate(
            (projectId) =>
              new Promise<unknown[]>((resolve, reject) => {
                const open = indexedDB.open('openzcad-v2');
                open.onerror = () =>
                  reject(
                    new Error('Checkpoint database could not open.', {
                      cause: open.error
                    })
                  );
                open.onsuccess = () => {
                  const db = open.result;
                  const tx = db.transaction(
                    'projectCheckpointDocuments',
                    'readonly'
                  );
                  const request = tx
                    .objectStore('projectCheckpointDocuments')
                    .getAll();
                  tx.oncomplete = () => {
                    db.close();
                    resolve(
                      (
                        request.result as Array<{
                          projectId: string;
                          reason: string;
                          checkpointId: string;
                          revisionId: string;
                          documentVersion: number;
                          document: ProjectDocument;
                        }>
                      )
                        .filter(
                          (row) =>
                            row.projectId === projectId &&
                            row.reason === 'Clicked box'
                        )
                        .map((row) => ({
                          checkpointId: row.checkpointId,
                          revisionId: row.revisionId,
                          version: row.documentVersion,
                          bodyCount: row.document.bodyOrder.length
                        }))
                    );
                  };
                  tx.onerror = () => {
                    db.close();
                    reject(
                      new Error('Checkpoint read failed.', { cause: tx.error })
                    );
                  };
                };
              }),
            server.read().projectId
          )
        )
        .toEqual([
          {
            checkpointId: server.stored()!.checkpoints.at(-1)!.checkpointId,
            revisionId: server.stored()!.checkpoints.at(-1)!.revisionId,
            version: server.stored()!.version,
            bodyCount: 2
          }
        ]);
      if (sourceArchived)
        expect(JSON.stringify(server.stored())).toContain(
          'artifact_checkpoint_copy'
        );
      if (sendTiming !== 'pending')
        await page.evaluate(() =>
          (
            window as unknown as { __restoreCheckpointSendTimer(): void }
          ).__restoreCheckpointSendTimer()
        );
      await addPrimitive(page, /^Cylinder \(C\)/);
      await expectBodyCount(page, buffered ? 4 : 3);
      await expect
        .poll(() => server.read().bodyOrder.length)
        .toBe(buffered ? 4 : 3);
      expect(server.read().checkpoints).toEqual(server.stored()!.checkpoints);
      // The seeded import is not a command; every later command must survive.
      if (buffered) {
        expect(server.read().revisions).toHaveLength(
          server.stored()!.revisions.length + 2
        );
        expect(server.read().revisions).toEqual(
          expect.arrayContaining([
            ...server.stored()!.revisions,
            expect.objectContaining({
              reason: 'Add cylinder',
              commandCount: 2
            }),
            expect.objectContaining({ reason: 'Add cylinder', commandCount: 3 })
          ])
        );
      } else {
        expect(server.read().revisions).toEqual([
          ...server.stored()!.revisions,
          expect.objectContaining({ reason: 'Add cylinder', commandCount: 2 })
        ]);
      }
      expect(
        JSON.stringify(server.read()).includes('artifact_local_checkpoint_copy')
      ).toBe(!sourceArchived);
      expect(server.accountWrites()).toBe(0);
      await page.keyboard.press('ControlOrMeta+z');
      await expectBodyCount(page, buffered ? 3 : 2);
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expectBodyCount(page, buffered ? 4 : 3);
    } finally {
      server.releaseSourceWrite();
      server.release();
      server.releaseAck();
    }
  });
}
