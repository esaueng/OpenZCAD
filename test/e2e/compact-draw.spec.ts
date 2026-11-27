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
  type DrawingAnnotationId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createStarterSheet,
  drawingSourceFingerprint
} from '../../apps/web/src/lib/drawing/sheetSources';
import { resolveDrawingAnnotation } from '../../apps/web/src/lib/drawing/annotations';
import {
  expect,
  stubApi,
  test,
  waitForSurfacesToSettle
} from './openzcad-fixtures';
import {
  STAGE_WORD_BUDGET,
  TRAY_WORD_BUDGET,
  dropTapAfterFling,
  expectReachable,
  preferCompact,
  tabTo,
  trayWords,
  visibleWords
} from './compactHelpers';
import {
  ACTIONS,
  COMPACT_ENTRIES
} from '../../apps/web/src/lib/actions/registry';

/**
 * Draw in the compact workspace (U12 slice 9): the sheet fills the stage,
 * and Annotate, Views, Sheets, Properties and Export are the sheet's tray
 * and pages. Driven by touch only (taps, a one-finger drag for a section
 * line and a two-finger pinch) on the Scissors demo, an assembly with
 * circles to dimension and parts to balloon, at the phone sizes the
 * compact frame is built for.
 */
const SIZES = [
  { width: 390, height: 844 },
  { width: 360, height: 640 },
  { width: 844, height: 390 }
];

const sheet = (page: Page) => page.locator('.compact-sheet');
const drawings = (page: Page) => page.getByRole('region', { name: 'Drawings' });
const canvas = (page: Page) => page.locator('.drawing-canvas');
const trayButton = (page: Page, name: string) =>
  page
    .getByRole('toolbar', { name: 'Draw tools' })
    .getByRole('button', { name, exact: true });
const runRow = (page: Page) => sheet(page).locator('.compact-draw-run');
const step = (page: Page) => runRow(page).locator('.compact-step-chip');

async function openScissorsInDraw(page: Page, size: (typeof SIZES)[number]) {
  await stubApi(page);
  await preferCompact(page);
  await page.setViewportSize(size);
  await page.goto('/');
  await page.getByRole('button', { name: /^Open demo: Scissors/ }).tap();
  await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible({
    timeout: 60_000
  });
  const draw = page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: 'Draw', exact: true });
  await draw.tap();
  await expect(draw).toHaveAttribute('aria-pressed', 'true');
}

/**
 * The sheet and the paper at rest: the sheet's height spring, the stage's
 * padding riding on it and the paper's refit all done, the paper's box the
 * same on two reads in a row.
 */
async function settled(page: Page) {
  await waitForSurfacesToSettle(page, ['.compact-sheet', '.drawing-stage']);
  let last = '';
  await expect
    .poll(async () => {
      const box = await page.locator('.drawing-paper').boundingBox();
      const read = JSON.stringify(box);
      const same = box !== null && read === last;
      last = read;
      return same;
    })
    .toBe(true);
}

/** Opens a tray page, at half height or more. */
async function openPage(page: Page, name: string) {
  await trayButton(page, name).tap();
  await expect(
    sheet(page).getByRole('heading', { name, exact: true })
  ).toBeVisible();
  await expect(sheet(page)).not.toHaveAttribute('data-detent', 'peek');
}

/** The sheet's Back, to the tray at peek. */
async function back(page: Page) {
  await sheet(page).getByRole('button', { name: 'Back', exact: true }).tap();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
}

/** Starts a tool from its page: the tray becomes the tool's row. */
async function startTool(page: Page, pageName: string, tool: string) {
  await openPage(page, pageName);
  await sheet(page).getByRole('button', { name: tool, exact: true }).tap();
  await expect(
    sheet(page).getByRole('group', { name: `${tool} placement` })
  ).toBeVisible();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await settled(page);
}

/** Ends a tool that waits for its next placement. */
async function done(page: Page) {
  await runRow(page).getByRole('button', { name: 'Done' }).tap();
  await expect(trayButton(page, 'Annotate')).toBeVisible();
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
}

/** A view's visible edges on screen, as segments, longest first. */
function viewSegments(page: Page, view: string): Promise<Segment[]> {
  return page.evaluate((view) => {
    const svg = document.querySelector<SVGSVGElement>('.drawing-canvas')!;
    const hit = svg.querySelector(
      `[data-view="${view}"]:not(.is-placeholder) .drawing-view-hit`
    )!;
    const box = hit.getBoundingClientRect();
    const ctm = svg.getScreenCTM()!;
    const segments: Segment[] = [];
    for (const shape of svg.querySelectorAll<SVGPolylineElement>(
      '.drawing-strokes.is-visible :is(polyline, polygon):not(.is-filled)'
    )) {
      const points = [...shape.points].map((point) =>
        new DOMPoint(point.x, point.y).matrixTransform(ctm)
      );
      const inside = points.every(
        (point) =>
          point.x >= box.left &&
          point.x <= box.right &&
          point.y >= box.top &&
          point.y <= box.bottom
      );
      if (!inside) continue;
      for (let index = 0; index + 1 < points.length; index++) {
        const a = points[index]!;
        const b = points[index + 1]!;
        segments.push({
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          length: Math.hypot(b.x - a.x, b.y - a.y)
        });
      }
    }
    return segments.sort((a, b) => b.length - a.length);
  }, view);
}

async function paperBox(page: Page) {
  return (await page.locator('.drawing-paper').boundingBox())!;
}

/**
 * A point of bare paper on screen, well clear of every view, where the
 * armed tool's surface is what a finger lands on; null when none shows.
 */
async function blankPaperPoint(page: Page) {
  return page.evaluate(() => {
    const surface = document.querySelector('.drawing-section-surface');
    const paper = document.querySelector('.drawing-paper');
    if (!surface || !paper) return null;
    const views = [...document.querySelectorAll('.drawing-view-hit')].map(
      (view) => view.getBoundingClientRect()
    );
    const bounds = paper.getBoundingClientRect();
    const clear = 40;
    for (let y = 8; y < innerHeight; y += 12) {
      for (let x = 8; x < innerWidth - 60; x += 12) {
        if (
          x < bounds.left ||
          x + 60 > bounds.right ||
          y < bounds.top ||
          y > bounds.bottom ||
          views.some(
            (box) =>
              x + 60 > box.left - clear &&
              x < box.right + clear &&
              y > box.top - clear &&
              y < box.bottom + clear
          ) ||
          document.elementFromPoint(x, y) !== surface ||
          document.elementFromPoint(x + 60, y) !== surface
        )
          continue;
        return { x, y };
      }
    }
    return null;
  });
}

/**
 * Taps candidate points on a view's edges until the running tool takes
 * one (its step moves on from `waiting`).
 */
async function tapUntilPicked(
  page: Page,
  points: readonly { x: number; y: number }[],
  waiting: string
) {
  for (const point of points) {
    await page.touchscreen.tap(point.x, point.y);
    const moved = await expect
      .poll(() => step(page).textContent(), { timeout: 600 })
      .not.toBe(waiting)
      .then(
        () => true,
        () => false
      );
    if (moved) return point;
  }
  throw new Error(`No edge took the ${waiting} pick`);
}

/** Annotations drawn on the sheet. */
const annotationCount = (page: Page) =>
  canvas(page).locator('.drawing-annotation-hit').count();

/** One finger dragged across the screen, as a touch. */
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [from]
  });
  for (let index = 1; index <= 10; index++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * index) / 10,
          y: from.y + ((to.y - from.y) * index) / 10
        }
      ]
    });
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
  await cdp.detach();
}

/** Two fingers spread apart over the paper's middle. */
async function pinchOut(page: Page) {
  const box = await paperBox(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: x - 15, y, id: 0 },
      { x: x + 15, y, id: 1 }
    ]
  });
  for (let index = 1; index <= 8; index++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: x - 15 - 6 * index, y, id: 0 },
        { x: x + 15 + 6 * index, y, id: 1 }
      ]
    });
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
  await cdp.detach();
}

interface LayoutReport {
  smallTargets: string[];
  regularChrome: string[];
}

/**
 * The compact targets under 44 px (a check box's target is its row), and
 * any of the regular Draw chrome drawn.
 */
function layoutReport(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 0 &&
        box.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        !element.closest('[hidden], [inert], .visually-hidden')
      );
    };
    const targets = [
      ...document.querySelectorAll<HTMLElement>(
        ':is(.compact-chrome, .compact-draw-zoom, .compact-draw-chip) :is(button, select, input, summary, [role="slider"]), .compact-draw-chip'
      )
    ].filter(shown);
    const smallTargets = targets
      .map((element) => {
        const target =
          element instanceof HTMLInputElement &&
          (element.type === 'checkbox' || element.type === 'radio')
            ? (element.closest('label') ?? element)
            : element;
        const box = target.getBoundingClientRect();
        return { element, box };
      })
      .filter(({ box }) => box.width < 43.5 || box.height < 43.5)
      .map(
        ({ element, box }) =>
          `${element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.className} ${Math.round(box.width)}×${Math.round(box.height)}`
      );
    const regularChrome = [
      '.drawing-stage-bar',
      '.drawing-tool-rail',
      '.drawing-tool-hint',
      '.drawing-panel',
      '.drawing-banner.is-blocked',
      '.view-mode-bar',
      '.view-rail',
      '.instrument-rail'
    ].filter((selector) =>
      [...document.querySelectorAll(selector)].some(shown)
    );
    return { smallTargets, regularChrome };
  });
}

/**
 * Every target at least 44 px, no regular Draw chrome, and the sheet's
 * zoom controls the topmost thing where they stand.
 */
async function expectTidy(page: Page) {
  await settled(page);
  const report = await layoutReport(page);
  expect(report.smallTargets).toEqual([]);
  expect(report.regularChrome).toEqual([]);
  for (const name of ['Zoom in', 'Dark paper']) {
    await expectReachable(
      page
        .getByRole('toolbar', { name: 'Sheet zoom' })
        .getByRole('button', { name })
    );
  }
}

async function readDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The sheet's views, as its Views page lists them. */
const viewOptions = (page: Page): Locator =>
  sheet(page)
    .getByRole('listbox', { name: 'Views on this sheet' })
    .getByRole('option');

/**
 * A union whose width parameter changed after its sheet was drawn: two
 * of the sheet's dimensions measure edges the edit replaced, so they
 * break once the sheet is updated.
 */
async function brokenDimensionsProject(): Promise<ProjectDocument> {
  let document = setParameter(
    createProjectDocument('Broken dimensions', toUserId('test')),
    { name: 'width', expression: '20' }
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
    expect(broken).toHaveLength(2);
    sheet.annotations = broken;
    return { ...document, drawings: { sheets: [sheet] } };
  } finally {
    adapter.dispose();
  }
}

/**
 * The notice's Undo after a delete: in reach over the sheet, a finger's
 * size, and tapped.
 */
async function tapNoticeUndo(page: Page) {
  const undo = page.locator('.toast').getByRole('button', { name: 'Undo' });
  await expectReachable(undo);
  // Measured once the notice has finished coming in (it scales up).
  await undo.evaluate((element) =>
    Promise.all(
      element
        .closest('.toast')!
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished)
    )
  );
  const box = (await undo.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(43.5);
  expect(box.height).toBeGreaterThanOrEqual(43.5);
  await undo.tap();
}

test.describe('Draw in the compact sheet', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const size of SIZES) {
    const smoke = size.width === 390 ? { tag: '@ci-smoke' } : {};

    test(
      `draws, annotates, sections and exports a sheet by touch at ${size.width}×${size.height}`,
      smoke,
      async ({ page }) => {
        test.setTimeout(240_000);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await openScissorsInDraw(page, size);

        // Before the first sheet, the tray at peek offers New sheet alone,
        // and the stage's invitation takes a finger too.
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        await expect(trayButton(page, 'Annotate')).toHaveCount(0);
        const newSheet = trayButton(page, 'New sheet');
        await expectReachable(newSheet);
        const invitation = (await drawings(page)
          .getByRole('button', { name: 'New drawing sheet' })
          .boundingBox())!;
        expect(invitation.height).toBeGreaterThanOrEqual(44);
        expect((await layoutReport(page)).smallTargets).toEqual([]);
        await newSheet.tap();
        await expect(
          canvas(page).locator('[data-view="top"]:not(.is-placeholder)')
        ).toHaveCount(1, { timeout: 60_000 });
        await expect(trayButton(page, 'Annotate')).toBeEnabled();
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        await expectTidy(page);
        // At rest the stage shows no sentences: the paper is the user's
        // own drawing, and the rest is icons.
        const words = await visibleWords(
          page,
          '.app-shell[data-shell="compact"]',
          [
            '.compact-project-name',
            '.compact-selection-chip',
            '.drawing-canvas'
          ]
        );
        expect(words.length, words.join(' ')).toBeLessThanOrEqual(
          STAGE_WORD_BUDGET
        );

        // A view, from the Views page.
        await openPage(page, 'Views');
        const viewsBefore = await viewOptions(page).count();
        await sheet(page).getByRole('button', { name: 'Add view' }).tap();
        await expect(viewOptions(page)).toHaveCount(viewsBefore + 1);
        // It lands beside the others, off this paper: Fit lays them out
        // again on it, as the regular panel's Fit does.
        const fit = sheet(page).getByRole('button', {
          name: 'Fit views to sheet'
        });
        await fit.scrollIntoViewIfNeeded();
        await fit.tap();
        await expectTidy(page);
        // Its configuration, and Delete view, beside the list.
        await expect(
          sheet(page).getByRole('button', { name: 'Delete view' })
        ).toBeVisible();
        await back(page);

        // A horizontal dimension on the top view's longest edge.
        let annotations = await annotationCount(page);
        await startTool(page, 'Annotate', 'Horizontal');
        await expect(step(page)).toHaveText('Point 1');
        expect((await trayWords(page)).length).toBeLessThanOrEqual(
          TRAY_WORD_BUDGET
        );
        await expectTidy(page);
        const longest = (await viewSegments(page, 'top')).slice(0, 6);
        const picked = await tapUntilPicked(
          page,
          longest.map((edge) => ({
            x: (edge.x1 + edge.x2) / 2,
            y: (edge.y1 + edge.y2) / 2
          })),
          'Point 1'
        );
        await expect(step(page)).toHaveText('Place');
        const paper = await paperBox(page);
        await page.touchscreen.tap(picked.x, picked.y - paper.height * 0.05);
        await expect.poll(() => annotationCount(page)).toBe(annotations + 1);
        // The tool waits for the next one until Done.
        await expect(step(page)).toHaveText('Point 1');
        await done(page);

        // A radius on one of the finger loops.
        annotations = await annotationCount(page);
        await startTool(page, 'Annotate', 'Radius');
        await expect(step(page)).toHaveText('Circle');
        const loops = (await viewSegments(page, 'top'))
          .filter((_, index) => index % 7 === 0)
          .map((edge) => ({ x: edge.x1, y: edge.y1 }));
        const circle = await tapUntilPicked(page, loops, 'Circle');
        await page.touchscreen.tap(
          Math.max(paper.x + 8, circle.x - paper.width * 0.04),
          circle.y - paper.height * 0.06
        );
        await expect.poll(() => annotationCount(page)).toBe(annotations + 1);
        await done(page);

        // A note on empty paper: placed, it opens its properties.
        annotations = await annotationCount(page);
        await startTool(page, 'Annotate', 'Note');
        await expect(step(page)).toHaveText('Leader');
        await page.touchscreen.tap(
          paper.x + paper.width * 0.5,
          paper.y + paper.height * 0.1
        );
        await expect.poll(() => annotationCount(page)).toBe(annotations + 1);
        await expect(
          sheet(page).getByRole('heading', { name: 'Properties', exact: true })
        ).toBeVisible();
        await expectTidy(page);
        await back(page);

        // A balloon on an edge of a part.
        annotations = await annotationCount(page);
        await startTool(page, 'Annotate', 'Balloon');
        await expect(step(page)).toHaveText('Edge');
        const edges = (await viewSegments(page, 'top')).slice(0, 12);
        const part = await tapUntilPicked(
          page,
          edges.map((edge) => ({
            x: (edge.x1 + edge.x2) / 2,
            y: (edge.y1 + edge.y2) / 2
          })),
          'Edge'
        );
        await page.touchscreen.tap(part.x, part.y + paper.height * 0.08);
        await expect.poll(() => annotationCount(page)).toBe(annotations + 1);
        await expect(
          canvas(page).getByRole('button', { name: /^Balloon \d/ })
        ).toHaveCount(1);
        await done(page);

        // A section view: a line dragged across the top view, then placed.
        await openPage(page, 'Views');
        const sectionsBefore = await viewOptions(page).count();
        await back(page);
        await startTool(page, 'Views', 'Section view');
        await expect(step(page)).toHaveText('Line');
        const top = (await canvas(page)
          .locator('[data-view="top"] .drawing-view-hit')
          .boundingBox())!;
        const middle = top.y + top.height / 2;
        await touchDrag(
          page,
          { x: top.x + top.width * 0.15, y: middle },
          { x: top.x + top.width * 0.85, y: middle }
        );
        await expect(step(page)).toHaveText('Place');
        await page.touchscreen.tap(
          top.x + top.width / 2,
          top.y - paper.height * 0.05
        );
        await expect(runRow(page)).toHaveCount(0);
        await openPage(page, 'Views');
        await expect(viewOptions(page)).toHaveCount(sectionsBefore + 1);
        await expect(
          viewOptions(page).filter({ hasText: /^Section/ })
        ).toHaveCount(1);
        await back(page);

        // A second sheet, renamed.
        await openPage(page, 'Sheets');
        await sheet(page)
          .getByRole('button', { name: 'New drawing sheet' })
          .tap();
        const sheets = sheet(page).getByRole('list', { name: 'Sheets' });
        await expect(sheets.getByRole('listitem')).toHaveCount(2);
        await sheet(page).getByRole('button', { name: 'Rename Sheet 2' }).tap();
        const name = sheet(page).getByRole('textbox', { name: 'Sheet name' });
        await name.fill('Details');
        await sheet(page).getByRole('button', { name: 'Save name' }).tap();
        await expect(
          sheets.getByRole('button', { name: 'Details', exact: true })
        ).toHaveAttribute('aria-pressed', 'true');
        await expectTidy(page);
        // Back to the first, where the annotations are.
        await sheets
          .getByRole('button', { name: 'Sheet 1', exact: true })
          .tap();
        await back(page);

        // A title-block field.
        await openPage(page, 'Properties');
        const title = sheet(page).getByLabel('Title', { exact: true });
        await title.tap();
        await title.fill('Shears');
        await back(page);
        await expect(
          canvas(page).locator('.drawing-texts text', { hasText: 'Shears' })
        ).toHaveCount(1);
        await openPage(page, 'Properties');
        await expect(
          sheet(page).getByLabel('Title', { exact: true })
        ).toHaveValue('Shears');
        await expectTidy(page);
        await back(page);

        // A PDF.
        await openPage(page, 'Export');
        const pdf = sheet(page).getByRole('button', { name: 'Export PDF' });
        await expect(pdf).toBeEnabled({ timeout: 30_000 });
        const downloading = page.waitForEvent('download');
        await pdf.tap();
        const download = await downloading;
        expect(download.suggestedFilename()).toMatch(/\.pdf$/);
        expect((await readDownload(download)).subarray(0, 5).toString()).toBe(
          '%PDF-'
        );
        await back(page);

        // Pinch to zoom the sheet, and Fit back.
        const fitted = await canvas(page).getAttribute('viewBox');
        await pinchOut(page);
        await expect(canvas(page)).toHaveClass(/is-zoomed/);
        expect(await canvas(page).getAttribute('viewBox')).not.toBe(fitted);
        await expectTidy(page);
        await page
          .getByRole('toolbar', { name: 'Sheet zoom' })
          .getByRole('button', { name: 'Fit sheet' })
          .tap();
        await expect(canvas(page)).toHaveAttribute('viewBox', fitted!);
        expect(errors).toEqual([]);
      }
    );
  }

  test('draws a section and a detail on a zoomed sheet, worded for a finger, with a new view in sight', async ({
    page
  }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // As on Linux CI and ChromeOS: the tap after a drag across the sheet
    // makes no click. Cancel must still end the tool (review case).
    await dropTapAfterFling(page);
    await openScissorsInDraw(page, SIZES[1]!);
    await trayButton(page, 'New sheet').tap();
    await expect(
      canvas(page).locator('[data-view="top"]:not(.is-placeholder)')
    ).toHaveCount(1, { timeout: 60_000 });
    await settled(page);

    // The annotation list's empty line points at the tools above it, not
    // at the regular sheet's left.
    await openPage(page, 'Annotate');
    await expect(
      sheet(page).getByText(/^Pick a dimension tool above\./)
    ).toBeVisible();
    await expect(sheet(page).getByText(/sheet's left/)).toHaveCount(0);
    await back(page);

    // Add view selects the new view: its settings, above the list, come
    // into sight rather than staying scrolled off the page's top.
    await openPage(page, 'Views');
    const add = sheet(page).getByRole('button', { name: 'Add view' });
    await add.scrollIntoViewIfNeeded();
    await add.tap();
    const settings = sheet(page).locator('.compact-draw-selected');
    await expect(settings.locator('.drawing-selection-title')).toBeInViewport({
      ratio: 1
    });
    await back(page);

    // Zoomed in, a finger's drag across a view draws the section line:
    // the paper does not pan under it.
    const zoom = page.getByRole('toolbar', { name: 'Sheet zoom' });
    await zoom.getByRole('button', { name: 'Zoom in' }).tap();
    await zoom.getByRole('button', { name: 'Zoom in' }).tap();
    await expect(canvas(page)).toHaveClass(/is-zoomed/);
    await startTool(page, 'Views', 'Section view');
    // Off every view, the same drag pans the zoomed paper instead (review
    // case: the tool's surface took the press, and nothing panned).
    const before = await canvas(page).getAttribute('viewBox');
    const blank = await blankPaperPoint(page);
    expect(blank, 'bare paper on screen').not.toBeNull();
    await touchDrag(page, blank!, { x: blank!.x + 60, y: blank!.y });
    await expect(canvas(page)).not.toHaveAttribute('viewBox', before!);
    await expect(step(page)).not.toHaveText('Place');
    const zoomed = await canvas(page).getAttribute('viewBox');
    const top = (await canvas(page)
      .locator('[data-view="top"] .drawing-view-hit')
      .boundingBox())!;
    const paper = await paperBox(page);
    const left = Math.max(top.x, paper.x, 0) + 12;
    const right = Math.min(top.x + top.width, paper.x + paper.width, 360) - 12;
    const middle = top.y + top.height / 2;
    await touchDrag(page, { x: left, y: middle }, { x: right, y: middle });
    await expect(step(page)).toHaveText('Place');
    expect(await canvas(page).getAttribute('viewBox')).toBe(zoomed);
    // Its step, for a finger: tap, not click.
    await expect(runRow(page).getByRole('status')).toHaveText(
      /tap\.$|then tap\b/
    );
    await expect(runRow(page).getByRole('status')).not.toHaveText(/click/i);
    await runRow(page).getByRole('button', { name: 'Cancel' }).tap();
    await expect(runRow(page)).toHaveCount(0);

    // A detail circle the same way.
    await startTool(page, 'Views', 'Detail view');
    const detailZoom = await canvas(page).getAttribute('viewBox');
    const front = (await canvas(page)
      .locator('[data-view="top"] .drawing-view-hit')
      .boundingBox())!;
    const centre = {
      x: Math.min(Math.max(front.x + front.width / 2, 40), 320),
      y: front.y + front.height / 2
    };
    await touchDrag(page, centre, { x: centre.x + 24, y: centre.y });
    await expect(step(page)).toHaveText('Place');
    expect(await canvas(page).getAttribute('viewBox')).toBe(detailZoom);
    await runRow(page).getByRole('button', { name: 'Cancel' }).tap();
    expect(errors).toEqual([]);
  });

  for (const size of [SIZES[0]!, SIZES[2]!]) {
    test(
      `puts Undo in reach after deleting broken annotations, a view and a sheet at ${size.width}×${size.height}`,
      size.width === 390 ? { tag: '@ci-smoke' } : {},
      async ({ page }) => {
        test.setTimeout(240_000);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const document = await brokenDimensionsProject();
        await stubApi(page);
        await preferCompact(page);
        await page.setViewportSize(size);
        await page.goto('/');
        await page.getByLabel('Import project backup').setInputFiles({
          name: 'broken.openzcad',
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
          page.locator('.app-shell[data-shell="compact"]')
        ).toBeVisible({ timeout: 60_000 });
        const draw = page
          .getByRole('group', { name: 'Workspace mode' })
          .getByRole('button', { name: 'Draw', exact: true });
        await draw.tap();
        await expect(draw).toHaveAttribute('aria-pressed', 'true');

        // The model changed since the sheet was drawn: Export offers its
        // Update, which redraws the sheet and breaks the two dimensions.
        await openPage(page, 'Export');
        const update = sheet(page).getByRole('button', { name: 'Update' });
        await expect(update).toBeEnabled({ timeout: 60_000 });
        await update.tap();
        const cleanup = sheet(page).getByRole('button', {
          name: 'Delete all broken'
        });
        await expect(cleanup).toBeEnabled({ timeout: 60_000 });
        await expect(
          sheet(page).getByRole('button', { name: 'Export PDF' })
        ).toBeDisabled();

        // Delete all broken, then Undo from the notice: they are back.
        await cleanup.tap();
        await expect(cleanup).toHaveCount(0);
        await tapNoticeUndo(page);
        await expect(cleanup).toBeEnabled();
        await back(page);

        // A view deleted, and back.
        await openPage(page, 'Views');
        const views = await viewOptions(page).count();
        await viewOptions(page).first().tap();
        await sheet(page).getByRole('button', { name: 'Delete view' }).tap();
        await expect(viewOptions(page)).toHaveCount(views - 1);
        await tapNoticeUndo(page);
        await expect(viewOptions(page)).toHaveCount(views);
        await back(page);

        // A sheet deleted, and back.
        await openPage(page, 'Sheets');
        await sheet(page)
          .getByRole('button', { name: 'New drawing sheet' })
          .tap();
        const sheets = sheet(page)
          .getByRole('list', { name: 'Sheets' })
          .getByRole('listitem');
        await expect(sheets).toHaveCount(2);
        await sheet(page).getByRole('button', { name: 'Delete Sheet 2' }).tap();
        await expect(sheets).toHaveCount(1);
        await tapNoticeUndo(page);
        await expect(sheets).toHaveCount(2);

        // At full height the stage under the sheet is inert: the notice
        // stands outside it, so its Undo still takes a tap and focus.
        const grabber = sheet(page).getByRole('slider', {
          name: 'Sheet height'
        });
        if (size.width > size.height) {
          // The side sheet's drag stops at half: full is the slider's end.
          await grabber.press('End');
        } else {
          const grip = (await grabber.boundingBox())!;
          await touchDrag(
            page,
            { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
            { x: grip.x + grip.width / 2, y: 4 }
          );
        }
        await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
        await expect(page.locator('.app-shell > .workspace')).toHaveAttribute(
          'inert',
          ''
        );
        await sheet(page).getByRole('button', { name: 'Delete Sheet 2' }).tap();
        await expect(sheets).toHaveCount(1);
        const undo = page
          .locator('.toast')
          .getByRole('button', { name: 'Undo' });
        await expect(
          undo.locator('xpath=ancestor-or-self::*[@inert]')
        ).toHaveCount(0);
        // By keyboard from inside the sheet, both ways round: the sheet's
        // focus trap takes the notice in, and Enter runs its Undo (review
        // case: the trap wrapped inside the sheet, past the Undo).
        await grabber.focus();
        await tabTo(page, undo, 'Tab');
        await grabber.focus();
        await tabTo(page, undo, 'Shift+Tab');
        await page.keyboard.press('Enter');
        await expect(sheets).toHaveCount(2);
        await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
        expect(errors).toEqual([]);
      }
    );
  }

  test(
    'reaches every drawing tool in the registry by taps',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(240_000);
      // The sheet cross-fades between heights rather than springing: 25
      // round trips through a page need no motion to read.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openScissorsInDraw(page, SIZES[0]!);
      await drawings(page)
        .getByRole('button', { name: 'New drawing sheet' })
        .tap();
      await expect(
        canvas(page).locator('[data-view="top"]:not(.is-placeholder)')
      ).toHaveCount(1, { timeout: 60_000 });
      const entries = ACTIONS.filter(
        (entry) => COMPACT_ENTRIES[entry.id] === 'draw-tray'
      );
      // Draw's 25 letter keys, every one with a compact entry.
      expect(entries).toHaveLength(25);
      expect(
        ACTIONS.filter((entry) => entry.sources.includes('drawing')).map(
          (entry) => entry.id
        )
      ).toEqual(entries.map((entry) => entry.id));
      const viewTools = new Set([
        'drawing-section-view',
        'drawing-detail-view',
        'drawing-auxiliary-view'
      ]);
      const reached: string[] = [];
      for (const entry of entries) {
        await openPage(page, viewTools.has(entry.id) ? 'Views' : 'Annotate');
        const tile = sheet(page).getByRole('button', {
          name: entry.label,
          exact: true
        });
        await tile.scrollIntoViewIfNeeded();
        await expectReachable(tile);
        const refused = (await tile.getAttribute('aria-disabled')) === 'true';
        // A refused tile is aria-disabled, which Playwright's own tap waits
        // out; a finger does not.
        const box = (await tile.boundingBox())!;
        await page.touchscreen.tap(
          box.x + box.width / 2,
          box.y + box.height / 2
        );
        if (refused) {
          // A tool the sheet cannot take yet says why, in place.
          await expect(sheet(page).locator('.compact-tray-reason')).toHaveText(
            new RegExp(`^${entry.label}: `)
          );
          await back(page);
        } else {
          const row = sheet(page).getByRole('group', {
            name: `${entry.label} placement`
          });
          await expect(row).toBeVisible();
          await row.getByRole('button', { name: 'Cancel' }).tap();
          await expect(trayButton(page, 'Annotate')).toBeVisible();
        }
        reached.push(entry.id);
      }
      expect(reached).toHaveLength(25);
    }
  );
});
