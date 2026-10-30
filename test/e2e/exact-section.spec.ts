import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi,
  finishInPlaceCommand,
  pickObjectsBody,
  openMoveOptions
} from './openzcad-fixtures';
import type { Download, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  duplicateProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { WORKSPACE_SESSION_STORAGE_KEY } from '../../apps/web/src/lib/workspaceSession';

interface SectionGeometry {
  triangles: number;
  bounds: { min: number[]; max: number[] };
}

interface SectionRenderState {
  sectionCaps: SectionGeometry[];
  exactSections: SectionGeometry[];
}

interface DxfLine {
  start: [number, number];
  end: [number, number];
}

function dxfLines(text: string): DxfLine[] {
  const values = text.split(/\r?\n/).filter((line) => line.length > 0);
  const pairs: Array<[number, string]> = [];
  for (let index = 0; index < values.length; index += 2) {
    pairs.push([Number(values[index]), values[index + 1]!]);
  }

  const result: DxfLine[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const [code, value] = pairs[index]!;
    if (code !== 0 || value !== 'LINE') continue;
    const coordinates = new Map<number, number>();
    for (let next = index + 1; next < pairs.length; next += 1) {
      const [nextCode, nextValue] = pairs[next]!;
      if (nextCode === 0) break;
      if ([10, 11, 20, 21].includes(nextCode)) {
        coordinates.set(nextCode, Number(nextValue));
      }
    }
    const start = [coordinates.get(10), coordinates.get(20)];
    const end = [coordinates.get(11), coordinates.get(21)];
    if (
      start.some((value) => value === undefined) ||
      end.some((value) => value === undefined)
    ) {
      throw new Error('DXF LINE is missing an endpoint.');
    }
    result.push({
      start: start as [number, number],
      end: end as [number, number]
    });
  }
  return result;
}

function samePoint(a: readonly [number, number], b: readonly [number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
}

function closedLineChains(
  lines: readonly DxfLine[]
): Array<Array<[number, number]>> {
  const unused = new Set(lines.map((_, index) => index));
  const chains: Array<Array<[number, number]>> = [];
  while (unused.size > 0) {
    const firstIndex = unused.values().next().value as number;
    unused.delete(firstIndex);
    const first = lines[firstIndex]!;
    const points: Array<[number, number]> = [[...first.start], [...first.end]];
    let cursor: [number, number] = [...first.end];
    while (!samePoint(cursor, first.start)) {
      let nextPoint: [number, number] | undefined;
      for (const candidateIndex of unused) {
        const candidate = lines[candidateIndex]!;
        if (samePoint(candidate.start, cursor)) {
          nextPoint = [...candidate.end];
        } else if (samePoint(candidate.end, cursor)) {
          nextPoint = [...candidate.start];
        }
        if (nextPoint) {
          unused.delete(candidateIndex);
          break;
        }
      }
      if (!nextPoint)
        throw new Error('DXF LINE entities do not form closed loops.');
      points.push(nextPoint);
      cursor = nextPoint;
    }
    chains.push(points);
  }
  return chains;
}

function polygonArea(points: readonly (readonly [number, number])[]) {
  let twiceArea = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[index + 1]!;
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea) / 2;
}

function pointBounds(points: readonly (readonly [number, number])[]) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    min: [Math.min(...xs), Math.min(...ys)],
    max: [Math.max(...xs), Math.max(...ys)]
  };
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
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible();
}

async function createBox(
  page: Page,
  dimensions: { width: string; depth: string; height: string },
  name: string
) {
  await createPrimitiveInPlace(page, 'box', {
    sizes: {
      width: dimensions.width,
      depth: dimensions.depth,
      height: dimensions.height
    },
    name: name
  });
  await expect(
    page.locator('.feature-row-main', { hasText: name })
  ).toBeVisible();
}

async function openExactSection(page: Page) {
  const sectionButton = page.getByRole('button', { name: /^Section view/ });
  await sectionButton.click();
  await expect(sectionButton).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('slider', { name: 'Section plane offset' })
  ).toBeVisible();
  await expect(
    page.locator('.rail-section-state-kind', { hasText: 'Exact' })
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await sectionState(page)).exactSections.length)
    .toBe(1);
}

test('restores each duplicated project’s own exact section with shared body IDs and versions', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  const owner = toUserId('user_e2e');
  const source = addPrimitiveFeature(
    createProjectDocument('Section source', owner),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, depth: 30, height: 20 }
    }
  );
  const copy = duplicateProjectDocument(source, 'Section copy', owner);
  const feature = Object.values(copy.nodes).find(
    (node) => node.kind === 'feature' && node.data.featureKind === 'primitive'
  );
  if (
    !feature ||
    feature.kind !== 'feature' ||
    feature.data.featureKind !== 'primitive'
  )
    throw new Error('Missing fixture primitive');
  feature.data.dimensions.width = 20;
  copy.version = source.version;
  expect(copy.bodyOrder).toEqual(source.bodyOrder);
  const documents = [source, copy];
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            projects: documents.map((document) => ({
              projectId: document.projectId,
              name: document.name,
              revisionCount: document.checkpoints.length,
              updatedAt: document.derived.updatedAt
            }))
          }
        })
      : route.fallback()
  );
  await page.route('**/api/projects/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const document = documents.find((document) => document.projectId === id);
    return route.request().method() === 'GET' && document
      ? route.fulfill({ json: document })
      : route.fallback();
  });
  await page.addInitScript(
    ({ key, projectIds }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          activeProjectId: null,
          pointerRevision: 0,
          views: Object.fromEntries(
            projectIds.map((id) => [
              id,
              {
                camera: {
                  position: [80, 80, 80],
                  target: [20, 15, 10],
                  orthographicZoom: 1
                },
                projection: 'perspective',
                settings: {
                  showGrid: true,
                  displayMode: 'shaded-edges',
                  sectionView: { plane: 'XY', offset: 5 }
                },
                hiddenBodyIds: [],
                updatedAt: Date.now()
              }
            ])
          )
        })
      );
    },
    {
      key: WORKSPACE_SESSION_STORAGE_KEY,
      projectIds: documents.map((document) => document.projectId)
    }
  );
  await page.goto('/');
  for (const [name, area] of [
    ['Section source', 800],
    ['Section copy', 400],
    ['Section source', 800]
  ] as const) {
    await page.getByRole('button', { name: new RegExp(`^${name} `) }).click();
    await expect(page.locator('.rail-section-state-kind')).toHaveText('Exact', {
      timeout: 30_000
    });
    await expect(page.locator('.rail-section-state-detail')).toContainText(
      `${area} mm² of material`
    );
    await expect(
      page.getByRole('button', { name: 'Export the exact section as DXF' })
    ).toBeEnabled();
    await page.getByTitle('Back to projects').click();
  }
});

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
  await openMoveOptions(move);
  await move.getByLabel('Move X in mm').fill('12');
  await move.getByLabel('Move Y in mm').fill('7');
  await move.getByLabel('Move Z in mm').fill('4');
  await move.getByLabel('Rotate Z in degrees').fill('30');
  await move.getByRole('button', { name: 'Done' }).click();
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
  const lines = dxfLines(dxf);
  expect(lines).toHaveLength(4);
  const bounds = pointBounds(lines.flatMap((line) => [line.start, line.end]));
  const angle = Math.PI / 6;
  const expectedWidth = 40 * Math.cos(angle) + 30 * Math.sin(angle);
  const expectedHeight = 40 * Math.sin(angle) + 30 * Math.cos(angle);
  // The four UI values define a 40 x 30 plate whose centre moves to (32, 22)
  // and rotates 30 degrees. These bounds are independent of the rail report,
  // so exporting an untransformed rectangle cannot satisfy this check.
  expect(bounds.min[0]).toBeCloseTo(32 - expectedWidth / 2, 2);
  expect(bounds.max[0]).toBeCloseTo(32 + expectedWidth / 2, 2);
  expect(bounds.min[1]).toBeCloseTo(22 - expectedHeight / 2, 2);
  expect(bounds.max[1]).toBeCloseTo(22 + expectedHeight / 2, 2);
  const lengths = lines
    .map((line) =>
      Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1])
    )
    .sort((a, b) => a - b);
  for (const [actual, expected] of lengths.map(
    (actual, index) => [actual, index < 2 ? 30 : 40] as const
  )) {
    expect(actual).toBeCloseTo(expected, 2);
  }
  expect(dxf.trimEnd().endsWith('0\r\nEOF')).toBe(true);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Exported the XY section to Transformed-Section-section.dxf.'
  );

  // A persisted cut restores its exact curves, not only its clipping settings.
  const position = page.getByLabel('Cut position', { exact: true });
  await position.fill('11.125');
  await position.press('Enter');
  await page.getByRole('button', { name: 'Flip cut direction' }).click();
  await expect(exportButton).toBeEnabled();
  await page.reload();
  await expect(position).toHaveValue('11.125', { timeout: 30_000 });
  await expect(
    page.getByRole('button', { name: 'Flip cut direction' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(exportButton).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('.rail-section-state-kind')).toHaveText('Exact');
  await expect
    .poll(async () => (await sectionState(page)).exactSections.length)
    .toBe(1);
});

test('keeps a section hole in the exact DXF and shuts export during a posed preview', async ({
  page
}, testInfo) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'Section Hole');
  await createBox(page, { width: '40', depth: '30', height: '30' }, 'Plate');

  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '6', height: '30' },
    name: 'Bore tool'
  });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Bore tool' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const move = page.getByRole('form', { name: 'Move controls' });
  await openMoveOptions(move);
  await move.getByLabel('Move X in mm').fill('20');
  await move.getByLabel('Move Y in mm').fill('15');
  await move.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.feature-row', { hasText: 'Move' })).toBeVisible();

  // U09: Subtract runs in place: the base, then the tool, then Done.
  await page.getByRole('button', { name: /^Subtract \(X\)/ }).click();
  await pickObjectsBody(page, 'Plate 1');
  await pickObjectsBody(page, 'Bore tool 1');
  await finishInPlaceCommand(page, 'Subtract');
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
  const chains = closedLineChains(dxfLines(dxf));
  expect(chains).toHaveLength(2);
  const areas = chains.map(polygonArea).sort((a, b) => a - b);
  expect(areas[1]).toBeCloseTo(40 * 30, 6);
  // The circular edge is span-true LINE tessellation, so its polygon area is
  // just below pi*r². A radius/bounds check proves the inner loop exists even
  // if its segment count changes.
  expect(Math.abs(areas[0]! - Math.PI * 6 ** 2)).toBeLessThan(0.5);
  const hole = chains.find((chain) => polygonArea(chain) === areas[0])!;
  const holeBounds = pointBounds(hole);
  expect(holeBounds.min[0]).toBeCloseTo(14, 6);
  expect(holeBounds.max[0]).toBeCloseTo(26, 6);
  expect(holeBounds.min[1]).toBeCloseTo(9, 6);
  expect(holeBounds.max[1]).toBeCloseTo(21, 6);
  expect(dxf.trimEnd().endsWith('0\r\nEOF')).toBe(true);

  // A section computed from the committed document must come down while the
  // Move preview is posing the body: the viewport is drawing a stand-in, not
  // the exact body the DXF exporter would section.
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
  await openMoveOptions(move);
  await move.getByLabel('Move X in mm').fill('2');
  await expect(page.locator('.rail-section-state-kind')).toContainText(
    'Preview'
  );
  // A Move's bar holds the command row, not the lane (U09), so the section
  // controls stay up; the export under them is disabled while it poses.
  await expect(page.locator('.rail-section-panel')).toBeVisible();
  await expect(page.locator('.rail-section-export')).toBeDisabled();

  await page.keyboard.press('Escape');
  await expect(move).toBeHidden();
  await expect(page.locator('.rail-section-panel')).toBeVisible();
  // Cancelling the preview leaves the old exact result invalidated. Cycling
  // the display off and on requests a fresh exact section of the restored
  // document pose, which proves the refusal is recoverable.
  const sectionButton = page.getByRole('button', { name: /^Section view/ });
  const cutSwitch = page.getByRole('switch', { name: 'Section cut' });
  const sectionPanel = page.locator('.rail-section-panel');
  // Cancellation can render one frame before the section-view state is
  // cleared. Read the rail button, which is always there, and switch the cut
  // off only while it is still on. A clear that lands first takes the panel
  // (and its switch) with it, so the click gives up quickly and the loop
  // reads the button again; either settled state is the same explicit off.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await sectionButton.getAttribute('aria-pressed')) !== 'true') break;
    await cutSwitch.click({ timeout: 2_000 }).catch(() => undefined);
  }
  await expect(sectionButton).toHaveAttribute('aria-pressed', 'false');
  // Only the switch leaves its panel up; the section button puts it away.
  // With the cut already off, that press can only hide the panel.
  if ((await sectionPanel.count()) > 0) await sectionButton.click();
  await expect(sectionPanel).toHaveCount(0);
  await openExactSection(page);
  await expect(exportButton).toBeEnabled();
});
