import type { Page } from '@playwright/test';
import {
  createProjectDocument,
  createSavedRevision,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  DEFAULT_APP_SETTINGS,
  documentNodesWithHistory,
  toProjectId,
  toUserId,
  type ProjectDocument,
  type ProjectWorkspaceSession,
  type SaveProjectDocumentRequest,
  type UnitSystem
} from '@openzcad/shared';
import type { StoredMeasurementRecord } from '../../apps/web/src/lib/measurementRecord';
import {
  createPrimitiveInPlace,
  createProject,
  expectBodyCount,
  expect,
  seedPanelLayout,
  seedUnitlessImportUnits,
  setSelectionFilter,
  stubApi,
  test,
  withHydratedDocument
} from './openzcad-fixtures';

// Cross-tab IndexedDB sync settles much more slowly on the 2-core CI runners
// than on a workstation; assertion budgets scale up there and stay tight
// locally. These are upper bounds, not waits — a fast run never touches them.
const SYNC_BUDGET_MS = process.env.CI ? 30_000 : 10_000;

const accountUserId = toUserId('user_cloud_sync_e2e');

test('keeps exact geometry and undo through a save echo and reopens compatible saved history without a conflict', async ({
  page
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    // This fixture deliberately has no thumbnail upload service. Its mocked
    // 404 is expected; application exceptions and all other console errors fail.
    if (message.type() !== 'error') return;
    if (
      message.location().url.endsWith('/api/uploads') &&
      message.text().includes('404 (Not Found)')
    )
      return;
    browserErrors.push(message.text());
  });
  const api = new SharedCloudProjectApi();
  await api.install(page);
  await page.addInitScript(() => {
    const counters = window as unknown as { __saveFlowBroadcasts: number };
    counters.__saveFlowBroadcasts = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      override postMessage(
        message: unknown,
        options?: StructuredSerializeOptions | Transferable[]
      ) {
        const request = message as { type?: string; requestId?: string };
        if (request.type === 'sync' && !request.requestId)
          counters.__saveFlowBroadcasts++;
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Save Flow');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  const count = () =>
    page.evaluate(
      () =>
        (window as unknown as { __saveFlowBroadcasts: number })
          .__saveFlowBroadcasts
    );
  const broadcasts = await count();
  // A server echo can advance the fence without changing the exact model.
  await page.route('**/api/projects/*/revisions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const payload = (await withHydratedDocument(
      route.request().postDataJSON()
    )) as {
      document: ProjectDocument;
      reason: string;
      savedRevisionId?: string;
    };
    const version = payload.document.version + 1;
    // The browser minted the save point (ADR-024 Phase 1); this echo keeps it
    // and moves the version, which a pre-Phase 1 server did by minting.
    api.project = withoutDerivedProjection(
      payload.savedRevisionId
        ? {
            ...payload.document,
            version,
            checkpoints: payload.document.checkpoints.map(
              (checkpoint, index) =>
                index === payload.document.checkpoints.length - 1
                  ? { ...checkpoint, documentVersion: version }
                  : checkpoint
            )
          }
        : createSavedRevision({ ...payload.document, version }, payload.reason)
    );
    await route.fulfill({ json: api.project });
  });
  const savedCheckpoints = api.project!.checkpoints.length;
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(() => api.project?.checkpoints.length)
    .toBe(savedCheckpoints + 1);
  await expect
    .poll(() => api.project?.checkpoints.at(-1)?.reason)
    .toBe('Manual save');
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  expect(await count()).toBe(broadcasts);
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true })
  ).toBeEnabled();

  await page.getByTitle('Back to projects').click();
  // Another saved checkpoint at the SAME version used to raise 8-vs-8.
  api.project = withoutDerivedProjection(
    createSavedRevision(api.project!, 'Before drilling')
  );
  await page.locator('.start-tile-open', { hasText: 'Save Flow' }).click();
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(
    page.getByRole('dialog', { name: 'Choose a version to keep' })
  ).toHaveCount(0);
  expect(await count()).toBe(broadcasts);
  const reopenedCheckpoints = api.project.checkpoints.length;
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(() => api.project?.checkpoints.length)
    .toBe(reopenedCheckpoints + 1);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  await expect
    .poll(() =>
      api.project?.checkpoints.some(
        (checkpoint) => checkpoint.reason === 'Before drilling'
      )
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('save-flow.png') });
  expect(browserErrors).toEqual([]);
});

function projectIdFrom(url: string): string {
  const parts = new URL(url).pathname.split('/');
  return decodeURIComponent(parts[3] ?? '');
}

class SharedCloudProjectApi {
  project: ProjectDocument | null = null;
  sessions: ProjectWorkspaceSession[] = [];
  measurement: { revision: number; record: StoredMeasurementRecord } | null =
    null;
  documentUnavailable = false;
  projectLoadAttempts = 0;

  async install(page: Page): Promise<void> {
    await seedPanelLayout(page);
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.assistant.enabled = false;
    settings.files.cloudAutosaveDelaySeconds = 1;

    await page.route('**/api/auth/config', (route) =>
      route.fulfill({
        json: { mode: 'development', emailCodeEnabled: false }
      })
    );
    await page.route('**/api/session', (route) =>
      route.fulfill({
        json: {
          userId: accountUserId,
          displayName: 'Cloud sync E2E',
          mode: 'development'
        }
      })
    );
    await page.route('**/api/settings', (route) =>
      route.fulfill({
        json: {
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
        }
      })
    );
    await page.route('**/api/health', (route) =>
      route.fulfill({
        json: {
          status: 'ok',
          environment: 'beta',
          time: new Date().toISOString(),
          projectSharingEnabled: false,
          projectEditLeasesEnforced: false,
          projectPersonalSyncEnabled: false,
          projectMeasurementStorageReady: true,
          projectMeasurementSyncEnabled: true
        }
      })
    );
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() === 'POST') {
        const payload = (await withHydratedDocument(
          route.request().postDataJSON()
        )) as {
          name: string;
          units?: UnitSystem;
          initialDocument?: ProjectDocument;
        };
        // The browser builds the new project (ADR-024 Phase 1).
        const document =
          payload.initialDocument ??
          createProjectDocument(
            payload.name,
            accountUserId,
            payload.units ?? 'mm'
          );
        this.project = withoutDerivedProjection(document);
        this.measurement = null;
        return route.fulfill({
          status: 201,
          json: {
            project: this.summary(this.project),
            document: this.project
          }
        });
      }
      return route.fulfill({
        json: { projects: this.project ? [this.summary(this.project)] : [] }
      });
    });
    await page.route('**/api/projects/*/document', async (route) => {
      const current = this.project;
      const payload = (await withHydratedDocument(
        route.request().postDataJSON()
      )) as SaveProjectDocumentRequest;
      if (
        !current ||
        payload.projectId !== current.projectId ||
        payload.expectedVersion !== current.version
      ) {
        return route.fulfill({
          status: 409,
          json: {
            error: 'The account has a newer project version.',
            code: 'REVISION_CONFLICT',
            currentVersion: current?.version ?? 0
          }
        });
      }
      this.project = withoutDerivedProjection({
        ...payload.document,
        ownerUserId: accountUserId
      });
      this.documentUnavailable = false;
      return route.fulfill({
        json: {
          projectId: this.project.projectId,
          version: this.project.version,
          updatedAt: this.project.derived.updatedAt
        }
      });
    });
    await page.route('**/api/projects/*/revisions', async (route) => {
      const current = this.project;
      // The history panel GETs this path when a project opens; only an
      // explicit save POSTs to it. Reading post data off the GET throws inside
      // the handler and strands the page, so the verb decides first.
      if (route.request().method() !== 'POST') {
        return route.fulfill({ json: { revisions: [], maxRevisions: 50 } });
      }
      const payload = (await withHydratedDocument(
        route.request().postDataJSON()
      )) as {
        expectedVersion: number;
        document: ProjectDocument;
      };
      if (!current || payload.expectedVersion !== current.version) {
        return route.fulfill({
          status: 409,
          json: {
            error: 'The account has a newer project version.',
            code: 'REVISION_CONFLICT',
            currentVersion: current?.version ?? 0
          }
        });
      }
      this.project = withoutDerivedProjection({
        ...payload.document,
        ownerUserId: accountUserId
      });
      return route.fulfill({ json: this.project });
    });
    await page.route('**/api/projects/*/measurements', async (route) => {
      const projectId = projectIdFrom(route.request().url());
      if (!this.project || projectId !== this.project.projectId) {
        return route.fulfill({ status: 404, json: { error: 'Not found.' } });
      }
      if (route.request().method() === 'GET') {
        return route.fulfill({
          json: this.measurement ?? { revision: 0, record: null }
        });
      }
      if (route.request().method() === 'PUT') {
        const payload = route.request().postDataJSON() as {
          expectedRevision: number;
          record: StoredMeasurementRecord;
        };
        const currentRevision = this.measurement?.revision ?? 0;
        if (payload.expectedRevision !== currentRevision) {
          return route.fulfill({
            status: 409,
            json: {
              error: 'The account has newer measurements.',
              code: 'MEASUREMENT_REVISION_CONFLICT',
              currentRevision
            }
          });
        }
        this.measurement = {
          revision: currentRevision + 1,
          record: structuredClone(payload.record)
        };
        return route.fulfill({ json: this.measurement });
      }
      return route.fulfill({ status: 405, json: { error: 'Unsupported.' } });
    });
    await page.route('**/api/projects/*/artifacts', (route) =>
      route.fulfill({ json: { artifacts: [] } })
    );
    await page.route('**/api/projects/*', (route) => {
      const projectId = projectIdFrom(route.request().url());
      if (
        route.request().method() !== 'GET' ||
        !this.project ||
        this.project.projectId !== projectId
      ) {
        return route.fulfill({
          status: 404,
          json: { error: `Project ${projectId} not found.` }
        });
      }
      this.projectLoadAttempts += 1;
      if (this.documentUnavailable) {
        return route.fulfill({
          status: 503,
          json: {
            error:
              'The account copy of this project is temporarily unavailable. Your work remains saved on this device.',
            code: 'PROJECT_DOCUMENT_UNAVAILABLE'
          }
        });
      }
      return route.fulfill({ json: this.project });
    });
    await page.route('**/api/projects/*/workspace-sessions', async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: { sessions: this.sessions } });
      const record = route.request().postDataJSON() as ProjectWorkspaceSession;
      this.sessions = [
        { ...record, updatedAt: new Date().toISOString() },
        ...this.sessions.filter(
          (session) => session.sessionId !== record.sessionId
        )
      ];
      return route.fulfill({ status: 204 });
    });
    await page.route('**/api/account/storage', (route) =>
      route.fulfill({
        json: {
          projectCount: this.project ? 1 : 0,
          documentBytes: this.project
            ? new TextEncoder().encode(JSON.stringify(this.project)).byteLength
            : 0,
          revisionBytes: 0,
          revisionCount: 0,
          documentLimitBytes: 24 * 1024 * 1024,
          maxRevisionsPerProject: 50
        }
      })
    );
    await page.route('**/api/exports', (route) =>
      route.fulfill({ status: 404, json: { error: 'stub' } })
    );
    await page.route('**/api/uploads', (route) =>
      route.fulfill({ status: 404, json: { error: 'stub' } })
    );
  }

  private summary(document: ProjectDocument) {
    return {
      projectId: toProjectId(document.projectId),
      name: document.name,
      lastRevisionId: document.revisions.at(-1)?.revisionId,
      documentVersion: document.version,
      revisionCount: document.checkpoints.length,
      updatedAt: document.derived.updatedAt
    };
  }
}

async function switchWorkspace(page: Page, to: 'View' | 'Build') {
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: to })
    .click();
}

async function armMeasure(page: Page) {
  await page
    .getByRole('toolbar', { name: 'View tools' })
    .getByRole('button', { name: 'Measure' })
    .click();
}

async function locateEdge(page: Page) {
  const canvas = page.locator('.viewer-host canvas');
  let found: { x: number; y: number } | null = null;
  await expect
    .poll(async () => {
      found = await canvas.evaluate(
        (element) =>
          new Promise<{ x: number; y: number } | null>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-locate-edge', {
                detail: { resolve }
              })
            );
          })
      );
      return found !== null;
    })
    .toBe(true);
  return found!;
}

async function renameProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Rename project' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByLabel('Project name').press('Enter');
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(name);
}

test('drains a pending account edit before opening a public share', async ({
  page
}) => {
  const api = new SharedCloudProjectApi();
  await api.install(page);
  const shared = createProjectDocument(
    'Public navigation target',
    toUserId('other_owner')
  );
  await page.route('**/api/share/*', (route) =>
    route.fulfill({
      json: {
        document: shared,
        project: { projectId: shared.projectId, name: shared.name },
        mode: 'tweak'
      }
    })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill('Account before navigation');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  await page.waitForTimeout(1500);
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
  await renameProject(page, 'Account edit retained');
  expect(api.project?.name).toBe('Account before navigation');
  await page.evaluate(() => {
    window.location.hash = `share=${'p'.repeat(43)}`;
  });
  await expect(page.locator('.breadcrumb')).toContainText(shared.name);
  expect(api.project?.name).toBe('Account edit retained');
  // The drain is proved above with the debounce clock still paused. Resume
  // painting as the shared workspace's remaining lazy tools arrive.
  await page.clock.resume();
  await expect(
    page.getByRole('button', { name: 'Make a copy', exact: true })
  ).toBeVisible();
});

test('drains a pending account edit before opening an invitation', async ({
  page
}) => {
  const api = new SharedCloudProjectApi();
  await stubApi(page, { collaborationRole: 'owner' });
  await api.install(page);
  const invited = createProjectDocument(
    'Invitation navigation target',
    toUserId('other_owner')
  );
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
  await page.route('**/api/project-invitations/accept', (route) =>
    route.fulfill({ json: { projectId: invited.projectId, role: 'editor' } })
  );
  await page.route(`**/api/projects/${invited.projectId}`, (route) =>
    route.fulfill({ json: invited })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill('Account before invitation');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible();
  await page.waitForTimeout(1500);
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
  await renameProject(page, 'Invitation edit retained');
  expect(api.project?.name).toBe('Account before invitation');
  await page.evaluate(() => {
    window.location.hash = `invite=${'i'.repeat(43)}`;
  });
  await expect(page.locator('.breadcrumb')).toContainText(invited.name);
  expect(api.project?.name).toBe('Invitation edit retained');
});

for (const action of ['edit', 'leave', 'switch', 'share'] as const) {
  test(`preserves the active workspace after a pending manual save and ${action}`, async ({
    page
  }) => {
    const api = new SharedCloudProjectApi();
    await api.install(page);
    const shared = createProjectDocument(
      'Shared during checkpoint',
      toUserId('other_owner')
    );
    await page.route('**/api/share/*', (route) =>
      route.fulfill({
        json: {
          document: shared,
          project: { projectId: shared.projectId, name: shared.name },
          mode: 'tweak'
        }
      })
    );
    await page.goto('/');
    await page.getByLabel('Project name').fill('Pending save');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(
      page.getByRole('status', { name: 'Saved', exact: true })
    ).toBeVisible();

    let release!: () => void;
    let received!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    await page.route('**/api/projects/*/revisions', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const { document } = (await withHydratedDocument(
        route.request().postDataJSON()
      )) as {
        document: ProjectDocument;
      };
      received();
      await responseGate;
      await route.fulfill({ json: document });
    });
    await page.keyboard.press('ControlOrMeta+s');
    await requestReceived;

    try {
      if (action === 'edit') {
        await renameProject(page, 'Newer edit');
      } else if (action === 'share') {
        await page.evaluate(() => {
          window.location.hash = `share=${'s'.repeat(43)}`;
        });
        await expect(page.locator('.breadcrumb')).toContainText(shared.name);
      } else {
        await page.getByTitle('Back to projects').click();
        await expect(
          page.getByRole('button', { name: 'Create project' })
        ).toBeVisible();
        if (action === 'switch') {
          await page.getByLabel('Project name').fill('Different project');
          await page.getByRole('button', { name: 'Create project' }).click();
          await expect(
            page.getByRole('button', { name: 'Rename project' })
          ).toContainText('Different project');
        }
      }
    } finally {
      release();
    }
    // Let the response and the following IndexedDB writes finish before asserting.
    await page.waitForTimeout(1000);
    if (action === 'share') {
      await expect(page.locator('.breadcrumb')).toContainText(shared.name);
      await expect(
        page.getByRole('button', { name: 'Make a copy', exact: true })
      ).toBeVisible();
      expect(await storedProjectNames(page)).toContain('Pending save');
      expect(await storedProjectNames(page)).not.toContain(shared.name);
    } else if (action === 'leave') {
      await expect(
        page.getByRole('button', { name: 'Create project' })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Rename project' })
      ).toHaveCount(0);
    } else {
      const expected = action === 'edit' ? 'Newer edit' : 'Different project';
      await expect(
        page.getByRole('button', { name: 'Rename project' })
      ).toContainText(expected);
      await expect.poll(() => storedProjectNames(page)).toContain(expected);
    }
  });
}

/** The names this device has actually committed to IndexedDB. */
async function storedProjectNames(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () =>
          reject(new Error(open.error?.message ?? 'IndexedDB unavailable.'));
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('projects')) {
            database.close();
            resolve([]);
            return;
          }
          const all = database
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          all.onerror = () =>
            reject(new Error(all.error?.message ?? 'Project read failed.'));
          all.onsuccess = () => {
            resolve((all.result as { name: string }[]).map(({ name }) => name));
            database.close();
          };
        };
      })
  );
}

/**
 * A canonical edit must start its device write without waiting for the
 * derived-state debounce or a departure event.
 *
 * Timers are frozen before the edit so that debounce provably cannot fire on
 * its own. Freezing has to wait for the app to go quiet first: a real timer
 * armed before the fake clock is installed stays scheduled, and could store
 * the edit even if canonical changes still incorrectly waited for a timer.
 */
test('writes a canonical edit without waiting for the autosave debounce', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Debounce Window');
  await expect
    .poll(() => storedProjectNames(page), { timeout: SYNC_BUDGET_MS })
    .toContain('Debounce Window');
  // Outlasts the trailing debounce that follows the first derived rebuild.
  await page.waitForTimeout(1500);

  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await renameProject(page, 'Saved Without Departure');
  await expect
    .poll(() => storedProjectNames(page), { timeout: SYNC_BUDGET_MS })
    .toContain('Saved Without Departure');
});

/**
 * Reopening a project is an adoption, not an edit. The account already holds
 * exactly this version, so mirroring it back is a write nobody asked for — and
 * on the collaboration path, where every inbound frame arrives the same way, it
 * is a write per frame fenced against a version the room may not have persisted
 * yet, which surfaces as a conflict the user never caused.
 */
/**
 * Two tabs autosaving one project write the whole document to the same key, so
 * the slower one lands last and the other tab's work stops existing. The second
 * tab opens read-only instead of competing.
 */
test('opens a project read-only when another tab already has it', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Two Tabs');
  await expect
    .poll(() => storedProjectNames(page), { timeout: SYNC_BUDGET_MS })
    .toContain('Two Tabs');

  // A second tab restores the same active project on its own. Assert the name
  // alone, not the rename button: the title is only a button while the tab
  // still believes it may edit, so once the claim resolves — the very thing
  // this test is about — the button is gone and the name is plain text. The
  // button form is a pre-claim frame this used to race, and win.
  const second = await page.context().newPage();
  await stubApi(second);
  await second.goto('/');
  await expect(second.getByRole('banner')).toContainText('Two Tabs');

  await expect(second.getByRole('button', { name: /^Box \(B\)/ })).toBeDisabled(
    { timeout: SYNC_BUDGET_MS }
  );
  // The dimmed rail is explained once, in the lane, not only in each
  // button's tooltip.
  await expect(
    second.locator('.workspace-toast-body [role="status"]')
  ).toContainText('Editing is locked: this project is open in another tab.');
  // And settles on saying so, rather than leaving up a save that is never
  // going to happen. Claiming the project is asynchronous, so the indicator
  // reads as saving until the answer arrives.
  await expect(
    second.getByRole('group', { name: 'Workspace status', exact: true })
  ).toContainText('syncLocal only', { timeout: SYNC_BUDGET_MS });

  // The tab that owns it keeps editing.
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeEnabled();
  await renameProject(page, 'Owner latest');
  await expect.poll(() => storedProjectNames(page)).toEqual(['Owner latest']);
  // The waiting tab still displays its older snapshot. Save must check the
  // ownership lock before touching the shared device record.
  await second.keyboard.press('ControlOrMeta+s');
  await expect(
    second.locator('.workspace-toast-body [role="status"]')
  ).toContainText('Editing is locked');
  await second.waitForTimeout(500);
  expect(await storedProjectNames(second)).toEqual(['Owner latest']);

  // Handing the project back promotes the tab that was waiting for it.
  await page.goto('about:blank');
  await expect(second.getByRole('button', { name: /^Box \(B\)/ })).toBeEnabled({
    timeout: SYNC_BUDGET_MS
  });
  await expect(
    second.locator('.workspace-toast-body [role="status"]')
  ).toContainText('Editing this project here now.');
  await expect(second.getByRole('banner')).toContainText('Owner latest');
  await second.close();
});

test('does not write to the account when a project is only reopened', async ({
  page
}) => {
  const api = new SharedCloudProjectApi();
  await api.install(page);
  let documentWrites = 0;
  page.on('request', (request) => {
    if (
      /\/api\/projects\/[^/]+\/document$/.test(new URL(request.url()).pathname)
    ) {
      documentWrites += 1;
    }
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('Reopen Echo');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('group', { name: 'Workspace status', exact: true })
  ).toContainText('syncSynced', { timeout: SYNC_BUDGET_MS });

  documentWrites = 0;
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Reopen Echo');
  await expect(
    page.getByRole('group', { name: 'Workspace status', exact: true })
  ).toContainText('syncSynced', { timeout: SYNC_BUDGET_MS });
  // Outlasts this fixture's 1 s cloud-autosave delay, so a queued mirror of the
  // adopted document would have been sent by now.
  await page.waitForTimeout(3000);
  expect(documentWrites).toBe(0);
});

test('restores an unreadable account document from the confirmed device copy', async ({
  page
}) => {
  const api = new SharedCloudProjectApi();
  await api.install(page);

  await page.goto('/');
  await page.getByLabel('Project name').fill('Repair Fixture');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('status', { name: 'Saved' })).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });

  api.documentUnavailable = true;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Repair needed' })).toBeVisible(
    { timeout: SYNC_BUDGET_MS }
  );
  await expect(
    page.getByRole('group', { name: 'Workspace status', exact: true })
  ).toContainText('syncAccount repair needed');
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Repair Fixture');

  await renameProject(page, 'Repair Fixture edited locally');
  await expect
    .poll(() => storedProjectNames(page), { timeout: SYNC_BUDGET_MS })
    .toContain('Repair Fixture edited locally');
  // Outlast this fixture's 1 s cloud-autosave delay before baselining the
  // retry count, so the rename's queued mirror has already been refused
  // scheduling and the repair state is settled rather than mid-flight.
  await page.waitForTimeout(3000);
  await expect(page.getByRole('button', { name: 'Repair needed' })).toBeVisible(
    { timeout: SYNC_BUDGET_MS }
  );

  const attemptsBeforeRetry = api.projectLoadAttempts;
  const restorePrompt = page.waitForEvent('dialog').then(async (dialog) => {
    const message = dialog.message();
    await dialog.dismiss();
    return message;
  });
  await page.getByRole('button', { name: 'Repair needed' }).click();
  await expect(
    page.getByRole('button', { name: 'Repair needed' })
  ).toBeVisible();
  expect(api.projectLoadAttempts).toBe(attemptsBeforeRetry + 1);
  expect(await restorePrompt).toContain(
    'Restore Repair Fixture edited locally in your account'
  );
  expect(api.project?.name).toBe('Repair Fixture');

  const acceptRestore = page
    .waitForEvent('dialog')
    .then((dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Repair needed' }).click();
  await acceptRestore;
  await expect
    .poll(() => api.project?.name, { timeout: SYNC_BUDGET_MS })
    .toBe('Repair Fixture edited locally');
  expect(api.documentUnavailable).toBe(false);
  await expect(page.getByRole('status', { name: 'Saved' })).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
});

class RecoveryMeshArchive {
  readonly artifactId = 'artifact_recovery_mesh_e2e';
  attempts = 0;
  downloads = 0;
  body: Buffer | null = null;
  projectId = '';

  constructor(readonly available: boolean) {}

  async install(page: Page) {
    await page.route('**/api/uploads', async (route) => {
      const input = route.request().postDataJSON() as {
        projectId: string;
        kind: string;
      };
      if (input.kind !== 'mesh-payload') return route.fallback();
      this.attempts++;
      if (!this.available)
        return route.fulfill({
          status: 503,
          json: { error: 'Recovery source upload unavailable.' }
        });
      this.projectId = input.projectId;
      return route.fulfill({
        status: 201,
        json: {
          session: {
            uploadSessionId: 'upload_recovery_mesh_e2e',
            artifactId: this.artifactId,
            projectId: input.projectId,
            objectKey: `${input.projectId}/${this.artifactId}`,
            uploadUrl: '/api/uploads/upload_recovery_mesh_e2e/content',
            expiresAt: '2099-01-01T00:00:00.000Z'
          }
        }
      });
    });
    await page.route(
      '**/api/uploads/upload_recovery_mesh_e2e/content',
      (route) => {
        this.body = route.request().postDataBuffer();
        return route.fulfill({ status: 204 });
      }
    );
    await page.route('**/api/artifacts/finalize', (route) => {
      const input = route.request().postDataJSON() as { artifactId: string };
      return input.artifactId === this.artifactId
        ? route.fulfill({ json: { artifactId: this.artifactId } })
        : route.fallback();
    });
    await page.route(`**/api/artifacts/${this.artifactId}`, (route) =>
      route.fulfill({
        json: {
          artifact: {
            artifactId: this.artifactId,
            projectId: this.projectId,
            kind: 'mesh-payload',
            name: 'Recovered mesh payload',
            contentType: 'application/vnd.openzcad.mesh-payload',
            bytes: this.body?.byteLength ?? 0,
            objectKey: `${this.projectId}/${this.artifactId}`,
            metadata: {},
            createdAt: new Date().toISOString()
          }
        }
      })
    );
    await page.route(
      `**/api/artifacts/${this.artifactId}/download`,
      (route) => {
        this.downloads++;
        return this.body
          ? route.fulfill({
              body: this.body,
              contentType: 'application/vnd.openzcad.mesh-payload'
            })
          : route.fulfill({ status: 404 });
      }
    );
  }
}

function meshArtifactIds(document: ProjectDocument | null) {
  return document
    ? Array.from(documentNodesWithHistory(document)).flatMap((node) =>
        node.kind === 'feature' && node.data.featureKind === 'imported-mesh'
          ? [node.data.artifactId]
          : []
      )
    : [];
}

for (const uploadAvailable of [true, false]) {
  test(`repairs imported mesh sources ${uploadAvailable ? 'before restoring an unreadable account copy' : 'without claiming success when the required upload fails'}`, async ({
    page,
    browser
  }) => {
    test.setTimeout(90_000);
    const api = new SharedCloudProjectApi();
    await api.install(page);
    await seedUnitlessImportUnits(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Imported repair fixture');
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await expect(
      page.getByRole('status', { name: 'Saved', exact: true })
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    // The original import cannot archive, but its canonical payload is durable
    // on this browser. Recovery must later carry these exact bytes to account.
    await page
      .getByLabel(/^Import FreeCAD, STEP or /)
      .setInputFiles('samples/simple-block.stl');
    await expectBodyCount(page, 1);
    await expect
      .poll(
        () =>
          meshArtifactIds(api.project).some((id) =>
            id.startsWith('artifact_local_')
          ),
        { timeout: SYNC_BUDGET_MS }
      )
      .toBe(true);
    const importedVersion = api.project!.version;
    const importedHistoryCursor = api.project!.editHistory?.cursor;
    expect(importedHistoryCursor).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectBodyCount(page, 0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectBodyCount(page, 1);
    // A late Redo autosave would repair the fixture after we mark its account
    // copy unreadable. Wait for that exact edit and its acknowledgement before
    // reloading; the imported model alone also describes the earlier snapshot.
    await expect
      .poll(
        () => ({
          version: api.project?.version,
          historyCursor: api.project?.editHistory?.cursor,
          bodies: api.project?.bodyOrder.length
        }),
        { timeout: SYNC_BUDGET_MS }
      )
      .toEqual({
        version: importedVersion + 2,
        historyCursor: importedHistoryCursor,
        bodies: 1
      });
    await expect(
      page.getByRole('button', { name: 'Local source', exact: true })
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    api.documentUnavailable = true;
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Repair needed', exact: true })
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await expectBodyCount(page, 1);
    const archive = new RecoveryMeshArchive(uploadAvailable);
    await archive.install(page);
    let restores = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/api\/projects\/[^/]+\/document$/.test(
          new URL(request.url()).pathname
        )
      )
        restores++;
    });
    const accepted = page
      .waitForEvent('dialog')
      .then((dialog) => dialog.accept());
    await page
      .getByRole('button', { name: 'Repair needed', exact: true })
      .click();
    await accepted;
    await expect
      .poll(() => archive.attempts, { timeout: SYNC_BUDGET_MS })
      .toBeGreaterThan(0);
    if (!uploadAvailable) {
      await expect(page.getByRole('contentinfo')).toContainText(
        'The account copy was not restored'
      );
      await expect(
        page.getByRole('button', { name: 'Repair needed', exact: true })
      ).toBeVisible();
      expect(api.documentUnavailable).toBe(true);
      expect(restores).toBe(0);
      await expectBodyCount(page, 1);
      return;
    }
    await expect.poll(() => api.documentUnavailable).toBe(false);
    expect(archive.body?.byteLength).toBeGreaterThan(0);
    const ids = meshArtifactIds(api.project);
    expect(ids.length).toBeGreaterThan(1); // current plus undo/redo history
    expect(new Set(ids)).toEqual(new Set([archive.artifactId]));
    // Recovery must retain one canonical revision lineage on this device and
    // in the account. Independent archive revisions used to diverge on reload.
    await page.reload();
    await expect(
      page.getByRole('status', { name: 'Saved', exact: true })
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await expect(
      page.getByRole('dialog', { name: 'Choose a version to keep' })
    ).toHaveCount(0);
    await expectBodyCount(page, 1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectBodyCount(page, 0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectBodyCount(page, 1);
    await expect(
      page.getByRole('status', { name: 'Saved', exact: true })
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await expect(
      page.getByRole('dialog', { name: 'Choose a version to keep' })
    ).toHaveCount(0);
    // Finish the original device before clearing its optional view handoff.
    // A late session write would otherwise open the fresh device's resume UI.
    await page.close();
    api.sessions = [];
    const device = await browser.newContext();
    try {
      const fresh = await device.newPage();
      await api.install(fresh);
      await archive.install(fresh);
      await fresh.goto('/');
      await fresh
        .locator('.start-tile-open', { hasText: 'Imported repair fixture' })
        .click();
      await expectBodyCount(fresh, 1);
      await expect(
        fresh.getByRole('status', { name: 'Saved', exact: true })
      ).toBeVisible({ timeout: SYNC_BUDGET_MS });
      await expect.poll(() => archive.downloads).toBeGreaterThan(0);
      await fresh.getByRole('button', { name: 'Undo', exact: true }).click();
      await expectBodyCount(fresh, 0);
      await fresh.getByRole('button', { name: 'Redo', exact: true }).click();
      await expectBodyCount(fresh, 1);
      await expect(
        fresh.getByRole('status', { name: 'Saved', exact: true })
      ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    } finally {
      await device.close();
    }
  });
}

test('does not restore an unreadable account document from an older device copy', async ({
  page
}) => {
  const api = new SharedCloudProjectApi();
  await api.install(page);
  let documentWrites = 0;
  page.on('request', (request) => {
    if (
      /\/api\/projects\/[^/]+\/document$/.test(new URL(request.url()).pathname)
    ) {
      documentWrites += 1;
    }
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('Older Repair Fixture');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('status', { name: 'Saved' })).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });

  api.project = {
    ...api.project!,
    version: api.project!.version + 10
  };
  api.documentUnavailable = true;
  documentWrites = 0;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Repair needed' })).toBeVisible(
    { timeout: SYNC_BUDGET_MS }
  );

  await page.getByRole('button', { name: 'Repair needed' }).click();
  await expect(
    page.getByRole('button', {
      name: /Open activity log\. Current status: The account record is newer/
    })
  ).toBeVisible();
  expect(documentWrites).toBe(0);
  await expect(
    page.getByRole('button', { name: 'Repair needed' })
  ).toBeVisible();
});

test('syncs View measurements to a second device without changing the CAD document', async ({
  browser
}) => {
  test.setTimeout(60_000);
  const api = new SharedCloudProjectApi();
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext();
  const pageA = await deviceA.newPage();
  const pageB = await deviceB.newPage();

  try {
    await api.install(pageA);
    await api.install(pageB);

    await pageA.goto('/');
    await pageA.getByLabel('Project name').fill('Measured Across Devices');
    await pageA.getByRole('button', { name: 'Create project' }).click();
    await createPrimitiveInPlace(pageA, 'box');
    await expect(pageA.getByRole('status', { name: 'Saved' })).toBeVisible({
      timeout: SYNC_BUDGET_MS
    });
    const canonicalBeforeMeasurement = structuredClone(api.project);

    await switchWorkspace(pageA, 'View');
    await armMeasure(pageA);
    await setSelectionFilter(pageA, 'Edge');
    const edge = await locateEdge(pageA);
    await pageA.mouse.click(edge.x, edge.y);
    const measured = await pageA
      .getByLabel('Measurement workbench')
      .getByRole('listitem')
      .textContent();
    expect(measured).toBeTruthy();
    await expect
      .poll(() => api.measurement?.record.measurements.length, {
        timeout: SYNC_BUDGET_MS
      })
      .toBe(1);
    expect(api.project).toEqual(canonicalBeforeMeasurement);

    // Blacksmith caught the receiving device between its stored-record apply
    // and exact-body refresh: the row had advanced to this document revision
    // as unresolved, then the same-revision short-circuit made that transient
    // status permanent even after the body arrived. A persisted row is only a
    // receipt; device B must re-derive its runtime status from its exact body.
    api.measurement!.record.measurements[0] = {
      ...api.measurement!.record.measurements[0]!,
      status: 'unresolved',
      reason: 'body-missing'
    };

    // Device A also publishes its view session. Wait for that real handoff
    // before opening B, then explicitly keep B's default view: the resume
    // dialog otherwise races the Measure click and blocks the entire test.
    await expect
      .poll(() => api.sessions.length, { timeout: SYNC_BUDGET_MS })
      .toBeGreaterThan(0);
    await pageB.goto('/');
    await pageB
      .locator('.start-tile-open', { hasText: 'Measured Across Devices' })
      .click();
    const resume = pageB.getByRole('dialog', {
      name: 'Resume where you left off?'
    });
    await resume
      .getByRole('button', { name: 'Open with default view' })
      .click();
    await expect(resume).toHaveCount(0);
    await switchWorkspace(pageB, 'View');
    await armMeasure(pageB);
    await expect(
      pageB.getByLabel('Measurement workbench').getByRole('listitem')
    ).toHaveText(measured!);
  } finally {
    await deviceA.close();
    await deviceB.close();
  }
});

for (const resolution of [
  'use-remote',
  'keep-mine',
  'save-local-copy'
] as const) {
  test(`syncs across two devices with explicit conflict choice ${resolution}`, async ({
    browser
  }, testInfo) => {
    test.setTimeout(60_000);
    const api = new SharedCloudProjectApi();
    const deviceA = await browser.newContext();
    const deviceB = await browser.newContext({
      viewport:
        resolution === 'save-local-copy'
          ? { width: 390, height: 740 }
          : { width: 1280, height: 800 },
      timezoneId: 'America/Detroit'
    });
    const pageA = await deviceA.newPage();
    const pageB = await deviceB.newPage();

    try {
      await api.install(pageA);
      await api.install(pageB);

      await pageA.goto('/');
      await pageA.getByLabel('Project name').fill('Shared Bracket');
      await pageA.getByRole('button', { name: 'Create project' }).click();
      await expect(pageA.getByRole('status', { name: 'Saved' })).toBeVisible({
        timeout: SYNC_BUDGET_MS
      });
      await expect(
        pageA.getByRole('group', { name: 'Workspace status', exact: true })
      ).toContainText('syncSynced');

      await pageA.reload();
      await expect(
        pageA.getByRole('button', { name: 'Rename project' })
      ).toContainText('Shared Bracket');
      // A reload is a second cold start, so the save chip passes back through
      // "Saving" before it settles — the same allowance the first open above
      // already takes. It does not excuse a save that never lands: a document
      // that never reaches the account stays on "Saving" and still fails here.
      await expect(pageA.getByRole('status', { name: 'Saved' })).toBeVisible({
        timeout: SYNC_BUDGET_MS
      });

      await pageB.goto('/');
      await pageB
        .locator('.start-tile-open', { hasText: 'Shared Bracket' })
        .click();
      await expect(
        pageB.getByRole('button', { name: 'Rename project' })
      ).toContainText('Shared Bracket');
      await expect(pageB.getByRole('status', { name: 'Saved' })).toBeVisible({
        timeout: SYNC_BUDGET_MS
      });

      await renameProject(pageA, 'Shared Bracket from A');
      await expect
        .poll(() => api.project?.name, { timeout: SYNC_BUDGET_MS })
        .toBe('Shared Bracket from A');

      await pageB.bringToFront();
      await pageB.evaluate(() => {
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('focus'));
      });
      await expect(
        pageB.getByRole('button', { name: 'Rename project' })
      ).toContainText('Shared Bracket from A', { timeout: SYNC_BUDGET_MS });

      await renameProject(pageB, 'Device B unsent edit');
      await deviceB.setOffline(true);
      await renameProject(pageA, 'Device A account edit');
      await pageA.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      await expect
        .poll(() => api.project?.name, { timeout: SYNC_BUDGET_MS })
        .toBe('Device A account edit');
      await deviceB.setOffline(false);

      const conflict = pageB.getByRole('dialog', {
        name: 'Choose a version to keep'
      });
      await expect(conflict).toBeVisible({ timeout: SYNC_BUDGET_MS });
      await pageB.screenshot({
        path: testInfo.outputPath('conflict-details.png')
      });
      // The top bar's save state is the one sync readout now.
      await expect(pageB.locator('.save-state')).toContainText('Conflict');
      // A lower overlay may mount after async conflict detection. The account
      // dialog remains painted above it and must not become inert just because
      // the lower overlay registered its focus trap later.
      await pageB.keyboard.press('?');
      await expect(
        pageB.locator('.conflict-dialog').locator('..')
      ).not.toHaveAttribute('inert', '');
      const originalProjectId = api.project!.projectId;
      const choice =
        resolution === 'keep-mine'
          ? /^This browser/
          : resolution === 'use-remote'
            ? /^Cloud/
            : /^Keep both/;
      const times = conflict.locator('time');
      await expect(times).toHaveCount(2);
      await expect(times.nth(0)).toHaveAttribute('datetime', /T/);
      await expect(times.nth(1)).toHaveAttribute('datetime', /T/);
      await expect(
        conflict.getByRole('button', { name: /^Cloud/ })
      ).toContainText('Newer');
      if (resolution === 'keep-mine') {
        await conflict.getByRole('button', { name: choice }).focus();
        await pageB.keyboard.press('Enter');
      } else {
        await conflict.getByRole('button', { name: choice }).click();
      }
      await pageB.keyboard.press('Escape');
      await expect(
        pageB.getByRole('button', { name: 'Rename project' })
      ).toContainText(
        resolution === 'keep-mine'
          ? 'Device B unsent edit'
          : 'Device A account edit'
      );
      await expect(pageB.getByRole('status', { name: 'Saved' })).toBeVisible();
      expect(api.project!.projectId).toBe(originalProjectId);

      await pageB.getByTitle('Back to projects').click();
      await expect(pageB.locator('.start-tile')).toHaveCount(
        resolution === 'save-local-copy' ? 2 : 1
      );
      await expect(
        pageB.getByText('Recovery copy', { exact: true })
      ).toHaveCount(0);
      if (resolution === 'save-local-copy') {
        const copy = pageB.locator('.start-tile-open', {
          hasText: 'Device B unsent edit (copy)'
        });
        await expect(copy).toBeVisible();
        await expect(copy.locator('.start-tile-rev')).toHaveText('1 save');
        await copy.click();
        await expect(
          pageB.getByRole('button', { name: 'Undo', exact: true })
        ).toBeEnabled();
        await pageB.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(
          pageB.getByRole('button', { name: 'Rename project' })
        ).toContainText('Shared Bracket from A');
        await pageB.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect(
          pageB.getByRole('button', { name: 'Rename project' })
        ).toContainText('Device B unsent edit (copy)');
      }
    } finally {
      await deviceA.close();
      await deviceB.close();
    }
  });
}

test('resumes a workspace on another device and carries undo and redo back across devices', async ({
  browser
}) => {
  test.setTimeout(90_000);
  const cloud = new SharedCloudProjectApi();
  const deviceA = await browser.newContext();
  const deviceB = await browser.newContext({
    viewport: { width: 900, height: 800 }
  });
  const a = await deviceA.newPage();
  const b = await deviceB.newPage();
  try {
    await cloud.install(a);
    await cloud.install(b);
    await a.goto('/');
    await a.getByLabel('Project name').fill('History handoff');
    await a.getByRole('button', { name: 'Create project' }).click();
    await createPrimitiveInPlace(a, 'box');
    await expect
      .poll(() => cloud.project?.bodyOrder.length, { timeout: SYNC_BUDGET_MS })
      .toBe(1);
    await expect
      .poll(() => cloud.sessions.length, { timeout: SYNC_BUDGET_MS })
      .toBeGreaterThan(0);
    await a.getByRole('button', { name: /^Orthographic projection/ }).click();
    await expect
      .poll(() => cloud.sessions[0]?.state.projection, {
        timeout: SYNC_BUDGET_MS
      })
      .toBe('orthographic');
    const before = structuredClone(cloud.project!);
    const camera = structuredClone(cloud.sessions[0]!.state.camera);
    await b.goto('/');
    await b.locator('.start-tile-open', { hasText: 'History handoff' }).click();
    await expect(
      b.getByRole('dialog', { name: 'Resume where you left off?' })
    ).toBeVisible();
    await b.screenshot({ path: 'output/playwright/resume-session.png' });
    await b
      .getByRole('button', { name: 'Resume session', exact: true })
      .click();
    await expect(
      b.getByRole('dialog', { name: 'Resume where you left off?' })
    ).toHaveCount(0);
    const restored = await b.evaluate((projectId) => {
      const stored = JSON.parse(
        localStorage.getItem('openzcad-workspace-session:v1') ?? '{}'
      ) as {
        views?: Record<
          string,
          { camera: ProjectWorkspaceSession['state']['camera'] }
        >;
      };
      return stored.views?.[projectId]?.camera;
    }, before.projectId);
    for (let axis = 0; axis < 3; axis++) {
      expect(restored!.position[axis]).toBeCloseTo(camera.position[axis]!, 8);
      expect(restored!.target[axis]).toBeCloseTo(camera.target[axis]!, 8);
    }
    expect(restored!.orthographicZoom).toBe(camera.orthographicZoom);
    expect(restored!.orthographicHalfHeight).toBeCloseTo(
      camera.orthographicHalfHeight!,
      8
    );
    await expect(
      b.getByRole('button', { name: 'Undo', exact: true })
    ).toBeEnabled();
    await b.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(() => cloud.project?.bodyOrder.length, { timeout: SYNC_BUDGET_MS })
      .toBe(0);
    expect(cloud.project!.version).toBeGreaterThan(before.version);
    await expect
      .poll(() => cloud.sessions[0]?.documentVersion, {
        timeout: SYNC_BUDGET_MS
      })
      .toBe(cloud.project!.version);
    await a.reload();
    const prompt = a.getByRole('dialog', {
      name: 'Resume where you left off?'
    });
    await expect(prompt).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await a.getByRole('button', { name: 'Open with default view' }).click();
    await expect(
      a.getByRole('region', { name: 'Getting started' })
    ).toHaveCount(0);
    await expect(
      a.getByRole('button', { name: 'Redo', exact: true })
    ).toBeEnabled();
    await a.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect
      .poll(() => cloud.project?.bodyOrder.length, { timeout: SYNC_BUDGET_MS })
      .toBe(1);
    await expect
      .poll(() => cloud.sessions[0]?.documentVersion, {
        timeout: SYNC_BUDGET_MS
      })
      .toBe(cloud.project!.version);
    await b.reload();
    await expect(
      b.getByRole('dialog', { name: 'Resume where you left off?' })
    ).toBeVisible();
    await b.getByRole('button', { name: 'Open with default view' }).click();
    await expect(
      b.getByRole('button', { name: 'Undo', exact: true })
    ).toBeEnabled();
    expect(cloud.project!.nodes).toEqual(before.nodes);
  } finally {
    await Promise.all([deviceA.close(), deviceB.close()]);
  }
});
