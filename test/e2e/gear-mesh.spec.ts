import type { Page } from '@playwright/test';
import {
  addAssemblyComponents,
  addPrimitiveFeature,
  createProjectDocument,
  gearBody,
  type GearInput
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';

/**
 * M14 meshing-pair helper in a real browser: two gear parts in Assemble,
 * Place gears opens its card with the working centre distance, Place fixes the
 * base and saves one rigid joint, and one undo takes the joint back. With a
 * plate to mount them on, the pair can instead turn together (AS02 gear
 * coupling): a joint per gear and a coupling, so turning one turns the other.
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

/** The pair with a plate to mount them on, all three parts floating. */
function gearPairOnPlate(): ProjectDocument {
  let document = createProjectDocument('Gear train', toUserId('user_e2e'));
  document = gearBody(document, gear('Pinion', { backlash: 0.1 })).document;
  document = gearBody(
    document,
    gear('Wheel', { teeth: 40, backlash: 0.1 })
  ).document;
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    bodyName: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 160, height: 100, depth: 2 }
  });
  const [a, b, c] = document.bodyOrder as [BodyId, BodyId, BodyId];
  return addAssemblyComponents(document, {
    components: [
      { componentId: 'comp_a', name: 'Pinion', bodyId: a, grounded: false },
      { componentId: 'comp_b', name: 'Wheel', bodyId: b, grounded: false },
      { componentId: 'comp_plate', name: 'Plate', bodyId: c, grounded: false }
    ]
  });
}

/** Imports the pair as a backup and waits for every body to build. */
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
    String(document.bodyOrder.length),
    { timeout: 30_000 }
  );
  await expectBodyCount(page, document.bodyOrder.length);
}

const panel = (page: Page) =>
  page.getByRole('complementary', { name: 'Assembly' });

test(
  'shows the Assemble sidebar loading while its chunk downloads after Build (M14)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    // Hold the sidebar's chunk until Build is visible and Assemble opened.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let requested = 0;
    await page.route(
      /\/assets\/AssemblyPanel-[^/]+\.js(?:\?|$)/,
      async (route) => {
        requested += 1;
        await gate;
        await route.continue();
      }
    );
    await openDocument(page, gearPair());
    expect(requested).toBe(0);
    const assemble = page.getByRole('button', {
      name: 'Assemble',
      exact: true
    });
    // Pointing at the switch starts the download before the click.
    await assemble.hover();
    await expect.poll(() => requested).toBe(1);
    await assemble.click();
    const loading = panel(page).getByRole('status');
    await expect(loading).toHaveText('Loading parts and joints…');
    await expect(panel(page)).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(
      panel(page).getByRole('region', { name: 'Parts' })
    ).toBeVisible();
    await expect(
      loading.filter({ hasText: 'Loading parts and joints…' })
    ).toHaveCount(0);
    expect(requested).toBe(1);
  }
);

test(
  'meshes two gears at their centre distance with one joint (M14)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    const assemblyLoads: string[] = [];
    page.on('request', (request) => {
      if (/\/assets\/AssemblyPanel-[^/]+\.js(?:\?|$)/.test(request.url()))
        assemblyLoads.push(request.url());
    });
    await openDocument(page, gearPair());
    expect(assemblyLoads).toHaveLength(0);
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    await expect(panel(page)).toBeVisible();
    expect(assemblyLoads).toHaveLength(1);
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
    await page.getByRole('button', { name: 'Build', exact: true }).click();
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    await expect(panel(page)).toBeVisible();
    expect(assemblyLoads).toHaveLength(1);
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

test(
  'meshed gears on a plate turn together: one drives, its mate follows (AS02)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    await openDocument(page, gearPairOnPlate());
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    await panel(page)
      .getByRole('region', { name: 'Joints' })
      .getByRole('button', { name: 'Place gears', exact: true })
      .click();
    const card = panel(page).getByRole('region', { name: 'Place gears' });
    // With a plate to mount them on, the card starts on Turn together;
    // Fixed together stays one choice away.
    const motion = card.getByRole('combobox', { name: 'How the pair moves' });
    await expect(motion).toHaveValue('coupled');
    await motion.selectOption('fixed');
    await expect(card).toContainText('pair stays fixed together');
    await motion.selectOption('coupled');
    await expect(
      card.getByRole('combobox', { name: 'Part the gears are mounted on' })
    ).toHaveValue('comp_plate');
    await expect(card).toContainText('which Place fixes in place');
    await expect(card.getByRole('definition').nth(0)).toHaveText('60 mm');
    await card.getByRole('button', { name: 'Place', exact: true }).click();
    await expect(card).toHaveCount(0);

    // A joint per gear, the plate fixed, the driving joint open with its
    // coupling named.
    const joints = panel(page).getByRole('region', { name: 'Joints' });
    await expect(joints).toContainText('Pinion turn');
    await expect(joints).toContainText('Wheel turn');
    await expect(
      panel(page).getByRole('button', { name: 'Plate is fixed' })
    ).toBeVisible();
    const pinionTurn = panel(page).getByLabel('Pinion turn details');
    await expect(pinionTurn).toContainText(
      'Gear ratio: moves with Wheel turn · 0.5 turns per turn, the other way'
    );

    // Turning the pinion 40° turns the wheel 20° the other way.
    const angle = panel(page).getByRole('textbox', {
      name: 'Angle',
      exact: true
    });
    await angle.fill('40');
    await angle.press('Enter');
    await expect(angle).toHaveValue('40');
    await joints.getByRole('button', { name: /^Wheel turn\b/ }).click();
    await expect(angle).toHaveValue('-20');
    // …and the wheel drives the pinion back the same way.
    await angle.fill('10');
    await angle.press('Enter');
    await joints.getByRole('button', { name: /^Pinion turn\b/ }).click();
    await expect(angle).toHaveValue('-20');

    // The saved project reopens with the coupling still holding.
    await page.reload();
    await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
      'data-e2e-rendered-bodies',
      '3',
      { timeout: 30_000 }
    );
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    await joints.getByRole('button', { name: /^Wheel turn\b/ }).click();
    await expect(angle).toHaveValue('10');
    await expect(panel(page).getByLabel('Wheel turn details')).toContainText(
      'Gear ratio: moves with Pinion turn'
    );
  }
);
