/**
 * M07: a face set's Offset in the workspace. Two coplanar faces picked with
 * Shift take the set's Offset verb, the one shared handle and its keypad move
 * both together as one `offset-faces` step, its History row reads "Offset 2
 * faces · +2 mm", and reopening that row changes the distance again.
 *
 * Parallel faces at different heights (a slot's floor and the top beside
 * it) arm the same handle as a chained move: each face moves along its own
 * normal by the one distance.
 *
 * The body is the parity corpus's slotted block: a 40 × 20 × 10 block with a
 * 10 wide, 5 deep slot cut across its top, imported from STEP, so its top is
 * two coplanar 15 × 20 faces and the slot's floor is parallel 5 below them.
 */
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import type { Locator, Page } from '@playwright/test';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

const X = 40;
const Y = 20;
const Z = 10;
const SLOT_WIDTH = 10;
const SLOT_DEPTH = 5;

const translation = (x: number, y: number, z: number) =>
  Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);

async function slottedBlockStep(): Promise<string> {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  try {
    const block = kernel.makeBox(X, Y, Z);
    const slot = kernel.makeBox(SLOT_WIDTH, Y + 4, SLOT_DEPTH + 2);
    kernel.transformSolid(
      slot,
      translation((X - SLOT_WIDTH) / 2, -2, Z - SLOT_DEPTH)
    );
    return new TextDecoder().decode(
      io.exportStep(
        kernel.serializeSolids(Uint32Array.of(kernel.cut(block, slot)))
      )
    );
  } finally {
    kernel.free();
  }
}

test(
  'offsets two coplanar faces together and reopens the step from History',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const canvas = await openSlottedBlock(page, 'Offset face set');
    // The highest point of the drawn body: the top faces' height.
    const topZ = () =>
      canvas.evaluate(
        (element) =>
          new Promise<number | null>((resolve) => {
            let answered = false;
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-render-policy', {
                detail: {
                  resolve: (state: {
                    bodyFaces: { worldBounds?: { max: number[] } }[];
                  }) => {
                    answered = true;
                    const tops = state.bodyFaces.flatMap((face) =>
                      face.worldBounds ? [face.worldBounds.max[2]!] : []
                    );
                    resolve(tops.length ? Math.max(...tops) : null);
                  }
                }
              })
            );
            // Before the hook is registered nothing answers: retry.
            if (!answered) setTimeout(() => resolve(null), 50);
          })
      );
    await expect.poll(topZ, { timeout: 30_000 }).toBeCloseTo(Z, 4);

    // One top face, then the other with Shift: a two-face set.
    const pickTop = (x: number, additive: boolean) =>
      canvas.evaluate(
        (element, input) =>
          new Promise<boolean>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: {
                  normal: { x: 0, y: 0, z: 1 },
                  near: { x: input.x, y: input.y, z: input.z },
                  additive: input.additive,
                  resolve: (face: unknown) => resolve(face !== null)
                }
              })
            );
          }),
        { x, y: Y / 2, z: Z, additive }
      );
    await expect.poll(() => pickTop((X - SLOT_WIDTH) / 4, false)).toBe(true);
    await pickTop(X - (X - SLOT_WIDTH) / 4, true);
    await expect(page.getByRole('contentinfo')).toContainText(
      '2 faces selected'
    );
    // Each side of the slot on its own: the highest point alone would pass
    // with only one of the two faces moved.
    const sideZ = (x: number) =>
      canvas.evaluate(
        (element, input) =>
          new Promise<number | null>((resolve) => {
            let answered = false;
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: {
                  normal: { x: 0, y: 0, z: 1 },
                  near: { x: input.x, y: input.y, z: input.z },
                  select: false,
                  resolve: (face: { center: { z: number } } | null) => {
                    answered = true;
                    resolve(face?.center.z ?? null);
                  }
                }
              })
            );
            if (!answered) setTimeout(() => resolve(null), 50);
          }),
        // At the faces' old height: a face that stayed is the nearest.
        { x, y: Y / 2, z: Z }
      );
    const leftX = (X - SLOT_WIDTH) / 4;
    const rightX = X - leftX;
    const bothSidesAt = async (z: number) => {
      await expect
        .poll(() => sideZ(leftX), { timeout: 30_000 })
        .toBeCloseTo(z, 4);
      await expect
        .poll(() => sideZ(rightX), { timeout: 30_000 })
        .toBeCloseTo(z, 4);
    };

    await page
      .getByRole('button', { name: 'Selection: Offset', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Offset Faces operation' })
    ).toBeVisible();
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Offset value' });
    await keypad.getByRole('textbox').fill('2');
    await expect(
      keypad.getByRole('button', { name: 'Apply offset' })
    ).toBeEnabled({ timeout: 30_000 });
    await keypad.getByRole('button', { name: 'Apply offset' }).click();

    const row = page.locator('.feature-row', { hasText: 'Offset 2 faces' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('+2 mm');
    await expect.poll(topZ, { timeout: 30_000 }).toBeCloseTo(Z + 2, 4);
    await bothSidesAt(Z + 2);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');

    // Reopened from History, the step's distance is changed and rebuilt.
    await row.locator('.feature-row-main').click();
    const form = page.getByRole('form', { name: 'Offset faces' });
    await expect(form).toBeVisible();
    const field = form.getByRole('textbox');
    await expect(field).toHaveValue('2');
    await field.fill('3');
    await form.getByRole('button', { name: 'Apply offset' }).click();
    await expect(row).toContainText('+3 mm', { timeout: 30_000 });
    await expect.poll(topZ, { timeout: 30_000 }).toBeCloseTo(Z + 3, 4);
    await bothSidesAt(Z + 3);
    await expect(page.locator('.feature-row')).toHaveCount(2);
    expect(errors).toEqual([]);
  }
);

/** Opens the slotted block in a new project. */
async function openSlottedBlock(page: Page, name: string) {
  const document = importStepBody(
    createProjectDocument('Slotted block', toUserId('user_offset_faces')),
    {
      name: 'Block',
      sourceName: 'block.step',
      artifactId: 'artifact_slotted_block',
      stepText: await slottedBlockStep()
    }
  ).document;
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'slotted.openzcad',
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
  // A cold kernel builds the STEP body: allow it more than the default.
  await expectBodyCount(page, 1, 30_000);
  return page.locator('.viewer-host canvas');
}

type Vec = { x: number; y: number; z: number };
const UP: Vec = { x: 0, y: 0, z: 1 };

/**
 * Picks (or, with `select: false`, only reads) the planar face facing
 * `normal` whose centre is nearest `near`; resolves its centre, or null.
 */
function planarFace(
  canvas: Locator,
  input: { normal: Vec; near: Vec; additive?: boolean; select?: boolean }
) {
  return canvas.evaluate(
    (element, detail) =>
      new Promise<Vec | null>((resolve) => {
        let answered = false;
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: {
              ...detail,
              resolve: (face: { center: Vec } | null) => {
                answered = true;
                resolve(face?.center ?? null);
              }
            }
          })
        );
        // Before the hook is registered nothing answers: retry.
        if (!answered) setTimeout(() => resolve(null), 50);
      }),
    input
  );
}

test(
  'offsets parallel faces at different heights together, each along its own normal',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const canvas = await openSlottedBlock(page, 'Offset chained face set');
    const floorAt = { x: X / 2, y: Y / 2, z: Z - SLOT_DEPTH };
    const leftTopAt = { x: (X - SLOT_WIDTH) / 4, y: Y / 2, z: Z };
    const rightTopAt = { x: X - (X - SLOT_WIDTH) / 4, y: Y / 2, z: Z };
    // The slot's floor, then the top beside it with Shift: the handle arms
    // on the top, 5 above the floor.
    await expect
      .poll(() => planarFace(canvas, { normal: UP, near: floorAt }), {
        timeout: 30_000
      })
      .not.toBeNull();
    await planarFace(canvas, { normal: UP, near: leftTopAt, additive: true });
    await expect(page.getByRole('contentinfo')).toContainText(
      '2 faces selected'
    );
    // Read at each face's old place: a face that stayed is the nearest.
    const zNear = (at: Vec) => async () =>
      (await planarFace(canvas, { normal: UP, near: at, select: false }))?.z ??
      null;
    const expectHeights = async (offset: number) => {
      await expect
        .poll(zNear(floorAt), { timeout: 30_000 })
        .toBeCloseTo(Z - SLOT_DEPTH + offset, 4);
      await expect
        .poll(zNear(leftTopAt), { timeout: 30_000 })
        .toBeCloseTo(Z + offset, 4);
      // The other top was never picked: it stays.
      await expect
        .poll(zNear(rightTopAt), { timeout: 30_000 })
        .toBeCloseTo(Z, 4);
    };

    await page
      .getByRole('button', { name: 'Selection: Offset', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Offset Faces operation' })
    ).toBeVisible();
    // One direction tick per face of the set.
    await expect(canvas).toHaveAttribute('data-e2e-offset-set-ticks', '2');
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Offset value' });
    await keypad.getByRole('textbox').fill('2');
    await expect(
      keypad.getByRole('button', { name: 'Apply offset' })
    ).toBeEnabled({ timeout: 30_000 });
    await keypad.getByRole('button', { name: 'Apply offset' }).click();

    const row = page.locator('.feature-row', { hasText: 'Offset 2 faces' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('+2 mm');
    await expectHeights(2);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    // The commit ends with nothing armed: no ticks are left behind.
    await expect(canvas).not.toHaveAttribute('data-e2e-offset-set-ticks', /.*/);

    // Reopened from History, the chained step's distance changes and both
    // faces rebuild along their own normals.
    await row.locator('.feature-row-main').click();
    const form = page.getByRole('form', { name: 'Offset faces' });
    await expect(form).toBeVisible();
    const field = form.getByRole('textbox');
    await expect(field).toHaveValue('2');
    await field.fill('3');
    await form.getByRole('button', { name: 'Apply offset' }).click();
    await expect(row).toContainText('+3 mm', { timeout: 30_000 });
    await expectHeights(3);
    await expect(page.locator('.feature-row')).toHaveCount(2);
    expect(errors).toEqual([]);
  }
);

test('refuses a face set whose faces face different ways, by name', async ({
  page
}) => {
  test.setTimeout(120_000);
  const canvas = await openSlottedBlock(page, 'Offset face set refusal');
  // A top face and the slot's wall beside it: they face different ways.
  await expect
    .poll(
      () =>
        planarFace(canvas, {
          normal: UP,
          near: { x: (X - SLOT_WIDTH) / 4, y: Y / 2, z: Z }
        }),
      { timeout: 30_000 }
    )
    .not.toBeNull();
  await planarFace(canvas, {
    normal: { x: 1, y: 0, z: 0 },
    near: { x: (X - SLOT_WIDTH) / 2, y: Y / 2, z: Z - SLOT_DEPTH / 2 },
    additive: true
  });
  await expect(page.getByRole('contentinfo')).toContainText('2 faces selected');
  await page
    .getByRole('button', { name: 'Selection: Offset', exact: true })
    .click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'the selected faces face different directions'
  );
  await expect(
    page.getByRole('region', { name: 'Offset Faces operation' })
  ).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(1);
});

test('a drag on a chained set releases into the whole set at the dragged distance', async ({
  page
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const canvas = await openSlottedBlock(page, 'Drag chained face set');
  const floorAt = { x: X / 2, y: Y / 2, z: Z - SLOT_DEPTH };
  const leftTopAt = { x: (X - SLOT_WIDTH) / 4, y: Y / 2, z: Z };
  await expect
    .poll(() => planarFace(canvas, { normal: UP, near: floorAt }), {
      timeout: 30_000
    })
    .not.toBeNull();
  await planarFace(canvas, { normal: UP, near: leftTopAt, additive: true });
  await page
    .getByRole('button', { name: 'Selection: Offset', exact: true })
    .click();
  await expect(canvas).toHaveAttribute('data-e2e-offset-set-ticks', '2');
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  const readChip = async () =>
    Number(
      (await page.getByTestId('direct-manipulation-value').innerText()).match(
        /([+-]?[\d.]+) mm/
      )?.[1]
    );
  const resting = await readChip();
  // Several moves, faster than the whole chain rebuilds: the leading plane
  // follows each, the chain catches up at its coarse rate.
  await page.mouse.move(bounds.x + handle.x, bounds.y + handle.y);
  await page.mouse.down();
  for (const units of [0.5, 1, 1.5, 2, 2.5, 3]) {
    await page.mouse.move(
      bounds.x + handle.x + handle.dx * handle.pixelsPerUnit * units,
      bounds.y + handle.y + handle.dy * handle.pixelsPerUnit * units
    );
  }
  const dragged = (await readChip()) - resting;
  expect(dragged).toBeGreaterThan(0);
  await page.mouse.up();

  // The release replays the whole set: both faces at the dragged distance.
  const row = page.locator('.feature-row', { hasText: 'Offset 2 faces' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(`+${dragged} mm`);
  const zNear = (at: Vec) => async () =>
    (await planarFace(canvas, { normal: UP, near: at, select: false }))?.z ??
    null;
  await expect
    .poll(zNear(floorAt), { timeout: 30_000 })
    .toBeCloseTo(Z - SLOT_DEPTH + dragged, 4);
  await expect
    .poll(zNear(leftTopAt), { timeout: 30_000 })
    .toBeCloseTo(Z + dragged, 4);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(errors).toEqual([]);
});

test('names a chained set’s kernel refusal on its card', async ({ page }) => {
  test.setTimeout(120_000);
  const canvas = await openSlottedBlock(page, 'Refused chained face set');
  const floorAt = { x: X / 2, y: Y / 2, z: Z - SLOT_DEPTH };
  await expect
    .poll(() => planarFace(canvas, { normal: UP, near: floorAt }), {
      timeout: 30_000
    })
    .not.toBeNull();
  await planarFace(canvas, {
    normal: UP,
    near: { x: (X - SLOT_WIDTH) / 4, y: Y / 2, z: Z },
    additive: true
  });
  await page
    .getByRole('button', { name: 'Selection: Offset', exact: true })
    .click();
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Offset value' });
  // Pulled in 6, the floor (the chain's first move) would pass through the
  // block's bottom 5 below it.
  await keypad.getByRole('textbox').fill('-6');
  // The whole chain's preview names the kernel's refusal, as a single
  // face's does; the lead plane's display-only lane never speaks for it.
  await expect(keypad.getByRole('alert')).toHaveText(
    'The face would run into another part of the body before it got that far.',
    { timeout: 30_000 }
  );
  await expect(
    keypad.getByRole('button', { name: 'Apply offset' })
  ).toBeDisabled();
  await expect(page.locator('.feature-row')).toHaveCount(1);
});
