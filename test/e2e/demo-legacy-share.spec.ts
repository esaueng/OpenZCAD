import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { sharedProjectSnapshotDocument } from '@openzcad/persistence';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  buildDemoDocument,
  DEMO_DEFINITIONS
} from '../../apps/web/src/lib/demos';
import { BRACKET_BOSS_HEIGHT } from '../../apps/web/src/lib/bracketDemoPlacement';
import { legacyBracket } from '../helpers/legacy-bracket';
import {
  expect,
  expectBodyCount,
  stubAnonymousApi,
  stubApi,
  test
} from './openzcad-fixtures';

async function localDocuments(page: Page): Promise<ProjectDocument[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openzcad-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB request failed'));
    });
    try {
      return await new Promise<ProjectDocument[]>((resolve, reject) => {
        const request = db
          .transaction('projects')
          .objectStore('projects')
          .getAll();
        request.onsuccess = () => resolve(request.result as ProjectDocument[]);
        request.onerror = () =>
          reject(request.error ?? new Error('IndexedDB request failed'));
      });
    } finally {
      db.close();
    }
  });
}

for (const [name, value] of [
  ['wall_h', '26'],
  ['boss_r', '14']
] as const) {
  test(`a legacy shared bracket repairs ${name}=${value} ephemerally and makes a durable editable copy`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const adapter = await createExactKernelAdapter();
    let source: ProjectDocument;
    try {
      source = legacyBracket(
        await buildDemoDocument(
          DEMO_DEFINITIONS.find((definition) => definition.key === 'bracket')!,
          toUserId('share_owner'),
          (document) => adapter.syncDocument(document)
        )
      );
    } finally {
      adapter.dispose();
    }
    const shared = sharedProjectSnapshotDocument(source);
    const before = structuredClone(shared);
    await stubAnonymousApi(page);
    await page.route('**/api/session', (route) =>
      route.fulfill({ json: null })
    );
    await page.route('**/api/share/*', (route) =>
      route.fulfill({
        json: {
          document: shared,
          project: { name: shared.name },
          mode: 'tweak'
        }
      })
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/#share=${'s'.repeat(43)}`);
    await expectBodyCount(page, 1);
    await page.getByRole('button', { name: 'Tweak', exact: true }).click();
    const input = page.getByLabel(`Expression for ${name}`, { exact: true });
    await input.fill(value);
    await input.press('Enter');
    await expect(page.getByRole('contentinfo')).toContainText(
      `Parameter ${name} updated.`,
      { timeout: 30_000 }
    );
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await localDocuments(page)).toEqual([]);
    await page
      .getByRole('button', { name: 'Make a copy', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Make a copy', exact: true })
    ).toHaveCount(0);
    await expect.poll(async () => (await localDocuments(page)).length).toBe(1);
    const copy = (await localDocuments(page))[0]!;
    expect(copy.projectId).not.toBe(shared.projectId);
    expect(copy.ownerUserId).not.toBe(shared.ownerUserId);
    for (const featureName of ['Place boss on wall', 'Aim bore through boss']) {
      const feature = Object.values(copy.nodes).find(
        (node) => node.kind === 'feature' && node.name === featureName
      );
      expect(
        feature?.kind === 'feature' &&
          feature.data.featureKind === 'transform' &&
          feature.data.transform.translation.z
      ).toBe(BRACKET_BOSS_HEIGHT);
    }
    expect(
      Object.values(copy.nodes).find(
        (node) => node.kind === 'parameter' && node.name === name
      )
    ).toMatchObject({ expression: value });
    await page.reload();
    await expectBodyCount(page, 1);
    await page.getByRole('button', { name: 'Tweak', exact: true }).click();
    await expect(input).toHaveValue(value);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export STEP/ }).click();
    const file = await download;
    expect(await file.failure()).toBeNull();
    expect(await readFile(await file.path(), 'utf8')).toContain(
      'ISO-10303-21;'
    );
    expect(
      (await localDocuments(page)).some(
        (document) => document.projectId === source.projectId
      )
    ).toBe(false);
    expect(shared).toEqual(before);
    expect(errors).toEqual([]);
  });
}

for (const [name, value] of [
  ['wall_h', '26'],
  ['boss_r', '14']
] as const) {
  test(`a collaboration editor can tweak the foreign legacy bracket with ${name}=${value}`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const adapter = await createExactKernelAdapter();
    let source: ProjectDocument;
    try {
      source = legacyBracket(
        await buildDemoDocument(
          DEMO_DEFINITIONS.find((definition) => definition.key === 'bracket')!,
          toUserId('other_owner'),
          (document) => adapter.syncDocument(document)
        )
      );
    } finally {
      adapter.dispose();
    }
    const before = structuredClone(source);
    await stubApi(page, { collaborationRole: 'editor' });
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
    await page.route('**/api/health', (route) =>
      route.fulfill({
        json: {
          status: 'ok',
          environment: 'beta',
          projectSharingEnabled: true,
          projectEditLeasesEnforced: false,
          projectPersonalSyncEnabled: false
        }
      })
    );
    const summary = {
      projectId: source.projectId,
      name: source.name,
      revisionCount: source.revisions.length,
      documentVersion: source.version,
      updatedAt: source.derived.updatedAt
    };
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        json:
          route.request().method() === 'POST'
            ? { project: summary, document: source }
            : { projects: [summary] }
      })
    );
    await page.route(`**/api/projects/${source.projectId}`, (route) =>
      route.fulfill({ json: source })
    );
    let ownerWrites = 0;
    await page.route(
      `**/api/projects/${source.projectId}/document`,
      (route) => {
        ownerWrites++;
        return route.fulfill({
          status: 403,
          json: { error: 'Owner endpoint' }
        });
      }
    );
    await page.route(
      `**/api/projects/${source.projectId}/revisions`,
      (route) => {
        if (route.request().method() !== 'GET') ownerWrites++;
        return route.fulfill({ json: { revisions: [] } });
      }
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill(source.name);
    await page
      .getByRole('button', { name: 'Create project', exact: true })
      .click();
    await expectBodyCount(page, 1);
    await page.getByRole('button', { name: 'Tweak', exact: true }).click();
    const input = page.getByLabel(`Expression for ${name}`, { exact: true });
    await expect(input).toBeEditable();
    await input.fill(value);
    await input.press('Enter');
    await expect(page.getByRole('contentinfo')).toContainText(
      `Parameter ${name} updated.`,
      { timeout: 30_000 }
    );
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expect(page.getByRole('alert')).toHaveCount(0);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export STEP/ }).click();
    const file = await download;
    expect(await file.failure()).toBeNull();
    expect(await readFile(await file.path(), 'utf8')).toContain(
      'ISO-10303-21;'
    );
    const cached = (await localDocuments(page)).find(
      (document) => document.projectId === source.projectId
    )!;
    expect(cached.ownerUserId).toBe(source.ownerUserId);
    expect(
      Object.values(cached.nodes).find(
        (node) => node.kind === 'parameter' && node.name === name
      )
    ).toMatchObject({ expression: value });
    expect(ownerWrites).toBe(0);
    expect(errors).toEqual([]);
    expect(source).toEqual(before);
  });
}
