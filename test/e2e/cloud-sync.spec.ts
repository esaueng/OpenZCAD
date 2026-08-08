import type { Page } from '@playwright/test';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  DEFAULT_APP_SETTINGS,
  toProjectId,
  toUserId,
  type ProjectDocument,
  type SaveProjectDocumentRequest,
  type UnitSystem
} from '@openzcad/shared';
import type { StoredMeasurementRecord } from '../../apps/web/src/lib/measurementRecord';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

const accountUserId = toUserId('user_cloud_sync_e2e');

function projectIdFrom(url: string): string {
  const parts = new URL(url).pathname.split('/');
  return decodeURIComponent(parts[3] ?? '');
}

class SharedCloudProjectApi {
  project: ProjectDocument | null = null;
  measurement: { revision: number; record: StoredMeasurementRecord } | null =
    null;

  async install(page: Page): Promise<void> {
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
        const payload = route.request().postDataJSON() as {
          name: string;
          units?: UnitSystem;
        };
        const document = createProjectDocument(
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
      const payload = route
        .request()
        .postDataJSON() as SaveProjectDocumentRequest;
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
      const payload = route.request().postDataJSON() as {
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
      return route.fulfill({ json: this.project });
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
 * The device write is the save, so it has to survive the tab going away while
 * an edit is still inside the 450 ms local-save debounce.
 *
 * Timers are frozen before the edit so that debounce provably cannot fire on
 * its own, which leaves the page-hide flush as the only thing that can reach
 * IndexedDB. Freezing has to wait for the app to go quiet first: a real timer
 * armed before the fake clock is installed stays scheduled, and when it lands
 * it stores whatever edit is pending by then — which looks exactly like the
 * behaviour under test. The mid-test assertion that the old name is still
 * stored is what keeps this honest; if the freeze ever stops working, the test
 * fails there instead of passing for the wrong reason.
 */
test('stores an edit made inside the autosave debounce when the tab goes away', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Debounce Window');
  await expect
    .poll(() => storedProjectNames(page), { timeout: 10_000 })
    .toContain('Debounce Window');
  // Outlasts the trailing debounce that follows the first derived rebuild.
  await page.waitForTimeout(1500);

  await page.clock.install();
  await page.clock.pauseAt(Date.now());
  await renameProject(page, 'Saved On Page Hide');
  expect(await storedProjectNames(page)).toEqual(['Debounce Window']);

  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect
    .poll(() => storedProjectNames(page), { timeout: 10_000 })
    .toContain('Saved On Page Hide');
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
    .poll(() => storedProjectNames(page), { timeout: 10_000 })
    .toContain('Two Tabs');

  // A second tab restores the same active project on its own.
  const second = await page.context().newPage();
  await stubApi(second);
  await second.goto('/');
  await expect(
    second.getByRole('button', { name: 'Rename project' })
  ).toContainText('Two Tabs');

  await expect(second.getByRole('button', { name: /^Box \(B\)/ })).toBeDisabled(
    { timeout: 10_000 }
  );
  // And settles on saying so, rather than leaving up a save that is never
  // going to happen. Claiming the project is asynchronous, so the indicator
  // reads as saving until the answer arrives.
  await expect(
    second.getByRole('group', { name: 'Workspace status', exact: true })
  ).toContainText('syncLocal only', { timeout: 15_000 });

  // The tab that owns it keeps editing.
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeEnabled();

  // Handing the project back promotes the tab that was waiting for it.
  await page.goto('about:blank');
  await expect(second.getByRole('button', { name: /^Box \(B\)/ })).toBeEnabled({
    timeout: 10_000
  });
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
  ).toContainText('syncSynced', { timeout: 10_000 });

  documentWrites = 0;
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Reopen Echo');
  await expect(
    page.getByRole('group', { name: 'Workspace status', exact: true })
  ).toContainText('syncSynced', { timeout: 10_000 });
  // Outlasts this fixture's 1 s cloud-autosave delay, so a queued mirror of the
  // adopted document would have been sent by now.
  await page.waitForTimeout(3000);
  expect(documentWrites).toBe(0);
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
    await pageA.getByRole('button', { name: /^Box \(B\)/ }).click();
    await pageA
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();
    await expect(pageA.getByRole('button', { name: 'Saved' })).toBeVisible({
      timeout: 10_000
    });
    const canonicalBeforeMeasurement = structuredClone(api.project);

    await switchWorkspace(pageA, 'View');
    await armMeasure(pageA);
    await pageA.getByRole('button', { name: 'Edge', exact: true }).click();
    const edge = await locateEdge(pageA);
    await pageA.mouse.click(edge.x, edge.y);
    const measured = await pageA
      .getByLabel('Measurement workbench')
      .getByRole('listitem')
      .textContent();
    expect(measured).toBeTruthy();
    await expect
      .poll(() => api.measurement?.record.measurements.length, {
        timeout: 10_000
      })
      .toBe(1);
    expect(api.project).toEqual(canonicalBeforeMeasurement);

    await pageB.goto('/');
    await pageB
      .locator('.start-tile-open', { hasText: 'Measured Across Devices' })
      .click();
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

test('syncs across two devices and preserves the losing side of a conflict', async ({
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
    await pageA.getByLabel('Project name').fill('Shared Bracket');
    await pageA.getByRole('button', { name: 'Create project' }).click();
    await expect(pageA.getByRole('button', { name: 'Saved' })).toBeVisible({
      timeout: 10_000
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
    await expect(pageA.getByRole('button', { name: 'Saved' })).toBeVisible({
      timeout: 10_000
    });

    await pageB.goto('/');
    await pageB
      .locator('.start-tile-open', { hasText: 'Shared Bracket' })
      .click();
    await expect(
      pageB.getByRole('button', { name: 'Rename project' })
    ).toContainText('Shared Bracket');
    await expect(pageB.getByRole('button', { name: 'Saved' })).toBeVisible({
      timeout: 10_000
    });

    await renameProject(pageA, 'Shared Bracket from A');
    await expect
      .poll(() => api.project?.name, { timeout: 10_000 })
      .toBe('Shared Bracket from A');

    await pageB.bringToFront();
    await pageB.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect(
      pageB.getByRole('button', { name: 'Rename project' })
    ).toContainText('Shared Bracket from A', { timeout: 10_000 });

    await renameProject(pageB, 'Device B unsent edit');
    await deviceB.setOffline(true);
    await renameProject(pageA, 'Device A account edit');
    await pageA.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect
      .poll(() => api.project?.name, { timeout: 10_000 })
      .toBe('Device A account edit');
    await deviceB.setOffline(false);

    const conflict = pageB.getByRole('dialog', {
      name: 'This project changed in two places'
    });
    await expect(conflict).toBeVisible({ timeout: 10_000 });
    await expect(pageB.locator('.status-groups')).toContainText('syncConflict');
    // A lower overlay may mount after async conflict detection. The account
    // dialog remains painted above it and must not become inert just because
    // the lower overlay registered its focus trap later.
    await pageB.keyboard.press('?');
    await expect(
      pageB.locator('.conflict-dialog').locator('..')
    ).not.toHaveAttribute('inert', '');
    await conflict
      .getByRole('button', { name: 'Use my account’s version' })
      .click();
    await pageB.keyboard.press('Escape');
    await expect(
      pageB.getByRole('button', { name: 'Rename project' })
    ).toContainText('Device A account edit');
    await expect(pageB.getByRole('button', { name: 'Saved' })).toBeVisible();

    await pageB.getByTitle('Back to projects').click();
    await expect(
      pageB.locator('.start-tile-open', {
        hasText: 'Device B unsent edit (Recovery)'
      })
    ).toBeVisible();
  } finally {
    await deviceA.close();
    await deviceB.close();
  }
});
