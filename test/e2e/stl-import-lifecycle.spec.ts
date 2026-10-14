import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';
import type { Page } from '@playwright/test';
import { IMPORT_CARD_DELAY_MS } from '../../apps/web/src/lib/importProgress';

const fixture = 'samples/simple-block.stl';

async function create(page: Page, name: string) {
  await page.getByLabel('Project name').fill(name);
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
}

async function nextProject(page: Page, name: string) {
  await page.getByTitle('Back to projects').click();
  await create(page, name);
}

async function holdArchive(page: Page) {
  let reached = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/uploads', async (route) => {
    const payload = route.request().postDataJSON() as { kind?: string };
    if (payload.kind !== 'stl-import') return route.fallback();
    reached = true;
    await held;
    return route.fulfill({
      status: 404,
      json: { error: 'archive unavailable' }
    });
  });
  return { reached: () => reached, release };
}

for (const signedOut of [true, false]) {
  test(`settles a completed STL import ${signedOut ? 'signed out' : 'when archival is unavailable'}`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    if (signedOut)
      await page.route('**/api/session', (route) =>
        route.fulfill({ json: null })
      );
    const uploads: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/uploads')
        uploads.push(request.url());
    });
    await page.goto('/');
    await create(page, 'STL completed');
    await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles(fixture);
    await expectBodyCount(page, 1);
    await expect(page.locator('.feature-row')).toHaveCount(1);
    // The regression was a completed, durable mesh with an orphaned active
    // archive card. Success must remove both the running clock and Cancel,
    // even though the original file could not be archived.
    // Cross the real initial display delay plus ActivityPill's 100 ms timer
    // tick, so an orphaned run cannot pass while its card is still hidden.
    await page.waitForTimeout(IMPORT_CARD_DELAY_MS + 100);
    await expect(page.locator('.activity-pill-cancel')).toHaveCount(0);
    await expect(page.locator('.activity-pill-time')).toHaveCount(0);
    await expect(page.locator('.activity-pill.error')).toHaveCount(0);
    await expect(page.locator('.activity-pill')).toHaveCount(0, {
      timeout: 6000
    });
    if (signedOut) expect(uploads).toEqual([]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectBodyCount(page, 0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectBodyCount(page, 1);
    await nextProject(page, 'STL next project');
    await expectBodyCount(page, 0);
    await expect(page.locator('.activity-pill')).toHaveCount(0);
  });
}

test('cancels an STL archive without committing and clears its job before switching', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  const archive = await holdArchive(page);
  await page.goto('/');
  await create(page, 'STL cancelled');
  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles(fixture);
  await expect.poll(archive.reached).toBe(true);
  const pill = page.getByRole('region', { name: 'File import', exact: true });
  await expect(pill).toContainText('Archiving a copy');
  await pill.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    pill.getByRole('button', { name: 'Cancelling…' })
  ).toBeDisabled();
  // The in-flight request finishes, but the aborted run must decline its
  // commit. Upload/session transport interruption is covered separately.
  archive.release();
  await expect(page.locator('.activity-pill-cancel')).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('you cancelled it');
  await expectBodyCount(page, 0);
  await expect(page.locator('.feature-row')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true })
  ).toBeDisabled();
  await nextProject(page, 'After STL cancellation');
  await expect(page.locator('.activity-pill')).toHaveCount(0);
  await expectBodyCount(page, 0);
});

test('settles an STL import that finishes after its project was replaced', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  const archive = await holdArchive(page);
  await page.goto('/');
  await create(page, 'STL origin');
  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles(fixture);
  await expect.poll(archive.reached).toBe(true);
  await nextProject(page, 'STL destination');
  archive.release();
  const pill = page.getByRole('region', { name: 'File import', exact: true });
  await expect(pill).toContainText('project changed');
  await expect(page.locator('.activity-pill-cancel')).toHaveCount(0);
  await expect(page.locator('.activity-pill-time')).toHaveCount(0);
  await expectBodyCount(page, 0);
  await expect(page.locator('.feature-row')).toHaveCount(0);
  await nextProject(page, 'After stale STL import');
  await expect(page.locator('.activity-pill')).toHaveCount(0);
  await expectBodyCount(page, 0);
});

test('settles an STL parse refusal and releases the geometry reservation', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.goto('/');
  await create(page, 'STL refused');
  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
    name: 'empty.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from('solid empty\nendsolid empty\n')
  });
  await expect(page.locator('.activity-pill.error')).toBeVisible();
  await expect(page.locator('.activity-pill-cancel')).toHaveCount(0);
  await expectBodyCount(page, 0);
  await page.getByRole('button', { name: /^Box \(/ }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expectBodyCount(page, 1);
});

test('keeps cancellation status when finalized mesh cleanup fails', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  const originalId = 'artifact_original_cleanup_e2e';
  const payloadId = 'artifact_payload_cleanup_e2e';
  const uploads = new Map<
    string,
    {
      projectId: string;
      fileName: string;
      contentType: string;
      kind: string;
      metadata?: Record<string, string | number | boolean>;
    }
  >();
  const finalized: string[] = [];
  const cleanups: { projectId: string; artifactId: string }[] = [];
  let metadataReached = false;
  let releaseMetadata!: () => void;
  const metadataHeld = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });
  await page.route('**/api/uploads', (route) => {
    const input = route.request().postDataJSON() as {
      projectId: string;
      fileName: string;
      contentType: string;
      kind: string;
      metadata?: Record<string, string | number | boolean>;
    };
    if (input.kind !== 'stl-import' && input.kind !== 'mesh-payload')
      return route.fallback();
    const artifactId = input.kind === 'mesh-payload' ? payloadId : originalId;
    uploads.set(artifactId, input);
    return route.fulfill({
      status: 201,
      json: {
        session: {
          uploadSessionId: `upload_${artifactId}`,
          artifactId,
          projectId: input.projectId,
          objectKey: `${input.projectId}/${artifactId}`,
          uploadUrl: `/api/uploads/upload_${artifactId}/content`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          fileName: input.fileName,
          contentType: input.contentType,
          kind: input.kind,
          metadata: input.metadata ?? {}
        }
      }
    });
  });
  await page.route(
    '**/api/uploads/upload_artifact_*_cleanup_e2e/content',
    (route) => route.fulfill({ status: 204 })
  );
  await page.route('**/api/artifacts/finalize', (route) => {
    const input = route.request().postDataJSON() as { artifactId: string };
    if (!uploads.has(input.artifactId)) return route.fallback();
    finalized.push(input.artifactId);
    return route.fulfill({ json: { artifactId: input.artifactId } });
  });
  await page.route('**/api/artifacts/artifact_*_cleanup_e2e', async (route) => {
    const artifactId = new URL(route.request().url()).pathname
      .split('/')
      .at(-1)!;
    const input = uploads.get(artifactId)!;
    if (artifactId === payloadId) {
      metadataReached = true;
      await metadataHeld;
    }
    await route.fulfill({
      json: {
        artifact: {
          artifactId,
          projectId: input.projectId,
          kind: input.kind,
          name: input.fileName,
          contentType: input.contentType,
          bytes: 3,
          objectKey: `${input.projectId}/${artifactId}`,
          metadata: input.metadata ?? {},
          createdAt: new Date().toISOString()
        }
      }
    });
  });
  await page.route('**/api/artifacts/*/discard-unreferenced', (route) => {
    const input = route.request().postDataJSON() as { projectId: string };
    cleanups.push({
      projectId: input.projectId,
      artifactId: new URL(route.request().url()).pathname.split('/').at(-2)!
    });
    return route.fulfill({
      status: 503,
      json: { error: 'Cleanup temporarily unavailable' }
    });
  });
  await page.goto('/');
  await create(page, 'STL cleanup failure');
  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles(fixture);
  await expect.poll(() => metadataReached).toBe(true);
  expect(finalized).toEqual([originalId, payloadId]);
  const pill = page.getByRole('region', { name: 'File import', exact: true });
  await pill.getByRole('button', { name: 'Cancel', exact: true }).click();
  releaseMetadata();
  await expect
    .poll(() => cleanups)
    .toEqual([
      { projectId: uploads.get(payloadId)!.projectId, artifactId: payloadId }
    ]);
  await expect(page.getByRole('contentinfo')).toContainText('you cancelled it');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cleanup temporarily unavailable'
  );
  await expect(page.locator('.activity-pill-cancel')).toHaveCount(0);
  await expectBodyCount(page, 0);
  await expect(page.locator('.feature-row')).toHaveCount(0);
});
