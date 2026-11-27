import type { Locator, Page } from '@playwright/test';
import type { GeometryBodyRepresentation } from '@openzcad/shared';
import {
  clickWorldPoint,
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  pickObjectsBody,
  pressTool,
  revealModelPanel,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';
import { SPLIT_EDGE_PLANE_SENTENCES } from '../../apps/web/src/lib/refusalLanguage';

/**
 * M11 with R01, slice 1b (owner decision D2): Split's plane picked as two
 * straight edges of a synthetic 20 mm block (x, y, z 0–20). The bottom edge
 * at x = 20 and the top edge at x = 0 give the plane x + z = 20, which
 * halves the block into two 4000 mm³ prisms. A skew pair is refused by its
 * own sentence with the first edge kept, and the re-picked second edge
 * resolves. The plane is stored as Split's numbers: Undo, Redo and a reload
 * keep it. Root-test twin: `test/split-edge-pair-plane.test.ts`.
 */

interface DrawnBody {
  bodyId: string;
  volume: number;
}

/** The live bodies the viewport draws, preview frames included. */
async function drawnBodies(page: Page): Promise<DrawnBody[]> {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<DrawnBody[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
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
                      volume: body.volume ?? NaN
                    }))
                )
            }
          })
        );
      })
  );
}

/** Drawn volumes to 0.01 mm³, smallest first. */
async function drawnVolumes(page: Page): Promise<number[]> {
  return (await drawnBodies(page))
    .map((body) => Math.round(body.volume * 100) / 100)
    .sort((a, b) => a - b);
}

type Vector = Record<'x' | 'y' | 'z', unknown>;

/** The stored Split's plane, or null without one. */
async function storedSplitPlane(
  page: Page,
  name: string
): Promise<{ origin: Vector; normal: Vector } | null> {
  return page.evaluate(
    (projectName) =>
      new Promise<{ origin: Vector; normal: Vector } | null>(
        (resolve, reject) => {
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
              const project = (
                all.result as {
                  name: string;
                  nodes: Record<
                    string,
                    { kind: string; data?: Record<string, unknown> }
                  >;
                }[]
              ).find((candidate) => candidate.name === projectName);
              const split = Object.values(project?.nodes ?? {}).find(
                (node) =>
                  node.kind === 'feature' && node.data?.featureKind === 'split'
              );
              resolve(
                (split?.data?.plane as
                  { origin: Vector; normal: Vector } | undefined) ?? null
              );
            };
          };
        }
      ),
    name
  );
}

type Point = [number, number, number];

/** An edge as its two ends to 1e-6 mm, ends in order: one key per edge. */
function edgeKey(a: Point, b: Point): string {
  const end = (p: Point) => p.map((value) => Math.round(value * 1e6) / 1e6 + 0);
  return [end(a), end(b)]
    .map((p) => p.join(','))
    .sort()
    .join(' – ');
}

/**
 * The held plane edges the viewport has drawn, by their ends: what the
 * picked-edge overlay put in the scene, whichever body is on screen.
 */
async function drawnPickedEdges(page: Page): Promise<string[]> {
  const value = await page
    .locator('.viewer-host canvas')
    .getAttribute('data-e2e-picked-edge-lines');
  if (value === null) return [];
  return (
    JSON.parse(value) as {
      start: Record<'x' | 'y' | 'z', number>;
      end: Record<'x' | 'y' | 'z', number>;
    }[]
  )
    .map(({ start, end }) =>
      edgeKey([start.x, start.y, start.z], [end.x, end.y, end.z])
    )
    .sort();
}

/** The block's edges this journey picks. */
const BOTTOM_RIGHT = edgeKey([20, 0, 0], [20, 20, 0]);
const TOP_LEFT = edgeKey([0, 0, 20], [0, 20, 20]);
const TOP_FRONT = edgeKey([0, 0, 20], [20, 0, 20]);
const FRONT_RIGHT = edgeKey([20, 0, 0], [20, 0, 20]);
const both = (...keys: string[]) => [...keys].sort();

const hint = (bar: Locator) => bar.getByRole('status');
const done = (bar: Locator) => bar.getByRole('button', { name: /Done/ });
const historyRows = (page: Page) =>
  page.locator('.feature-row:not(.is-sketch)');

test(
  'Split takes its plane from two picked edges, refuses a skew pair, and keeps the plane through Undo and reload',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const projectName = 'Split edge plane';
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill(projectName);
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '20', depth: '20', height: '20' },
      name: 'Block'
    });
    await expectBodyCount(page, 1);
    await expect.poll(() => drawnVolumes(page)).toEqual([8000]);
    await revealModelPanel(page, 'History');
    const rowsBefore = await historyRows(page).count();

    // 1. The body, then the bottom edge at x = 20 (its middle, (20, 10, 0)).
    await pressTool(page, /^Split — /);
    await pickObjectsBody(page, 'Block');
    const bar = page.getByRole('group', { name: 'Split command' });
    await expect(bar).toContainText(
      'Pick a plane or flat face, or two straight edges'
    );
    await waitForStillViewport(page);
    // Split's default filter (Any) takes the edge under the pointer.
    await clickWorldPoint(page, [20, 10, 0]);
    await expect(hint(bar)).toContainText('Pick a second edge for the plane');
    await expect(done(bar)).toBeDisabled();
    // The held edge is drawn as a picked edge (preview check of 2099cc5).
    await expect.poll(() => drawnPickedEdges(page)).toEqual([BOTTOM_RIGHT]);

    // 2. The top front edge along x is skew to it: refused by name, the
    // first edge kept, Done disabled, the block untouched.
    await clickWorldPoint(page, [10, 0, 20]);
    await expect(bar).toHaveClass(/\brefused\b/);
    await expect(hint(bar)).toContainText(
      `Plane: ${SPLIT_EDGE_PLANE_SENTENCES.skew}`
    );
    await expect(done(bar)).toBeDisabled();
    await expect.poll(() => drawnVolumes(page)).toEqual([8000]);
    // Both held edges are drawn under the refusal.
    await expect
      .poll(() => drawnPickedEdges(page))
      .toEqual(both(BOTTOM_RIGHT, TOP_FRONT));

    // 3. The top edge at x = 0 replaces the skew one: x + z = 20 halves the
    // block in the preview.
    await clickWorldPoint(page, [0, 10, 20]);
    await expect(bar).not.toHaveClass(/\brefused\b/, { timeout: 30_000 });
    await expect(done(bar)).toBeEnabled({ timeout: 30_000 });
    await expect
      .poll(() => drawnVolumes(page), { timeout: 30_000 })
      .toEqual([4000, 4000]);
    // Both picked edges are drawn over the preview's halves, which carry
    // no id of the committed block's (preview re-check of 68bd7b3, #1).
    await expect
      .poll(() => drawnPickedEdges(page))
      .toEqual(both(BOTTOM_RIGHT, TOP_LEFT));

    // 3b. From the preview, the front right vertical edge (clicked on a
    // half) starts a new pair, and the top left edge then makes it skew:
    // both picks are drawn under the refusal (re-check of 68bd7b3, #2).
    await clickWorldPoint(page, [20, 0, 10]);
    await expect(hint(bar)).toContainText('Pick a second edge for the plane');
    await expect.poll(() => drawnPickedEdges(page)).toEqual([FRONT_RIGHT]);
    await expect.poll(() => drawnVolumes(page)).toEqual([8000]);
    await clickWorldPoint(page, [0, 10, 20]);
    await expect(hint(bar)).toContainText(
      `Plane: ${SPLIT_EDGE_PLANE_SENTENCES.skew}`
    );
    await expect
      .poll(() => drawnPickedEdges(page))
      .toEqual(both(FRONT_RIGHT, TOP_LEFT));

    // 3c. The vertical edge, clicked again on the block (it was picked on a
    // half), comes back out; the bottom right edge then makes the pair.
    await clickWorldPoint(page, [20, 0, 10]);
    await expect.poll(() => drawnPickedEdges(page)).toEqual([TOP_LEFT]);
    await clickWorldPoint(page, [20, 10, 0]);
    await expect(bar).not.toHaveClass(/\brefused\b/, { timeout: 30_000 });
    await expect(done(bar)).toBeEnabled({ timeout: 30_000 });
    await expect
      .poll(() => drawnVolumes(page), { timeout: 30_000 })
      .toEqual([4000, 4000]);
    await expect
      .poll(() => drawnPickedEdges(page))
      .toEqual(both(BOTTOM_RIGHT, TOP_LEFT));

    // 4. Done: one History row, two bodies, the plane stored as numbers
    // through the four ends' centroid with the canonical normal.
    await done(bar).click();
    await expect(bar).toHaveCount(0);
    // The command's edges are no selection left behind.
    await expect.poll(() => drawnPickedEdges(page)).toEqual([]);
    await expect(historyRows(page)).toHaveCount(rowsBefore + 1, {
      timeout: 20_000
    });
    await expectBodyCount(page, 2);
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    const stored = await storedSplitPlane(page, projectName);
    expect(stored).not.toBeNull();
    const numbers = (vector: Vector) =>
      [vector.x, vector.y, vector.z].map(Number);
    const [ox, oy, oz] = numbers(stored!.origin);
    expect([ox, oy, oz].map((value) => Math.round(value! * 1e6) / 1e6)).toEqual(
      [10, 10, 10]
    );
    const [nx, ny, nz] = numbers(stored!.normal);
    expect(nx).toBeCloseTo(Math.SQRT1_2, 9);
    expect(ny).toBeCloseTo(0, 9);
    expect(nz).toBeCloseTo(Math.SQRT1_2, 9);
    expect(JSON.stringify(stored)).not.toMatch(/edge|datum/i);

    // 5. Undo takes it back; Redo and a reload bring the same plane back.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectBodyCount(page, 1);
    await expect.poll(() => drawnVolumes(page)).toEqual([8000]);
    await expect
      .poll(() => storedSplitPlane(page, projectName), { timeout: 20_000 })
      .toBeNull();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectBodyCount(page, 2);
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    await expect
      .poll(() => storedSplitPlane(page, projectName), { timeout: 20_000 })
      .toEqual(stored);
    await page.reload();
    await expectBodyCount(page, 2, 30_000);
    await expect
      .poll(() => drawnVolumes(page), { timeout: 30_000 })
      .toEqual([4000, 4000]);
    expect(await storedSplitPlane(page, projectName)).toEqual(stored);
    expect(errors).toEqual([]);
  }
);
