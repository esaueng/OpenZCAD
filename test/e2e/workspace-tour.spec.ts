import type { Locator } from '@playwright/test';
import {
  createPrimitiveInPlace,
  expectBodyCount,
  test,
  expect,
  createProject,
  MODEL_ONLY,
  modelPanel,
  stubApi,
  waitForStillViewport,
  waitForSurfacesToSettle
} from './openzcad-fixtures';

test(
  'first-model tour rides the real workflow and never returns',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page, {
      workspaceTour: true,
      panelLayout: null,
      commandFoldClosed: true
    });
    await createProject(page, 'Tour Part');

    const tour = page.locator('.workspace-tour');
    await expect(tour).toBeVisible();
    await expect(tour).toContainText('Create your first feature');
    // The step outlines the chrome it talks about.
    await expect(page.locator('.tool-palette')).toHaveClass(/tour-target/);
    await expect(modelPanel(page, 'History')).toBeVisible();

    // Creating the first feature advances the tour by itself.
    await createPrimitiveInPlace(page, 'box');
    await expect(tour).toContainText('Select to edit');

    // So does selecting geometry once the exact build is ready.
    await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
    const canvas = page.locator('.viewer-host canvas');
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();
    await canvas.click({
      position: { x: bounds!.width / 2, y: bounds!.height / 2 }
    });
    await expect(tour).toContainText('The history is the model');
    // History is pinned on a fresh device. Teach its contents directly
    // without asking the user to toggle it closed from the rail.
    const history = page.getByRole('button', {
      name: 'History panel',
      exact: true
    });
    await expect(history).toHaveAttribute('aria-pressed', 'true');
    await expect(
      modelPanel(page, 'History').getByRole('heading', { name: 'History 1' })
    ).toBeVisible();
    await expect(page.locator('.feature-row')).toHaveCount(1);
    await expect(page.getByText(/^Loading feature history/)).toBeHidden();
    await test.info().attach('history-tour-opened-panel', {
      body: await page.screenshot(),
      contentType: 'image/png'
    });

    // The lesson remains visible until Next even though History was open
    // before the tour reached this step (I16).
    await expect(tour).toContainText('The history is the model');
    await expect(tour).toContainText(
      'History on the right lists every feature'
    );
    await expect(tour).toContainText('Drag the grip to reorder');
    await expect(page.locator('.model-panel-history')).toHaveClass(
      /tour-target/
    );
    await expect(history).not.toHaveClass(/tour-target/);
    await tour.getByRole('button', { name: 'Next' }).click();
    // The last step shows where Export lives; Finish on it is the same
    // dismissal as skipping.
    await expect(tour).toContainText('Take it with you');
    await expect(tour).toContainText('File › Export');
    await expect(page.locator('.file-menu > summary')).toHaveClass(
      /tour-target/
    );
    await expect(page.locator('.model-panel-history')).not.toHaveClass(
      /tour-target/
    );
    await tour.getByRole('button', { name: 'Finish' }).click();
    await expect(tour).toHaveCount(0);

    // The dismissal is a device habit: the restored workspace stays clean.
    await page.reload();
    await expect(
      page.getByRole('button', { name: /^Box \(B\)/ })
    ).toBeVisible();
    await expect(tour).toHaveCount(0);
    // A restored model is independently ineligible, so a second EMPTY project
    // proves Finish was persisted as a device habit rather than merely hidden.
    await page.getByTitle('Back to projects').click();
    await page.getByLabel('Project name').fill('Another Tour Part');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(
      page.getByRole('button', { name: /^Box \(B\)/ })
    ).toBeVisible();
    await expect(tour).toHaveCount(0);
  }
);

test('a second empty project picks the tour up where the first left it', async ({
  page
}) => {
  await stubApi(page, {
    workspaceTour: true,
    panelLayout: null,
    commandFoldClosed: true
  });
  await createProject(page, 'Tour First Part');
  const tour = page.locator('.workspace-tour');
  await expect(tour).toContainText('Create your first feature');
  // The rail's foot is named and outlined, not an unlabelled ⋯ (I16).
  await expect(tour).toContainText('More tools (⋯) at its foot');
  await expect(page.locator('.command-more-toggle')).toHaveClass(/tour-target/);
  await createPrimitiveInPlace(page, 'box');
  await expect(tour).toContainText('Select to edit');
  await expect(tour.locator('.workspace-tour-count')).toHaveText('2/4');

  // It began again at 1/4 in every new empty project (I16).
  await page.getByTitle('Back to projects').click();
  await page.getByLabel('Project name').fill('Tour Second Part');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
  await expect(tour).toContainText('Select to edit');
  await expect(tour.locator('.workspace-tour-count')).toHaveText('2/4');
});

test(
  'manual tour advance reveals a closed History control without moving keyboard focus',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page, {
      workspaceTour: true,
      panelLayout: MODEL_ONLY,
      commandFoldClosed: true
    });
    await createProject(page, 'Tour Keyboard Part');

    await createPrimitiveInPlace(page, 'box');

    const tour = page.locator('.workspace-tour');
    await expect(tour).toContainText('Select to edit');
    const next = tour.getByRole('button', { name: 'Next' });
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(tour).toContainText('The history is the model');
    await expect(next).toBeFocused();
    await expect(modelPanel(page, 'History')).toHaveCount(0);
    const history = page.getByRole('button', {
      name: 'History panel',
      exact: true
    });
    await expect(history).toBeVisible();
    await expect(history).toHaveClass(/tour-target/);
    await history.click();
    await expect(modelPanel(page, 'History')).toBeVisible();
    await expect(page.locator('.feature-row')).toHaveCount(1);
    await tour.getByRole('button', { name: 'Skip the tour' }).click();
    await expect(tour).toHaveCount(0);
    await expect(history).not.toHaveClass(/tour-target/);
    // Opening the temporary History panel moves the keyboard into it; leaving
    // the guide returns there rather than back to its rail opener.
    await expect(modelPanel(page, 'History')).toBeFocused();

    await page.reload();
    await expect(
      page.getByRole('button', { name: /^Box \(B\)/ })
    ).toBeVisible();
    await expect(tour).toHaveCount(0);
    await page.getByTitle('Back to projects').click();
    await page.getByLabel('Project name').fill('Another Keyboard Tour Part');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(
      page.getByRole('button', { name: /^Box \(B\)/ })
    ).toBeVisible();
    await expect(tour).toHaveCount(0);
  }
);

test('a project that opens with history never shows the tour', async ({
  page
}) => {
  await stubApi(page, { workspaceTour: true });
  await createProject(page, 'Veteran Part');
  await createPrimitiveInPlace(page, 'box');
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  // Leave WITHOUT skipping — the exit through the project list flushes the
  // local save, and the dismissal flag stays unset.
  await page.getByTitle('Back to projects').click();
  const savedProject = page.locator('.start-tile-open', {
    hasText: 'Veteran Part'
  });
  await expect(savedProject).toBeVisible();
  await savedProject.click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();

  // The tour was skipped by nobody — the project simply reopens WITH history,
  // so eligibility never latches even though the flag is still unset.
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await expect(page.locator('.workspace-tour')).toHaveCount(0);
});

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

// The guide unmounted for every in-place command, so the card that asked for
// a Box vanished as the Box began, its step and Skip with it (#1947). It stays
// up now, above the command's bar: whole on a desktop, folded to its header
// on a phone, and back as it was when the command ends.
for (const view of [
  { width: 1440, height: 900, touch: false },
  { width: 360, height: 640, touch: true }
]) {
  test.describe(`at ${view.width}px`, () => {
    test.use({ hasTouch: view.touch, isMobile: view.touch });

    test(`the guide stays up above an in-place command's bar at ${view.width}px (#1947)`, async ({
      page
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: view.width, height: view.height });
      await stubApi(page, {
        workspaceTour: true,
        panelLayout: null,
        commandFoldClosed: true
      });
      await createProject(page, 'Tour In Place');
      const tour = page.locator('.workspace-tour');
      await expect(tour).toContainText('Create your first feature');
      const toggle = tour.getByRole('button', { name: /modeling guide$/ });
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await page.keyboard.press('b');
      const bar = page.getByRole('group', { name: 'Box command' });
      await expect(bar).toBeVisible();
      await expect(tour).toBeVisible();
      await expect(toggle).toHaveAttribute(
        'aria-expanded',
        view.touch ? 'false' : 'true'
      );
      await waitForSurfacesToSettle(page, ['.workspace-tour']);
      await test.info().attach(`guide-over-box-bar-${view.width}`, {
        body: await page.screenshot(),
        contentType: 'image/png'
      });
      // Clear of the bar, each taking its own presses.
      const card = (await tour.boundingBox())!;
      const barBox = (await bar.boundingBox())!;
      expect(card.y + card.height).toBeLessThanOrEqual(barBox.y + 0.5);
      for (const control of [
        toggle,
        tour.getByRole('button', { name: 'Skip the tour' }),
        bar.getByRole('button', { name: /^Done/ }),
        bar.getByRole('button', { name: /^Cancel/ })
      ]) {
        await expect.poll(() => reachable(control)).toBe(true);
      }

      // Done makes the Box, and the guide moves on, whole again.
      await bar.getByRole('button', { name: /^Done/ }).click();
      await expect(bar).toBeHidden();
      await expect(tour).toContainText('Select to edit');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      // Enter on the guide's own buttons is theirs, not the command's Done:
      // on Skip it made a second Box and left the guide open (PR review).
      if (!view.touch) {
        await page.keyboard.press('b');
        await expect(bar).toBeVisible();
        await expect(bar.getByRole('button', { name: /^Done/ })).toBeEnabled();
        await tour.getByRole('button', { name: 'Skip the tour' }).focus();
        await page.keyboard.press('Enter');
        await expect(tour).toHaveCount(0);
        await expect(bar).toBeVisible();
        await expect(page.locator('.feature-row')).toHaveCount(1);
      }
    });
  });
}

// The desktop's corner card stood over part of the new box it asks to be
// clicked too, at 1280 × 800 and an undocked 768 × 1024 under a mouse. The
// box is framed above or beside the card now.
for (const [width, height] of [
  [1280, 800],
  [768, 1024]
] as const) {
  test(`the guide leaves the new box clear on a ${width} × ${height} desktop`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height });
    await stubApi(page, { workspaceTour: true });
    await createProject(page, 'Desktop guide box');
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

// A box panned beside the card, clear of it but past the one-rectangle
// clear stage above it, was reframed when Next was pressed (preview check
// on #1969). In plain view, it stays where the user put it.
test('Next leaves a box panned clear beside the guide where it is', async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubApi(page, {
    workspaceTour: true,
    panelLayout: null,
    commandFoldClosed: true
  });
  await createProject(page, 'Desktop guide next');
  const tour = page.locator('.workspace-tour');
  await expect(tour).toBeVisible();
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await expect(tour).toContainText('Select to edit');
  await waitForSurfacesToSettle(page, ['.workspace-tour']);
  await waitForStillViewport(page);
  const canvas = page.locator('.viewer-host canvas');
  const inView = () =>
    canvas.evaluate(
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
  const card = (await tour.boundingBox())!;
  const before = (await inView()).screen!;
  // Pan the box down until its foot is past the card's top, beside it.
  const dy = card.y + 40 - before.bottom;
  const dx = Math.max(0, card.x + card.width + 20 - before.left);
  const x = (before.left + before.right) / 2;
  const y = (before.top + before.bottom) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x + dx, y + dy, { steps: 16 });
  await page.mouse.up({ button: 'right' });
  await waitForStillViewport(page);
  const panned = (await inView()).screen!;
  // The setup this guards: beside the card, past its top, off the card.
  expect(panned.bottom).toBeGreaterThan(card.y);
  expect(panned.left).toBeGreaterThanOrEqual(card.x + card.width);
  expect(panned.right).toBeLessThan(1280);
  await tour.getByRole('button', { name: 'Next' }).click();
  await waitForSurfacesToSettle(page, ['.workspace-tour']);
  await page.waitForTimeout(600);
  await waitForStillViewport(page);
  const after = (await inView()).screen!;
  expect(Math.abs(after.left - panned.left)).toBeLessThan(1);
  expect(Math.abs(after.top - panned.top)).toBeLessThan(1);
  expect(Math.abs(after.right - panned.right)).toBeLessThan(1);
});
