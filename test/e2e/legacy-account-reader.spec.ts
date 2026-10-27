import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { prepareProjectStorageSnapshot } from '@openzcad/persistence';
import {
  LEGACY_PROJECT_FRAME_CONTENT_TYPE,
  encodeE2eeFrame,
  toUserId
} from '@openzcad/shared';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';

for (const kind of ['inline', 'snapshot'] as const) {
  test(`opens an account ${kind} storage frame in the browser`, async ({
    page
  }) => {
    const manager = new CommandManager(
      createProjectDocument('Legacy account reader', toUserId('user_e2e'))
    );
    manager.execute(
      commandFactories.importMesh({
        name: 'Triangle',
        artifactId: 'artifact_local_triangle',
        sourceName: 'triangle.stl',
        triangleCount: 4,
        vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
        indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]
      })
    );
    const document = manager.document;
    const prepared = await prepareProjectStorageSnapshot(document);
    const payload =
      kind === 'inline'
        ? new TextEncoder().encode(JSON.stringify(document))
        : prepared.storedBody;
    const frame = encodeE2eeFrame(
      {
        version: 1,
        projectId: document.projectId,
        kind,
        aliases: [],
        storedBytes: payload.length,
        logicalBytes:
          kind === 'inline' ? payload.length : prepared.logicalBytes,
        checksumSha256: kind === 'inline' ? null : prepared.checksumSha256
      },
      payload
    );
    await stubApi(page);
    await page.route('**/api/projects', (route) =>
      route.request().method() !== 'GET'
        ? route.fallback()
        : route.fulfill({
            json: {
              projects: [
                {
                  projectId: document.projectId,
                  name: document.name,
                  revisionCount: document.revisions.length,
                  documentVersion: document.version,
                  updatedAt: document.derived.updatedAt
                }
              ]
            }
          })
    );
    let reads = 0;
    let assets = 0;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(`**/api/projects/${document.projectId}`, (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      expect(route.request().headers().accept).toBe(
        LEGACY_PROJECT_FRAME_CONTENT_TYPE
      );
      reads++;
      return route.fulfill({
        contentType: LEGACY_PROJECT_FRAME_CONTENT_TYPE,
        body: Buffer.from(frame)
      });
    });
    await page.route(/\/api\/projects\/[^/]+\/storage-assets\?/, (route) => {
      const key = new URL(route.request().url()).searchParams.get('key');
      const asset = prepared.assets.find((entry) => entry.objectKey === key);
      expect(asset).toBeDefined();
      assets++;
      return route.fulfill({
        contentType: 'application/octet-stream',
        body: Buffer.from(asset!.storedBody)
      });
    });
    await page.goto('/');
    await page.locator('.start-tile-open', { hasText: document.name }).click();
    await expect(
      page.getByRole('button', {
        name: `Rename project ${document.name}`,
        exact: true
      })
    ).toBeVisible();
    await expect(
      page.locator('.feature-row-main', { hasText: 'Triangle' })
    ).toHaveCount(1);
    await expectBodyCount(page, 1);
    expect(reads).toBeGreaterThan(0);
    expect(assets).toBe(kind === 'snapshot' ? prepared.assets.length : 0);
    expect(errors).toEqual([]);
  });
}
