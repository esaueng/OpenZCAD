import type { Page } from '@playwright/test';
import { assertClientProjectCopy } from '@openzcad/persistence';
import type { ProjectDocument } from '@openzcad/shared';
import { parseDuplicateProjectRequest } from '../../apps/web/worker/validation';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';

/**
 * ADR-024 Phase 1: a signed-in Duplicate or Branch builds the copy in the
 * browser and the account only stores it. The worker's own parser and copy
 * check read what the page sent, so a request the worker would refuse fails
 * here rather than in production.
 */

async function addBox(page: Page) {
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expectBodyCount(page, 1);
}

/** The account side: the newest document the page stored, and copy requests. */
async function accountProject(page: Page) {
  const state: {
    latest?: ProjectDocument;
    revisions: Map<string, ProjectDocument>;
    copies: Array<{ path: string; body: unknown }>;
  } = { revisions: new Map(), copies: [] };
  page.on('request', (request) => {
    const url = new URL(request.url());
    const saved =
      request.method() === 'POST' && url.pathname.endsWith('/revisions');
    if (
      saved ||
      (request.method() === 'PUT' && url.pathname.endsWith('/document'))
    )
      state.latest = (
        request.postDataJSON() as { document: ProjectDocument }
      ).document;
    // The browser mints named saves (ADR-024 Phase 1), so the account's
    // copy of one is exactly the document the page sent.
    const revisionId = saved && state.latest?.revisions.at(-1)?.revisionId;
    if (revisionId) state.revisions.set(revisionId, state.latest!);
  });
  await page.route('**/api/projects/*/revisions/*', (route) => {
    const revisionId = new URL(route.request().url()).pathname
      .split('/')
      .at(-1)!;
    const document = state.revisions.get(decodeURIComponent(revisionId));
    return document ? route.fulfill({ json: document }) : route.fallback();
  });
  await page.route('**/api/projects/*', (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || !state.latest) return route.fallback();
    return route.fulfill({ json: state.latest });
  });
  await page.route('**/api/projects/*/duplicate', (route) => {
    state.copies.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON()
    });
    return route.fallback();
  });
  return state;
}

function checkedCopy(
  copy: { path: string; body: unknown },
  sourceProjectId: string
) {
  const request = parseDuplicateProjectRequest(copy.body, sourceProjectId);
  expect(copy.path).toBe(`/api/projects/${sourceProjectId}/duplicate`);
  expect(request.document).toBeDefined();
  expect(request.document!.projectId).not.toBe(sourceProjectId);
  expect(request.documentDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(request.importSources).toEqual([]);
  assertClientProjectCopy(request.document!, {
    userId: 'user_e2e',
    sourceProjectId,
    revisionId: request.revisionId
  });
  return request;
}

test('a signed-in Duplicate sends the copy the browser built', async ({
  page
}) => {
  await stubApi(page);
  const account = await accountProject(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Account copy source');
  await page.getByRole('button', { name: 'Create project' }).click();
  await addBox(page);
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).toContainText('Synced');
  const sourceProjectId = account.latest!.projectId;

  await page.getByTitle('Back to projects').click();
  await page
    .getByRole('button', {
      name: 'Actions for Account copy source',
      exact: true
    })
    .click();
  await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  const copyTile = page.locator('.start-tile-open', {
    hasText: 'Account copy source (copy)'
  });
  await expect(copyTile).toBeVisible();

  expect(account.copies).toHaveLength(1);
  const request = checkedCopy(account.copies[0]!, sourceProjectId);
  expect(request.revisionId).toBeUndefined();
  expect(request.document!.checkpoints.at(-1)?.reason).toBe(
    'Duplicated from Account copy source'
  );

  await copyTile.click();
  await expectBodyCount(page, 1);
});

test('a signed-in Branch sends the branch the browser built from the account save state', async ({
  page
}) => {
  await stubApi(page);
  const account = await accountProject(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Account branch source');
  await page.getByRole('button', { name: 'Create project' }).click();
  await addBox(page);
  await page.keyboard.press('ControlOrMeta+s');
  const savedRow = page.locator('.revision-row', { hasText: 'Manual save' });
  await expect(savedRow).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).not.toContainText('Saving');
  const sourceProjectId = account.latest!.projectId;

  await savedRow.hover();
  await savedRow
    .getByRole('button', { name: 'Branch Manual save into a new project' })
    .click();
  await expect(page.getByRole('contentinfo')).toContainText('Branched');

  expect(account.copies).toHaveLength(1);
  const request = checkedCopy(account.copies[0]!, sourceProjectId);
  expect(request.revisionId).toBeDefined();
  expect(request.document!.branchedFrom).toMatchObject({
    projectId: sourceProjectId,
    revisionId: request.revisionId,
    projectName: 'Account branch source'
  });
});
