import type { Locator, Page } from '@playwright/test';
import type { ProjectDocument } from '@openzcad/shared';
import {
  AIM,
  referenceEligibilityPart
} from '../fixtures/reference-eligibility-part';
import {
  expect,
  expectFeatureMeasurement,
  revealModelPanel,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * S06 / I01: editing an earlier sketch, which references it may use. The
 * invented part (test/fixtures/reference-eligibility-part.ts) puts a later
 * Cap above the slab edge Boss profile may project, so from the sketch's
 * normal a click aimed at that edge lands on Cap's face. Re-entering Boss
 * profile, a linked pick of Cap's face is refused naming Cap and changes
 * nothing; a round trip through the isometric view keeps the sketch, its
 * plane and a half-placed circle; the slab's exposed edge then projects
 * linked, and Boss and Cap rebuild unchanged before and after a reload.
 * Exact-kernel oracles: test/sketch-reference-eligibility.test.ts.
 */

const PROJECT = 'Reference eligibility';
const REFUSAL = `That edge cannot be projected linked here: the source body is unavailable at the sketch's place in the history (source feature "Cap"). To copy it as independent geometry instead, switch Project to Unlinked and pick it again.`;
const BOSS_VOLUME = '301.59 mm³';
const CAP_VOLUME = '1200 mm³';
/** Written to this device: local-only or synced, not mid-save. */
const SAVED = /\bis-(?:local|synced)(?:\s|$)/;

interface StoredNode {
  kind: string;
  name: string;
  objectIds?: string[];
  constraints?: unknown[];
  data?: {
    objectKind?: string;
    construction?: boolean;
    projection?: { mode: string };
  } & Record<string, unknown>;
}

interface StoredProject {
  name: string;
  version: number;
  nodes: Record<string, StoredNode>;
  derived?: {
    featureWarnings?: unknown[];
    sketchProjections?: Record<string, { status: string }>;
  };
}

async function storedProject(page: Page): Promise<StoredProject> {
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
  const project = projects.find((candidate) => candidate.name === PROJECT);
  if (!project) throw new Error(`No stored project named ${PROJECT}.`);
  return project;
}

/** Boss profile as stored: its objects in order, and its constraints. */
function bossProfile(project: StoredProject) {
  const sketch = Object.values(project.nodes).find(
    (node) => node.kind === 'sketch' && node.name === 'Boss profile'
  );
  if (!sketch) throw new Error('No stored Boss profile.');
  return {
    objects: (sketch.objectIds ?? []).map((id) => ({
      id,
      data: project.nodes[id]?.data ?? {}
    })),
    constraints: sketch.constraints ?? []
  };
}

interface SketchState {
  screen: { x: number; y: number }[];
  objects: { id: string; data: Record<string, unknown> }[];
  target: number[];
  projection: string;
}

/** The active sketch, and where plane points sit on screen right now. */
async function sketchState(
  canvas: Locator,
  points: { x: number; y: number }[] = []
): Promise<SketchState> {
  const state = await canvas.evaluate(
    (element, project) =>
      new Promise<SketchState | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: { project, resolve }
          })
        );
      }),
    points
  );
  if (!state) throw new Error('No active sketch.');
  return state;
}

async function importProject(page: Page, document: ProjectDocument) {
  await page.getByLabel('Import project backup').setInputFiles({
    name: `${document.name}.openzcad`,
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
  ).toContainText(document.name);
}

async function expectPartBuilt(page: Page) {
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 30_000
  });
  await revealModelPanel(page, 'History');
  const row = (name: string) =>
    page.locator('.feature-row', {
      has: page.locator('.feature-row-main', {
        hasText: new RegExp(`^${name}`)
      })
    });
  await expectFeatureMeasurement(page, row('Boss').last(), BOSS_VOLUME);
  await expectFeatureMeasurement(page, row('Cap').last(), CAP_VOLUME);
}

/**
 * Opens the part and re-enters Boss profile from History, zoomed out until
 * the slab and Cap are on screen (entry frames the sketch's one circle),
 * with Project armed, linked.
 */
async function enterBossProfile(page: Page) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Eligibility scratch');
  await page.getByRole('button', { name: 'New project' }).click();
  // Importing over a project that is still being created races its save.
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await importProject(page, referenceEligibilityPart(PROJECT).document);
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('warnings0', { timeout: 30_000 });

  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: 'Boss profile' }).click();
  await page
    .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
    .click();
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(rail).toBeVisible();
  await waitForStillViewport(page);

  const canvas = page.locator('.viewer-host canvas');
  const box = (await canvas.boundingBox())!;
  for (let step = 0; ; step += 1) {
    const [corner] = (await sketchState(canvas, [{ x: 30, y: 20 }])).screen;
    if (corner!.x < box.x + box.width * 0.6 && corner!.y > box.y + 80) break;
    if (step === 20) throw new Error('Could not zoom the part into view.');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 1200);
    await waitForStillViewport(page);
  }

  const project = rail.getByRole('button', { name: 'Project edges' });
  await project.click();
  await expect(project).toHaveAttribute('aria-pressed', 'true');
  await expect(
    rail
      .getByRole('radiogroup', { name: 'Projection link' })
      .getByRole('radio', { name: 'Linked', exact: true })
  ).toBeChecked();
  await expect(status).toContainText(
    'Click a model edge, or a face for its boundary, to project it linked'
  );
  const aim = async () => {
    const [downstreamFace, upstreamEdge] = (
      await sketchState(canvas, [AIM.downstreamFace, AIM.upstreamEdge])
    ).screen;
    return { downstreamFace: downstreamFace!, upstreamEdge: upstreamEdge! };
  };
  return { canvas, rail, status, project, aim };
}

/** Screen step of one sketch unit along u and v, from the plane's origin. */
async function planeSteps(canvas: Locator) {
  const [origin, u, v] = (
    await sketchState(canvas, [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 }
    ])
  ).screen;
  return {
    origin: origin!,
    u: { x: (u!.x - origin!.x) / 10, y: (u!.y - origin!.y) / 10 },
    v: { x: (v!.x - origin!.x) / 10, y: (v!.y - origin!.y) / 10 }
  };
}

test('an earlier sketch refuses a later face, survives a view round trip, and keeps an earlier edge through reload', async ({
  page
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { canvas, rail, status, project, aim } = await enterBossProfile(page);
  await expect(page.locator('.save-state')).toHaveClass(SAVED);
  const before = await storedProject(page);
  expect(
    bossProfile(before).objects.map(({ data }) => data.objectKind)
  ).toEqual(['circle']);

  // 1. A click aimed at the slab's covered edge lands on Cap's top face,
  //    which comes after Boss profile: refused after the pick, naming Cap.
  const { downstreamFace } = await aim();
  await page.mouse.click(downstreamFace.x, downstreamFace.y);
  await expect(status).toContainText(REFUSAL, { timeout: 30_000 });
  // Nothing changed: no new entity or constraint, the same stored version,
  // no projection verdict, and the later features build as before.
  expect((await sketchState(canvas)).objects).toHaveLength(1);
  await expect(page.locator('.save-state')).toHaveClass(SAVED);
  const refused = await storedProject(page);
  expect(refused.version).toBe(before.version);
  expect(bossProfile(refused)).toEqual(bossProfile(before));
  expect(bossProfile(refused).constraints).toEqual([]);
  expect(refused.derived?.sketchProjections ?? {}).toEqual({});
  await expect(status).toContainText('warnings0');
  await expect(project).toHaveAttribute('aria-pressed', 'true');

  // 2. Without leaving the sketch: half-place a construction circle, go to
  //    the isometric view and back to the sketch normal, then finish it.
  await rail.getByRole('button', { name: 'Construction', exact: true }).click();
  const circle = rail.getByRole('button', { name: 'Circle: Center circle' });
  await circle.click();
  await expect(circle).toHaveAttribute('aria-pressed', 'true');
  const normal = await planeSteps(canvas);
  const target = (await sketchState(canvas)).target;
  const original = (await sketchState(canvas)).objects[0]!.data;
  const [center, rim] = (
    await sketchState(canvas, [
      { x: 0, y: -15 },
      { x: 3, y: -15 }
    ])
  ).screen;
  await page.mouse.click(center!.x, center!.y);
  await page.getByRole('button', { name: 'Standard views' }).click();
  await page.getByRole('button', { name: /^Isometric view/ }).click();
  await waitForStillViewport(page);
  await expect(rail).toBeVisible();
  const oblique = await planeSteps(canvas);
  // Premise: the view really tilted (u no longer runs straight across).
  expect(Math.abs(oblique.u.y)).toBeGreaterThan(Math.abs(normal.u.x) / 10);
  await page
    .getByRole('button', { name: 'Normal to sketch', exact: true })
    .click();
  await waitForStillViewport(page);
  const returned = await planeSteps(canvas);
  expect(returned.u.x).toBeCloseTo(normal.u.x, 0);
  expect(returned.u.y).toBeCloseTo(0, 0);
  expect(returned.v.x).toBeCloseTo(0, 0);
  expect(returned.v.y).toBeCloseTo(normal.v.y, 0);
  expect((await sketchState(canvas)).projection).toBe('orthographic');
  expect((await sketchState(canvas)).target).toEqual(target);
  // The half-placed circle is still pending: its second click finishes it.
  await expect(circle).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(rim!.x, rim!.y);
  await expect
    .poll(async () =>
      (await sketchState(canvas)).objects.map(({ data }) => ({
        kind: data.objectKind,
        construction: data.construction === true
      }))
    )
    .toEqual([
      { kind: 'circle', construction: false },
      { kind: 'circle', construction: true }
    ]);
  const drawn = (await sketchState(canvas)).objects[1]!.data as {
    centerX: number;
    centerY: number;
    radius: number;
  };
  // The view round trip left Boss's own circle exactly where it was.
  expect((await sketchState(canvas)).objects[0]!.data).toEqual(original);
  expect(drawn.centerX).toBeCloseTo(0, 0);
  expect(drawn.centerY).toBeCloseTo(-15, 0);
  expect(drawn.radius).toBeCloseTo(3, 0);

  // 3. The slab's exposed edge comes before Boss profile: it projects
  //    linked (as construction, so Boss's profile stays one circle).
  await project.click();
  await expect(project).toHaveAttribute('aria-pressed', 'true');
  const { upstreamEdge } = await aim();
  await page.mouse.click(upstreamEdge.x, upstreamEdge.y);
  await expect(status).toContainText('Projected 1 linked edge.', {
    timeout: 30_000
  });
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(rail).toHaveCount(0);

  const expectStored = async () => {
    await expect(page.locator('.save-state')).toHaveClass(SAVED);
    await expect
      .poll(
        async () => {
          const stored = await storedProject(page);
          const { objects, constraints } = bossProfile(stored);
          return {
            objects: objects.map(({ data }) => ({
              kind: data.objectKind,
              construction: data.construction === true,
              mode: data.projection?.mode ?? null,
              x: data.objectKind === 'line' ? [data.x1, data.x2] : null
            })),
            constraints: constraints.length,
            states: Object.values(stored.derived?.sketchProjections ?? {}).map(
              (state) => state.status
            )
          };
        },
        { timeout: 30_000 }
      )
      .toEqual({
        objects: [
          { kind: 'circle', construction: false, mode: null, x: null },
          { kind: 'circle', construction: true, mode: null, x: null },
          { kind: 'line', construction: true, mode: 'linked', x: [20, 20] }
        ],
        constraints: 0,
        states: ['current']
      });
  };
  await expectStored();
  await expectPartBuilt(page);
  await expect(
    page.locator('.feature-row', { hasText: 'Boss profile' })
  ).not.toContainText('broken projection');

  // 4. Reload: the same sketch, a current link, the same Boss and Cap.
  await page.reload();
  await expectPartBuilt(page);
  await expectStored();
  // The live workspace, not only the saved verdict, holds the link current.
  await expect(
    page.locator('.feature-row', { hasText: 'Boss profile' })
  ).not.toContainText('broken projection');
  await revealModelPanel(page, 'Objects');
  const projected = page
    .getByRole('list', { name: 'Objects' })
    .getByRole('listitem', { name: /^Projected line: Linked from Base/ });
  await expect(projected).toHaveCount(1);
  await expect(projected.locator('.feature-flag')).toHaveText('linked');
  await expect(projected.locator('.feature-flag')).not.toHaveClass(/\berror\b/);
  expect(errors).toEqual([]);
});

/**
 * Finding (Pick, U11 / viewer), recorded at the Remus pin in the evidence
 * fragment: with Project armed in Boss profile, hovering Cap's face (refused
 * on click), the slab's exposed edge (accepted) or empty plane looks the
 * same. The cursor stays `auto`, no hover film or edge highlight is drawn
 * (a screenshot differs only by the sketch cursor dot), and the hint and
 * status keep the armed tool's sentence. Expected: before the click, the
 * later face reads as unavailable here, naming Cap, while the earlier edge
 * reads as a candidate.
 */
test.fixme('tells a later face from an earlier edge before the click', async ({
  page
}) => {
  test.setTimeout(120_000);
  const { canvas, status, aim } = await enterBossProfile(page);
  const cursor = () =>
    canvas.evaluate((element) => getComputedStyle(element).cursor);
  const { downstreamFace, upstreamEdge } = await aim();

  await page.mouse.move(upstreamEdge.x, upstreamEdge.y, { steps: 4 });
  await waitForStillViewport(page);
  const eligibleCursor = await cursor();
  await expect(status).not.toContainText(/Cap/);

  await page.mouse.move(downstreamFace.x, downstreamFace.y, { steps: 4 });
  await waitForStillViewport(page);
  await expect(status).toContainText(/Cap.*(later|after)/i);
  expect(await cursor()).not.toBe(eligibleCursor);
});
