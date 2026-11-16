import type { Download, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

/**
 * D02 arc and three-point angles (schema v82): on a block whose top right
 * edge is rounded R5, the front view's quarter arc reads 90° with the Arc
 * angle tool, and three corners read 90° with the 3-point angle tool; both
 * export and reopen.
 */

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

/** A 30 × 20 × 10 block, its top right edge along y rounded R5. */
async function roundedBlock(): Promise<ProjectDocument> {
  const document = addPrimitiveFeature(
    createProjectDocument('Rounded block', toUserId('test')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 20, depth: 10 }
    }
  );
  const adapter = await createExactKernelAdapter();
  try {
    const bodyId = document.bodyOrder[0]!;
    const body = (await adapter.syncDocument(document)).bodyRepresentations[
      bodyId
    ]!;
    const { max } = body.bbox;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const edge = body.topology!.edges.find((entry) => {
      const p = entry.points;
      return [p.slice(0, 3), p.slice(p.length - 3)].every(
        (q) => near(q[0]!, max.x) && near(q[2]!, max.z)
      );
    })!;
    return filletEdges(document, {
      name: 'Round',
      targetBodyId: bodyId,
      edgeHashes: [edge.hash],
      size: 5
    }).document;
  } finally {
    adapter.dispose();
  }
}

test(
  'dimensions an arc’s included angle and the angle at a corner',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Import target');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'rounded.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: await roundedBlock(),
          files: []
        })
      )
    });
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Rounded block');

    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
    const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      canvas.locator('[data-view="front"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 30_000 });
    const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });

    const hit = canvas.locator('[data-view="front"] .drawing-view-hit');
    const frame = async () => {
      const box = (await hit.boundingBox())!;
      const widthMm = Number(await hit.getAttribute('width'));
      const pxPerMm = box.width / widthMm;
      const pad = 3 * pxPerMm;
      return {
        pxPerMm,
        // The sheet's scale: the block is 30 wide inside the 3 mm pad.
        paperPerModel: (widthMm - 6) / 30,
        left: box.x + pad,
        right: box.x + box.width - pad,
        top: box.y + pad,
        bottom: box.y + box.height - pad
      };
    };

    // The quarter arc at the top right corner, picked at its middle.
    await tools.getByRole('button', { name: 'Arc angle', exact: true }).click();
    let front = await frame();
    const inset = 5 * (1 - Math.SQRT1_2) * front.paperPerModel * front.pxPerMm;
    await page.mouse.click(front.right - inset, front.top + inset);
    await page.mouse.click(
      front.right + 14 * front.pxPerMm,
      front.top - 14 * front.pxPerMm
    );
    await expect(
      canvas.getByRole('button', { name: 'Arc angle dimension 90°' })
    ).toBeVisible();

    // The bottom left corner, then the bottom right and top left corners.
    await tools
      .getByRole('button', { name: '3-point angle', exact: true })
      .click();
    front = await frame();
    await page.mouse.click(front.left, front.bottom);
    await page.mouse.click(front.right, front.bottom);
    await page.mouse.click(front.left, front.top);
    await page.mouse.click(
      front.left + 12 * front.pxPerMm,
      front.bottom - 12 * front.pxPerMm
    );
    await expect(
      canvas.getByRole('button', { name: '3-point angle dimension 90°' })
    ).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await drawings.getByRole('button', { name: 'Export SVG' }).click();
    const svg = (await readDownload(await downloadPromise)).toString('utf8');
    expect(svg.match(/>90°<\/text>/g)?.length).toBe(2);

    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    const reopened = page
      .getByRole('region', { name: 'Drawings' })
      .getByRole('application', { name: 'Sheet Sheet 1' });
    await expect(
      reopened.getByRole('button', { name: 'Arc angle dimension 90°' })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      reopened.getByRole('button', { name: '3-point angle dimension 90°' })
    ).toBeVisible();
    expect(errors).toEqual([]);
  }
);
