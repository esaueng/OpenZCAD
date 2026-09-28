import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { expect, test, stubApi } from './openzcad-fixtures';

/**
 * ROADMAP U01, coherence plan phase 2 gate: one value, one commit gesture.
 *
 * Three commands with three different histories — an offset that appends a
 * feature, a cylinder resize that edits its primitive in place, and a fillet
 * that is created and then re-edited — go through the same script, and the
 * script asserts the same things of each:
 *
 * - the chip is the value: what it shows before a commit is what the geometry
 *   measures afterwards;
 * - `Enter` in the keypad commits, and the committed geometry equals the
 *   typed value;
 * - `Escape` in the keypad cancels, leaves the committed geometry alone and
 *   adds nothing to history: one Undo afterwards lands on the baseline, not on
 *   the cancelled value, and Redo returns to the commit.
 *
 * The existing per-command specs commit through the Apply button; this one
 * is the keyboard contract they share.
 *
 * The Escape contract outside a sketch is proved at the end of the file: one
 * press from any direct edit or command returns to nothing selected — card,
 * preview, handle and selection together, a refused value included — and
 * open exact entry is the only rung it keeps (the next press clears).
 */

interface Command {
  /** Arms the command from nothing and again after a commit. */
  arm(): Promise<void>;
  /** Arms the command for the re-edit after the first commit. */
  rearm?(): Promise<void>;
  /** Accessible name of the keypad dialog the chip opens. */
  dialog: string;
  /** Chip text: before anything, after the commit. */
  chipBefore: string;
  chipAfter: string;
  /** Typed values: the one to commit, the one to cancel. */
  commitValue: string;
  cancelValue: string;
  /** What the geometry measures: before, and after the commit. */
  baseline: number;
  committed: number;
  read(): Promise<number | null>;
}

const READ_TIMEOUT = { timeout: 30_000 };

async function proveContract(page: Page, canvas: Locator, command: Command) {
  const chip = page.getByTestId('direct-manipulation-value');
  const rearm = command.rearm ?? command.arm;

  await command.arm();
  await expect(chip).toHaveText(command.chipBefore);
  await expect
    .poll(command.read, READ_TIMEOUT)
    .toBeCloseTo(command.baseline, 5);

  // Enter commits the typed value; the geometry then measures that value.
  await chip.click();
  const keypad = page.getByRole('dialog', { name: command.dialog });
  await expect(keypad).toBeVisible();
  await keypad.getByRole('textbox').fill(command.commitValue);
  await keypad.getByRole('textbox').press('Enter');
  await expect(keypad).toBeHidden();
  await expect
    .poll(command.read, READ_TIMEOUT)
    .toBeCloseTo(command.committed, 5);
  await rearm();
  await expect(chip).toHaveText(command.chipAfter);

  // Escape cancels the typed value; the committed geometry is untouched.
  await chip.click();
  await expect(keypad).toBeVisible();
  await keypad.getByRole('textbox').fill(command.cancelValue);
  await keypad.getByRole('textbox').press('Escape');
  await expect(keypad).toBeHidden();
  await expect
    .poll(command.read, READ_TIMEOUT)
    .toBeCloseTo(command.committed, 5);
  await rearm();
  await expect(chip).toHaveText(command.chipAfter);
  // One Escape from the armed command is nothing selected: no card, no chip.
  await page.keyboard.press('Escape');
  await expect(page.locator('.tool-card')).toHaveCount(0);
  await expect(chip).toBeHidden();

  // The cancel left no history entry: one Undo is the baseline again.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(command.read, READ_TIMEOUT)
    .toBeCloseTo(command.baseline, 5);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect
    .poll(command.read, READ_TIMEOUT)
    .toBeCloseTo(command.committed, 5);
  await expect(canvas).toBeVisible();
}

async function createCylinder(page: Page, project: string) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill(project);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Rebuilding geometry/i,
    { timeout: 30_000 }
  );
  return { canvas, inspector, consoleErrors };
}

function cylinderHooks(canvas: Locator) {
  const select = (surface: 'wall' | 'top-cap') =>
    canvas.evaluate((element, requested) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: { surface: requested }
        })
      );
    }, surface);
  const wall = () =>
    canvas.evaluate(
      (element) =>
        new Promise<{
          diameter?: number;
          axisStart?: { x: number; y: number; z: number };
          axisEnd?: { x: number; y: number; z: number };
        } | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: { surface: 'wall', select: false, resolve }
            })
          );
        })
    );
  const axisLength = async () => {
    const geometry = await wall();
    if (!geometry?.axisStart || !geometry.axisEnd) return null;
    return Math.hypot(
      geometry.axisEnd.x - geometry.axisStart.x,
      geometry.axisEnd.y - geometry.axisStart.y,
      geometry.axisEnd.z - geometry.axisStart.z
    );
  };
  return { select, wall, axisLength };
}

test('cap height under chamfers: Enter commits the chip value, Escape leaves history alone', async ({
  page
}) => {
  test.setTimeout(180_000);
  const { canvas, inspector, consoleErrors } = await createCylinder(
    page,
    'Contract offset'
  );
  // Chamfers put the cap edit on the exact-preview path: every value must
  // survive a real rebuild rather than a proxy scale.
  await page.getByRole('button', { name: /^Chamfer/ }).click();
  await inspector.getByRole('button', { name: 'Select all 2 edges' }).click();
  await inspector.getByLabel('Distance', { exact: true }).fill('1');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  const { select, axisLength } = cylinderHooks(canvas);
  const arm = async () => {
    await expect
      .poll(async () => {
        await select('top-cap');
        return canvas.getAttribute('data-e2e-handle-x');
      }, READ_TIMEOUT)
      .not.toBeNull();
  };
  await proveContract(page, canvas, {
    arm,
    dialog: 'Total value',
    // The "Total" word lives on the tag pill beside the value now.
    chipBefore: '28 mm',
    chipAfter: '34 mm',
    commitValue: '34',
    cancelValue: '40',
    baseline: 28,
    committed: 34,
    // The wall's axis is the height less the two 1 mm chamfers.
    read: async () => {
      const axis = await axisLength();
      return axis === null ? null : axis + 2;
    }
  });
  // The cap's total height routes to the cylinder primitive even under its
  // chamfers (Resize Body), so the commit edits in place: still two features.
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('resize cylinder: Enter commits the chip value, Escape leaves history alone', async ({
  page
}) => {
  test.setTimeout(180_000);
  const { canvas, consoleErrors } = await createCylinder(
    page,
    'Contract diameter'
  );
  const { select, wall } = cylinderHooks(canvas);
  const arm = async () => {
    await expect
      .poll(async () => {
        await select('wall');
        return canvas.getAttribute('data-e2e-handle-x');
      }, READ_TIMEOUT)
      .not.toBeNull();
  };
  await proveContract(page, canvas, {
    arm,
    dialog: 'Diameter value',
    chipBefore: 'Ø 28 mm',
    chipAfter: 'Ø 20 mm',
    commitValue: '20',
    cancelValue: '36',
    baseline: 28,
    committed: 20,
    read: async () => (await wall())?.diameter ?? null
  });
  // A primitive resize edits the cylinder in place: still one feature.
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('fillet: Enter commits the chip value, Escape leaves history alone', async ({
  page
}) => {
  test.setTimeout(180_000);
  const { canvas, consoleErrors } = await createCylinder(
    page,
    'Contract fillet'
  );
  const selectCircularEdge = () =>
    canvas.evaluate(
      (element) =>
        new Promise<boolean>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-edge', {
              detail: {
                curve: 'circle',
                resolve: (selection: unknown) => resolve(selection !== null)
              }
            })
          );
        })
    );
  const readBlend = (select: boolean) =>
    canvas.evaluate(
      (element, shouldSelect) =>
        new Promise<{ blendRadius: number } | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-blend', {
              detail: {
                select: shouldSelect,
                inspectOnly: !shouldSelect,
                resolve
              }
            })
          );
        }),
      select
    );
  await proveContract(page, canvas, {
    arm: async () => {
      await expect.poll(selectCircularEdge, READ_TIMEOUT).toBe(true);
      await expect(
        page.getByRole('region', { name: 'Fillet operation' })
      ).toBeVisible();
    },
    // After the commit the edge is a blend: re-editing selects the blend.
    rearm: async () => {
      await expect
        .poll(
          async () => (await readBlend(true))?.blendRadius ?? null,
          READ_TIMEOUT
        )
        .not.toBeNull();
      await expect(
        page.getByRole('region', { name: 'Edit Fillet operation' })
      ).toBeVisible();
    },
    dialog: 'Radius value',
    chipBefore: 'R 0 mm',
    // Re-editing an existing feature names the command on the chip itself.
    chipAfter: 'Edit Fillet · R 2 mm',
    commitValue: '2',
    cancelValue: '4',
    baseline: 0,
    committed: 2,
    read: async () => (await readBlend(false))?.blendRadius ?? 0
  });
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('resize hole: Enter commits the chip value, Escape leaves history alone', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Contract hole');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  // One 5 mm hole through the top face: the bore is the body's only
  // cylindrical face, so the cylinder hook's wall read measures it.
  await page.getByRole('button', { name: /^Hole/ }).click();
  const entry = page.getByRole('group', { name: 'Entry face' });
  await page.getByRole('textbox', { name: 'Diameter', exact: true }).fill('5');
  await entry.getByRole('button', { name: 'Pick faces in viewport' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const topFace = () =>
    canvas.evaluate(
      (element) =>
        new Promise<{ lineageName?: string } | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-planar-face', {
              detail: { normal: { x: 0, y: 0, z: 1 }, select: true, resolve }
            })
          );
        })
    );
  await expect
    .poll(topFace, READ_TIMEOUT)
    .toMatchObject({ lineageName: 'primitive.box.face.z-max' });
  await page.getByRole('button', { name: 'Check exact result' }).click();
  await page.getByRole('button', { name: 'Create hole' }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Hole' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  const { select, wall } = cylinderHooks(canvas);
  await proveContract(page, canvas, {
    arm: async () => {
      await expect
        .poll(async () => {
          await select('wall');
          return canvas.getAttribute('data-e2e-handle-x');
        }, READ_TIMEOUT)
        .not.toBeNull();
      await expect(
        page.getByRole('region', { name: 'Resize Hole operation' })
      ).toBeVisible();
    },
    dialog: 'Diameter value',
    chipBefore: 'Ø 5 mm',
    chipAfter: 'Ø 8 mm',
    commitValue: '8',
    cancelValue: '3',
    baseline: 5,
    committed: 8,
    read: async () => (await wall())?.diameter ?? null
  });
  expect(consoleErrors).toEqual([]);
});

/** Nothing is selected and nothing of a direct edit is left on screen. */
async function expectNothingSelected(page: Page, canvas: Locator) {
  await expect(page.locator('.tool-card')).toHaveCount(0);
  await expect(page.getByTestId('direct-manipulation-value')).toBeHidden();
  await expect(page.locator('.selection-callout-chip')).toHaveCount(0);
  await expect(page.locator('.profile-quick-action')).toHaveCount(0);
  await expect(canvas).not.toHaveAttribute('data-e2e-handle-x');
  await expect(canvas).not.toHaveAttribute('data-e2e-offset-change-visible');
  await expect(canvas).not.toHaveAttribute('data-e2e-selected-face');
}

test('one Escape clears a refused offset: card, preview, handle and selection', async ({
  page
}) => {
  test.setTimeout(180_000);
  const { canvas, inspector, consoleErrors } = await createCylinder(
    page,
    'Contract refused offset'
  );
  // Chamfers keep the cap on the exact-preview path, so a refusal comes from
  // the kernel rather than from a viewport proxy.
  await page.getByRole('button', { name: /^Chamfer/ }).click();
  await inspector.getByRole('button', { name: 'Select all 2 edges' }).click();
  await inspector.getByLabel('Distance', { exact: true }).fill('1');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  const { select, axisLength } = cylinderHooks(canvas);
  const height = async () => {
    const axis = await axisLength();
    return axis === null ? null : axis + 2;
  };
  await expect
    .poll(async () => {
      await select('top-cap');
      return canvas.getAttribute('data-e2e-handle-x');
    }, READ_TIMEOUT)
    .not.toBeNull();
  const chip = page.getByTestId('direct-manipulation-value');
  await expect(chip).toHaveText('28 mm');
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  const start = { x: bounds.x + handle.x, y: bounds.y + handle.y };
  const at = (units: number) => ({
    x: start.x + handle.dx * handle.pixelsPerUnit * units,
    y: start.y + handle.dy * handle.pixelsPerUnit * units
  });

  // A value that builds, then one past the body's own height, released there.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(at(5).x, at(5).y, { steps: 2 });
  await expect.poll(height, READ_TIMEOUT).toBeGreaterThan(28.5);
  await page.mouse.move(at(-40).x, at(-40).y, { steps: 1 });
  await expect(chip).toHaveAttribute('data-state', 'warning', READ_TIMEOUT);
  await page.mouse.up();
  await expect(page.locator('.tool-card')).toContainText('Failed');

  // One press: the card, its refusal, the kept preview, the handle and its
  // change band and the selection all go. Nothing re-arms at the refused
  // value, and the model reads its committed height again.
  await page.keyboard.press('Escape');
  await expectNothingSelected(page, canvas);
  await expect.poll(height, READ_TIMEOUT).toBeCloseTo(28, 4);
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();

  // Picking the cap again starts from the committed value, not the refusal.
  await expect
    .poll(async () => {
      await select('top-cap');
      return canvas.getAttribute('data-e2e-handle-x');
    }, READ_TIMEOUT)
    .not.toBeNull();
  await expect(chip).toHaveText('28 mm');
  await expect(chip).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.tool-card')).not.toContainText('Failed');
  expect(consoleErrors).toEqual([]);
});

test('one Escape leaves a region extrude for nothing selected, not a profile prompt', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  let document = createProjectDocument(
    'Contract region escape',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 40, depth: 8 }
  });
  document = addSketchFeature(document, {
    name: 'Boss outline',
    plane: 'XY',
    offset: 8,
    objects: [{ objectKind: 'circle', radius: 5, centerX: 20, centerY: 20 }]
  }).document;
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            project: {
              projectId: document.projectId,
              name: document.name,
              revisionCount: 1,
              updatedAt: new Date().toISOString()
            },
            document
          }
        })
      : route.fulfill({ json: { projects: [] } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });

  await page.locator('.feature-row-main', { hasText: 'Boss outline' }).click();
  await page.keyboard.press('e');
  const card = page.getByRole('region', { name: 'Extrude operation' });
  await expect(card).toBeVisible();
  // Escape from wherever focus landed: a field the card autofocused hands
  // the key to the form's own cancel, anything else to the workspace. Both
  // must land on the same clean state.
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expectNothingSelected(page, canvas);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Extrude' })
  ).toHaveCount(0);

  // The card's own close button releases the profiles the same way.
  await page.locator('.feature-row-main', { hasText: 'Boss outline' }).click();
  await page.keyboard.press('e');
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss Extrude' }).click();
  await expect(card).toHaveCount(0);
  await expectNothingSelected(page, canvas);
});

test('exact entry keeps one rung: Escape closes the keypad, the next clears', async ({
  page
}) => {
  test.setTimeout(180_000);
  const { canvas, consoleErrors } = await createCylinder(
    page,
    'Contract keypad escape'
  );
  const { select, wall } = cylinderHooks(canvas);
  await expect
    .poll(async () => {
      await select('wall');
      return canvas.getAttribute('data-e2e-handle-x');
    }, READ_TIMEOUT)
    .not.toBeNull();
  const chip = page.getByTestId('direct-manipulation-value');
  await expect(chip).toHaveText('Ø 28 mm');
  await chip.click();
  const keypad = page.getByRole('dialog', { name: 'Diameter value' });
  await expect(keypad).toBeVisible();
  await keypad.getByRole('textbox').fill('36');

  // First press: the keypad closes and the typed value is dropped, but the
  // command stays armed with its card.
  await keypad.getByRole('textbox').press('Escape');
  await expect(keypad).toBeHidden();
  await expect(page.locator('.tool-card')).toBeVisible();
  await expect(chip).toBeVisible();

  // Second press: nothing selected.
  await page.keyboard.press('Escape');
  await expectNothingSelected(page, canvas);
  await expect
    .poll(async () => (await wall())?.diameter ?? null, READ_TIMEOUT)
    .toBeCloseTo(28, 5);
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
