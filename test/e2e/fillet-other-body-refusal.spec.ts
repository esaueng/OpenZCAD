import type { Locator, Page } from '@playwright/test';
import type { GeometryBodyRepresentation } from '@openzcad/shared';
import {
  clickWorldPoint,
  createPrimitiveInPlace,
  enterCommandValue,
  expect,
  expectBodyCount,
  pressTool,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U01, Fillet on another body: Fillet takes the target-change rule Split has
 * had since #2242. Box A (40 mm cube at the origin) takes a fillet that box
 * B (6 mm cube at x = 60) refuses. Once B's edge is picked, the bar names no
 * input of A's ("Edges:", "R:") and the viewport draws no frame of A's
 * fillet: a frame kept under A's own refusal comes down with the pick, and
 * one that built comes down with B's refusal and is never drawn again.
 *
 * Every frame the viewport renders is recorded in the page, since a stale
 * frame lasts only a paint or two and a poll from the test sees just its
 * end. Oracles are the bar's text and the drawn bodies' faces, never kernel
 * prose.
 */

/** A box's six faces; a fillet on one of its edges adds its blend face. */
const BOX_FACES = 6;
const A_EDGE: [number, number, number] = [20, 0, 40];
const B_EDGE: [number, number, number] = [63, 0, 6];
/** An input of A's named before the sentence, as "R: …" or "Edges: …". */
const NAMED = /\b(?:R|Edges|End R|Radius):/;

interface RecordedFrame {
  /** `[min x, max x, faces]` per drawn body, sorted by min x. */
  bodies: number[][];
  bar: string;
  refused: boolean;
  /** Done enabled: A's built fillet is the current request's verdict. */
  done: boolean;
}

/** The drawn bodies as `[min x, max x, faces]`, sorted by min x. */
async function drawnBodies(page: Page): Promise<number[][]> {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<number[][]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              resolve: ({
                bodies
              }: {
                bodies: (GeometryBodyRepresentation & {
                  consumed?: boolean;
                  faceCount: number;
                })[];
              }) =>
                resolve(
                  bodies
                    .filter((body) => !body.consumed)
                    .map((body) => [
                      Math.round(body.bbox.min.x),
                      Math.round(body.bbox.max.x),
                      body.faceCount
                    ])
                    .sort((a, b) => a[0]! - b[0]!)
                )
            }
          })
        );
      })
  );
}

/** Starts recording each new (bodies, bar) pair the page renders. */
async function recordFrames(page: Page) {
  await page.locator('.viewer-host canvas').evaluate((element) => {
    const store = window as unknown as {
      __filletFrames: RecordedFrame[];
      __filletFramesStop: boolean;
    };
    store.__filletFrames = [];
    store.__filletFramesStop = false;
    const sample = () => {
      if (store.__filletFramesStop) return;
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-render-policy', {
          detail: {
            includeBodies: true,
            resolve: ({
              bodies
            }: {
              bodies: (GeometryBodyRepresentation & {
                consumed?: boolean;
                faceCount: number;
              })[];
            }) => {
              const bar = document.querySelector(
                '[aria-label="Fillet command"]'
              );
              const frame = {
                bodies: bodies
                  .filter((body) => !body.consumed)
                  .map((body) => [
                    Math.round(body.bbox.min.x),
                    Math.round(body.bbox.max.x),
                    body.faceCount
                  ])
                  .sort((a, b) => a[0]! - b[0]!),
                bar: bar?.querySelector('[role="status"]')?.textContent ?? '',
                refused: bar?.classList.contains('refused') ?? false,
                done: Array.from(bar?.querySelectorAll('button') ?? []).some(
                  (button) =>
                    /Done/.test(button.textContent ?? '') && !button.disabled
                )
              };
              const last = store.__filletFrames.at(-1);
              if (JSON.stringify(last) !== JSON.stringify(frame)) {
                store.__filletFrames.push(frame);
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
      __filletFrames: RecordedFrame[];
      __filletFramesStop: boolean;
    };
    store.__filletFramesStop = true;
    return store.__filletFrames;
  });
}

/** A frame that shows box A filleted. */
const filletsA = (frame: RecordedFrame) =>
  frame.bodies.some((body) => body[0] === 0 && body[2] !== BOX_FACES);

const unfilleted = [
  [0, 40, BOX_FACES],
  [60, 66, BOX_FACES]
];
const filletedA = [
  [0, 40, BOX_FACES + 1],
  [60, 66, BOX_FACES]
];

/** Box A's front top edge picked, at R 8, built. */
async function builtOnA(page: Page, bar: Locator) {
  await clickWorldPoint(page, A_EDGE);
  await expect(bar).toContainText('1 edge');
  await enterCommandValue(page, 'radius', '8');
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await expect
    .poll(() => drawnBodies(page), { timeout: 30_000 })
    .toEqual(filletedA);
}

/** Box B's front top edge picked, and its refusal shown bare. */
async function refusedOnB(page: Page, bar: Locator) {
  await clickWorldPoint(page, B_EDGE);
  await expect(bar).toHaveClass(/\brefused\b/, { timeout: 30_000 });
  const status = bar.getByRole('status');
  await expect(status).not.toHaveText('');
  await expect(status).not.toContainText(NAMED);
  await expect(bar.getByRole('button', { name: /Done/ })).toBeDisabled();
  await expect.poll(() => drawnBodies(page)).toEqual(unfilleted);
}

test("a Fillet refused on another body shows nothing of the first body's fillet", async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('U01 fillet retarget');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '40', depth: '40', height: '40' },
    name: 'Box A'
  });
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '6', depth: '6', height: '6' },
    at: { x: '60' },
    name: 'Box B'
  });
  await expectBodyCount(page, 2);
  await expect.poll(() => drawnBodies(page)).toEqual(unfilleted);
  await page
    .getByRole('button', { name: 'Top front left isometric view', exact: true })
    .click();
  await waitForStillViewport(page);

  await pressTool(page, /^Fillet —/);
  const bar = page.getByRole('group', { name: 'Fillet command' });
  await expect(bar).toBeVisible();

  // A's fillet built, then B picked: R 8 is too big for B's 6 mm faces.
  // The pick takes A's frame down in its own commit, so no frame from the
  // pick on (Done off) draws A's fillet or names A's inputs, B's refusal
  // included: left up while B was checked, it was drawn for a paint under
  // B's refusal.
  await builtOnA(page, bar);
  await recordFrames(page);
  await refusedOnB(page, bar);
  let frames = await recordedFrames(page);
  const picked = frames.findIndex((frame) => !frame.done);
  expect(picked, JSON.stringify(frames)).toBeGreaterThanOrEqual(0);
  expect(
    frames
      .slice(picked)
      .filter((frame) => NAMED.test(frame.bar) || filletsA(frame)),
    JSON.stringify(frames)
  ).toEqual([]);

  // A's fillet kept under A's own refused R 50, then B picked, three times:
  // from the pick on, no frame names A's radius or draws A's fillet.
  for (let round = 1; round <= 3; round += 1) {
    await builtOnA(page, bar);
    await enterCommandValue(page, 'radius', '50');
    await expect(bar.getByRole('status')).toContainText(/^R: \S/, {
      timeout: 30_000
    });
    expect(await drawnBodies(page)).toEqual(filletedA);

    await recordFrames(page);
    await refusedOnB(page, bar);
    frames = await recordedFrames(page);
    // Frames before the pick took effect still say A's "R:" refusal.
    const taken = frames.findIndex((frame) => !NAMED.test(frame.bar));
    expect(taken, JSON.stringify(frames)).toBeGreaterThanOrEqual(0);
    const stale = frames
      .slice(taken)
      .filter((frame) => NAMED.test(frame.bar) || filletsA(frame));
    expect(stale, `round ${round}: ${JSON.stringify(frames)}`).toEqual([]);
    // Back to R 8 for the next round's build on A.
    await enterCommandValue(page, 'radius', '8');
  }
});
