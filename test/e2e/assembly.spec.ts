import type { Page } from '@playwright/test';
import {
  addAssemblyComponents,
  addAssemblyJoint,
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  DEFAULT_APP_SETTINGS,
  toUserId,
  type AssemblyFrame,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import { APP_SETTINGS_STORAGE_KEY } from '../../apps/web/src/lib/appSettings';
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

// Before an assembly exists Assemble's own viewport does not hold the
// pointer, and a click on a body fell through to Build's pick: a face was
// selected and its edit armed under the hood, so the handle stood ready the
// moment the workspace changed. A click there picks the whole part.
test(
  'a click on a part before an assembly exists picks the part, not a face to edit',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let document = createProjectDocument('Part pick', toUserId('user_e2e'));
    document = addPrimitiveFeature(document, {
      name: 'Block',
      bodyName: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 20 }
    });
    await openDocument(page, document);
    const canvas = page.locator('.viewer-host canvas');
    const picked = (name: string) =>
      canvas.evaluate(
        (element, key) => (element as HTMLElement).dataset[key] ?? null,
        name
      );
    const clickPart = async () => {
      const box = (await canvas.boundingBox())!;
      const [at] = await canvas.evaluate(
        (element) =>
          new Promise<{ x: number; y: number }[]>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-project-points', {
                detail: {
                  points: [[20, 15, 20]],
                  resolve: (state: { points: { x: number; y: number }[] }) =>
                    resolve(state.points)
                }
              })
            );
          })
      );
      expect(at!.x).toBeGreaterThan(box.x);
      await page.mouse.click(at!.x, at!.y);
    };

    // Build, for contrast: the same click picks a face.
    await clickPart();
    await expect.poll(() => picked('e2eSelectedFace')).not.toBeNull();
    await page.keyboard.press('Escape');
    await expect.poll(() => picked('e2eSelectedFace')).toBeNull();

    await assemble(page);
    await expect(page.getByText('Start an assembly')).toBeVisible({
      timeout: 30_000
    });
    await clickPart();
    await expect.poll(() => picked('e2eSelectedBodies')).not.toBeNull();
    expect(await picked('e2eSelectedFace')).toBeNull();
    await expect(page.locator('.selection-callout')).not.toContainText(
      /face|edge/i
    );
    // Nothing was armed behind the workspace: Build opens on the part with
    // no face's handle or value chip waiting.
    await page.getByRole('button', { name: 'Build', exact: true }).click();
    await expect(
      page.getByRole('button', { name: /^Box \(B\)/ })
    ).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(await picked('e2eSelectedFace')).toBeNull();
    expect(await picked('e2eHandleX')).toBeNull();
    await expect(page.locator('.selection-readout')).not.toContainText(
      /face|edge/i
    );
  }
);

test(
  'groups rigid copies and retains a missing assembly part in the BOM and CSV',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    let document = blades('Missing assembly part', true);
    const missingId = document.bodyOrder[1]!;
    document.bodyOrder = document.bodyOrder.filter((id) => id !== missingId);
    document.assembly!.joints = [];
    const copied = transformBody(document, {
      name: 'Copy blade',
      targetBodyId: document.bodyOrder[0]!,
      translation: { x: 80, y: 0, z: 0 },
      copy: true
    });
    document = addAssemblyComponents(copied.document, {
      components: [
        {
          componentId: 'comp_copy',
          name: 'Blade copy',
          bodyId: copied.bodyId,
          grounded: false
        }
      ]
    });
    await openDocument(page, document);
    await assemble(page);
    const bom = panel(page).getByRole('region', { name: 'Bill of materials' });
    await expect(bom.getByRole('listitem')).toHaveText([
      'Blade A×2',
      'Blade BMissing×1'
    ]);
    const pending = page.waitForEvent('download');
    await bom
      .getByRole('button', { name: 'Download bill of materials as CSV' })
      .click();
    const download = await pending;
    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream())
      chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString('utf8')).toContain(
      `2,1,Blade B,Blade B,${missingId},missing`
    );
  }
);

for (const width of [1440, 390]) {
  test(
    `scissors opens with back-and-forth pivot motion at ${width}px`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 900 });
      await stubApi(page);
      await page.route('**/api/session', (route) =>
        route.fulfill({ status: 401, json: { error: 'Not signed in' } })
      );
      await page.goto('/');
      const sample = page.getByRole('button', { name: /^Open demo: Scissors/ });
      const angle = panel(page).getByRole('textbox', {
        name: 'Angle',
        exact: true
      });
      const backToProjects = () =>
        page
          .getByRole('banner')
          .getByRole('button', { name: /^OpenZCAD/ })
          .click();
      const ready = async (value: string) => {
        // Cold tool/worker loading has its own startup allowance; the mode
        // and visible controls below still use the normal UI assertions.
        await expect(
          page.getByRole('group', { name: 'Workspace mode' })
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByRole('button', { name: 'Assemble', exact: true })
        ).toHaveAttribute('aria-pressed', 'true');
        await expect(angle).toBeInViewport();
        const pause = panel(page).getByRole('button', {
          name: 'Pause',
          exact: true
        });
        await expect(pause).toBeInViewport();
        await expect(
          panel(page).getByRole('combobox', { name: 'Playback' })
        ).toHaveValue('ping-pong');
        const shown = new Set<string>();
        await expect
          .poll(async () => {
            shown.add(await angle.inputValue());
            return shown.size;
          })
          .toBeGreaterThan(2);
        await pause.click();
        await expect(angle).toHaveValue(value);
        await expect(
          panel(page).getByRole('button', { name: 'Play', exact: true })
        ).toBeInViewport();
        await expectBodyCount(page, 3);
      };

      await sample.click();
      await ready('30');
      await angle.fill('45');
      await angle.press('Enter');
      await angle.blur();
      await expect(
        panel(page).getByRole('region', { name: 'Joints' })
      ).toContainText('45.0°');
      await panel(page)
        .getByRole('combobox', { name: 'Playback' })
        .selectOption('once');

      // An edited local copy still opens in the sample's workspace, even
      // after the user changed modes and collapsed its pivot controls.
      await panel(page)
        .getByRole('button', { name: /^Pivot / })
        .click();
      await expect(angle).toHaveCount(0);
      await page.getByRole('button', { name: 'Build', exact: true }).click();
      await backToProjects();
      await sample.click();
      await ready('45');
      await page.reload();
      await ready('45');

      await page.getByRole('button', { name: 'Build', exact: true }).click();
      await backToProjects();
      const reset = page.getByRole('button', {
        name: 'Reset Scissors to the original'
      });
      await reset.click();
      await page
        .getByRole('alertdialog', { name: 'Reset the Scissors sample?' })
        .getByRole('button', { name: 'Reset sample' })
        .click();
      await expect(reset).toHaveCount(0);
      await sample.click();
      await ready('30');
    }
  );
}

test(
  'Reduce motion leaves the scissors paused with manual Play available',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.route('**/api/session', (route) =>
      route.fulfill({ status: 401, json: { error: 'Not signed in' } })
    );
    await page.addInitScript(
      ({ key, defaults }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            settings: {
              ...defaults,
              appearance: { ...defaults.appearance, reducedMotion: true }
            },
            syncedRevision: null
          })
        );
      },
      { key: APP_SETTINGS_STORAGE_KEY, defaults: DEFAULT_APP_SETTINGS }
    );
    await page.goto('/');
    await page.getByRole('button', { name: /^Open demo: Scissors/ }).click();
    await expect(
      page.getByRole('group', { name: 'Workspace mode' })
    ).toBeVisible({ timeout: 30_000 });
    const angle = panel(page).getByRole('textbox', {
      name: 'Angle',
      exact: true
    });
    await expect(angle).toHaveValue('30');
    await panel(page)
      .getByRole('button', { name: 'Play', exact: true })
      .click();
    await panel(page)
      .getByRole('button', { name: 'Pause', exact: true })
      .click();
    await expect(angle).toHaveValue('30');
  }
);

test(
  'turns bodies into parts from the first run in the sidebar (AS01)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await openDocument(page, blades('Assembly first run', false));
    await expect(
      page.getByRole('button', { name: 'Build', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
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
  'adds a body that is not in the assembly yet and lists it in the BOM (regression, AS03)',
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
    // AS03: the bill of materials lists the new part and exports as CSV.
    const bom = panel(page).getByRole('region', { name: 'Bill of materials' });
    await expect(bom.getByRole('listitem')).toHaveText([
      'Blade A×1',
      'Blade B×1',
      'Pivot screw×1'
    ]);
    const pending = page.waitForEvent('download');
    await bom
      .getByRole('button', { name: 'Download bill of materials as CSV' })
      .click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('Assembly-add-body.bom.csv');
    const chunks: Buffer[] = [];
    for await (const chunk of await download.createReadStream())
      chunks.push(chunk as Buffer);
    const csv = Buffer.concat(chunks).toString('utf8').trim().split('\n');
    expect(csv[0]).toBe('item,quantity,part,instances,source_body,status');
    expect(csv.slice(1).every((line) => line.endsWith(',ready'))).toBe(true);
    expect(csv.slice(1).map((line) => line.split(',').slice(0, 4))).toEqual([
      ['1', '1', 'Blade A', 'Blade A'],
      ['2', '1', 'Blade B', 'Blade B'],
      ['3', '1', 'Pivot screw', 'Pivot screw']
    ]);
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

test(
  'sets up a lift-out motion from the sidebar and plays it back and forth (AS02/AS06)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const loose = blades('Assembly motion setup', false);
    const [a, b] = loose.bodyOrder as [BodyId, BodyId];
    await openDocument(
      page,
      addAssemblyComponents(loose, {
        components: [
          { componentId: 'comp_a', name: 'Blade A', bodyId: a, grounded: true },
          { componentId: 'comp_b', name: 'Blade B', bodyId: b, grounded: false }
        ]
      })
    );
    await assemble(page);
    const joints = panel(page).getByRole('region', { name: 'Joints' });
    const canvas = page.locator('canvas').first();
    const before = await canvas.screenshot();
    await joints.getByRole('button', { name: 'Set up motion' }).click();

    const setup = panel(page).getByRole('region', { name: 'Set up motion' });
    await expect(
      setup.getByRole('combobox', { name: 'Part that stays put' })
    ).toHaveValue('comp_a');
    await expect(
      setup.getByRole('combobox', { name: 'Part that moves' })
    ).toHaveValue('comp_b');
    await expect(setup.getByRole('combobox', { name: 'Playback' })).toHaveValue(
      'ping-pong'
    );
    // The preview moves the part on screen before anything is saved.
    await expect
      .poll(async () => Buffer.compare(await canvas.screenshot(), before) !== 0)
      .toBe(true);
    const to = setup.getByRole('textbox', { name: 'Slide to' });
    await to.fill('30');
    await to.press('Enter');
    await setup.getByRole('button', { name: 'Create and play' }).click();

    await expect(setup).toHaveCount(0);
    await expect(joints).toContainText('Blade B slide');
    const shown = new Set<string>();
    await expect
      .poll(async () => {
        shown.add((await joints.textContent()) ?? '');
        return shown.size;
      })
      .toBeGreaterThan(2);
    await joints
      .getByRole('button', { name: 'Pause Blade B slide', exact: true })
      .click();
    await expect(joints).toContainText('0.0 mm');
    // Playback saved nothing: one undo removes the motion it set up.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(joints).not.toContainText('Blade B slide');
  }
);

// Review I55/I56: a slide's values are model coordinates, so an inch
// project's "5" is 5 in — the card and the joint row said "mm". And once
// every part is fixed or already moving, the header's Motion opened a card
// already in an error; it now says why instead.
test(
  'sets up motion in an inch project in inches, then says Motion has nothing left to move',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    let loose = createProjectDocument(
      'Inch motion setup',
      toUserId('user_e2e'),
      'inch'
    );
    for (const bodyName of ['Base', 'Slider'])
      loose = addPrimitiveFeature(loose, {
        name: bodyName,
        bodyName,
        primitiveKind: 'box',
        dimensions: { width: 4, height: 1, depth: 2 }
      });
    const [a, b] = loose.bodyOrder as [BodyId, BodyId];
    await openDocument(
      page,
      addAssemblyComponents(loose, {
        components: [
          { componentId: 'comp_a', name: 'Base', bodyId: a, grounded: true },
          { componentId: 'comp_b', name: 'Slider', bodyId: b, grounded: false }
        ]
      })
    );
    await assemble(page);
    const joints = panel(page).getByRole('region', { name: 'Joints' });
    await joints.getByRole('button', { name: 'Set up motion' }).click();
    const setup = panel(page).getByRole('region', { name: 'Set up motion' });
    // Sized in inches: the 1 in tall base, or 2 in before its size is
    // read — never 5 or 50, the millimetre defaults read as inches.
    const slideTo = Number(
      await setup.getByRole('textbox', { name: 'Slide to' }).inputValue()
    );
    expect(slideTo).toBeGreaterThan(0);
    expect(slideTo).toBeLessThanOrEqual(2);
    await expect(setup.locator('.assembly-unit')).toHaveText('in');
    await setup.getByRole('button', { name: 'Create and play' }).click();
    await expect(setup).toHaveCount(0);
    await joints
      .getByRole('button', { name: 'Pause Slider slide', exact: true })
      .click();
    await expect(joints).toContainText(/\d\.\d\d in/);
    await expect(joints).not.toContainText(' mm');

    const motion = panel(page).getByRole('button', {
      name: 'Make it move',
      exact: true
    });
    await expect(motion).toHaveAttribute('aria-disabled', 'true');
    // It stays focusable so the reason can be read and heard: pressing it
    // says why instead of opening a card that starts in an error.
    await motion.focus();
    await page.keyboard.press('Enter');
    await expect(
      panel(page).getByRole('region', { name: 'Set up motion' })
    ).toHaveCount(0);
    await expect(
      page
        .getByText('Every part is fixed or already moves on a joint', {
          exact: false
        })
        .first()
    ).toBeVisible();
  }
);
