import type { Locator, Page } from '@playwright/test';
import type { GeometryBodyRepresentation } from '@openzcad/shared';
import {
  clickWorldPoint,
  createPrimitiveInPlace,
  enterCommandValue,
  expect,
  expectBodyCount,
  pickObjectsBody,
  pressTool,
  revealModelPanel,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';
import {
  SPLIT_PLANE_MISSES,
  SPLIT_PLANE_ON_FACE
} from '../../apps/web/src/lib/refusalLanguage';

/**
 * K10 workflow coupon (Slice 0), browser half: Split by a picked face on the
 * A0 coupon blank (x 0–90, y 0–36, z 0–14) beside a witness block
 * (x 100–120). The command bar must show a typed refusal for a plane that
 * only touches or misses the body, keep the body and plane picked, keep Done
 * disabled, and recover when the plane is slid back through the body. A
 * refused offset keeps the last two-halves frame on screen and names the
 * offset (M11, owner decision D5), as Hole, Fillet and Chamfer do; the first
 * face pick has no earlier frame to keep. Root-test twin:
 * `test/cad-workflow-coupon.test.ts`.
 *
 * Oracles are the bar's hint/refusal region, Done, the History and Objects
 * rows, the stored feature and the drawn bodies — never kernel prose.
 */

interface LiveBody {
  bodyId: string;
  volume: number;
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** The live (unconsumed) bodies the viewport draws, preview frames included. */
async function drawnBodies(page: Page): Promise<LiveBody[]> {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<LiveBody[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              // A completed frame's bodies carry their exact volume; a
              // drag-only geometry frame omits it, and reads as NaN here.
              resolve: ({
                bodies
              }: {
                bodies: (GeometryBodyRepresentation & { volume?: number })[];
              }) =>
                resolve(
                  bodies
                    .filter((body) => !body.consumed)
                    .map((body) => ({
                      bodyId: body.bodyId,
                      volume: Math.round((body.volume ?? NaN) * 1000) / 1000,
                      min: body.bbox.min,
                      max: body.bbox.max
                    }))
                )
            }
          })
        );
      })
  );
}

/**
 * Drawn bodies as `[min x, max x, volume]`, sorted by min x. Volumes keep two
 * decimals, inside the K10 tolerance of 0.05 mm³ for these bodies.
 */
async function drawnSpans(page: Page): Promise<number[][]> {
  return (await drawnBodies(page))
    .map((body) => [
      Math.round(body.min.x * 1000) / 1000,
      Math.round(body.max.x * 1000) / 1000,
      Math.round(body.volume * 100) / 100
    ])
    .sort((a, b) => a[0]! - b[0]!);
}

interface StoredProject {
  name: string;
  bodyOrder: string[];
  nodes: Record<
    string,
    {
      kind: string;
      name: string;
      featureId?: string;
      bodyId?: string;
      data?: Record<string, unknown> & { featureKind: string };
    }
  >;
}

async function storedProject(page: Page, name: string): Promise<StoredProject> {
  const projects = await page.evaluate(
    () =>
      new Promise<StoredProject[]>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () => reject(new Error('Could not open storage.'));
        request.onsuccess = () => {
          const db = request.result;
          const all = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          all.onerror = () => {
            db.close();
            reject(new Error('Could not read the saved project.'));
          };
          all.onsuccess = () => {
            db.close();
            resolve(all.result as StoredProject[]);
          };
        };
      })
  );
  const project = projects.find((candidate) => candidate.name === name);
  if (!project) throw new Error(`No stored project named ${name}.`);
  return project;
}

/** The stored Split feature's plane and body ids, or null without one. */
function storedSplit(project: StoredProject) {
  const node = Object.values(project.nodes).find(
    (candidate) =>
      candidate.kind === 'feature' && candidate.data?.featureKind === 'split'
  );
  if (!node?.data) return null;
  return {
    plane: node.data.plane as {
      origin: Record<'x' | 'y' | 'z', unknown>;
      normal: Record<'x' | 'y' | 'z', unknown>;
    },
    bodies: [node.bodyId, node.data.secondBodyId as string].sort()
  };
}

const historyRows = (page: Page) =>
  page.locator('.feature-row:not(.is-sketch)');
const liveObjectRows = (page: Page) =>
  page.locator('.body-row:not(.consumed) .body-row-main');

/** The A0 blank and the witness block, made in place. */
async function coupon(page: Page, name: string) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '90', depth: '36', height: '14' },
    name: 'Coupon'
  });
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '20', depth: '36', height: '14' },
    at: { x: '100' },
    name: 'Witness'
  });
  await expectBodyCount(page, 2);
  await expect
    .poll(() => drawnSpans(page))
    .toEqual([
      [0, 90, 45360],
      [100, 120, 10080]
    ]);
}

/** Split armed on the coupon, its end face x = 90 clicked as the plane. */
async function splitOnEndFace(page: Page): Promise<Locator> {
  await pressTool(page, /^Split — /);
  await pickObjectsBody(page, 'Coupon');
  const bar = page.getByRole('group', { name: 'Split command' });
  await expect(bar).toContainText('Pick a plane or flat face');
  await waitForStillViewport(page);
  await clickWorldPoint(page, [90, 18, 7]);
  return bar;
}

const hint = (bar: Locator) => bar.getByRole('status');
const done = (bar: Locator) => bar.getByRole('button', { name: /Done/ });

test(
  'Split on a picked face refuses a touching or missing plane by type and recovers',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const projectName = 'K10 split coupon';
    await coupon(page, projectName);
    await revealModelPanel(page, 'History');
    const rowsBefore = await historyRows(page).count();

    // 1. The face pick stores the end face's plane at offset 0: it only
    // touches the body, so the first preview is the face-touch refusal,
    // which says so rather than naming an edge (M11 slice 1a).
    const bar = await splitOnEndFace(page);
    await expect(bar).toHaveClass(/\brefused\b/, { timeout: 30_000 });
    await expect(bar).toContainText('Needs attention');
    await expect(hint(bar)).toContainText(SPLIT_PLANE_ON_FACE);
    await expect(hint(bar)).not.toContainText(
      /split:|unsupported configuration|edge \d/
    );
    await expect(done(bar)).toBeDisabled();
    await expect
      .poll(() => drawnSpans(page))
      .toEqual([
        [0, 90, 45360],
        [100, 120, 10080]
      ]);

    // 2. Inward is −X, the picked face's outward normal being +X: −38 puts
    // the plane at x = 52, through the body.
    await enterCommandValue(page, 'offset', '-38');
    await expect(bar).not.toHaveClass(/\brefused\b/, { timeout: 30_000 });
    await expect(done(bar)).toBeEnabled({ timeout: 30_000 });
    await expect(bar).toContainText('Preview');
    await expect
      .poll(() => drawnSpans(page), { timeout: 30_000 })
      .toEqual([
        [0, 52, 26208],
        [52, 90, 19152],
        [100, 120, 10080]
      ]);

    // 3. +8 outward puts it at x = 98, past the body: a refusal that names
    // the offset, Done disabled, the body and face still picked, and the
    // x = 52 halves kept on screen as the last frame that built.
    await enterCommandValue(page, 'offset', '8');
    await expect(bar).toHaveClass(/\brefused\b/, { timeout: 30_000 });
    await expect(bar).toContainText('Needs attention');
    // A miss says it misses, never the generic kernel sentence.
    await expect(hint(bar)).toContainText(`Offset: ${SPLIT_PLANE_MISSES}`);
    await expect(done(bar)).toBeDisabled();
    await expect(hint(bar)).not.toContainText('Pick a plane or flat face');
    await expect
      .poll(() => drawnSpans(page))
      .toEqual([
        [0, 52, 26208],
        [52, 90, 19152],
        [100, 120, 10080]
      ]);

    // 4. Back to x = 52, and Done: one History row, two halves and the
    // witness in Objects, the plane stored at x = 52.
    await enterCommandValue(page, 'offset', '-38');
    await expect(done(bar)).toBeEnabled({ timeout: 30_000 });
    await done(bar).click();
    await expect(bar).toHaveCount(0);
    await expect(historyRows(page)).toHaveCount(rowsBefore + 1, {
      timeout: 20_000
    });
    await expectBodyCount(page, 3);
    await revealModelPanel(page, 'Objects');
    await expect(liveObjectRows(page)).toHaveCount(3);
    const halves: number[][] = [
      [0, 52, 26208],
      [52, 90, 19152],
      [100, 120, 10080]
    ];
    await expect.poll(() => drawnSpans(page)).toEqual(halves);
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    const committed = storedSplit(await storedProject(page, projectName));
    expect(committed).not.toBeNull();
    expect(Number(committed!.plane.origin.x)).toBeCloseTo(52, 9);
    expect(
      [
        committed!.plane.normal.x,
        committed!.plane.normal.y,
        committed!.plane.normal.z
      ].map(Number)
    ).toEqual([1, 0, 0]);
    const ids = (await drawnBodies(page)).map((body) => body.bodyId).sort();

    // 5. Undo, Redo and a reload keep the body count, ids and plane.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectBodyCount(page, 2);
    // The Undo reaches storage before Redo, so the reload below reads the
    // redone split and not the save from step 4 that both steps left alone.
    await expect
      .poll(async () => storedSplit(await storedProject(page, projectName)), {
        timeout: 20_000
      })
      .toBeNull();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectBodyCount(page, 3);
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    await page.reload();
    await expectBodyCount(page, 3, 30_000);
    await expect
      .poll(() => drawnSpans(page), { timeout: 30_000 })
      .toEqual(halves);
    expect((await drawnBodies(page)).map((body) => body.bodyId).sort()).toEqual(
      ids
    );
    expect(storedSplit(await storedProject(page, projectName))).toEqual(
      committed
    );
    expect(errors).toEqual([]);
  }
);

test('Escape on a refused Split adds no History row and leaves the bodies', async ({
  page
}) => {
  test.setTimeout(120_000);
  const projectName = 'K10 split escape';
  await coupon(page, projectName);
  await revealModelPanel(page, 'History');
  const rowsBefore = await historyRows(page).count();
  const bar = await splitOnEndFace(page);
  await expect(bar).toHaveClass(/\brefused\b/, { timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(historyRows(page)).toHaveCount(rowsBefore);
  await expectBodyCount(page, 2);
  await expect
    .poll(() => drawnSpans(page))
    .toEqual([
      [0, 90, 45360],
      [100, 120, 10080]
    ]);
  expect(storedSplit(await storedProject(page, projectName))).toBeNull();
});

// Preview check of #2242: with the coupon's −35 halves kept under a refused
// +20, the witness picked in Objects takes them down before its own frame.
// x = 110 cuts the witness, so its frame builds; every frame the viewport
// draws is recorded in the page, since the stale halves lasted only until
// that frame landed and a poll from the test sees just its end.
test('a refused Split takes the kept halves down when Objects picks another body', async ({
  page
}) => {
  test.setTimeout(120_000);
  await coupon(page, 'K10 split retarget');
  // Open already, so the pick below is one click.
  await revealModelPanel(page, 'Objects');
  const bar = await splitOnEndFace(page);
  await expect(bar).toHaveClass(/\brefused\b/, { timeout: 30_000 });
  await enterCommandValue(page, 'offset', '-35');
  await expect(done(bar)).toBeEnabled({ timeout: 30_000 });
  await expect
    .poll(() => drawnSpans(page), { timeout: 30_000 })
    .toEqual([
      [0, 55, 27720],
      [55, 90, 17640],
      [100, 120, 10080]
    ]);
  await enterCommandValue(page, 'offset', '20');
  await expect(hint(bar)).toContainText(`Offset: ${SPLIT_PLANE_MISSES}`, {
    timeout: 30_000
  });

  await recordFrames(page);
  await pickObjectsBody(page, 'Witness');
  await expect(done(bar)).toBeEnabled({ timeout: 30_000 });
  await expect
    .poll(() => drawnSpans(page))
    .toEqual([
      [0, 90, 45360],
      [100, 110, 5040],
      [110, 120, 5040]
    ]);
  const frames = await recordedFrames(page);
  const key = (spans: number[][]) => JSON.stringify(spans);
  const halves = key([
    [0, 55],
    [55, 90],
    [100, 120]
  ]);
  const unsplit = key([
    [0, 90],
    [100, 120]
  ]);
  const witnessCut = key([
    [0, 90],
    [100, 110],
    [110, 120]
  ]);
  // The pick takes the halves and the refusal down first: the two blocks
  // unsplit, before the witness's frame, and the halves never again.
  const down = frames.findIndex(
    (frame) => key(frame.spans) === unsplit && !frame.bar.includes('Offset:')
  );
  expect(down, JSON.stringify(frames)).toBeGreaterThanOrEqual(0);
  expect(
    frames.slice(0, down).some((frame) => key(frame.spans) === witnessCut)
  ).toBe(false);
  expect(
    frames.slice(down).some((frame) => key(frame.spans) === halves),
    JSON.stringify(frames)
  ).toBe(false);
});

// Re-check of #2242 on the preview: Box 2 stands where the refused plane
// misses it too, so its own refusal replaces nothing. From the Objects pick
// until that refusal, no frame may show Box 1's halves or the −35 they were
// built at: the pick takes them down. Three switches back and forth.
test('a refused Split shows nothing of the kept halves while another refused body is checked', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('K10 split stale halves');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '90', depth: '36', height: '14' },
    name: 'Box 1'
  });
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '30', depth: '18', height: '24' },
    at: { x: '115' },
    name: 'Box 2'
  });
  await expectBodyCount(page, 2);
  const unsplit = [
    [0, 90, 45360],
    [115, 145, 12960]
  ];
  await expect.poll(() => drawnSpans(page)).toEqual(unsplit);
  await revealModelPanel(page, 'Objects');
  await pressTool(page, /^Split — /);
  await pickObjectsBody(page, 'Box 1');
  const bar = page.getByRole('group', { name: 'Split command' });
  await expect(bar).toContainText('Pick a plane or flat face');
  await waitForStillViewport(page);
  // Box 1's +X end face, x = 90.
  await clickWorldPoint(page, [90, 18, 7]);
  await expect(bar).toHaveClass(/\brefused\b/, { timeout: 30_000 });

  for (let round = 1; round <= 3; round += 1) {
    if (round > 1) await pickObjectsBody(page, 'Box 1');
    await enterCommandValue(page, 'offset', '-35');
    await expect(done(bar)).toBeEnabled({ timeout: 30_000 });
    await expect
      .poll(() => drawnSpans(page), { timeout: 30_000 })
      .toEqual([
        [0, 55, 27720],
        [55, 90, 17640],
        [115, 145, 12960]
      ]);
    // x = 110 misses Box 1, and Box 2 (x 115–145) as well.
    await enterCommandValue(page, 'offset', '20');
    await expect(hint(bar)).toContainText(`Offset: ${SPLIT_PLANE_MISSES}`, {
      timeout: 30_000
    });

    await recordFrames(page);
    await pickObjectsBody(page, 'Box 2');
    await expect(hint(bar)).toContainText(SPLIT_PLANE_MISSES, {
      timeout: 30_000
    });
    await expect(hint(bar)).not.toContainText('Offset:');
    await expect.poll(() => drawnSpans(page)).toEqual(unsplit);
    const frames = await recordedFrames(page);
    // Frames before the pick took effect still say the Offset refusal.
    const picked = frames.findIndex((frame) => !frame.bar.includes('Offset:'));
    expect(picked, JSON.stringify(frames)).toBeGreaterThanOrEqual(0);
    const stale = frames.slice(picked).filter(
      (frame) =>
        JSON.stringify(frame.spans) !==
          JSON.stringify([
            [0, 90],
            [115, 145]
          ]) || /[-−]35/.test(frame.chip)
    );
    expect(stale, `round ${round}: ${JSON.stringify(frames)}`).toEqual([]);
  }
  await expect(done(bar)).toBeDisabled();
});

interface RecordedFrame {
  spans: number[][];
  bar: string;
  /** The offset chip's text. */
  chip: string;
}

/** Starts recording each new (spans, bar text) pair the page renders. */
async function recordFrames(page: Page) {
  await page.locator('.viewer-host canvas').evaluate((element) => {
    const store = window as unknown as {
      __splitFrames: RecordedFrame[];
      __splitFramesStop: boolean;
    };
    store.__splitFrames = [];
    store.__splitFramesStop = false;
    const sample = () => {
      if (store.__splitFramesStop) return;
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-render-policy', {
          detail: {
            includeBodies: true,
            resolve: ({
              bodies
            }: {
              bodies: (GeometryBodyRepresentation & { consumed?: boolean })[];
            }) => {
              const frame = {
                spans: bodies
                  .filter((body) => !body.consumed)
                  .map((body) => [
                    Math.round(body.bbox.min.x),
                    Math.round(body.bbox.max.x)
                  ])
                  .sort((a, b) => a[0]! - b[0]!),
                bar:
                  document.querySelector('[aria-label="Split command"]')
                    ?.textContent ?? '',
                chip:
                  document.querySelector(
                    '[data-testid="command-handle-offset"]'
                  )?.textContent ?? ''
              };
              const last = store.__splitFrames.at(-1);
              if (JSON.stringify(last) !== JSON.stringify(frame)) {
                store.__splitFrames.push(frame);
              }
              requestAnimationFrame(sample);
            }
          }
        })
      );
    };
    sample();
  });
}

async function recordedFrames(page: Page): Promise<RecordedFrame[]> {
  return page.evaluate(() => {
    const store = window as unknown as {
      __splitFrames: RecordedFrame[];
      __splitFramesStop: boolean;
    };
    store.__splitFramesStop = true;
    return store.__splitFrames;
  });
}
