import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { fromBase64Url, parseEnvelope } from '@openzcad/crypto';
import { withEncryptedProjectInfo } from '../../apps/web/worker/e2eeProjectDocuments';
import { d1Database } from '../d1-sqlite';
import {
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';
import {
  createE2eeServer,
  E2E_USER_ID,
  installE2eeServer,
  installUploadRoutes,
  openEncryptionSettings,
  seedE2eeDevice,
  writeDevice,
  type E2eeServer
} from './e2ee-fixtures';

/** Autosave waits out a 3 s idle delay; the MLS Worker starts on first use. */
const SYNC_BUDGET_MS = 30_000;
const STEP = readFileSync('test/parity/corpus/b-unit-mm-cube.step');
const STEP_SHA256 = createHash('sha256').update(STEP).digest('hex');

/** The shelf as the Worker lists it: format-2 rows and their project info. */
async function listing(server: E2eeServer) {
  const rows = server.db
    .prepare(
      `SELECT id, document_version, revision_count, last_revision_id, updated_at
       FROM projects WHERE user_id = ? AND storage_format = 2`
    )
    .all(E2E_USER_ID) as {
    id: string;
    document_version: number;
    revision_count: number;
    last_revision_id: string | null;
    updated_at: string;
  }[];
  return withEncryptedProjectInfo(d1Database(server.db), E2E_USER_ID, {
    projects: rows.map((row) => ({
      projectId: row.id as never,
      name: 'Encrypted project',
      revisionCount: row.revision_count,
      ...(row.last_revision_id
        ? { lastRevisionId: row.last_revision_id as never }
        : {}),
      updatedAt: row.updated_at,
      documentVersion: row.document_version,
      organization: { status: 'active', pinned: false, sortOrder: 0 },
      storageFormat: 2
    }))
  });
}

const count = (server: E2eeServer, sql: string) =>
  (server.db.prepare(sql).get() as { n: number }).n;

/** The app's routes for an account that encrypts new projects. */
async function serveAccount(page: Page, server: E2eeServer) {
  await stubApi(page);
  await installE2eeServer(page.context(), server);
  await installUploadRoutes(page, server);
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({
        status: 409,
        json: {
          error: 'Plaintext projects are refused for this account.',
          code: 'ENCRYPTED_PROJECTS_REQUIRED'
        }
      });
    }
    return route.fulfill({ json: await listing(server) });
  });
  // Every plaintext route of a format-2 project answers as the Worker's
  // format gate does (slices 4-1 and 4-6).
  await page.route(/\/api\/projects\/proj_[^/]+(\/.*)?$/, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: 'This project is end-to-end encrypted.',
        code: 'PROJECT_FORMAT_UNSUPPORTED'
      }
    })
  );
}

/** Whether this browser's own source store holds the bytes. */
const holdsSource = (page: Page) =>
  page.evaluate(async (checksum) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('openzcad-v2');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('open failed'));
    });
    try {
      if (!db.objectStoreNames.contains('sourceBlobs')) return false;
      return await new Promise<boolean>((resolve, reject) => {
        const request = db
          .transaction('sourceBlobs', 'readonly')
          .objectStore('sourceBlobs')
          .count(checksum);
        request.onsuccess = () => resolve(request.result === 1);
        request.onerror = () => reject(request.error ?? new Error('count'));
      });
    } finally {
      db.close();
    }
  }, STEP_SHA256);

/**
 * ADR-024 Phase 4, slice 4-6: a STEP file imported into an end-to-end
 * encrypted project is stored as an encrypted content blob through the
 * ordinary upload session, named by the encrypted document, and a fresh
 * browser of the same device, holding no copy of the file, resolves the
 * exact source from the account: it learns the blob's key from the
 * verified head and decrypts the blob in the decode worker before the
 * geometry worker rebuilds the import. No plaintext upload route is used.
 */
test('imports a STEP file into an encrypted project and resolves it in a fresh browser', async ({
  page,
  browser
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const plaintextUploads: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      (path === '/api/uploads' || path.startsWith('/api/artifacts')) &&
      request.method() !== 'GET'
    ) {
      plaintextUploads.push(`${request.method()} ${path}`);
    }
  });
  const server = createE2eeServer({ projectsEnabled: true });
  await serveAccount(page, server);

  await page.goto('/');
  const seeded = await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  const toggle = settings.getByRole('checkbox', {
    name: 'Encrypt new projects'
  });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  await page.getByLabel('Project name').fill('Secret fixture');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
    name: 'secret-cube.step',
    mimeType: 'application/step',
    buffer: STEP
  });
  await expectBodyCount(page, 1);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  // One encrypted blob, named by the saved head.
  await expect
    .poll(() => count(server, 'SELECT COUNT(*) AS n FROM e2ee_version_blobs'), {
      timeout: SYNC_BUDGET_MS
    })
    .toBeGreaterThan(0);
  expect(count(server, 'SELECT COUNT(*) AS n FROM e2ee_content_blobs')).toBe(1);
  expect(count(server, 'SELECT COUNT(*) AS n FROM artifacts')).toBe(0);
  const { blob_id: blobId } = server.db
    .prepare('SELECT blob_id FROM e2ee_content_blobs')
    .get() as { blob_id: string };
  // The account holds ciphertext only: neither the file nor its name.
  const stored = [
    JSON.stringify(server.db.prepare('SELECT * FROM e2ee_content_blobs').all()),
    JSON.stringify(
      server.db.prepare('SELECT * FROM e2ee_project_versions').all()
    ),
    ...[...server.objects.values()].map((bytes) =>
      Buffer.from(bytes).toString('latin1')
    )
  ].join('\n');
  expect(stored).not.toContain('secret-cube');
  expect(stored).not.toContain('ISO-10303-21');
  expect(plaintextUploads).toEqual([]);

  // Reload: the project reopens from the account copy with its import.
  await page.reload();
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expectBodyCount(page, 1);

  // A fresh browser of the same device holds no copy of the file.
  const fresh = await browser.newContext();
  try {
    const second = await fresh.newPage();
    second.on('pageerror', (error) => errors.push(error.message));
    const blobReads: string[] = [];
    second.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith(`/blobs/${blobId}`)) {
        blobReads.push(request.method());
      }
    });
    await serveAccount(second, server);
    await second.goto('/');
    await writeDevice(second, seeded.device);
    await second.reload();
    expect(await holdsSource(second)).toBe(false);
    const card = second.locator('.start-tile-project', {
      hasText: 'Secret fixture'
    });
    await expect(card).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await card.locator('.start-tile-open').click();
    // The exact source resolved: the import rebuilds its body, from the
    // one blob this browser read and decrypted (it had no copy before).
    await expectBodyCount(second, 1);
    expect(blobReads).toEqual(['GET']);
    await expect(second.getByText(/could not be fetched/)).toHaveCount(0);
  } finally {
    await fresh.close();
  }
  expect(errors).toEqual([]);
});

/**
 * ADR-024 Phase 4, slice 4-8: Duplicate on the shelf copies an end-to-end
 * encrypted project in the browser. The page decrypts the verified head,
 * builds the copy with the ordinary builders and writes its first version
 * under a new MLS group, naming the source's blob with the same id and key;
 * the account copies the blob's ciphertext byte for byte, so nothing is
 * uploaded or encrypted again. A fresh browser of the same device, holding
 * no copy of the file, opens the copy and rebuilds its import from the
 * copy's own blob.
 */
test('duplicates an encrypted project and opens the copy in a fresh browser', async ({
  page,
  browser
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const uploads: string[] = [];
  const server = createE2eeServer({ projectsEnabled: true });
  await serveAccount(page, server);

  await page.goto('/');
  const seeded = await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  const toggle = settings.getByRole('checkbox', {
    name: 'Encrypt new projects'
  });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  await page.getByLabel('Project name').fill('Secret original');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
    name: 'secret-cube.step',
    mimeType: 'application/step',
    buffer: STEP
  });
  await expectBodyCount(page, 1);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect
    .poll(() => count(server, 'SELECT COUNT(*) AS n FROM e2ee_version_blobs'), {
      timeout: SYNC_BUDGET_MS
    })
    .toBeGreaterThan(0);
  const { project_id: sourceId, blob_id: blobId } = server.db
    .prepare(
      "SELECT project_id, blob_id FROM e2ee_content_blobs WHERE kind = 'import-source'"
    )
    .get() as { project_id: string; blob_id: string };

  await page.getByTitle('Back to projects').click();
  // Leaving publishes shelf thumbnails; the import is never stored again.
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/blobs/uploads')) {
      const { kind } = request.postDataJSON() as { kind: string };
      if (kind !== 'thumbnail') uploads.push(`${kind} ${path}`);
    }
  });
  await page
    .getByRole('button', { name: 'Actions for Secret original', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  await expect(
    page.locator('.start-tile-open', { hasText: 'Secret original (copy)' })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  const copies = server.db
    .prepare(
      `SELECT project_id, object_key FROM e2ee_content_blobs
       WHERE blob_id = ? ORDER BY project_id = ? DESC`
    )
    .all(blobId, sourceId) as { project_id: string; object_key: string }[];
  expect(copies).toHaveLength(2);
  const copyId = copies[1]!.project_id;
  expect(copyId).not.toBe(sourceId);
  // Byte for byte the source's ciphertext, uploaded by nobody.
  expect(Buffer.from(server.objects.get(copies[1]!.object_key)!)).toEqual(
    Buffer.from(server.objects.get(copies[0]!.object_key)!)
  );
  expect(uploads).toEqual([]);
  // Still ciphertext only: neither the file nor the names.
  const stored = [
    JSON.stringify(server.db.prepare('SELECT * FROM projects').all()),
    JSON.stringify(
      server.db.prepare('SELECT * FROM e2ee_project_envelopes').all()
    ),
    ...[...server.objects.values()].map((bytes) =>
      Buffer.from(bytes).toString('latin1')
    )
  ].join('\n');
  expect(stored).not.toContain('Secret original');
  expect(stored).not.toContain('ISO-10303-21');

  // A fresh browser of the same device holds no copy of the file.
  const fresh = await browser.newContext();
  try {
    const second = await fresh.newPage();
    second.on('pageerror', (error) => errors.push(error.message));
    const blobReads: string[] = [];
    second.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/blobs/${blobId}`)) blobReads.push(path);
    });
    await serveAccount(second, server);
    await second.goto('/');
    await writeDevice(second, seeded.device);
    await second.reload();
    expect(await holdsSource(second)).toBe(false);
    const card = second.locator('.start-tile-project', {
      hasText: 'Secret original (copy)'
    });
    await expect(card).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await card.locator('.start-tile-open').click();
    await expectBodyCount(second, 1);
    // The import rebuilt from the copy's own blob.
    expect(blobReads).toEqual([
      `/api/e2ee/projects/${encodeURIComponent(copyId)}/blobs/${blobId}`
    ]);
    await expect(second.getByText(/could not be fetched/)).toHaveCount(0);
  } finally {
    await fresh.close();
  }
  expect(errors).toEqual([]);
});

/**
 * ADR-024 Phase 4, slice 4-7: leaving an encrypted project publishes its
 * shelf thumbnail as an encrypted thumbnail blob named by a new project
 * info, never an artifact, and a fresh browser of the same device, holding
 * no cached thumbnail, decrypts the project's name and its picture on the
 * shelf: it learns the thumbnail's key from the verified project info and
 * reads the blob through the decode worker, never the plaintext artifact
 * download.
 */
test('decrypts shelf names and thumbnails of an encrypted project in a fresh browser', async ({
  page,
  browser
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const plaintextFiles: string[] = [];
  const watchPlaintext = (target: Page) =>
    target.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/uploads' || path.startsWith('/api/artifacts')) {
        plaintextFiles.push(`${request.method()} ${path}`);
      }
    });
  watchPlaintext(page);
  const server = createE2eeServer({ projectsEnabled: true });
  await serveAccount(page, server);

  await page.goto('/');
  const seeded = await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  const toggle = settings.getByRole('checkbox', {
    name: 'Encrypt new projects'
  });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  await page.getByLabel('Project name').fill('Secret shelf part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });

  // Leaving the workspace captures the card and publishes it encrypted.
  await page.getByTitle('Back to projects').click();
  await expect
    .poll(
      () =>
        count(
          server,
          "SELECT COUNT(*) AS n FROM e2ee_content_blobs WHERE kind = 'thumbnail'"
        ),
      { timeout: SYNC_BUDGET_MS }
    )
    .toBe(1);
  const { blob_id: thumbnailId } = server.db
    .prepare("SELECT blob_id FROM e2ee_content_blobs WHERE kind = 'thumbnail'")
    .get() as { blob_id: string };
  await expect
    .poll(
      () => {
        const row = server.db
          .prepare(
            "SELECT envelope FROM e2ee_project_envelopes WHERE kind = 'project-info'"
          )
          .get() as { envelope: string };
        const header = parseEnvelope(fromBase64Url(row.envelope)).header;
        return header.class === 'project' ? header.blobIds : [];
      },
      { timeout: SYNC_BUDGET_MS }
    )
    .toEqual([thumbnailId]);
  expect(count(server, 'SELECT COUNT(*) AS n FROM artifacts')).toBe(0);
  const stored = [
    JSON.stringify(server.db.prepare('SELECT * FROM projects').all()),
    JSON.stringify(
      server.db.prepare('SELECT * FROM e2ee_project_envelopes').all()
    ),
    ...[...server.objects.values()].map((bytes) =>
      Buffer.from(bytes).toString('latin1')
    )
  ].join('\n');
  expect(stored).not.toContain('Secret shelf part');
  expect(stored).not.toContain('WEBPVP8');

  // A fresh browser of the same device: no cached picture, no pins.
  const fresh = await browser.newContext();
  try {
    const second = await fresh.newPage();
    second.on('pageerror', (error) => errors.push(error.message));
    watchPlaintext(second);
    const thumbnailReads: string[] = [];
    second.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith(`/blobs/${thumbnailId}`)) {
        thumbnailReads.push(request.method());
      }
    });
    await serveAccount(second, server);
    await second.goto('/');
    await writeDevice(second, seeded.device);
    await second.reload();
    const card = second.locator('.start-tile-project', {
      hasText: 'Secret shelf part'
    });
    await expect(card).toBeVisible({ timeout: SYNC_BUDGET_MS });
    const picture = card.locator('img');
    await expect(picture).toHaveAttribute('src', /^data:image\/webp;base64,/, {
      timeout: SYNC_BUDGET_MS
    });
    expect(thumbnailReads).toContain('GET');
  } finally {
    await fresh.close();
  }
  expect(plaintextFiles).toEqual([]);
  expect(errors).toEqual([]);
});
