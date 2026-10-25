import type { Locator, Page } from '@playwright/test';
import {
  clickWorldPoint,
  enterCommandValue,
  expect,
  expectBodyCount,
  finishInPlaceCommand,
  pickObjectsBody,
  setSelectionFilter,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * R01 datum axes, made in place (U09): an axis where two ghost planes meet
 * and one along a block's edge, which its History card retypes through two
 * points; a sketch revolves about the first; a body turns about the second
 * with Rotate about axis and is then patterned about it; an edit of the
 * axis moves both consumers; coincident points are refused with nothing
 * changed. Every consumer stores the axis by id.
 */

interface DrawnAxis {
  featureId: string;
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
}

async function drawnAxes(canvas: Locator): Promise<DrawnAxis[]> {
  const raw = await canvas.getAttribute('data-e2e-datum-axes');
  return raw ? (JSON.parse(raw) as DrawnAxis[]) : [];
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
      data?: Record<string, unknown> & { featureKind: string };
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

function storedFeature(project: StoredProject, name: string) {
  const node = Object.values(project.nodes).find(
    (candidate) => candidate.kind === 'feature' && candidate.name === name
  );
  if (!node?.featureId || !node.data) throw new Error(`No feature ${name}.`);
  return { featureId: node.featureId, bodyId: node.bodyId, data: node.data };
}

/** A stored body's display-mesh extent along one axis, rounded to 0.01. */
function extent(
  project: StoredProject,
  bodyId: string,
  axis: 0 | 1 | 2
): [number, number] | null {
  const vertices =
    project.derived?.bodyRepresentations?.[bodyId]?.mesh?.vertices;
  if (!vertices?.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let index = axis; index < vertices.length; index += 3) {
    min = Math.min(min, vertices[index]!);
    max = Math.max(max, vertices[index]!);
  }
  return [Math.round(min * 100) / 100, Math.round(max * 100) / 100];
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

test('datum axes drive a revolve, a rotate about axis and a circular pattern', async ({
  page
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const projectName = 'Datum axes';
  await page.goto('/');
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  // Axis 1: where Front (XZ) meets Right (YZ), the world Z axis. U09: the
  // Axis runs in place; the two ghost planes are clicked in that order.
  await page.getByRole('button', { name: /^Axis — / }).click();
  const axisBar = page.getByRole('group', { name: 'Axis command' });
  await expect(axisBar).toContainText('Pick a straight edge');
  await clickWorldPoint(page, [3, 0, 3]);
  await expect(axisBar).toContainText('Pick the second plane');
  await clickWorldPoint(page, [0, -3, 3]);
  await expect(axisBar).toContainText('Where the two planes meet');
  await finishInPlaceCommand(page, 'Axis');
  await expect(
    page.locator('.feature-row', { hasText: 'Axis 1' })
  ).toContainText('planes meet', { timeout: 20_000 });
  await expect.poll(async () => (await drawnAxes(canvas)).length).toBe(1);
  const [zAxis] = await drawnAxes(canvas);
  expect(zAxis!.direction.z).toBeCloseTo(1, 9);
  expect(zAxis!.origin.x).toBeCloseTo(0, 9);
  expect(zAxis!.origin.y).toBeCloseTo(0, 9);

  // A circle of radius 2 centred at x 12, z 3 on Front (XZ), revolved about
  // Axis 1 into a ring.
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Front (XZ)' }).click();
  await expect(page.locator('.viewport-dock-grid')).toBeVisible();
  await waitForStillViewport(page);
  const {
    screen: [center, rim]
  } = await liveSketch(canvas, [
    { x: 12, y: 3 },
    { x: 14, y: 3 }
  ]);
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await rail.getByRole('button', { name: /^Circle/ }).click();
  await page.mouse.move(center!.x, center!.y);
  await page.mouse.down();
  await page.mouse.move(rim!.x, rim!.y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await liveSketch(canvas)).objects.length)
    .toBe(1);
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  // U09: Revolve runs in place. The circle is the profile; Axis 1 lies
  // along the sketch's vertical axis, so its line stands in for that axis
  // and a click on it picks the datum.
  await page.getByRole('button', { name: /^Revolve \(R\)/ }).click();
  const revolveBar = page.getByRole('group', { name: 'Revolve command' });
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-profile', {
            detail: { index: 0 }
          })
        )
      );
      return revolveBar.textContent();
    })
    .toContain('Pick the axis');
  const [onAxis] = await canvas.evaluate(
    (element) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: [[0, 0, 10]],
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      })
  );
  await page.mouse.move(onAxis!.x, onAxis!.y);
  await page.mouse.click(onAxis!.x, onAxis!.y);
  await expect(revolveBar.getByRole('button', { name: /Done/ })).toBeEnabled({
    timeout: 30_000
  });
  await revolveBar.getByRole('button', { name: /Done/ }).click();
  await expectBodyCount(page, 1);
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  let stored = await storedProject(page, projectName);
  const axis1 = storedFeature(stored, 'Axis 1');
  const revolve = Object.values(stored.nodes).find(
    (node) => node.kind === 'feature' && node.data?.featureKind === 'revolve'
  )!;
  expect(revolve.data!.axisRef).toEqual({
    type: 'datum-axis',
    datumFeatureId: axis1.featureId
  });
  // Turned about Z: the ring spans x and y from −14 to 14.
  await expect
    .poll(async () => {
      stored = await storedProject(page, projectName);
      return [0, 1].map((axis) =>
        extent(stored, revolve.bodyId!, axis as 0 | 1)?.map(Math.round)
      );
    })
    .toEqual([
      [-14, 14],
      [-14, 14]
    ]);

  // A 2 mm block, and Axis 2 along its back right edge (clicked midway,
  // with edges filtered so nothing else takes the click).
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Width (X)').fill('2');
  await inspector.getByLabel('Depth (Y)').fill('2');
  await inspector.getByLabel('Height (Z)').fill('2');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expectBodyCount(page, 2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Axis — / }).click();
  await expect(axisBar).toContainText('Pick a straight edge');
  await setSelectionFilter(page, 'Edge');
  await clickWorldPoint(page, [2, 2, 1]);
  await expect(axisBar).toContainText('Along the edge');
  await finishInPlaceCommand(page, 'Axis');
  await setSelectionFilter(page, 'Any');
  const axis2Row = page.locator('.feature-row', { hasText: 'Axis 2' });
  await expect(axis2Row).toContainText(/edge/i, { timeout: 20_000 });
  await expect.poll(async () => (await drawnAxes(canvas)).length).toBe(2);

  // Its History card retypes it through two points, the vertical line at
  // x = 10.
  await page.locator('.feature-row-main', { hasText: 'Axis 2' }).click();
  await expect(
    inspector.getByRole('heading', { name: 'Axis 2' })
  ).toBeVisible();
  await inspector.getByRole('button', { name: 'Two points' }).click();
  await typePoint(inspector, 'From point', ['10', '0', '0']);
  await typePoint(inspector, 'To point', ['10', '0', '1']);
  await inspector.getByRole('button', { name: 'Apply' }).click();
  await expect(axis2Row).toContainText('2 points', { timeout: 20_000 });

  // The 2 mm block turned half a turn about Axis 2 lands at x 18..20.
  // U09: Rotate about axis runs in place: the body, then a click on the
  // Axis 2 line (x = 10, vertical), then the angle on its chip's keypad.
  await page.getByRole('button', { name: /^Rotate about axis — / }).click();
  await pickObjectsBody(page, 'Box 1');
  const rotateBar = page.getByRole('group', {
    name: 'Rotate about axis command'
  });
  await expect(rotateBar).toContainText('datum axis');
  await clickWorldPoint(page, [10, 0, 6]);
  await expect(rotateBar).toContainText('Drag the angle');
  await enterCommandValue(page, 'angle', '180');
  await finishInPlaceCommand(page, 'Rotate about axis');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Rotate' })
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  stored = await storedProject(page, projectName);
  const box = Object.values(stored.nodes).find(
    (node) => node.kind === 'body' && node.name === 'Box 1'
  )!;
  const axis2 = storedFeature(stored, 'Axis 2');
  expect(storedFeature(stored, 'Rotate').data.axisRotation).toEqual({
    axis: { type: 'datum-axis', datumFeatureId: axis2.featureId },
    angleDeg: 180
  });
  await expect
    .poll(async () => {
      stored = await storedProject(page, projectName);
      return extent(stored, box.bodyId!, 0);
    })
    .toEqual([18, 20]);

  // Four copies about Axis 2 ring it: x 0..20, y −10..10.
  // U09: Circular pattern runs in place: the body, a click on Axis 2, the
  // count on its chip's keypad.
  await page.getByRole('button', { name: /^Circular pattern/ }).click();
  await pickObjectsBody(page, 'Box 1');
  const patternBar = page.getByRole('group', {
    name: 'Circular pattern command'
  });
  await expect(patternBar).toContainText('Pick the axis');
  await clickWorldPoint(page, [10, 0, 6]);
  await expect(patternBar).toContainText('Drag the total angle');
  await enterCommandValue(page, 'count', '4');
  await finishInPlaceCommand(page, 'Circular pattern');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Circular pattern' })
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  stored = await storedProject(page, projectName);
  const pattern = storedFeature(stored, 'Circular pattern');
  expect(pattern.data.axisRef).toEqual({
    type: 'datum-axis',
    datumFeatureId: axis2.featureId
  });
  await expect
    .poll(async () => {
      stored = await storedProject(page, projectName);
      return [0, 1].map((axis) =>
        extent(stored, pattern.bodyId!, axis as 0 | 1)
      );
    })
    .toEqual([
      [0, 20],
      [-10, 10]
    ]);

  // Edit Axis 2 to x = 20 from History: both consumers follow.
  await page.locator('.feature-row-main', { hasText: 'Axis 2' }).click();
  await expect(
    inspector.getByRole('heading', { name: 'Axis 2' })
  ).toBeVisible();
  await inspector.getByLabel('From point X').fill('20');
  await inspector.getByLabel('To point X').fill('20');
  await inspector.getByRole('button', { name: 'Apply' }).click();
  await expect
    .poll(
      async () => {
        stored = await storedProject(page, projectName);
        return extent(stored, pattern.bodyId!, 0);
      },
      { timeout: 20_000 }
    )
    .toEqual([0, 40]);

  // Coincident points (equal only once evaluated) are refused by the exact
  // check, and nothing changes.
  await page.locator('.feature-row-main', { hasText: 'Axis 2' }).click();
  await expect(inspector.getByRole('button', { name: 'Apply' })).toBeVisible();
  await typePoint(inspector, 'From point', ['0', '0', '0']);
  await typePoint(inspector, 'To point', ['1 - 1', '0', '0']);
  await inspector.getByRole('button', { name: 'Apply' }).click();
  await expect(inspector.getByRole('alert')).toContainText(
    /Not applied — .*coincide/,
    { timeout: 20_000 }
  );
  await expect(page.locator('.feature-row', { hasText: 'Axis 3' })).toHaveCount(
    0
  );
  await inspector.getByRole('button', { name: 'Cancel' }).click();

  // Undo the edit: the pattern returns to its first ring.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => {
      stored = await storedProject(page, projectName);
      return extent(stored, pattern.bodyId!, 0);
    })
    .toEqual([0, 20]);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(errors).toEqual([]);
});
