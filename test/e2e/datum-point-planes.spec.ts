import type { Locator, Page } from '@playwright/test';
import {
  expect,
  expectBodyCount,
  expectConsumedBodyCount,
  locateEdge,
  setSelectionFilter,
  stubApi,
  test,
  finishInPlaceCommand,
  pickDatumRow,
  pickObjectsBody
} from './openzcad-fixtures';

/**
 * R01: the Plane card's Three points and Parallel at point modes. A plane
 * through three typed points drives a Split; collinear points are refused
 * with nothing created; a parallel plane takes its point from an edge picked
 * in the viewport and is stored as that edge's vertex, not a copied position.
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

async function typePoint(
  inspector: Locator,
  slot: string,
  [x, y, z]: [string, string, string]
) {
  await inspector.getByLabel(slot, { exact: true }).selectOption('typed');
  await inspector.getByLabel(`${slot} X`).fill(x);
  await inspector.getByLabel(`${slot} Y`).fill(y);
  await inspector.getByLabel(`${slot} Z`).fill(z);
}

test('three-point and parallel-at-point planes: typed points, a refusal and a picked vertex', async ({
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
  const projectName = 'Point datum planes';
  await page.goto('/');
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Width (X)').fill('20');
  await inspector.getByLabel('Depth (Y)').fill('20');
  await inspector.getByLabel('Height (Z)').fill('20');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expectBodyCount(page, 1);

  // Parallel to Top (XY) through the end of an edge picked on the block.
  await page.getByRole('button', { name: /^Plane — / }).click();
  await inspector.getByRole('button', { name: 'Parallel at point' }).click();
  await expect(inspector.getByLabel('Parallel to')).toHaveValue('canonical:XY');
  await expect(inspector.getByRole('button', { name: 'Done' })).toBeDisabled();
  await setSelectionFilter(page, 'Edge');
  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);
  const through = inspector.getByLabel('Through point', { exact: true });
  await expect(through).toHaveValue(/^vertex:/);
  const label = await through.evaluate(
    (select: HTMLSelectElement) => select.selectedOptions[0]?.textContent ?? ''
  );
  const match = /^Picked vertex \((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/.exec(
    label
  );
  expect(match, label).not.toBeNull();
  const vertex = {
    x: Number(match![1]),
    y: Number(match![2]),
    z: Number(match![3])
  };
  await inspector.getByRole('button', { name: 'Done' }).click();
  const parallelRow = page.locator('.feature-row', { hasText: 'Plane 1' });
  await expect(parallelRow).toContainText('through point', { timeout: 20_000 });
  await expect.poll(async () => (await drawnDatums(canvas)).length).toBe(1);
  const [parallel] = await drawnDatums(canvas);
  expect(parallel!.normal).toEqual({ x: 0, y: 0, z: 1 });
  for (const axis of ['x', 'y', 'z'] as const)
    expect(parallel!.origin[axis]).toBeCloseTo(vertex[axis], 3);

  // Stored as the edge's vertex, by lineage, not as a copied position.
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  let stored = await storedProject(page, projectName);
  const definition = storedFeature(stored, 'Plane 1').data.definition as {
    kind: string;
    point: { type: string; edgeReference?: { kind: string } };
  };
  expect(definition.kind).toBe('parallel-point');
  expect(definition.point.type).toBe('edge-vertex');
  expect(definition.point.edgeReference?.kind).toBe('edge');
  await setSelectionFilter(page, 'Any');

  // Three typed points at z = 5 make the plane z = 5.
  await page.getByRole('button', { name: /^Plane — / }).click();
  await inspector.getByRole('button', { name: 'Three points' }).click();
  await expect(inspector.getByRole('button', { name: 'Done' })).toBeDisabled();
  await typePoint(inspector, 'Point 1', ['0', '0', '5']);
  await typePoint(inspector, 'Point 2', ['10', '0', '5']);
  await typePoint(inspector, 'Point 3', ['0', '10', '5']);
  await inspector.getByRole('button', { name: 'Done' }).click();
  const planeRow = page.locator('.feature-row', { hasText: 'Plane 2' });
  await expect(planeRow).toContainText('3 points', { timeout: 20_000 });
  await expect.poll(async () => (await drawnDatums(canvas)).length).toBe(2);
  const drawn = (await drawnDatums(canvas)).find(
    (datum) => datum.featureId !== parallel!.featureId
  )!;
  expect(drawn.origin.z).toBeCloseTo(5, 6);
  expect(drawn.normal).toEqual({ x: 0, y: 0, z: 1 });

  // Split on it: the halves meet at z = 5.
  // U09: Split runs in place: the body, then Plane 2 from its row.
  await page.getByRole('button', { name: /^Split — / }).click();
  await pickObjectsBody(page, /./);
  await pickDatumRow(page, 'Plane 2');
  await finishInPlaceCommand(page, 'Split');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Split' })
  ).toBeVisible({ timeout: 20_000 });
  await expectConsumedBodyCount(page, 1);
  await expectBodyCount(page, 2);
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  stored = await storedProject(page, projectName);
  expect(storedFeature(stored, 'Plane 2').data).toEqual({
    featureKind: 'datum-plane',
    definition: {
      kind: 'three-point',
      points: [
        { type: 'point', point: { x: 0, y: 0, z: 5 } },
        { type: 'point', point: { x: 10, y: 0, z: 5 } },
        { type: 'point', point: { x: 0, y: 10, z: 5 } }
      ]
    }
  });
  const split = storedFeature(stored, 'Split');
  const halves = [split.bodyId!, split.data.secondBodyId as string];
  await expect
    .poll(async () => {
      stored = await storedProject(page, projectName);
      return halves.map((bodyId) => zRange(stored, bodyId)).sort();
    })
    .toEqual([
      [0, 5],
      [5, 20]
    ]);

  // Collinear points are refused by the exact check; nothing is created.
  await page.getByRole('button', { name: /^Plane — / }).click();
  await inspector.getByRole('button', { name: 'Three points' }).click();
  await typePoint(inspector, 'Point 1', ['0', '0', '0']);
  await typePoint(inspector, 'Point 2', ['1', '1', '1']);
  await typePoint(inspector, 'Point 3', ['2', '2', '2']);
  await inspector.getByRole('button', { name: 'Done' }).click();
  await expect(inspector.getByRole('alert')).toContainText(
    /Not created — .*collinear/,
    { timeout: 20_000 }
  );
  await expect(
    page.locator('.feature-row', { hasText: 'Plane 3' })
  ).toHaveCount(0);

  // A split half's edges carry no identity a rebuild can find: refused.
  await inspector.getByRole('button', { name: 'Parallel at point' }).click();
  await setSelectionFilter(page, 'Edge');
  const halfEdge = await locateEdge(page);
  await page.mouse.click(halfEdge.x, halfEdge.y);
  await expect(
    inspector.getByText(/This edge has no identity a rebuild can find again/)
  ).toBeVisible();
  await inspector.getByRole('button', { name: 'Cancel' }).click();

  // Undo removes the split; both planes stay.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 1);
  await expect.poll(async () => (await drawnDatums(canvas)).length).toBe(2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(errors).toEqual([]);
});
