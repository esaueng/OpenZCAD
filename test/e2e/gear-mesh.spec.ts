import type { Page } from '@playwright/test';
import {
  addAssemblyComponents,
  createProjectDocument,
  gearBody,
  type GearInput
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';

/**
 * M14 meshing-pair helper in a real browser: two gear parts in Assemble,
 * Place gears opens its card with the working centre distance, Place fixes the
 * base and saves one rigid joint, and one undo takes the joint back.
 */
function gear(name: string, overrides: Partial<GearInput> = {}): GearInput {
  return {
    name,
    gearType: 'external',
    sizing: 'module',
    pitch: 2,
    teeth: 20,
    faceWidth: 5,
    origin: { x: 0, y: 0, z: 0 },
    axis: { x: 0, y: 0, z: 1 },
    ...overrides
  };
}

function gearPair(): ProjectDocument {
  let document = createProjectDocument('Gear pair', toUserId('user_e2e'));
  document = gearBody(document, gear('Pinion', { backlash: 0.1 })).document;
  document = gearBody(
    document,
    gear('Wheel', { teeth: 40, backlash: 0.1 })
  ).document;
  const [a, b] = document.bodyOrder as [BodyId, BodyId];
  return addAssemblyComponents(document, {
    components: [
      { componentId: 'comp_a', name: 'Pinion', bodyId: a, grounded: false },
      { componentId: 'comp_b', name: 'Wheel', bodyId: b, grounded: false }
    ]
  });
}

/** Imports the pair as a backup and waits for both gears to build. */
async function openDocument(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Import project' }).click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'gears.openzcad',
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
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '2',
    { timeout: 30_000 }
  );
  await expectBodyCount(page, document.bodyOrder.length);
}

const panel = (page: Page) =>
  page.getByRole('complementary', { name: 'Assembly' });

test(
  'meshes two gears at their centre distance with one joint (M14)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    await openDocument(page, gearPair());
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    await panel(page)
      .getByRole('region', { name: 'Joints' })
      .getByRole('button', { name: 'Place gears', exact: true })
      .click();
    const card = panel(page).getByRole('region', { name: 'Place gears' });
    await expect(
      card.getByRole('combobox', { name: 'Gear that stays put' })
    ).toHaveValue('comp_a');
    const readout = card.getByRole('definition');
    await expect(readout.nth(0)).toHaveText('60 mm');
    await expect(readout.nth(3)).toHaveText('0.2 mm');
    await card.getByRole('button', { name: 'Place', exact: true }).click();
    await expect(card).toHaveCount(0);
    const joints = panel(page).getByRole('region', { name: 'Joints' });
    await expect(joints).toContainText('Gear placement');
    await expect(joints.getByRole('group', { name: 'Animate' })).toHaveCount(0);
    await expect(joints.getByRole('slider')).toHaveCount(0);
    await expect(
      panel(page).getByRole('button', { name: 'Pinion is fixed' })
    ).toBeVisible();
    // One undo takes the joint back out; the base stays fixed.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(joints).not.toContainText('Gear placement');
  }
);

test(
  'places the two selected gears in selection order',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await openDocument(page, gearPair());
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    const parts = panel(page).getByRole('region', {
      name: 'Parts',
      exact: true
    });
    await parts.getByRole('button', { name: /^Wheel\b/ }).click();
    await parts
      .getByRole('button', { name: /^Pinion\b/ })
      .click({ modifiers: ['ControlOrMeta'] });
    await expect(
      parts.getByRole('button', { name: /^Wheel\b/ })
    ).toHaveAttribute('aria-pressed', 'true');
    await panel(page)
      .getByRole('button', { name: 'Place selected gears' })
      .click();
    const card = panel(page).getByRole('region', { name: 'Place gears' });
    await expect(
      card.getByRole('combobox', { name: 'Gear that stays put' })
    ).toHaveValue('comp_b');
    await expect(
      card.getByRole('combobox', { name: 'Gear that meshes with it' })
    ).toHaveValue('comp_a');
    await expect(card).toContainText('pair stays fixed together');
    await card.getByRole('button', { name: 'Place', exact: true }).click();
    const joints = panel(page).getByRole('region', { name: 'Joints' });
    await expect(joints).toContainText('Gear placement');
    await expect(joints.getByRole('group', { name: 'Animate' })).toHaveCount(0);
    await expect(
      panel(page).getByRole('button', { name: 'Wheel is fixed' })
    ).toBeVisible();
  }
);
