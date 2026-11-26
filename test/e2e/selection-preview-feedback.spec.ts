import type { Locator, Page } from '@playwright/test';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type ProjectDocument,
  type SketchId
} from '@openzcad/shared';
import {
  MODEL_ONLY,
  expect,
  expectBodyCount,
  stubApi,
  switchFaceOffsetToTotal,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U11 slice 2a: selection and edit-preview feedback in the viewport's face
 * edits, on Fixture A — the invented slotted coupon of the K10 workflow
 * coupon (`test/cad-workflow-coupon.test.ts`, A0–A4): a 90 × 36 × 14 blank
 * at x 0–90, y 0–36, z 0–14, a witness block at x 100–120, through channels
 * at x 12–22 and x 62–72 (y 8–28), and a through bore of r 6 at (42, 18).
 *
 * Oracles: the Picked group, the chip and its mode tag, the keypad's value
 * field and its alert, Apply, the feature count, the drawn bodies and the
 * stored feature. A refusal is asserted by its presence and kind, never by
 * kernel prose. The superseded-reply cell is the hook regression
 * `apps/web/src/hooks/useInPlaceCommandSuperseded.test.tsx`.
 *
 * Cases marked `test.fixme` pin a product gap: each names its failure class
 * and the expected behavior, and is left for a separate fix PR.
 */

const XY = { type: 'canonical', plane: 'XY', offset: 0 } as const;
const PI = Math.PI;
/** A4: the blank less two 10 × 20 channels and the r 6 bore, mm³. */
const A4_VOLUME = 90 * 36 * 14 - 2 * 2800 - 504 * PI;
const NAME = 'Slotted coupon';

function rectangle(
  document: ProjectDocument,
  name: string,
  [x0, x1]: [number, number],
  [y0, y1]: [number, number]
) {
  return addSketchFeature(document, {
    name,
    planeRef: XY,
    objects: [
      {
        objectKind: 'rectangle',
        width: x1 - x0,
        height: y1 - y0,
        centerX: (x0 + x1) / 2,
        centerY: (y0 + y1) / 2
      }
    ]
  });
}

function pad(document: ProjectDocument, name: string, sketchId: SketchId) {
  return extrudeSketch(document, {
    name,
    sketchId,
    distance: 14,
    operation: 'new-body'
  });
}

function cut(
  document: ProjectDocument,
  name: string,
  sketchId: SketchId,
  targetBodyId: BodyId
) {
  return extrudeSketch(document, {
    name,
    sketchId,
    distance: 14,
    operation: 'cut',
    targetBodyId,
    endCondition: 'through-all',
    throughAllSide: 'both'
  });
}

/** Fixture A, A0–A4, as a parametric history. */
function slottedCoupon(): ProjectDocument {
  const blank = rectangle(
    createProjectDocument(NAME, toUserId('user_e2e')),
    'Coupon sketch',
    [0, 90],
    [0, 36]
  );
  const a0 = pad(blank.document, 'Coupon', blank.sketchId);
  const witness = rectangle(a0.document, 'Witness sketch', [100, 120], [0, 36]);
  const a1 = pad(witness.document, 'Witness', witness.sketchId);
  const one = rectangle(a1.document, 'Channel 1 sketch', [12, 22], [8, 28]);
  const a2 = cut(one.document, 'Channel 1', one.sketchId, a0.bodyId);
  const two = rectangle(a2.document, 'Channel 2 sketch', [62, 72], [8, 28]);
  const a3 = cut(two.document, 'Channel 2', two.sketchId, a2.bodyId);
  const bore = addSketchFeature(a3.document, {
    name: 'Bore sketch',
    planeRef: XY,
    objects: [{ objectKind: 'circle', radius: 6, centerX: 42, centerY: 18 }]
  });
  return cut(bore.document, 'Bore', bore.sketchId, a3.bodyId).document;
}

async function openCoupon(page: Page) {
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Import project' }).click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'slotted-coupon.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: slottedCoupon(),
        files: []
      })
    )
  });
  await expectBodyCount(page, 2);
  await waitForStillViewport(page);
}

const canvasOf = (page: Page) => page.locator('.viewer-host canvas');

async function screenPoint(page: Page, at: [number, number, number]) {
  const [point] = await canvasOf(page).evaluate(
    (element, points) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    [at]
  );
  return point!;
}

interface Drawn {
  /** Null on a preview frame, which carries no exact volume. */
  volume: number | null;
  maxZ: number;
  minX: number;
  maxX: number;
  /** Radii of the body's cylindrical faces: the bore, as drawn. */
  cylinders: number[];
}

/** The drawn coupon (the live body starting at x = 0), preview frames included. */
async function drawnCoupon(page: Page): Promise<Drawn | null> {
  const bodies = await canvasOf(page).evaluate(
    (element) =>
      new Promise<Drawn[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              resolve: ({
                bodies
              }: {
                bodies: {
                  consumed?: boolean;
                  volume?: number;
                  bbox: {
                    min: { x: number; z: number };
                    max: { x: number; z: number };
                  };
                  topology?: {
                    faces?: {
                      geometry?: { surfaceType?: string; radius?: number };
                    }[];
                  };
                }[];
              }) =>
                resolve(
                  bodies
                    .filter((body) => !body.consumed)
                    .map((body) => ({
                      volume:
                        body.volume === undefined
                          ? null
                          : Math.round(body.volume * 100) / 100,
                      maxZ: Math.round(body.bbox.max.z * 1000) / 1000,
                      minX: Math.round(body.bbox.min.x * 1000) / 1000,
                      maxX: Math.round(body.bbox.max.x * 1000) / 1000,
                      cylinders: (body.topology?.faces ?? [])
                        .filter(
                          (face) =>
                            face.geometry?.surfaceType === 'cylinder' &&
                            face.geometry.radius !== undefined
                        )
                        .map(
                          (face) =>
                            Math.round(face.geometry!.radius! * 1000) / 1000
                        )
                    }))
                )
            }
          })
        );
      })
  );
  return bodies.find((body) => body.minX === 0) ?? null;
}

const couponTop = async (page: Page) => (await drawnCoupon(page))?.maxZ;
const couponRight = async (page: Page) => (await drawnCoupon(page))?.maxX;
/** The drawn bore's radius, preview frames included. */
const boreRadii = async (page: Page) =>
  (await drawnCoupon(page))?.cylinders ?? [];
const couponVolume = async (page: Page) =>
  (await drawnCoupon(page))?.volume ?? null;

/** The feature count the status bar reports. */
async function featureCount(page: Page) {
  return Number(
    (
      await page
        .locator('.workspace-status-summary [title]')
        .getAttribute('title')
    )?.match(/(\d+) features?/)?.[1]
  );
}

interface StoredFeature {
  name: string;
  featureId?: string;
  featureKind?: string;
  data?: Record<string, unknown>;
}

/** The project's features in storage, in node order. */
async function storedFeatures(page: Page): Promise<StoredFeature[]> {
  const projects = await page.evaluate(
    () =>
      new Promise<
        {
          name: string;
          nodes: Record<string, StoredFeature & { kind: string }>;
        }[]
      >((resolve, reject) => {
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
            resolve(all.result);
          };
        };
      })
  );
  const project = projects.find((candidate) => candidate.name === NAME);
  if (!project) throw new Error(`No stored project named ${NAME}.`);
  return Object.values(project.nodes).filter((node) => node.kind === 'feature');
}

/**
 * Opens Select other from the keyboard over `point` and moves focus to the
 * row whose label matches `row`. Returns the list and the row.
 */
async function focusStackRow(
  page: Page,
  point: { x: number; y: number },
  row: RegExp
): Promise<{ menu: Locator; target: Locator }> {
  await page.mouse.move(point.x, point.y);
  await page.keyboard.press('Alt+ArrowDown');
  const menu = page.getByRole('menu', { name: 'Select other' });
  await expect(menu).toBeVisible();
  const rows = menu.getByRole('menuitem');
  await expect(rows.first()).toBeFocused();
  const labels = await rows.allTextContents();
  const index = labels.findIndex((label) => row.test(label));
  expect(index, `${row} in ${labels.join(' | ')}`).toBeGreaterThanOrEqual(0);
  for (let step = 0; step < index; step += 1) {
    await page.keyboard.press('ArrowDown');
  }
  const target = rows.nth(index);
  await expect(target).toBeFocused();
  return { menu, target };
}

/** Where the bore's rim, the top face and the bore wall stack up. */
const RIM: [number, number, number] = [48.3, 18, 14];

test('an overlapping pick confirmed from Select other is the face the preview and the commit use', async ({
  page
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openCoupon(page);
  const canvas = canvasOf(page);
  const picked = page.getByRole('group', { name: 'Picked' });
  const mode = page.getByTestId('direct-manipulation-mode');
  const chip = page.getByTestId('direct-manipulation-value');
  const features = await featureCount(page);

  // A click on the rim takes the front candidate, the bore's rim edge.
  const rim = await screenPoint(page, RIM);
  await page.mouse.move(rim.x, rim.y);
  await page.mouse.click(rim.x, rim.y);
  await expect(picked).toContainText('Hole edge');

  // Under the pointer: the rim edge, the coupon's top face (the pad owns
  // it) and the bore wall (the Bore cut owns it). Fixture A's channels and
  // bore run through, so there is no floor candidate in the stack.
  const top = await focusStackRow(page, rim, /Top face/);
  const stack = await top.menu.getByRole('menuitem').allTextContents();
  expect(stack.slice(0, 3)).toEqual([
    expect.stringMatching(/Hole edge/),
    expect.stringMatching(/Top face/),
    expect.stringMatching(/Through hole/)
  ]);
  // A focused row pre-highlights its candidate; Space confirms it.
  await expect(canvas).toHaveAttribute('data-e2e-pick-list-hover', /.+/);
  await page.keyboard.press('Space');
  await expect(top.menu).toBeHidden();
  await expect(picked).toContainText('Top face');

  // The top face's own baseline: its Total is the coupon's 14 mm. A Total
  // of 10 previews the top at z = 10.
  await switchFaceOffsetToTotal(page);
  await expect(chip).toHaveText('14 mm');
  await chip.click();
  const totalKeypad = page.getByRole('dialog', { name: 'Total value' });
  await totalKeypad.getByRole('textbox').fill('10');
  await expect.poll(() => couponTop(page), { timeout: 30_000 }).toBe(10);
  // Leaving the entry takes that frame down; nothing was committed.
  await totalKeypad.getByRole('textbox').press('Escape');
  await expect(totalKeypad).toBeHidden();
  await expect.poll(() => couponTop(page), { timeout: 30_000 }).toBe(14);

  // Confirm the bore wall from the same stack, by keyboard.
  const wall = await focusStackRow(page, rim, /Through hole/);
  await page.keyboard.press('Space');
  await expect(wall.menu).toBeHidden();
  await expect(picked).toContainText('Through hole');
  // Its own reading and its own baseline: no Total, no 14 or 10 left over
  // from the top face.
  await expect(mode).toHaveText('Diameter');
  await expect(chip).toHaveText('Ø 12 mm');
  expect(await boreRadii(page)).toEqual([6]);
  await chip.click();
  const diameter = page.getByRole('dialog', { name: 'Diameter value' });
  const field = diameter.getByRole('textbox');
  await expect(field).toHaveValue('12');

  // Ø 14 previews on the bore before anything is applied — the drawn
  // preview's bore is r 7 — and on the bore only: the top stays at 14.
  await field.fill('14');
  const apply = diameter.getByRole('button', { name: 'Apply diameter' });
  await expect(apply).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => boreRadii(page), { timeout: 30_000 }).toEqual([7]);
  expect(await featureCount(page)).toBe(features);
  expect(await couponTop(page)).toBe(14);
  await apply.click();
  await expect(diameter).toBeHidden();
  await expect.poll(() => featureCount(page)).toBe(features + 1);
  const widened = Math.round((A4_VOLUME - 13 * PI * 14) * 100) / 100;
  await expect
    .poll(() => couponVolume(page), { timeout: 30_000 })
    .toBeCloseTo(widened, 1);
  expect(await couponTop(page)).toBe(14);

  // The commit names the face the list confirmed: the bore wall the Bore
  // cut made, at its stored Ø 12, now Ø 14.
  // An imported project stays local; its save lands in storage.
  await expect
    .poll(async () => (await storedFeatures(page)).length, {
      timeout: 30_000
    })
    .toBe(features + 1);
  const stored = await storedFeatures(page);
  const boreId = stored.find((feature) => feature.name === 'Bore')?.featureId;
  expect(boreId).toBeTruthy();
  const edit = stored.at(-1)!;
  expect(edit.featureKind).toBe('direct-edit');
  expect(edit.data?.operation).toMatchObject({
    kind: 'resize-through-hole',
    sourceDiameter: 12,
    diameter: 14,
    faceReference: { kind: 'face', producingFeatureId: boreId }
  });
  expect(errors).toEqual([]);
});

/**
 * Pinned gap, failure class Pick (U11 / viewer): Enter on a focused Select
 * other row does not confirm that row. The list closes and the workspace's
 * Enter opens exact entry for the candidate picked before the list opened
 * (here the rim edge's Radius keypad); Space confirms the row. Smallest
 * failing prefix: open Fixture A, click the rim at (48.3, 18, 14), Alt+↓,
 * ↓ to "Top face", Enter. Expected: Enter selects the focused row, as Space
 * and a click do, and opens no keypad for the old pick.
 */
test.fixme('Enter on a focused Select other row confirms that row', async ({
  page
}) => {
  await openCoupon(page);
  const picked = page.getByRole('group', { name: 'Picked' });
  const rim = await screenPoint(page, RIM);
  await page.mouse.move(rim.x, rim.y);
  await page.mouse.click(rim.x, rim.y);
  await expect(picked).toContainText('Hole edge');
  const { menu } = await focusStackRow(page, rim, /Top face/);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(picked).toContainText('Top face');
  await expect(page.locator('.numeric-keypad')).toHaveCount(0);
});

test('a negative Total is refused at its field and stays editable; the same inward offset applies', async ({
  page
}) => {
  test.setTimeout(180_000);
  await openCoupon(page);
  const picked = page.getByRole('group', { name: 'Picked' });
  const mode = page.getByTestId('direct-manipulation-mode');
  const chip = page.getByTestId('direct-manipulation-value');
  const features = await featureCount(page);

  const face = await screenPoint(page, [30, 30, 14]);
  await page.mouse.click(face.x, face.y);
  await expect(picked).toContainText('Top face');
  await switchFaceOffsetToTotal(page);
  await expect(chip).toHaveText('14 mm');
  await chip.click();
  const total = page.getByRole('dialog', { name: 'Total value' });
  const field = total.getByRole('textbox');
  const applyTotal = total.getByRole('button', { name: 'Apply total' });

  // A Total of −4 is refused beside the field: an alert with a word, not
  // only a colour, the field marked invalid, Apply held — and the field
  // keeps the value, the focus and the face.
  await field.fill('-4');
  const refusal = total.getByRole('alert');
  await expect(refusal).toBeVisible({ timeout: 30_000 });
  await expect(refusal).toContainText('Not built');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(applyTotal).toBeDisabled();
  await expect(field).toHaveValue('-4');
  await expect(field).toBeFocused();
  await expect(picked).toContainText('Top face');
  // Enter does not take a refused value.
  await field.press('Enter');
  await expect(total).toBeVisible();
  await expect(field).toHaveValue('-4');
  expect(await featureCount(page)).toBe(features);
  expect(await couponTop(page)).toBe(14);
  await field.press('Escape');
  await expect(total).toBeHidden();

  // The same size as a signed offset, inward: −4 is accepted and commits
  // only its own value.
  await mode.click();
  await expect(mode).toHaveText(/^Offset/);
  const offset = page.getByRole('dialog', { name: 'Offset value' });
  if (!(await offset.isVisible())) await chip.click();
  const offsetField = offset.getByRole('textbox');
  await offsetField.fill('-4');
  const applyOffset = offset.getByRole('button', { name: /^Apply/ });
  await expect(applyOffset).toBeEnabled({ timeout: 30_000 });
  await expect(offset.getByRole('alert')).toHaveCount(0);
  await expect(offsetField).toHaveAttribute('aria-invalid', 'false');
  await applyOffset.click();
  await expect(offset).toBeHidden();
  await expect.poll(() => featureCount(page)).toBe(features + 1);
  await expect.poll(() => couponTop(page), { timeout: 30_000 }).toBe(10);
  const thinner = Math.round((90 * 36 - 400 - 36 * PI) * 10 * 100) / 100;
  await expect
    .poll(() => couponVolume(page), { timeout: 30_000 })
    .toBeCloseTo(thinner, 1);
  await expect
    .poll(async () => (await storedFeatures(page)).length, {
      timeout: 30_000
    })
    .toBe(features + 1);
  const added = (await storedFeatures(page)).slice(-1);
  // One stored offset of the top face, at exactly the entered −4: not
  // the refused Total, and not a Total turned into an offset.
  expect(added[0]!.featureKind).toBe('direct-edit');
  expect(added[0]!.data?.operation).toMatchObject({
    kind: 'offset-face',
    offset: -4,
    sourceNormal: { z: 1 }
  });
  expect(
    (added[0]!.data?.operation as { sourceCenter: { z: number } }).sourceCenter
      .z
  ).toBe(14);
});

/**
 * Pinned gap, failure class Command state (U01 / face direct edit): a
 * negative Diameter or Radius on the bore is not refused. The chip takes the
 * value (Ø −12 mm), the keypad shows no alert, the field is not marked
 * invalid and Apply stays enabled; Enter then closes the keypad without a
 * commit or a word. Smallest failing prefix: open Fixture A, pick the bore
 * wall (Select other at the rim, "Through hole"), open its Diameter keypad,
 * type −12. Expected, as for a negative Total: an alert at the field,
 * `aria-invalid`, Apply held, and value, focus and face kept — in Radius as
 * in Diameter.
 */
test.fixme('a negative Diameter or Radius on the bore is refused at its field', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openCoupon(page);
  const picked = page.getByRole('group', { name: 'Picked' });
  const rim = await screenPoint(page, RIM);
  await page.mouse.move(rim.x, rim.y);
  await page.mouse.click(rim.x, rim.y);
  const { menu } = await focusStackRow(page, rim, /Through hole/);
  await page.keyboard.press('Space');
  await expect(menu).toBeHidden();
  await expect(picked).toContainText('Through hole');
  await page.getByTestId('direct-manipulation-value').click();
  // The keypad is named for the mode it is in: "Diameter value", then
  // "Radius value" once R is chosen.
  for (const [radio, name, value] of [
    ['Ø Diameter', 'Diameter value', '-12'],
    ['R Radius', 'Radius value', '-6']
  ] as const) {
    await page
      .locator('.numeric-keypad')
      .getByRole('radio', { name: radio })
      .click();
    const keypad = page.getByRole('dialog', { name });
    await expect(keypad).toBeVisible();
    const field = keypad.getByRole('textbox');
    await field.fill(value);
    await expect(keypad.getByRole('alert')).toBeVisible({ timeout: 30_000 });
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(keypad.getByRole('button', { name: /^Apply/ })).toBeDisabled();
    await expect(field).toHaveValue(value);
    await expect(field).toBeFocused();
    await expect(picked).toContainText('Through hole');
  }
});

/**
 * Cell 4. Under a section view (Side, YZ at x = 45, keeping x < 45) a valid
 * Offset Face edit that the section only partly hides, one it hides wholly,
 * and a refused one: the refusal is told apart (an alert, the field invalid,
 * Apply held) from both valid edits. Whether the two valid edits are told
 * apart from each other is the pinned case below; today they are not.
 */
test('under a section, a refused face edit is told apart from valid ones', async ({
  page
}) => {
  test.setTimeout(180_000);
  await openCoupon(page);
  const picked = page.getByRole('group', { name: 'Picked' });
  const chip = page.getByTestId('direct-manipulation-value');
  const features = await featureCount(page);

  // Pick the Right face (x = 90) while it is in view.
  const right = await screenPoint(page, [90, 4, 7]);
  await page.mouse.click(right.x, right.y);
  await expect(picked).toContainText('Right face');

  const section = page.getByRole('button', { name: /^Section view — now:/ });
  const panel = page.getByRole('group', { name: 'Section view', exact: true });
  await section.click();
  await panel.getByRole('button', { name: 'Side (YZ plane)' }).click();
  const cut = panel.getByRole('spinbutton', { name: 'Cut position' });
  await cut.fill('45');
  await cut.press('Enter');
  await section.click();
  await expect(panel).toBeHidden();
  await expect(section).toHaveAttribute('aria-pressed', 'true');
  await expect(section).toHaveAccessibleName(/YZ plane/);

  const keypad = page.locator('.numeric-keypad');
  const field = keypad.getByRole('textbox');
  const apply = keypad.getByRole('button', { name: /^Apply/ });

  // Wholly hidden: the Right face, still picked, offset outward by 2.
  await expect(picked).toContainText('Right face');
  await chip.click();
  await field.fill('2');
  await expect(apply).toBeEnabled({ timeout: 30_000 });
  await expect(keypad.getByRole('alert')).toHaveCount(0);
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await field.press('Escape');
  await page.keyboard.press('Escape');

  // Partly hidden: the top face spans the cut; offset in by 2.
  const top = await screenPoint(page, [30, 30, 14]);
  await page.mouse.click(top.x, top.y);
  await expect(picked).toContainText('Top face');
  await chip.click();
  await field.fill('-2');
  await expect(apply).toBeEnabled({ timeout: 30_000 });
  await expect(keypad.getByRole('alert')).toHaveCount(0);
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await field.press('Escape');

  // Refused: a Total below zero on the same face.
  await switchFaceOffsetToTotal(page);
  await chip.click();
  await field.fill('-4');
  await expect(keypad.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(apply).toBeDisabled();
  await field.press('Escape');

  // Nothing above committed, and the section is as it was set.
  expect(await featureCount(page)).toBe(features);
  await expect(section).toHaveAttribute('aria-pressed', 'true');
});

/**
 * Pinned gap, failure class Display (U02 / viewer): an Offset Face edit the
 * section view hides wholly reads exactly like one it hides in part. For a
 * planar face on the clipped side of a planar cut the visibility is exact
 * (the Right face's plane x = 90 lies wholly past the cut at x = 45), as
 * Extrude's `isExtrudeChangeClipped` already decides for its own preview.
 * Smallest failing prefix: open Fixture A, set Section view Side at 45, pick
 * the Right face (flip the cut to reach it, then flip it back), open the
 * Offset keypad, type 2. Expected: the keypad says
 * "Section view hides this change" with Show full model for the wholly
 * hidden edit only; Show full model is a view change that keeps the typed
 * value, the focus, the face and the request, and adds no History row.
 */
test.fixme('a face edit hidden wholly by the section says so and can reveal it', async ({
  page
}) => {
  test.setTimeout(180_000);
  await openCoupon(page);
  const picked = page.getByRole('group', { name: 'Picked' });
  const chip = page.getByTestId('direct-manipulation-value');
  const features = await featureCount(page);
  const section = page.getByRole('button', { name: /^Section view — now:/ });
  const panel = page.getByRole('group', { name: 'Section view', exact: true });
  const flip = panel.getByRole('button', { name: 'Flip cut direction' });
  await section.click();
  await panel.getByRole('button', { name: 'Side (YZ plane)' }).click();
  const cut = panel.getByRole('spinbutton', { name: 'Cut position' });
  await cut.fill('45');
  await cut.press('Enter');
  await section.click();
  await expect(panel).toBeHidden();
  await expect(section).toHaveAttribute('aria-pressed', 'true');
  const keypad = page.locator('.numeric-keypad');
  const field = keypad.getByRole('textbox');
  const apply = keypad.getByRole('button', { name: /^Apply/ });
  const note = keypad.getByText('Section view hides this change');

  // Partly hidden: the top face spans the cut. A valid edit, and no note.
  const top = await screenPoint(page, [30, 30, 14]);
  await page.mouse.click(top.x, top.y);
  await expect(picked).toContainText('Top face');
  await chip.click();
  await field.fill('-2');
  await expect(apply).toBeEnabled({ timeout: 30_000 });
  await expect(note).toHaveCount(0);
  await field.press('Escape');
  await page.keyboard.press('Escape');

  // Flip the cut to keep x > 45, pick the Right face, flip it back: the
  // Right face (x = 90) is then wholly past the cut, and still picked.
  await section.click();
  await flip.click();
  await section.click();
  const right = await screenPoint(page, [90, 4, 7]);
  await page.mouse.click(right.x, right.y);
  await expect(picked).toContainText('Right face');
  await section.click();
  await flip.click();
  await expect(flip).toHaveAttribute('aria-pressed', 'false');
  await section.click();
  await expect(panel).toBeHidden();
  await expect(picked).toContainText('Right face');

  // Wholly hidden: a valid +2, said to be hidden by the section.
  await chip.click();
  await field.fill('2');
  await expect(apply).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => couponRight(page), { timeout: 30_000 }).toBe(92);
  await expect(note).toBeVisible({ timeout: 30_000 });

  // Show full model is a view change: the section goes, and the typed
  // value, the focus, the face and the live preview of x = 92 stay, with
  // nothing committed.
  await keypad.getByRole('button', { name: 'Show full model' }).click();
  await expect(section).toHaveAttribute('aria-pressed', 'false');
  await expect(field).toHaveValue('2');
  await expect(field).toBeFocused();
  await expect(picked).toContainText('Right face');
  await expect(apply).toBeEnabled();
  expect(await couponRight(page)).toBe(92);
  expect(await featureCount(page)).toBe(features);
});
