import type { Download, Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type DrawingAnnotation,
  type DrawingAnnotationId
} from '@openzcad/shared';
import {
  createStarterSheet,
  drawingSourceFingerprint
} from '../../apps/web/src/lib/drawing/sheetSources';
import { resolveDrawingAnnotation } from '../../apps/web/src/lib/drawing/annotations';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi
} from './openzcad-fixtures';

/**
 * D02: dimensions and notes on a drawing view. A dimension is picked from
 * the view's edges, reads its value from the model, exports with the sheet,
 * follows the sheet's stale/Update fence after a model edit, and comes back
 * from the saved document after a reload.
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

/**
 * The front view's drawn extent on screen: its hit box pads the projected
 * extent by 3 mm a side, and its width attribute is in paper millimetres.
 */
async function frontViewBox(canvas: Locator) {
  const hit = canvas.locator('[data-view="front"] .drawing-view-hit');
  const box = (await hit.boundingBox())!;
  const pxPerMm = box.width / Number(await hit.getAttribute('width'));
  const pad = 3 * pxPerMm;
  return {
    pxPerMm,
    left: box.x + pad,
    right: box.x + box.width - pad,
    top: box.y + pad,
    bottom: box.y + box.height - pad,
    centreX: box.x + box.width / 2,
    centreY: box.y + box.height / 2
  };
}

test(
  'cleans up broken dimensions after editing a union, with one-step undo and reopen',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    let document = setParameter(
      createProjectDocument('Dimension cleanup', toUserId('test')),
      {
        name: 'width',
        expression: '20'
      }
    );
    for (const [name, width, height] of [
      ['Base', 'width', 10],
      ['Upright', 10, 20]
    ] as const)
      document = addPrimitiveFeature(document, {
        name,
        primitiveKind: 'box',
        dimensions: { width, height, depth: 10 }
      });
    const union = booleanBodies(document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [...document.bodyOrder]
    });
    document = union.document;
    const adapter = await createExactKernelAdapter();
    try {
      const before = (await adapter.syncDocument(document)).bodyRepresentations;
      const sheet = createStarterSheet({
        name: 'Sheet 1',
        bodyIds: [union.bodyId],
        bodies: before,
        units: 'mm',
        paper: { size: 'A3', orientation: 'landscape' },
        projectionAngle: 'first',
        fingerprint: drawingSourceFingerprint(before, [union.bodyId])!
      });
      const front = sheet.views.find((view) => view.orientation === 'front')!;
      // Saved union edges use their unique geometry hash. A size edit replaces
      // some of those edges; it must not silently measure a different one.
      const candidates: DrawingAnnotation[] = before[
        union.bodyId
      ]!.topology!.edges.flatMap((edge, index) =>
        (['horizontal', 'vertical'] as const).map((direction) => ({
          kind: 'linear' as const,
          annotationId: `dann_${direction}${index}` as DrawingAnnotationId,
          viewId: front.viewId,
          direction,
          from: {
            edge: { bodyId: union.bodyId, hash: edge.hash },
            anchor: 'first' as const
          },
          to: {
            edge: { bodyId: union.bodyId, hash: edge.hash },
            anchor: 'second' as const
          },
          placementMm: { x: 0, y: -20 }
        }))
      ).filter(
        (annotation) =>
          resolveDrawingAnnotation(annotation, front, before, 'mm').ok
      );
      document = setParameter(document, { name: 'width', expression: '30' });
      const after = (await adapter.syncDocument(document)).bodyRepresentations;
      const broken = candidates
        .filter(
          (annotation) =>
            !resolveDrawingAnnotation(annotation, front, after, 'mm').ok
        )
        .slice(0, 2);
      const healthy = candidates.find(
        (annotation) =>
          resolveDrawingAnnotation(annotation, front, after, 'mm').ok
      )!;
      expect(broken).toHaveLength(2);
      expect(healthy).toBeTruthy();
      sheet.annotations = [
        ...broken,
        healthy,
        {
          kind: 'note',
          annotationId: 'dann_note' as DrawingAnnotationId,
          text: 'Keep this note',
          placementMm: { x: 25, y: 250 }
        }
      ];
      document.drawings = { sheets: [sheet] };
    } finally {
      adapter.dispose();
    }
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Cleanup fixture');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'dimensions.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document,
          files: []
        })
      )
    });
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Dimension cleanup');
    await mode(page, 'Draw').click();
    const drawings = page.getByRole('region', { name: 'Drawings' });
    await drawings.getByRole('button', { name: 'Update', exact: true }).click();
    const cleanup = drawings.getByRole('button', { name: 'Delete all broken' });
    await expect(cleanup).toBeEnabled({ timeout: 30_000 });
    const annotations = drawings.getByRole('listbox', {
      name: 'Annotations on this sheet'
    });
    await expect(
      annotations.getByRole('option', { name: /\(broken\)/ })
    ).toHaveCount(2);
    await expect(annotations.getByRole('option')).toHaveCount(4);
    await expect(
      drawings.getByRole('button', { name: 'Export PDF' })
    ).toBeDisabled();
    const beforeScreenshot = testInfo.outputPath('broken-dimensions.png');
    await page.screenshot({ path: beforeScreenshot });
    await testInfo.attach('broken-dimensions', {
      path: beforeScreenshot,
      contentType: 'image/png'
    });
    await cleanup.click();
    await expect(annotations.getByRole('option')).toHaveCount(2);
    await expect(annotations).toContainText('Keep this note');
    await expect(cleanup).toHaveCount(0);
    await expect(
      drawings.getByRole('button', { name: 'Export PDF' })
    ).toBeEnabled();
    const afterScreenshot = testInfo.outputPath('after-cleanup.png');
    await page.screenshot({ path: afterScreenshot });
    await testInfo.attach('after-cleanup', {
      path: afterScreenshot,
      contentType: 'image/png'
    });
    await page.keyboard.press('ControlOrMeta+z');
    await expect(
      annotations.getByRole('option', { name: /\(broken\)/ })
    ).toHaveCount(2);
    await expect(annotations.getByRole('option')).toHaveCount(4);
    await cleanup.click();
    await expect(annotations.getByRole('option')).toHaveCount(2);
    await expect(page.locator('.save-state')).toHaveClass(
      /is-(synced|local)\b/
    );
    await page.reload();
    await expect(annotations.getByRole('option')).toHaveCount(2, {
      timeout: 30_000
    });
    await expect(annotations).toContainText('Keep this note');
    await expect(cleanup).toHaveCount(0);
    await expect(
      drawings.getByRole('button', { name: 'Export PDF' })
    ).toBeEnabled();
    expect(errors).toEqual([]);
  }
);

test('dimensions a drawing view from the model and follows its Update', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Dimensioned');
  await page.getByRole('button', { name: 'New project' }).click();

  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '30', depth: '20', height: '10' }
  });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  await mode(page, 'Draw').click();
  const drawings = page.getByRole('region', { name: 'Drawings' });
  await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
  const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
  const panel = drawings.getByRole('complementary', {
    name: 'Drawing properties'
  });
  await expect(
    canvas.locator('[data-view="front"]:not(.is-placeholder)')
  ).toHaveCount(1, { timeout: 20_000 });
  const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });

  // Horizontal: the front view's top edge picked away from its ends is
  // dimensioned whole; the next click places the text above it.
  await tools.getByRole('button', { name: 'Horizontal' }).click();
  // Arming a tool adds its hint row and relays out the sheet.
  let front = await frontViewBox(canvas);
  await page.mouse.click(front.centreX, front.top);
  await page.mouse.click(front.centreX, front.top - 12 * front.pxPerMm);
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension 30' })
  ).toBeVisible();
  await expect(canvas.locator('.drawing-texts')).toContainText('30');

  // Vertical, on the right edge, placed to its right.
  await tools.getByRole('button', { name: 'Vertical' }).click();
  front = await frontViewBox(canvas);
  await page.mouse.click(front.right, front.centreY);
  await page.mouse.click(front.right + 12 * front.pxPerMm, front.centreY);
  await expect(
    canvas.getByRole('button', { name: 'Vertical dimension 10' })
  ).toBeVisible();

  // A note with a leader to the left edge, then its text typed.
  await tools.getByRole('button', { name: 'Note' }).click();
  front = await frontViewBox(canvas);
  await page.mouse.click(front.left, front.centreY);
  await page.mouse.click(
    front.left - 30 * front.pxPerMm,
    front.bottom + 15 * front.pxPerMm
  );
  const text = panel.getByLabel('Text');
  await text.fill('BREAK SHARP EDGES');
  await text.press('Enter');
  await expect(canvas.locator('.drawing-texts')).toContainText(
    'BREAK SHARP EDGES'
  );
  await expect(
    canvas.locator('.drawing-strokes.is-dimension polygon.is-filled')
  ).not.toHaveCount(0);

  // Delete and undo: the dimension comes back with its value.
  await canvas.getByRole('button', { name: 'Vertical dimension 10' }).click();
  await page.keyboard.press('Delete');
  await expect(
    canvas.getByRole('button', { name: 'Vertical dimension 10' })
  ).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(
    canvas.getByRole('button', { name: 'Vertical dimension 10' })
  ).toBeVisible();

  // Export: the dimensions and note are in the SVG and the PDF.
  let downloadPromise = page.waitForEvent('download');
  await drawings.getByRole('button', { name: 'Export SVG' }).click();
  const svg = (await readDownload(await downloadPromise)).toString('utf8');
  expect(svg).toContain('<g class="dimension"');
  expect(svg).toMatch(/>30<\/text>/);
  expect(svg).toMatch(/>10<\/text>/);
  expect(svg).toContain('>BREAK SHARP EDGES</text>');
  downloadPromise = page.waitForEvent('download');
  await drawings.getByRole('button', { name: 'Export PDF' }).click();
  const pdf = (await readDownload(await downloadPromise)).toString('latin1');
  expect(pdf).toContain('(30) Tj');
  expect(pdf).toContain('(BREAK SHARP EDGES) Tj');

  // Widen the box: the sheet goes stale but keeps its drawing, dimensions
  // read from the model it was drawn from, until the explicit Update reads
  // the new one.
  await mode(page, 'Build').click();
  await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
  await inspector.getByRole('textbox', { name: 'Width (X)' }).fill('45');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edited Box');
  await mode(page, 'Draw').click();
  const outdated = drawings.locator('.drawing-sync.is-outdated');
  await expect(outdated).toContainText(
    'The model changed since this sheet was drawn',
    { timeout: 20_000 }
  );
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension 30' })
  ).toBeVisible();
  await expect(
    drawings.getByRole('button', { name: 'Export PDF' })
  ).toBeEnabled();
  await outdated.getByRole('button', { name: 'Update' }).click();
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension 45' })
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    canvas.getByRole('button', { name: 'Vertical dimension 10' })
  ).toBeVisible();

  // Reopen: placement and references come back from the saved document.
  await expect(page.locator('.save-state')).toHaveClass(/is-(synced|local)\b/);
  await page.reload();
  const reopened = page
    .getByRole('region', { name: 'Drawings' })
    .getByRole('application', { name: 'Sheet Sheet 1' });
  await expect(
    reopened.getByRole('button', { name: 'Horizontal dimension 45' })
  ).toBeVisible({ timeout: 30_000 });
  await expect(reopened.locator('.drawing-texts')).toContainText(
    'BREAK SHARP EDGES'
  );
  front = await frontViewBox(reopened);
  expect(front.right - front.left).toBeGreaterThan(0);
});

/**
 * D06 slice B (schema v48): a turned part's rims are closed circles that a
 * side view draws as lines. Picked there, they measure to their silhouette
 * ends, so a cylinder's height and its side-view diameter are dimensioned.
 */
test("dimensions a cylinder's height and Ø off its rims' silhouettes", async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Turned');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '10', height: '20' }
  });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Cylinder' })
  ).toBeVisible();

  await mode(page, 'Draw').click();
  const drawings = page.getByRole('region', { name: 'Drawings' });
  await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
  const canvas = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
  const panel = drawings.getByRole('complementary', {
    name: 'Drawing properties'
  });
  await expect(
    canvas.locator('[data-view="front"]:not(.is-placeholder)')
  ).toHaveCount(1, { timeout: 20_000 });
  const tools = drawings.getByRole('toolbar', { name: 'Annotation tools' });
  await tools.getByRole('button', { name: 'Vertical' }).click();
  let front = await frontViewBox(canvas);
  // Just inside the rims' right ends: the bottom and top rims seen side-on.
  const inset = 1.5 * front.pxPerMm;

  await page.mouse.click(front.right - inset, front.bottom);
  await expect(drawings.locator('.drawing-tool-hint')).toContainText(
    'pick the second point'
  );
  await page.mouse.click(front.right - inset, front.top);
  await page.mouse.click(front.right + 12 * front.pxPerMm, front.centreY);
  await expect(
    canvas.getByRole('button', { name: 'Vertical dimension 20' })
  ).toBeVisible();

  // Across the top rim from its left end to its right: the diameter, then
  // marked Ø and as a reference dimension from the panel.
  await tools.getByRole('button', { name: 'Horizontal' }).click();
  front = await frontViewBox(canvas);
  await page.mouse.click(front.left + inset, front.top);
  await page.mouse.click(front.right - inset, front.top);
  await page.mouse.click(front.centreX, front.top - 12 * front.pxPerMm);
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension 20' })
  ).toBeVisible();
  await panel.getByLabel(/Ø diameter/).check();
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension Ø20' })
  ).toBeVisible();
  await panel.getByLabel(/Reference dimension/).check();
  await expect(
    canvas.getByRole('button', { name: 'Horizontal dimension (Ø20)' })
  ).toBeVisible();
  await expect(canvas.locator('.drawing-texts')).toContainText('(Ø20)');
});
