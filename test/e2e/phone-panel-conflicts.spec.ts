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
  promptField,
  expect,
  ensureToolsDrawerOpen,
  expectBodyCount,
  modelPanel,
  pickPlanarFace,
  railPanelButton,
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

// A tablet's corner card stood over the new box the same way, in portrait
// (768 × 1024) and landscape (1024 × 768) alike. The box is framed above
// or beside the card now.
for (const [width, height] of [
  [768, 1024],
  [1024, 768]
] as const) {
  test(`the modeling guide leaves the new box clear to tap on a ${width} × ${height} tablet`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height });
    await stubApi(page, { workspaceTour: true });
    await createProject(page, 'Tablet guide box');
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
              screen: {
                left: number;
                right: number;
                top: number;
                bottom: number;
              } | null;
            }>((resolve) =>
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-bodies-in-view', {
                  detail: { resolve }
                })
              )
            )
        );
        const box = view.screen;
        if (box === null) return null;
        return (
          box.bottom <= card.y + 0.5 ||
          box.left >= card.x + card.width - 0.5 ||
          box.right <= card.x + 0.5
        );
      })
      .toBe(true);
  });
}

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

// A phone 541–620 px tall keeps two-column rails, 138 px apart at 360 px,
// and the 296 px guide kept the desktop corner there, 60 px off the screen
// with Next cut (#1957). It spans from the tool rail to the edge over the
// search bar, starts folded, and opened by hand stays open.
for (const { width, height } of [
  { width: 360, height: 560 },
  { width: 320, height: 568 }
]) {
  test(`the modeling guide fits a ${width} × ${height} phone, folded at first (#1957)`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height });
    await stubApi(page, {
      workspaceTour: true,
      panelLayout: null,
      commandFoldClosed: true
    });
    await createProject(page, 'Short phone guide');
    const tour = page.locator('.workspace-tour');
    await expect(tour).toBeVisible();
    const expand = tour.getByRole('button', { name: 'Expand modeling guide' });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await waitForSurfacesToSettle(page, ['.workspace-tour']);
    await shot(page, `short-phone-guide-folded-${width}`);
    const inside = async () => {
      const box = (await tour.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(
        (await page.locator('.command-bar').boundingBox())!.y + 0.5
      );
      // Clear of the tool rail beside it.
      const rail = (await page
        .locator('.workspace-column-float')
        .boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(rail.x + rail.width);
    };
    await inside();
    const card = (await tour.boundingBox())!;
    for (const control of [
      expand,
      tour.getByRole('button', { name: 'Skip the tour' })
    ]) {
      // Inside the card, not past its edge: the title gives way.
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(card.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
      await expect.poll(() => reachable(control)).toBe(true);
    }

    await expand.tap();
    const minimize = tour.getByRole('button', {
      name: 'Minimize modeling guide'
    });
    await expect(minimize).toHaveAttribute('aria-expanded', 'true');
    await waitForSurfacesToSettle(page, ['.workspace-tour']);
    await shot(page, `short-phone-guide-open-${width}`);
    await inside();
    await expect(tour).toContainText('Create your first feature');
    const next = tour.getByRole('button', { name: 'Next' });
    await expect.poll(() => reachable(next)).toBe(true);
    await expectOnScreen(page, next);

    // The notice row stands just over the card, over an in-place command's
    // bar too, lifted by the card alone (PR review: by the bar twice, a
    // warning rose a whole bar's height higher, toward the top bar).
    const noticeOverCard = async () => {
      await waitForSurfacesToSettle(page, ['.workspace-tour']);
      const notice = (await page.locator('.workspace-toast').boundingBox())!;
      const over = (await tour.boundingBox())!;
      expect(notice.y + notice.height).toBeLessThanOrEqual(over.y + 0.5);
      expect(notice.y + notice.height).toBeGreaterThanOrEqual(over.y - 24);
    };
    await noticeOverCard();
    await page.keyboard.press('b');
    await expect(
      page.getByRole('group', { name: 'Box command' })
    ).toBeVisible();
    await noticeOverCard();
    // A notice spoken during the command, over a card that fills the
    // stage, shows on the stage rather than under the top bar's mode
    // switch (preview review).
    const box = page.getByRole('group', { name: 'Box command' });
    await box.getByRole('button', { name: /^Cancel/ }).tap();
    await page.keyboard.press('b');
    await expect(box).toBeVisible();
    const said = page.locator(
      '.workspace-toast:not(.hidden) .workspace-toast-body'
    );
    await expect(said).toContainText('Box canceled');
    await expect.poll(() => reachable(said)).toBe(true);
    const top = (await page.locator('.topbar').boundingBox())!;
    expect((await said.boundingBox())!.y).toBeGreaterThanOrEqual(
      top.y + top.height
    );
    await page.keyboard.press('Escape');

    // Opened by hand, it stays open on the next visit.
    await page.reload();
    await expect(
      page
        .locator('.workspace-tour')
        .getByRole('button', { name: 'Minimize modeling guide' })
    ).toBeVisible();
  });
}

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

/** The bodies' projected screen bounds, from the viewer's e2e hook. */
async function bodiesOnScreen(page: Page) {
  const view = await page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<{
        screen: {
          left: number;
          right: number;
          top: number;
          bottom: number;
        } | null;
      }>((resolve) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-bodies-in-view', {
            detail: { resolve }
          })
        )
      )
  );
  return view.screen!;
}

/** A tablet's new box at "Select to edit", the guide expanded. */
async function tabletBoxAtSelect(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await stubApi(page, {
    workspaceTour: true,
    panelLayout: null,
    commandFoldClosed: true
  });
  await createProject(page, 'Tablet guide next');
  const tour = page.locator('.workspace-tour');
  await expect(tour).toBeVisible();
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await expect(tour).toContainText('Select to edit');
  await waitForSurfacesToSettle(page, ['.workspace-tour']);
  await waitForStillViewport(page);
  return tour;
}

/** Pans the view by (dx, dy) with a right-drag from below the bodies. */
async function panBy(page: Page, dx: number, dy: number) {
  const box = await bodiesOnScreen(page);
  const x = (box.left + box.right) / 2;
  const y = box.bottom + 20;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await waitForStillViewport(page);
}

async function pressNext(page: Page, tour: Locator) {
  await tour.getByRole('button', { name: 'Next' }).click();
  await waitForSurfacesToSettle(page, ['.workspace-tour']);
  await page.waitForTimeout(600);
  await waitForStillViewport(page);
}

// A 768 × 1024 tablet's box nudged clear of everything, 7 px from the rail:
// inside the clear stage's gap, it read as covered and Next moved it 32 px
// (preview check on #1974).
test('Next leaves a tablet’s box clear of the rail where it is', async ({
  page
}) => {
  test.setTimeout(120_000);
  const tour = await tabletBoxAtSelect(page, 768, 1024);
  await panBy(page, 10, 45);
  const panned = await bodiesOnScreen(page);
  const rail = (await page.locator('.instrument-rail').boundingBox())!;
  // The setup this guards: inside the stage's gap, clear of the rail.
  expect(panned.right).toBeLessThan(rail.x);
  await pressNext(page, tour);
  const after = await bodiesOnScreen(page);
  expect(Math.abs(after.left - panned.left)).toBeLessThan(1);
  expect(Math.abs(after.top - panned.top)).toBeLessThan(1);
});

// A 1024 × 768 tablet with the Tools drawer open: a box panned behind it
// was reframed on Next, still behind it (preview check on #1974).
test('Next reframes a tablet’s box clear of the open Tools drawer', async ({
  page
}) => {
  test.setTimeout(120_000);
  const tour = await tabletBoxAtSelect(page, 1024, 768);
  await page
    .getByRole('button', { name: /More tools/i })
    .first()
    .click();
  const fold = page.locator('.command-flyout');
  await expect(fold).toBeVisible();
  await waitForSurfacesToSettle(page, ['.command-flyout']);
  const drawer = (await fold.boundingBox())!;
  const before = await bodiesOnScreen(page);
  await panBy(page, drawer.x + drawer.width - 40 - before.left, 0);
  // The setup this guards: the box reaches under the drawer.
  expect((await bodiesOnScreen(page)).left).toBeLessThan(
    drawer.x + drawer.width
  );
  await pressNext(page, tour);
  await expect
    .poll(async () => (await bodiesOnScreen(page)).left)
    .toBeGreaterThanOrEqual(drawer.x + drawer.width);
});

// The Tools drawer is remembered open, and on a phone it opens over the
// lane the model panels share: History brought up beside it stood under it,
// History as text and the first rows with it (found writing
// history-text-layout.spec.ts on #1981). A panel coming up in the lane puts
// the drawer away.
for (const [width, height] of [
  [390, 844],
  [360, 740],
  [430, 932]
] as const) {
  test(`History comes up clear of an open Tools drawer on a ${width} × ${height} phone`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    // The suite's baseline leaves the drawer open, as a phone it was left
    // open on reopens it.
    await stubApi(page);
    await page.setViewportSize({ width, height });
    await createProject(page, 'Drawer and History');
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    const drawer = page.locator('.command-flyout');
    await expect(drawer).toBeVisible();

    await railPanelButton(page, 'History').tap();
    const history = modelPanel(page, 'History');
    await expect(history).toBeVisible();
    for (const control of [
      history.getByRole('button', { name: 'History as text' }),
      history.getByRole('button', { name: 'Find a step' }),
      history.getByRole('button', { name: 'Close History' }),
      history.getByRole('button', { name: 'Box', exact: true })
    ]) {
      await expect(control).toBeInViewport();
      await expect
        .poll(() => reachable(control), { message: String(control) })
        .toBe(true);
    }
    await expect(drawer).toHaveCount(0);
    await shot(page, `history-${width}x${height}`);
    // History as text opens from that press, with no drawer to close first.
    await history.getByRole('button', { name: 'History as text' }).tap();
    const dialog = page.getByRole('dialog', { name: 'History as text' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).tap();
    await expect(dialog).toHaveCount(0);

    // The drawer opened again stands over the panel, the newest surface,
    // and its own Close tools drawer gives the panel back.
    await page
      .getByRole('button', { name: /More tools/i })
      .first()
      .tap();
    await expect(drawer).toBeVisible();
    await page.getByRole('button', { name: 'Close tools drawer' }).tap();
    await expect(drawer).toHaveCount(0);
    await expect(history).toBeVisible();
    await expect
      .poll(() =>
        reachable(history.getByRole('button', { name: 'History as text' }))
      )
      .toBe(true);
  });
}

/** The Tools drawer as the device remembers it, open or closed. */
function storedToolsDrawer(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('openzcad-panel-state:v1');
    return raw
      ? (JSON.parse(raw) as { commandFoldOpen?: boolean }).commandFoldOpen
      : undefined;
  });
}

// Bringing up the panel the lane already shows is asked for as much as
// bringing up another: the palette naming a parameter while Parameters
// stands under the reopened drawer put the field it focused out of reach.
test('the palette brings Parameters back out from under a reopened Tools drawer', async ({
  page
}) => {
  test.setTimeout(150_000);
  await stubApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(
    page.getByRole('button', { name: 'Tweak', exact: true })
  ).toBeVisible({ timeout: 90_000 });
  const drawer = page.locator('.command-flyout');
  await ensureToolsDrawerOpen(page);
  await expect(drawer).toBeVisible();
  await railPanelButton(page, 'Parameters').tap();
  const parameters = modelPanel(page, 'Parameters');
  await expect(parameters).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await page
    .getByRole('button', { name: /More tools/i })
    .first()
    .tap();
  await expect(drawer).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await expect(promptField(page)).toBeFocused();
  await page.keyboard.type('/plate_t');
  await page
    .getByRole('option')
    .filter({ hasText: 'plate_t' })
    .filter({ hasText: 'Parameter' })
    .click();
  const field = page.getByRole('textbox', { name: 'Expression for plate_t' });
  await expect(field).toBeFocused();
  await expect(drawer).toHaveCount(0);
  await expect(field).toBeInViewport();
  await expect.poll(() => reachable(field)).toBe(true);
});

// The lane filling on its own is nobody asking for a panel: starting at a
// phone width, or narrowing to one, with History docked put the remembered
// drawer away for good, and a wider window came back without it.
test('starting or resizing at a phone width keeps the remembered Tools drawer', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: { right: [['history']] } });
  await page.setViewportSize({ width: 600, height: 900 });
  await createProject(page, 'Drawer remembered');
  const history = railPanelButton(page, 'History');
  await expect(history).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => storedToolsDrawer(page)).toBe(true);
  const more = page.getByRole('button', { name: /^More tools/ });

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  expect(await storedToolsDrawer(page)).toBe(true);

  await page.setViewportSize({ width: 600, height: 900 });
  await expect(history).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => storedToolsDrawer(page)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  expect(await storedToolsDrawer(page)).toBe(true);
});

// A command folds the drawer; the drawer comes back when the command ends.
// A panel brought up meanwhile has no drawer to put away, and must not
// close the one the command will give back.
test('a panel brought up during Box leaves the Tools drawer to come back', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await createProject(page, 'Drawer after Box');
  const drawer = page.locator('.command-flyout');
  await expect(drawer).toBeVisible();

  await pressTool(page, /^Box \(B\)/);
  await expect(page.getByRole('group', { name: 'Box command' })).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await railPanelButton(page, 'History').tap();
  await expect(modelPanel(page, 'History')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Box command' })).toHaveCount(0);
  await expect(drawer).toBeVisible();
  expect(await storedToolsDrawer(page)).toBe(true);
});

/** The Panel layout menu, opened if it is closed. */
async function panelLayoutMenu(page: Page) {
  const menu = page.getByRole('menu', { name: 'Panel layout' });
  if (!(await menu.isVisible())) {
    // A phone keeps the layout menu behind the viewer bar's toggle.
    const more = page.getByRole('button', { name: 'More view tools' });
    if ((await more.getAttribute('aria-expanded')) !== 'true') {
      await more.click();
    }
    await page
      .getByRole('toolbar', { name: 'Model panels' })
      .getByRole('button', { name: 'Panel layout' })
      .click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

/** A box with History brought up in the lane and the drawer opened over it. */
async function historyUnderReopenedDrawer(
  page: Page,
  name: string,
  { width, height } = { width: 390, height: 844 }
) {
  await stubApi(page);
  await page.setViewportSize({ width, height });
  await createProject(page, name);
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  const drawer = page.locator('.command-flyout');
  await railPanelButton(page, 'History').tap();
  await expect(modelPanel(page, 'History')).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await page
    .getByRole('button', { name: /More tools/i })
    .first()
    .tap();
  await expect(drawer).toBeVisible();
  return drawer;
}

// Showing the panels from the Panel layout menu is asked for as much as
// the pill's Show panels and Ctrl+\: the menu wrote Hide off straight into
// the layout, and History came back under the drawer.
test('the Panel layout menu’s Hide all brings History back clear of the Tools drawer', async ({
  page
}) => {
  test.setTimeout(90_000);
  const drawer = await historyUnderReopenedDrawer(page, 'Menu Hide all');
  const hide = (await panelLayoutMenu(page)).getByRole('menuitemcheckbox', {
    name: 'Hide all panels'
  });
  await hide.click();
  await expect(hide).toHaveAttribute('aria-checked', 'true');
  await expect(modelPanel(page, 'History')).toHaveCount(0);
  // Hiding the panels leaves the drawer as it is.
  await expect(drawer).toBeVisible();
  await hide.click();
  await expect(hide).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  const history = modelPanel(page, 'History');
  await expect(history).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await expect
    .poll(() =>
      reachable(history.getByRole('button', { name: 'History as text' }))
    )
    .toBe(true);
});

// A preset turns Hide off so the picked layout shows: picking Review with
// the panels hidden put History back in the lane, under the drawer.
test('a preset picked with the panels hidden brings History up clear of the Tools drawer', async ({
  page
}) => {
  test.setTimeout(90_000);
  const drawer = await historyUnderReopenedDrawer(page, 'Preset Review');
  await page.keyboard.press('Control+\\');
  await expect(modelPanel(page, 'History')).toHaveCount(0);
  await expect(drawer).toBeVisible();
  const review = (await panelLayoutMenu(page)).getByRole('menuitemradio', {
    name: 'Review',
    exact: true
  });
  await review.click();
  await expect(review).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  const history = modelPanel(page, 'History');
  await expect(history).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await expect
    .poll(() =>
      reachable(history.getByRole('button', { name: 'History as text' }))
    )
    .toBe(true);
});

// A held rail puts the drawer away for a drag without forgetting it. A
// panel asked for under the hand has no drawer to put away: Ctrl+\ showing
// History mid-drag closed the remembered drawer, and it stayed closed
// after the release.
test('panels shown during a face drag leave the Tools drawer to come back', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 150_000);
  // The widest phone stage, where the drawer leaves the box beside it.
  const drawer = await historyUnderReopenedDrawer(page, 'Drawer under drag', {
    width: 700,
    height: 900
  });
  await page.keyboard.press('Control+\\');
  await expect(modelPanel(page, 'History')).toHaveCount(0);
  await expect(drawer).toBeVisible();

  // The open drawer stands over the stage's left side, and the box with it:
  // pan the box out beside the drawer, then take the first face whose handle
  // a finger can reach there.
  const canvas = page.locator('.viewer-host canvas');
  const drawerBox = (await drawer.boundingBox())!;
  const panFrom = { x: drawerBox.x + drawerBox.width + 30, y: 220 };
  await page.mouse.move(panFrom.x, panFrom.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(panFrom.x + 200, panFrom.y, { steps: 12 });
  await page.mouse.up({ button: 'right' });
  await waitForStillViewport(page);
  const operation = page.getByRole('region', { name: 'Offset Face operation' });
  let grab: { start: { x: number; y: number }; dx: number; dy: number } | null =
    null;
  for (const normal of [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: -1, z: 0 }
  ]) {
    await expect
      .poll(() =>
        canvas.evaluate(
          (element, normal) =>
            new Promise((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-planar-face', {
                  detail: { normal, resolve }
                })
              );
            }),
          normal
        )
      )
      .not.toBeNull();
    await page
      .locator('.selection-rail')
      .getByRole('button', { name: 'Selection: Offset', exact: true })
      .click();
    await expect(operation).toBeVisible();
    await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
    const bounds = (await canvas.boundingBox())!;
    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      pixels: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    const start = { x: bounds.x + handle.x, y: bounds.y + handle.y };
    const onCanvas = await canvas.evaluate(
      (element, { x, y }) => document.elementFromPoint(x, y) === element,
      start
    );
    if (onCanvas) {
      grab = {
        start,
        dx: handle.dx * handle.pixels * 3,
        dy: handle.dy * handle.pixels * 3
      };
      break;
    }
    await page.keyboard.press('Escape');
    await expect(operation).toHaveCount(0);
  }
  expect(grab, 'a face handle clear of the drawer').not.toBeNull();
  const { start } = grab!;
  await expect(drawer).toBeVisible();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + grab!.dx, start.y + grab!.dy, {
    steps: 12
  });
  await expect(operation).toHaveAttribute('data-hold', 'drag');
  await expect(drawer).toHaveCount(0);
  expect(await storedToolsDrawer(page)).toBe(true);

  await page.keyboard.press('Control+\\');
  await expect(modelPanel(page, 'History')).toBeVisible();
  await page.mouse.up();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(drawer).toBeVisible();
  expect(await storedToolsDrawer(page)).toBe(true);
});

// The feature card a History row opens on a phone shares the lane with
// History, capped at 40dvh. The card kept its full height in its share
// and ran down over the search bar and off the screen, Apply with it: at
// 430 × 932 its Position fields stood under the bar. It takes the lane up
// to the top islands now, History giving way, and its body scrolls. Closed,
// by its Close or by Escape, it gives History its lane back.
for (const [width, height] of [
  [430, 932],
  [390, 844]
] as const) {
  test(
    `a feature card from History stays clear of the command bar on a ${width} × ${height} phone`,
    width === 430 ? { tag: '@ci-smoke' } : {},
    async ({ page }) => {
      test.setTimeout(150_000);
      await openBracket(page, width, height);
      await railPanelButton(page, 'History').tap();
      const history = modelPanel(page, 'History');
      await expect(history).toBeVisible();
      const row = history
        .locator('.feature-row-main[title^="Base plate"]')
        .first();
      const card = page.getByRole('region', { name: 'Feature inspector' });
      const bar = page.locator('.command-bar-lane');

      await row.tap();
      await expect(card).toBeVisible();
      await waitForSurfacesToSettle(page, ['.stage-right']);
      await shot(page, `feature-card-${width}x${height}`);
      const barTop = (await bar.boundingBox())!.y;
      const box = (await card.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(barTop + 0.5);
      // Its Apply, at the foot of the form, is a press away inside the card.
      const apply = card.getByRole('button', { name: 'Apply', exact: true });
      await apply.scrollIntoViewIfNeeded();
      await expectOnScreen(page, apply);
      const after = (await apply.boundingBox())!;
      expect(after.y + after.height).toBeLessThanOrEqual(barTop + 0.5);
      await expect.poll(() => reachable(apply)).toBe(true);

      // Closed, History has its lane back, and a row opens the card again.
      await card.getByRole('button', { name: 'Close panel' }).tap();
      await expect(card).toHaveCount(0);
      await expect(history).toBeVisible();
      await expect(row).toBeInViewport();
      await expect.poll(() => reachable(row)).toBe(true);
      await row.tap();
      await expect(card).toBeVisible();
      // Escape closes it the same way.
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      await expect(history).toBeVisible();
      await expect.poll(() => reachable(row)).toBe(true);
    }
  );
}
