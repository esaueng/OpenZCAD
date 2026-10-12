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
