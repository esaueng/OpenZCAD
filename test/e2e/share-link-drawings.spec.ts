import type { Download, Page } from '@playwright/test';
import {
  normalizeDocument,
  setShareLinkSheets,
  sharedProjectSnapshotDocument
} from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import {
  createPrimitiveInPlace,
  expect,
  stubAnonymousApi,
  stubApi,
  test,
  withHydratedDocument
} from './openzcad-fixtures';

/**
 * L08: a share link shows the drawing sheets its project chose for links,
 * read only, and the visitor downloads them as PDF. The owner's sheet is
 * drawn and saved in one browser; the link is opened in another with no
 * account, served the snapshot the Worker would serve for that project.
 */

const token = 's'.repeat(43);

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function mode(page: Page, name: 'Build' | 'Draw') {
  return page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name, exact: true });
}

test(
  'a link shows the chosen drawing sheet read only and downloads it as PDF',
  { tag: '@ci-smoke' },
  async ({ page, browser }) => {
    test.setTimeout(180_000);
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Shared Drawing');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '40', depth: '20', height: '10' }
    });
    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    await expect(
      drawings
        .getByRole('application', { name: 'Sheet Sheet 1' })
        .locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 20_000 });

    const saved = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        /\/api\/projects\/[^/]+\/revisions$/.test(
          new URL(request.url()).pathname
        )
    );
    await page.keyboard.press('ControlOrMeta+s');
    const { document } = (await withHydratedDocument(
      (await saved).postDataJSON()
    )) as { document: ProjectDocument };
    const owner = normalizeDocument(document);
    const sheetId = owner.drawings!.sheets[0]!.sheetId;
    // Unchosen, the link carries no sheet. The owner's choice in Share
    // (`ShareLinkDrawings`, `handleShareLinkSheets`) is the same forward
    // write; the snapshot is the Worker's projection of the saved project.
    expect(sharedProjectSnapshotDocument(owner).drawings).toBeUndefined();
    const snapshot = sharedProjectSnapshotDocument(
      setShareLinkSheets(owner, [sheetId])
    );

    const visitorContext = await browser.newContext({ acceptDownloads: true });
    const visitor = await visitorContext.newPage();
    await stubAnonymousApi(visitor);
    await visitor.route('**/api/share', (route) =>
      route.fulfill({
        json: {
          document: snapshot,
          project: { projectId: snapshot.projectId, name: snapshot.name },
          mode: 'tweak'
        }
      })
    );
    await visitor.goto(`/#share=${token}`);
    await expect(visitor.locator('.breadcrumb')).toContainText(
      'Shared Drawing'
    );
    await mode(visitor, 'Draw').click();
    const shared = visitor.getByRole('region', { name: 'Drawings' });
    const sheet = shared.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      sheet.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });
    // Read only: no new sheet and no annotation on a visitor's link.
    await expect(
      shared.getByRole('button', { name: 'New sheet', exact: true })
    ).toBeDisabled();
    await expect(
      shared
        .getByRole('toolbar', { name: 'Annotation tools' })
        .getByRole('button', { name: 'Note' })
    ).toBeDisabled();

    const download = visitor.waitForEvent('download');
    await shared.getByRole('button', { name: 'Export PDF' }).click();
    const pdf = await readDownload(await download);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await visitorContext.close();
  }
);
