import { test, expect, stubApi } from './openzcad-fixtures';
import type { Download, Page } from '@playwright/test';

interface SectionGeometry {
  triangles: number;
  bounds: { min: number[]; max: number[] };
}

interface SectionRenderState {
  sectionCaps: SectionGeometry[];
  exactSections: SectionGeometry[];
}

async function sectionState(page: Page): Promise<SectionRenderState> {
  return page.locator('.viewer-host canvas').evaluate(
    (canvas: HTMLCanvasElement) =>
      new Promise<SectionRenderState>((resolve) => {
        canvas.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: { resolve }
          })
        );
      })
  );
}

async function readDownload(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function createProject(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible();
}

async function createBox(
  page: Page,
  dimensions: { width: string; depth: string; height: string },
  name: string
) {
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill(name);
  await inspector.getByLabel('Width (X)').fill(dimensions.width);
  await inspector.getByLabel('Depth (Y)').fill(dimensions.depth);
  await inspector.getByLabel('Height (Z)').fill(dimensions.height);
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: name })
  ).toBeVisible();
}

async function openExactSection(page: Page) {
  const sectionButton = page.getByRole('button', { name: /^Section display/ });
  await sectionButton.click();
  await expect(sectionButton).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('slider', { name: 'Section plane offset' })
  ).toBeVisible();
  await expect(
    page.locator('.rail-section-state-kind', { hasText: 'Exact section' })
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await sectionState(page)).exactSections.length)
    .toBe(1);
}

test('exports the exact section of a transformed body as a measured DXF', async ({
  page
}, testInfo) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'Transformed Section');
  await createBox(
    page,
    { width: '40', depth: '30', height: '20' },
    'Rotated Plate'
  );

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const move = page.getByRole('form', { name: 'Move controls' });
  await move.getByLabel('Move X in mm').fill('12');
  await move.getByLabel('Move Y in mm').fill('7');
  await move.getByLabel('Move Z in mm').fill('4');
  await move.getByLabel('Rotate Z in degrees').fill('30');
  await move.getByRole('button', { name: /Apply move/ }).click();
  await expect(page.locator('.feature-row', { hasText: 'Move' })).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  await openExactSection(page);
  const state = await sectionState(page);
  expect(state.sectionCaps).toEqual([]);
  expect(state.exactSections[0]!.triangles).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.rail-section-state-detail')).toContainText(
    'mm² of material'
  );

  await page.screenshot({
    path: testInfo.outputPath('transformed-exact-section.png')
  });
  const exportButton = page.getByRole('button', {
    name: 'Export the exact section as DXF'
  });
  await expect(exportButton).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Transformed-Section-section.dxf');
  const dxf = await readDownload(download);
  expect(dxf).toContain('AC1009');
  expect(dxf).toContain('$INSUNITS');
  expect((dxf.match(/^LINE\r?$/gm) ?? []).length).toBeGreaterThanOrEqual(4);
  expect(dxf.trimEnd().endsWith('0\r\nEOF')).toBe(true);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Exported the XY section to Transformed-Section-section.dxf.'
  );
});

test('keeps a section hole in the exact DXF and shuts export during a posed preview', async ({
  page
}, testInfo) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'Section Hole');
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await createBox(page, { width: '40', depth: '30', height: '30' }, 'Plate');

  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await inspector.getByLabel('Name').fill('Bore tool');
  await inspector.getByLabel('Radius', { exact: true }).fill('6');
  await inspector.getByLabel('Height', { exact: true }).fill('30');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Bore tool' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const move = page.getByRole('form', { name: 'Move controls' });
  await move.getByLabel('Move X in mm').fill('20');
  await move.getByLabel('Move Y in mm').fill('15');
  await move.getByRole('button', { name: /Apply move/ }).click();
  await expect(page.locator('.feature-row', { hasText: 'Move' })).toBeVisible();

  await page.getByRole('button', { name: /^Subtract \(X\)/ }).click();
  await inspector.locator('.pick-row', { hasText: 'Plate Body' }).click();
  await inspector.locator('.pick-row', { hasText: 'Bore tool Body' }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();
  const subtract = page.locator('.feature-row', { hasText: 'Subtract' });
  await expect(subtract).toBeVisible();
  await expect(subtract.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  await openExactSection(page);
  const exactState = await sectionState(page);
  expect(exactState.sectionCaps).toEqual([]);
  expect(exactState.exactSections[0]!.triangles).toBeGreaterThanOrEqual(2);
  const sectionDetail = await page
    .locator('.rail-section-state-detail')
    .textContent();
  const measuredArea = Number(sectionDetail?.match(/([0-9.]+) mm²/)?.[1]);
  expect(measuredArea).toBeCloseTo(1200 - Math.PI * 36, 0);
  const exportButton = page.getByRole('button', {
    name: 'Export the exact section as DXF'
  });
  await expect(exportButton).toBeEnabled();

  await page.screenshot({
    path: testInfo.outputPath('hole-exact-section.png')
  });
  const downloadPromise = page.waitForEvent('download');
  await exportButton.click();
  const download = await downloadPromise;
  const dxf = await readDownload(download);
  // R12 has no CIRCLE entity for a trimmed section edge here: the exact
  // exporter writes the closed circular edge as a span-true LINE chain. Four
  // lines are the plate outline; the much longer chain is the bore boundary.
  expect((dxf.match(/^LINE\r?$/gm) ?? []).length).toBeGreaterThan(20);
  expect(dxf.trimEnd().endsWith('0\r\nEOF')).toBe(true);

  // A section computed from the committed document must come down while the
  // Move preview is posing the body: the viewport is drawing a stand-in, not
  // the exact body the DXF exporter would section.
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
  await move.getByLabel('Move X in mm').fill('2');
  await expect(page.locator('.rail-section-state-kind')).toContainText(
    'Clipping preview'
  );
  await expect(exportButton).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(move).toBeHidden();
  // Cancelling the preview leaves the old exact result invalidated. Cycling
  // the display off and on requests a fresh exact section of the restored
  // document pose, which proves the refusal is recoverable.
  const sectionButton = page.getByRole('button', { name: /^Section display/ });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await sectionButton.click();
  }
  await expect(sectionButton).toHaveAttribute('aria-pressed', 'false');
  await openExactSection(page);
  await expect(exportButton).toBeEnabled();
});
