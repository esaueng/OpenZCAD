/**
 * M07: a face set's Offset in the workspace. Two coplanar faces picked with
 * Shift take the set's Offset verb, the one shared handle and its keypad move
 * both together as one `offset-faces` step, its History row reads "Offset 2
 * faces · +2 mm", and reopening that row changes the distance again.
 *
 * The body is the parity corpus's slotted block: a 40 × 20 × 10 block with a
 * 10 wide, 5 deep slot cut across its top, imported from STEP, so its top is
 * two coplanar 15 × 20 faces and the slot's floor is parallel 5 below them.
 */
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
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
    await page.getByLabel('Project name').fill('Offset face set');
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
    await expectBodyCount(page, 1);

    const canvas = page.locator('.viewer-host canvas');
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
    await expect(page.locator('.feature-row')).toHaveCount(2);
    expect(errors).toEqual([]);
  }
);

test('refuses a face set that is not one plane, by name', async ({ page }) => {
  test.setTimeout(120_000);
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
  await page.getByLabel('Project name').fill('Offset face set refusal');
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
  await expectBodyCount(page, 1);
  const canvas = page.locator('.viewer-host canvas');
  // A top face and the slot's floor: parallel, 5 apart.
  const pick = (x: number, z: number, additive: boolean) =>
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
      { x, y: Y / 2, z, additive }
    );
  await expect
    .poll(() => pick(X / 2, Z - SLOT_DEPTH, false), { timeout: 30_000 })
    .toBe(true);
  await pick((X - SLOT_WIDTH) / 4, Z, true);
  await expect(page.getByRole('contentinfo')).toContainText('2 faces selected');
  await page
    .getByRole('button', { name: 'Selection: Offset', exact: true })
    .click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'the selected faces are parallel but at different heights'
  );
  await expect(
    page.getByRole('region', { name: 'Offset Faces operation' })
  ).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(1);
});
