import type { Locator, Page } from '@playwright/test';
import {
  clickWorldPoint,
  createPrimitiveInPlace,
  enterCommandValue,
  expect,
  expectBodyCount,
  expectConsumedBodyCount,
  finishInPlaceCommand,
  pickDatumRow,
  pickObjectsBody,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * R01-C: a datum plane made in place (U09) is a real feature — a sketch
 * drawn on it, a Split cut on it and a Mirror reflected across it all name it
 * by id, and editing its offset moves every one of them.
 */

interface DrawnDatum {
  featureId: string;
  origin: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

async function drawnDatums(canvas: Locator): Promise<DrawnDatum[]> {
  const raw = await canvas.getAttribute('data-e2e-datum-planes');
  return raw ? (JSON.parse(raw) as DrawnDatum[]) : [];
}

interface StoredFeature {
  name: string;
  featureId: string;
  bodyId?: string;
  data: Record<string, unknown> & { featureKind: string };
}

interface StoredProject {
  name: string;
  nodes: Record<
    string,
    {
      kind: string;
      name: string;
      featureId?: string;
      bodyId?: string;
      planeRef?: unknown;
      data?: StoredFeature['data'];
    }
  >;
  derived?: {
    bodyRepresentations?: Record<string, { mesh?: { vertices?: number[] } }>;
  };
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

function storedFeature(project: StoredProject, name: string): StoredFeature {
  const node = Object.values(project.nodes).find(
    (candidate) => candidate.kind === 'feature' && candidate.name === name
  );
  if (!node?.featureId || !node.data) throw new Error(`No feature ${name}.`);
  return {
    name: node.name,
    featureId: node.featureId,
    ...(node.bodyId ? { bodyId: node.bodyId } : {}),
    data: node.data
  };
}

/** The z range of a stored body's display mesh, or null without one. */
function zRange(
  project: StoredProject,
  bodyId: string
): [number, number] | null {
  const vertices =
    project.derived?.bodyRepresentations?.[bodyId]?.mesh?.vertices;
  if (!vertices?.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let index = 2; index < vertices.length; index += 3) {
    min = Math.min(min, vertices[index]!);
    max = Math.max(max, vertices[index]!);
  }
  return [Math.round(min * 1000) / 1000, Math.round(max * 1000) / 1000];
}

interface LiveSketch {
  objects: unknown[];
  screen: { x: number; y: number }[];
}

async function liveSketch(
  canvas: Locator,
  points: { x: number; y: number }[] = []
): Promise<LiveSketch> {
  return canvas.evaluate(
    (element, project) =>
      new Promise<LiveSketch>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: {
              project,
              resolve: (state: LiveSketch | null) =>
                resolve(state ?? { objects: [], screen: [] })
            }
          })
        );
      }),
    points
  );
}

test('a datum plane drives a sketch, a Split and a Mirror, and an edit moves them all', async ({
  page
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const projectName = 'Datum plane consumers';
  await page.goto('/');
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '20', depth: '20', height: '20' }
  });
  await expectBodyCount(page, 1);

  // U09: the Plane runs in place. An offset plane 8 above Top (XY): its
  // ghost plane clicked clear of the box, then 8 on the offset chip.
  await page.getByRole('button', { name: /^Plane — / }).click();
  const planeBar = page.getByRole('group', { name: 'Plane command' });
  await expect(planeBar).toContainText('Pick a plane');
  await clickWorldPoint(page, [3, -2, 0]);
  await expect(planeBar).toContainText('Drag the offset');
  await enterCommandValue(page, 'offset', '8');
  await finishInPlaceCommand(page, 'Plane');
  const planeRow = page.locator('.feature-row', { hasText: 'Plane 1' });
  await expect(planeRow).toContainText('8 mm');
  await expect
    .poll(async () => (await drawnDatums(canvas)).map((d) => d.origin.z))
    .toEqual([8]);
  const [drawn] = await drawnDatums(canvas);
  expect(drawn!.normal).toEqual({ x: 0, y: 0, z: 1 });

  // Split on the datum, by id. U09: Split runs in place: the body, then
  // the plane (here Plane 1's row, since the box hides most of its quad).
  await page.getByRole('button', { name: /^Split — / }).click();
  await pickObjectsBody(page, 'Box 1');
  const splitBar = page.getByRole('group', { name: 'Split command' });
  await expect(splitBar).toContainText('Pick the plane');
  await pickDatumRow(page, 'Plane 1');
  await finishInPlaceCommand(page, 'Split');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Split' })
  ).toBeVisible({ timeout: 20_000 });
  await expectConsumedBodyCount(page, 1);
  await expectBodyCount(page, 2);

  // Mirror across the same datum.
  await page.getByRole('button', { name: /^Mirror — / }).click();
  // Either half: the first live body listed.
  await pickObjectsBody(page, /./);
  await pickDatumRow(page, 'Plane 1');
  await finishInPlaceCommand(page, 'Mirror');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Mirror' })
  ).toBeVisible({ timeout: 20_000 });
  await expectBodyCount(page, 3);

  // Sketch on the datum: entered from the plane prompt, drawn, finished.
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Sketch on Plane 1' }).click();
  await expect(page.getByText('Sketching on Plane 1')).toBeVisible();
  await expect(page.locator('.viewport-dock-grid')).toBeVisible();
  await waitForStillViewport(page);
  const {
    screen: [from, to]
  } = await liveSketch(canvas, [
    { x: -12, y: -12 },
    { x: -4, y: -4 }
  ]);
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await rail.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.mouse.click(from!.x, from!.y);
  await page.mouse.move(to!.x, to!.y, { steps: 4 });
  await page.mouse.click(to!.x, to!.y);
  // A rectangle is four sides held as one shape.
  await expect
    .poll(async () => (await liveSketch(canvas)).objects.length)
    .toBe(4);
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: /^Sketch/ })
  ).toBeVisible();

  // Every consumer holds the datum's id, never a copied plane.
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  let stored = await storedProject(page, projectName);
  const datum = storedFeature(stored, 'Plane 1');
  expect(datum.data).toEqual({
    featureKind: 'datum-plane',
    definition: {
      kind: 'offset',
      source: { type: 'canonical', plane: 'XY', offset: 0 },
      offset: 8
    }
  });
  const reference = { type: 'datum', datumFeatureId: datum.featureId };
  const split = storedFeature(stored, 'Split');
  expect(split.data.plane).toEqual(reference);
  expect(storedFeature(stored, 'Mirror').data.plane).toEqual(reference);
  const sketchNode = Object.values(stored.nodes).find(
    (node) => node.kind === 'sketch'
  );
  expect(sketchNode?.planeRef).toEqual(reference);
  const halves = [split.bodyId!, split.data.secondBodyId as string];
  expect(halves.map((bodyId) => zRange(stored, bodyId)).sort()).toEqual([
    [0, 8],
    [8, 20]
  ]);

  // Editing the datum moves the split with it, as one validated edit.
  await page.locator('.feature-row-main', { hasText: 'Plane 1' }).click();
  await expect(inspector.getByRole('button', { name: 'Apply' })).toBeVisible();
  await inspector.getByLabel('Offset', { exact: true }).fill('12');
  await inspector.getByRole('button', { name: 'Apply' }).click();
  await expect(planeRow).toContainText('12 mm', { timeout: 20_000 });
  await expect
    .poll(async () => (await drawnDatums(canvas)).map((d) => d.origin.z))
    .toEqual([12]);
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await expect
    .poll(async () => {
      stored = await storedProject(page, projectName);
      return halves.map((bodyId) => zRange(stored, bodyId)).sort();
    })
    .toEqual([
      [0, 12],
      [12, 20]
    ]);

  // Undo puts the plane back; the datum survives a reload.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(planeRow).toContainText('8 mm');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(planeRow).toContainText('12 mm');
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page.reload();
  await expect(planeRow).toContainText('12 mm');
  await expect
    .poll(async () => (await drawnDatums(canvas)).map((d) => d.origin.z))
    .toEqual([12]);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(errors).toEqual([]);
});
