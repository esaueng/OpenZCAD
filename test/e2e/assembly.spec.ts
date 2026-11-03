import type { Page } from '@playwright/test';
import {
  addAssemblyComponents,
  addAssemblyJoint,
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type AssemblyFrame,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createProject,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * AS01/AS02/AS06 in a real browser: bodies become components from the
 * first-run card, a revolute joint takes a typed value as one undo step and
 * actually turns its part on screen, and Play animates it without saving.
 */
const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

function blades(name: string, joined: boolean, screw = false): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  for (const bodyName of ['Blade A', 'Blade B']) {
    document = addPrimitiveFeature(document, {
      name: bodyName,
      bodyName,
      primitiveKind: 'box',
      dimensions: { width: 60, height: 4, depth: 12 }
    });
  }
  if (screw)
    document = addPrimitiveFeature(document, {
      name: 'Pivot screw',
      bodyName: 'Pivot screw',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 10 }
    });
  if (!joined) return document;
  const [a, b] = document.bodyOrder as [BodyId, BodyId];
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'comp_a', name: 'Blade A', bodyId: a, grounded: true },
      { componentId: 'comp_b', name: 'Blade B', bodyId: b, grounded: false }
    ]
  });
  return addAssemblyJoint(document, {
    joint: {
      id: 'joint_pivot',
      name: 'Pivot',
      kind: 'revolute',
      parent: { componentId: 'comp_a', frame: PIVOT },
      child: { componentId: 'comp_b', frame: PIVOT },
      values: [0],
      limits: [{ min: 0, max: 35 }]
    }
  });
}

async function openDocument(page: Page, document: ProjectDocument) {
  await stubApi(page);
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
  await createProject(page, document.name);
  await expectBodyCount(page, document.bodyOrder.length);
}

const assemble = (page: Page) =>
  page.getByRole('button', { name: 'Assemble', exact: true }).click();

const panel = (page: Page) =>
  page.getByRole('complementary', { name: 'Assembly' });

test(
  'turns bodies into parts from the first run in the sidebar (AS01)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await openDocument(page, blades('Assembly first run', false));
    await assemble(page);
    await panel(page).getByRole('button', { name: 'Add 2 parts' }).click();
    const parts = panel(page).getByRole('region', { name: 'Parts' });
    await expect(parts).toContainText('Blade A');
    await expect(parts).toContainText('Blade B');
    await expect(
      parts.getByRole('button', { name: 'Blade A is fixed' })
    ).toBeVisible();
  }
);

test(
  'adds a body that is not in the assembly yet (regression)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await openDocument(page, blades('Assembly add body', true, true));
    await assemble(page);
    const parts = panel(page).getByRole('region', { name: 'Parts' });
    await expect(
      parts.getByRole('group', { name: 'Not in the assembly' })
    ).toContainText('Pivot screw');
    await parts.getByRole('button', { name: 'Add Pivot screw' }).click();
    await expect(
      parts.getByRole('group', { name: 'Not in the assembly' })
    ).toHaveCount(0);
    await expect(parts).toContainText('Pivot screw');
    await expect(parts).toContainText('Not joined');
    // One undo takes the added part back out.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(
      parts.getByRole('group', { name: 'Not in the assembly' })
    ).toContainText('Pivot screw');
  }
);

test(
  'sets, undoes and animates a revolute joint that really turns its part (AS02/AS06)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await openDocument(page, blades('Assembly joint', true));
    await assemble(page);
    const joints = panel(page).getByRole('region', { name: 'Joints' });
    await expect(joints).toContainText('Pivot');
    await expect(joints).toContainText('0.0°');
    await joints.getByText('Pivot', { exact: true }).click();

    const canvas = page.locator('canvas').first();
    const before = await canvas.screenshot();

    const angle = page.getByRole('textbox', { name: 'Angle', exact: true });
    await angle.fill('30');
    await angle.press('Enter');
    await expect(joints).toContainText('30.0°');
    await expect
      .poll(async () => Buffer.compare(await canvas.screenshot(), before) !== 0)
      .toBe(true);

    // Past the limit clamps; then one undo returns the typed value.
    await angle.fill('90');
    await angle.press('Enter');
    await expect(joints).toContainText('35.0°');
    // Undo is the app's, not the text field's: leave the field first.
    await angle.blur();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(joints).toContainText('30.0°');

    // Play animates the joint without writing the document.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const shown = new Set<string>();
    await expect
      .poll(async () => {
        shown.add((await joints.textContent()) ?? '');
        return shown.size;
      })
      .toBeGreaterThan(2);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(joints).toContainText('30.0°');
  }
);

test('drags a part about its joint and soft-stops at the limit (AS02)', async ({
  page
}) => {
  test.setTimeout(120_000);
  // The camera fit, and so where Blade B lands on screen, follows the size.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDocument(page, blades('Assembly drag', true));
  await assemble(page);
  const joints = panel(page).getByRole('region', { name: 'Joints' });
  await joints.getByText('Pivot', { exact: true }).click();
  const angle = page.getByRole('textbox', { name: 'Angle', exact: true });
  await angle.fill('25');
  await angle.press('Enter');
  await angle.blur();
  await expect(joints).toContainText('25.0°');

  // Grab Blade B's free end and swing it past the 35° limit.
  await page.mouse.move(930, 445);
  await page.mouse.down();
  await page.mouse.move(925, 420, { steps: 5 });
  await page.mouse.move(900, 330, { steps: 10 });
  await expect(page.getByText('35.0° · max')).toBeVisible();
  await page.mouse.up();
  await expect(joints).toContainText('35.0°');

  // The whole drag was one undo step.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(joints).toContainText('25.0°');
});
