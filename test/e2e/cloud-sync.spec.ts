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
import { expect, test } from './openzcad-fixtures';

const accountUserId = toUserId('user_cloud_sync_e2e');

function projectIdFrom(url: string): string {
  const parts = new URL(url).pathname.split('/');
  return decodeURIComponent(parts[3] ?? '');
}

class SharedCloudProjectApi {
  project: ProjectDocument | null = null;

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
          projectPersonalSyncEnabled: false
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

async function renameProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Rename project' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByLabel('Project name').press('Enter');
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(name);
}

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
    await expect(pageA.getByRole('button', { name: 'Saved' })).toBeVisible();

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
