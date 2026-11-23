import type { Locator, Page } from '@playwright/test';
import {
  addAssemblyComponents,
  addAssemblyJoint,
  addPrimitiveFeature,
  createProjectDocument,
  setAssemblyStudy
} from '@openzcad/document-core';
import {
  toUserId,
  type AssemblyFrame,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  keepMeasurement,
  createPrimitiveInPlace,
  createProject,
  waitForStillViewport,
  finishInPlaceCommand,
  pressTool,
  expect,
  expectBodyCount,
  pickPlanarFace,
  stubApi,
  test,
  waitForSurfacesToSettle
} from './openzcad-fixtures';

/**
 * Floating surfaces sharing a phone's stage (design review 16 Nov 2026,
 * UX-001, UX-003, UX-010, UX-011). At 390 × 844 with touch, one surface
 * stood over another's controls and took its taps: the Objects panel over
 * the modeling guide's Finish, the Assemble sidebar over the animation
 * timeline's Play, the measurement workbench over the opened view tools'
 * own toggle, and a measurement's Edit and Delete ran past the
 * workbench's edge once touch sizing grew them to 44 px.
 *
 * Each check presses the control as a finger does and asks the page what
 * is under its centre: Playwright's actionability check alone scrolls a
 * clipped control into view, which hid UX-010.
 */

test.use({ hasTouch: true, isMobile: true });

/** Whether a press at the control's centre reaches the control itself. */
function reachable(control: Locator) {
  return control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2
    );
    return hit !== null && element.contains(hit);
  });
}

async function shot(page: Page, name: string) {
  await test.info().attach(name, {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
}

async function openBracket(page: Page, width = 390, height = 844) {
  await stubApi(page, { commandFoldClosed: true });
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(
    page.getByRole('button', { name: 'Tweak', exact: true })
  ).toBeVisible({ timeout: 90_000 });
}

/** Build's Measure on the bracket, with one result in the workbench. */
async function measureTopFace(page: Page) {
  const more = page.getByRole('button', { name: 'More view tools' });
  await more.tap();
  await page.getByRole('button', { name: 'Measure', exact: true }).tap();
  const workbench = page.locator('.measurement-dock');
  await expect(workbench).toBeVisible();
  await expect
    .poll(
      async () => (await pickPlanarFace(page, { x: 0, y: 0, z: 1 })) !== null,
      {
        timeout: 60_000
      }
    )
    .toBe(true);
  await keepMeasurement(page);
  const row = workbench.locator('.measurement-row').first();
  await expect(row).toBeVisible();
  return { more, workbench, row };
}

/**
 * Each of a result's four actions is a whole 44 px target inside the list,
 * with nothing to scroll sideways, and a press at its centre reaches it.
 */
async function expectActionsFit(workbench: Locator, row: Locator) {
  const list = workbench.locator('.measurement-dock-list');
  expect(
    await list.evaluate((element) => element.scrollWidth - element.clientWidth)
  ).toBeLessThanOrEqual(0);
  for (const name of [/^(Hide|Show) /, /^Copy /, /^Edit /, /^Delete /]) {
    const action = row.getByRole('button', { name });
    await expect(action).toBeVisible();
    // A short stage scrolls the list up and down, never across.
    await action.scrollIntoViewIfNeeded();
    expect(await list.evaluate((element) => element.scrollLeft)).toBe(0);
    const edge = (await list.boundingBox())!;
    const box = (await action.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(edge.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(edge.x + edge.width + 0.5);
    expect(box.y).toBeGreaterThanOrEqual(edge.y - 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(edge.y + edge.height + 0.5);
    await expectOnScreen(workbench.page(), action);
    await expect.poll(() => reachable(action)).toBe(true);
  }
}

/**
 * Wholly inside the window, with the page itself unscrolled: a reach for
 * a control must not be met by scrolling the stage, which a finger cannot.
 */
async function expectOnScreen(page: Page, control: Locator) {
  expect(
    await page.evaluate(() => [
      window.scrollX,
      window.scrollY,
      document.querySelector('.viewer-area')?.scrollTop ?? 0
    ])
  ).toEqual([0, 0, 0]);
  const box = (await control.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
}

test('the modeling guide’s Finish stays clear of the phone’s panel (UX-001)', async ({
  page
}) => {
  test.setTimeout(120_000);
  // A new device, laid out on a wide window (the default panels open, as
  // the review found them) and then narrowed to a phone's width.
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, {
    workspaceTour: true,
    panelLayout: null,
    commandFoldClosed: true
  });
  await createProject(page, 'Phone guide');
  const tour = page.locator('.workspace-tour');
  await expect(tour).toBeVisible();
  const next = tour.getByRole('button', { name: 'Next' });
  for (let step = 0; step < 3; step += 1) await next.tap();
  await expect(tour).toContainText('4/4');
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.locator('.panel-lane-float .model-panel');
  await expect(panel).toBeVisible();
  const finish = tour.getByRole('button', { name: 'Finish' });
  await expect(finish).toBeVisible();
  await waitForSurfacesToSettle(page, [
    '.workspace-tour',
    '.panel-lane-float .model-panel'
  ]);
  await shot(page, 'ux-001-guide-finish');
  await expect.poll(() => reachable(finish)).toBe(true);
  // The two share the stage one above the other, the guide whole.
  const card = (await tour.boundingBox())!;
  const lane = (await panel.boundingBox())!;
  expect(
    lane.y + lane.height <= card.y + 0.5 || card.y + card.height <= lane.y + 0.5
  ).toBe(true);
  // The panel's own "Hide panels" stays in reach too.
  await expect
    .poll(() => reachable(panel.getByRole('button', { name: 'Hide panels' })))
    .toBe(true);
  await finish.tap();
  await expect(tour).toBeHidden();
  // Finished, the panel takes its usual place back.
  await expect(panel).toBeVisible();
});

// A fresh phone project (preview check on #1951): the expanded guide's
// "Select to edit" step stood over the box it asked to be tapped. The new
// body is framed above the guide now.
test('the modeling guide leaves the new box clear to tap on a phone', async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page, { workspaceTour: true });
  await createProject(page, 'Phone guide box');
  const tour = page.locator('.workspace-tour');
  await expect(tour).toBeVisible();
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await expect(tour).toContainText('Select to edit');
  await waitForSurfacesToSettle(page, ['.workspace-tour']);
  const canvas = page.locator('.viewer-host canvas');
  const card = (await tour.boundingBox())!;
  await expect
    .poll(async () => {
      const view = await canvas.evaluate(
        (element) =>
          new Promise<{
            screen: { top: number; bottom: number } | null;
          }>((resolve) =>
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-bodies-in-view', {
                detail: { resolve }
              })
            )
          )
      );
      return view.screen === null
        ? null
        : view.screen.bottom <= card.y + 0.5 && view.screen.top >= 0;
    })
    .toBe(true);
  await shot(page, 'guide-leaves-box-clear');
});

// The same, with the guide opened again over the Box command: it never
// rose after Done, so only its step moving on to "Select to edit" can ask
// for the model to be framed clear (preview check on #1964).
test('the guide opened over a dragged-out Box leaves the box clear after Done', async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page, { workspaceTour: true });
  await createProject(page, 'Phone guide done');
  const tour = page.locator('.workspace-tour');
  await expect(tour).toBeVisible();
  await pressTool(page, /^Box \(B\)/);
  await expect(page.getByRole('group', { name: 'Box command' })).toBeVisible();
  const expand = tour.getByRole('button', { name: 'Expand modeling guide' });
  if (await expand.isVisible()) await expand.tap();
  await expect(
    tour.getByRole('button', { name: 'Minimize modeling guide' })
  ).toBeVisible();
  // Dragged out, as the check did: no typed value, so no creation reframe;
  // only the step moving on asks for the box to be framed clear.
  await waitForStillViewport(page);
  await page.mouse.move(90, 300);
  await page.mouse.down();
  await page.mouse.move(300, 395, { steps: 12 });
  await page.mouse.up();
  await finishInPlaceCommand(page, 'Box');
  await expectBodyCount(page, 1);
  await expect(tour).toContainText('Select to edit');
  await waitForSurfacesToSettle(page, ['.workspace-tour']);
  const canvas = page.locator('.viewer-host canvas');
  const card = (await tour.boundingBox())!;
  await expect
    .poll(async () => {
      const view = await canvas.evaluate(
        (element) =>
          new Promise<{
            screen: { top: number; bottom: number } | null;
          }>((resolve) =>
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-bodies-in-view', {
                detail: { resolve }
              })
            )
          )
      );
      return view.screen === null
        ? null
        : view.screen.bottom <= card.y + 0.5 && view.screen.top >= 0;
    })
    .toBe(true);
});

// A 360 × 640 phone with the guide up on its second step (#1945). It
// stood over the opened view tools, Measure under its text, and expanded
// it left the measurement workbench a 13 px sliver of the lane. The rail
// stands over it now, and it folds to its header while the card is up.
test('the modeling guide folds for the measurement workbench on a short phone (#1945)', async ({
  page
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, {
    workspaceTour: true,
    panelLayout: null,
    commandFoldClosed: true
  });
  await createProject(page, 'Phone guide measure');
  await createPrimitiveInPlace(page, 'box');
  await page.setViewportSize({ width: 360, height: 640 });
  const tour = page.locator('.workspace-tour');
  await expect(tour).toContainText('Select to edit');
  const expand = tour.getByRole('button', { name: 'Expand modeling guide' });
  const minimize = tour.getByRole('button', {
    name: 'Minimize modeling guide'
  });
  await expect(minimize).toBeVisible();

  // No panel in the lane: with one, the lane already ended above the guide.
  const shownPanel = page
    .getByRole('toolbar', { name: 'Model panels' })
    .locator('button[aria-pressed="true"]');
  await expect(async () => {
    if ((await shownPanel.count()) > 0) await shownPanel.first().tap();
    await expect(page.locator('.panel-lane-float')).toHaveCount(0, {
      timeout: 1_000
    });
  }).toPass();
  await page.getByRole('button', { name: 'More view tools' }).tap();
  const measure = page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Measure', exact: true });
  await expect.poll(() => reachable(measure)).toBe(true);
  await measure.tap();
  const workbench = page.locator('.measurement-dock');
  await expect(workbench).toBeVisible();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await waitForSurfacesToSettle(page, ['.workspace-tour', '.measurement-dock']);
  await shot(page, 'guide-folds-for-measure-360');
  // The workbench has the lane: room to read, and Keep in reach once a
  // pick gives it something to keep.
  expect((await workbench.boundingBox())!.height).toBeGreaterThanOrEqual(150);
  await expect
    .poll(
      async () => (await pickPlanarFace(page, { x: 0, y: 0, z: 1 })) !== null,
      { timeout: 60_000 }
    )
    .toBe(true);
  const keep = workbench.locator('.measurement-keep');
  await keep.scrollIntoViewIfNeeded();
  await expect.poll(() => reachable(keep)).toBe(true);
  // Kept, the workbench grows, and ends above the folded guide: its rows
  // stood over Expand and Skip (preview review).
  await keep.tap();
  await expect(workbench.locator('.measurement-row').first()).toBeVisible();
  await waitForSurfacesToSettle(page, ['.workspace-tour', '.measurement-dock']);
  await shot(page, 'guide-folded-under-kept-rows-360');
  const folded = (await tour.boundingBox())!;
  const card = (await workbench.boundingBox())!;
  expect(card.y + card.height).toBeLessThanOrEqual(folded.y + 0.5);
  await expect.poll(() => reachable(expand)).toBe(true);
  await expect
    .poll(() => reachable(tour.getByRole('button', { name: 'Skip the tour' })))
    .toBe(true);
  // The workbench closes and the guide is back as it was.
  await page.keyboard.press('Escape');
  await expect(workbench).toBeHidden();
  await expect(minimize).toHaveAttribute('aria-expanded', 'true');

  // Opened over a card in the shorter lane that leaves, the card scrolls
  // in it rather than running over the guide: Sketch's plane picker took
  // the press on Minimize and started a sketch (preview re-check).
  await page.keyboard.press('s');
  const prompt = page.locator('.sketch-plane-prompt');
  await expect(prompt).toBeVisible();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.tap();
  await expect(minimize).toHaveAttribute('aria-expanded', 'true');
  await waitForSurfacesToSettle(page, ['.workspace-tour', '.command-float']);
  await shot(page, 'guide-expanded-over-sketch-prompt-360');
  const slot = (await page.locator('.command-float').boundingBox())!;
  expect(slot.y + slot.height).toBeLessThanOrEqual(
    (await tour.boundingBox())!.y + 0.5
  );
  await expect.poll(() => reachable(minimize)).toBe(true);
  await minimize.tap();
  await expect(prompt).toBeVisible();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Cancel sketch' }).tap();
  await expect(prompt).toBeHidden();
  await expect(minimize).toHaveAttribute('aria-expanded', 'true');
});

// A 360 × 640 phone during Box with Objects open (#1953). Expanded over the
// command's 180 px bar, the guide reached up the whole stage: Objects kept
// 0 px of the lane, and over a taller bar the card ran under the top
// islands. It caps its height now, leaving the lane room, its step text
// scrolling between its header and Next.
test('the expanded guide leaves an open panel room over an in-place bar (#1953)', async ({
  page
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, {
    workspaceTour: true,
    panelLayout: null,
    commandFoldClosed: true
  });
  await createProject(page, 'Phone guide panel');
  await createPrimitiveInPlace(page, 'box');
  await page.setViewportSize({ width: 360, height: 640 });
  const tour = page.locator('.workspace-tour');
  await expect(tour).toContainText('Select to edit');
  const objects = page
    .getByRole('toolbar', { name: 'Model panels' })
    .getByRole('button', { name: 'Objects panel' });
  if ((await objects.getAttribute('aria-pressed')) !== 'true') {
    await objects.tap();
  }
  const panel = page.locator('.panel-lane-float .model-panel');
  await expect(panel).toBeVisible();
  await page.keyboard.press('b');
  await expect(page.getByRole('group', { name: 'Box command' })).toBeVisible();
  await tour.getByRole('button', { name: 'Expand modeling guide' }).tap();
  const minimize = tour.getByRole('button', {
    name: 'Minimize modeling guide'
  });
  await expect(minimize).toHaveAttribute('aria-expanded', 'true');
  await waitForSurfacesToSettle(page, [
    '.workspace-tour',
    '.panel-lane-float .model-panel'
  ]);
  await shot(page, 'guide-expanded-over-box-with-objects-360');

  const card = (await tour.boundingBox())!;
  const lane = (await panel.boundingBox())!;
  const top = (await page.locator('.topbar').boundingBox())!;
  // The panel keeps its header and the row under it, above the card.
  expect(lane.height).toBeGreaterThanOrEqual(70);
  expect(lane.y + lane.height).toBeLessThanOrEqual(card.y + 0.5);
  // The card stays on the stage, below the top islands.
  expect(card.y).toBeGreaterThanOrEqual(top.y + top.height);
  for (const control of [
    minimize,
    tour.getByRole('button', { name: 'Next' }),
    panel.getByRole('button', { name: 'Hide panels' })
  ]) {
    await expect.poll(() => reachable(control)).toBe(true);
  }
  // The step shows its title and two lines at least, Next whole under them,
  // and what does not fit scrolls (PR review: at a 116 px floor the text
  // had no height at all, and Next ran past the card).
  const content = tour.locator('.workspace-tour-content');
  const text = await content.evaluate((element) => ({
    shown: element.clientHeight,
    scroll: getComputedStyle(element).overflowY,
    whole: element.scrollHeight
  }));
  expect(text.shown).toBeGreaterThanOrEqual(60);
  expect(text.scroll).toBe('auto');
  const next = (await tour
    .getByRole('button', { name: 'Next' })
    .boundingBox())!;
  expect(next.y + next.height).toBeLessThanOrEqual(card.y + card.height + 0.5);
  // Text that scrolls takes a keyboard stop, as Safari gives none.
  if (text.whole > text.shown + 1) {
    await expect(content).toHaveAttribute('tabindex', '0');
  }
});

const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

/** Two blades on a revolute joint with one saved animation of it. */
function animatedBlades(): ProjectDocument {
  let document = createProjectDocument('Phone animation', toUserId('user_e2e'));
  for (const bodyName of ['Blade A', 'Blade B']) {
    document = addPrimitiveFeature(document, {
      name: bodyName,
      bodyName,
      primitiveKind: 'box',
      dimensions: { width: 60, height: 4, depth: 12 }
    });
  }
  const [a, b] = document.bodyOrder as [BodyId, BodyId];
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'comp_a', name: 'Blade A', bodyId: a, grounded: true },
      { componentId: 'comp_b', name: 'Blade B', bodyId: b, grounded: false }
    ]
  });
  document = addAssemblyJoint(document, {
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
  return setAssemblyStudy(document, {
    study: {
      id: 'study_phone',
      name: 'Animation 1',
      durationS: 2,
      playback: 'once',
      tracks: [
        {
          jointId: 'joint_pivot',
          dof: 0,
          keys: [
            { t: 0, value: 0, easing: 'linear' },
            { t: 2, value: 30, easing: 'ease' }
          ]
        }
      ]
    }
  });
}

test('the animation timeline keeps its own band under the Assemble sidebar (UX-003)', async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const document = animatedBlades();
  await stubApi(page, { commandFoldClosed: true });
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
  await expectBodyCount(page, 2);
  await page.getByRole('button', { name: 'Assemble', exact: true }).tap();
  const sidebar = page.getByRole('complementary', { name: 'Assembly' });
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole('button', { name: /^Animation 1/ }).tap();
  const timeline = page.locator('.motion-timeline-floating');
  await expect(timeline).toBeVisible();
  const play = timeline.getByRole('button', { name: 'Play', exact: true });
  await expect(play).toBeVisible();
  await shot(page, 'ux-003-timeline-play');
  await expect.poll(() => reachable(play)).toBe(true);
  // The sidebar ends above the timeline rather than over it.
  const float = page.locator('.assembly-panel-float');
  await expect
    .poll(async () => {
      const side = (await float.boundingBox())!;
      const band = (await timeline.boundingBox())!;
      return side.y + side.height <= band.y + 0.5;
    })
    .toBe(true);
  // And the sidebar still shows its sections, scrolling inside its room.
  await expect(sidebar.getByText('Animations')).toBeVisible();
  await play.tap();
  await expect(
    timeline.getByRole('button', { name: 'Pause', exact: true })
  ).toBeVisible();
});

test('opened view tools stand over the measurement workbench and close from their toggle (UX-011)', async ({
  page
}) => {
  test.setTimeout(150_000);
  await openBracket(page);
  const { more } = await measureTopFace(page);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.tap();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await shot(page, 'ux-011-view-tools-open');
  await expect.poll(() => reachable(more)).toBe(true);
  // Every tool the opened rail shows takes its own press.
  const rail = page.locator('.instrument-rail');
  const covered = await rail.evaluate((element) =>
    [...element.querySelectorAll('.viewer-rail button')]
      .filter((button) => {
        const box = button.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2
        );
        return !(hit && button.contains(hit));
      })
      .map((button) => button.getAttribute('aria-label') ?? button.textContent)
  );
  expect(covered).toEqual([]);
  await more.tap();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  // Folded, the workbench's own controls are in reach again.
  await expect
    .poll(() =>
      reachable(page.locator('.measurement-dock-foot button').first())
    )
    .toBe(true);
});

test('a measurement’s four actions fit the touch workbench (UX-010)', async ({
  page
}) => {
  test.setTimeout(150_000);
  await openBracket(page);
  const { workbench, row } = await measureTopFace(page);
  await shot(page, 'ux-010-measure-actions');
  await expectActionsFit(workbench, row);
  // The value keeps its line beside them.
  await expect(row.locator('.measurement-row-value')).toBeVisible();
  await row.getByRole('button', { name: /^Edit / }).tap();
  await expect(row.locator('.measurement-row-editor')).toBeVisible();
});

// The lane steps past the opened rail, and with a model panel open it
// also started after the tool rail: 150 px of list at 390 px, under the
// 182 px the four actions take in a row, so Hide was an 8 px sliver whose
// centre missed (PR review). The workbench and its actions fit with the
// Objects panel open and the view tools opened, on a narrower phone too.
for (const { width, height } of [
  { width: 390, height: 844 },
  { width: 360, height: 640 }
]) {
  test(`with Objects open, opened view tools leave the workbench whole at ${width}px`, async ({
    page
  }) => {
    test.setTimeout(150_000);
    await openBracket(page, width, height);
    const objects = page
      .getByRole('toolbar', { name: 'Model panels' })
      .getByRole('button', { name: 'Objects panel' });
    await objects.tap();
    await expect(objects).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.panel-lane-float .model-panel')).toBeVisible();
    const { more, workbench, row } = await measureTopFace(page);
    await more.tap();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => reachable(more)).toBe(true);
    await shot(page, `review-objects-measure-rail-${width}`);
    await expectActionsFit(workbench, row);
    // And the rest of the workbench, across its whole width. The first tap
    // inside it may only fold the view tools away; the settings open on the
    // tap that reaches them.
    const settings = workbench.getByRole('button', {
      name: 'Measurement settings'
    });
    await settings.tap();
    if ((await settings.getAttribute('aria-expanded')) !== 'true') {
      await settings.tap();
    }
    await expect(settings).toHaveAttribute('aria-expanded', 'true');
    const edge = (await workbench.boundingBox())!;
    for (const control of [
      workbench.getByRole('button', { name: 'Measurement settings' }),
      workbench.getByRole('combobox', { name: 'Measurement units' }),
      workbench.getByRole('combobox', { name: 'Measurement precision' }),
      workbench.getByRole('button', { name: 'Radius', exact: true }),
      // The foot, which ran off a 360 × 640 screen and over the search bar.
      workbench.locator('.measurement-dock-foot button').last()
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(edge.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(edge.x + edge.width + 0.5);
      await expectOnScreen(page, control);
      await expect.poll(() => reachable(control)).toBe(true);
    }
    // The workbench ends above the search bar.
    const bar = (await page.locator('.command-bar').boundingBox())!;
    expect(edge.y + edge.height).toBeLessThanOrEqual(bar.y + 0.5);
  });
}
