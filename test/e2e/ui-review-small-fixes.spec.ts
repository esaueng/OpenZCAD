import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  createProject,
  expect,
  modelPanel,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * Small findings from the 16 November design review (UX-002, UX-004,
 * UX-005, UX-006, UX-009), each checked where it depends on real layout or
 * real focus. UX-008's chip names are checked in point-pattern.spec.ts.
 */

/** A sketch and the extrude built on it: deleting the sketch asks first. */
async function openSketchAndExtrude(page: Page) {
  await stubApi(page, { panelLayout: null, commandFoldClosed: true });
  const sketch = addSketchFeature(
    createProjectDocument('Review fixture', toUserId('user_e2e')),
    {
      name: 'Sketch 01',
      plane: 'XY',
      offset: 0,
      objects: [
        {
          objectKind: 'rectangle',
          width: 25,
          height: 10,
          centerX: 0,
          centerY: 0
        }
      ]
    }
  );
  const document = extrudeSketch(sketch.document, {
    name: 'Extrude',
    sketchId: sketch.sketchId,
    distance: '12'
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
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('toolbar', { name: 'Model panels' })).toBeVisible(
    { timeout: 30_000 }
  );
}

/** The scrolling body of the History panel. */
function historyBody(page: Page) {
  return modelPanel(page, 'History').locator('.model-panel-body').first();
}

test.describe('UX-002: the first-model guide in a narrow mouse window', () => {
  for (const size of [
    { width: 320, height: 768 },
    { width: 390, height: 844 }
  ]) {
    test(`stays inside a ${size.width}px window with a fine pointer`, async ({
      page
    }) => {
      // The default context: no touch, a fine pointer.
      expect(
        await page.evaluate(() => matchMedia('(pointer: fine)').matches)
      ).toBe(true);
      await page.setViewportSize(size);
      await stubApi(page, {
        workspaceTour: true,
        panelLayout: null,
        commandFoldClosed: true
      });
      await createProject(page, 'Narrow tour');
      const tour = page.locator('.workspace-tour');
      await expect(tour).toBeVisible();
      await expect
        .poll(async () => (await tour.boundingBox())?.x ?? -1)
        .toBeGreaterThanOrEqual(0);
      // Past its entrance animation.
      await tour.evaluate((element) =>
        Promise.all(element.getAnimations().map((a) => a.finished))
      );
      const card = (await tour.boundingBox())!;
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width).toBeLessThanOrEqual(size.width);
      // Between the rails, as on touch: clear of the instrument rail too.
      const rail = (await page.locator('.instrument-rail').boundingBox())!;
      expect(card.x + card.width).toBeLessThanOrEqual(rail.x);
      for (const name of ['Next', 'Skip the tour']) {
        const button = tour.getByRole('button', { name, exact: true });
        await expect(button, `${name} present`).toHaveCount(1);
        const box = (await button.boundingBox())!;
        expect(box.x, `${name} inside`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${name} inside`).toBeLessThanOrEqual(
          size.width
        );
      }
    });
  }

  test('keeps its desktop width and corner', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await stubApi(page, {
      workspaceTour: true,
      panelLayout: null,
      commandFoldClosed: true
    });
    await createProject(page, 'Wide tour');
    const tour = page.locator('.workspace-tour');
    await expect(tour).toBeVisible();
    await tour.evaluate((element) =>
      Promise.all(element.getAnimations().map((a) => a.finished))
    );
    expect((await tour.boundingBox())!.width).toBe(296);
  });
});

test.describe('UX-004: a refused backup says why in full', () => {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 }
  ]) {
    test(`wraps the reason at ${size.width}px without repeating the name`, async ({
      page
    }) => {
      await page.setViewportSize(size);
      await stubApi(page, { panelLayout: null, commandFoldClosed: true });
      await createProject(page, 'Restore target');
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'parent-invalid-backup.openzcad',
        mimeType: 'application/json',
        buffer: Buffer.from('{"format":"openzcad-project","document":')
      });
      const pill = page.locator('.activity-pill.error');
      await expect(pill).toBeVisible({ timeout: 15_000 });
      const detail = pill.locator('.activity-pill-detail');
      await expect(detail).toHaveText(
        'Not a readable OpenZCAD project backup. It may be damaged or incomplete.'
      );
      // Every line of it is drawn: nothing clipped or ellipsized.
      const fits = await detail.evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth &&
          element.scrollHeight <= element.clientHeight + 1 &&
          getComputedStyle(element).textOverflow !== 'ellipsis'
      );
      expect(fits).toBe(true);
      const card = (await pill.boundingBox())!;
      expect(card.x + card.width).toBeLessThanOrEqual(size.width);
      const box = (await detail.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(card.y + card.height);
    });
  }
});

test('UX-005: cancelling a History delete returns to its More actions', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSketchAndExtrude(page);
  await revealModelPanel(page, 'History');
  const more = page.getByRole('button', { name: 'More actions for Sketch 01' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: /^Delete/ })).toBeFocused();
  await page.keyboard.press('Enter');
  const prompt = page.getByRole('alertdialog');
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(more).toBeFocused();

  // And by Cancel itself, the other way out.
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(prompt).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(prompt).toHaveCount(0);
  await expect(more).toBeFocused();
});

test('UX-006: Find a step fits the History panel and Tab never shifts it', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSketchAndExtrude(page);
  await revealModelPanel(page, 'History');
  const body = historyBody(page);
  const overflow = () =>
    body.evaluate((element) => ({
      scrollLeft: element.scrollLeft,
      over: element.scrollWidth - element.clientWidth
    }));
  await modelPanel(page, 'History')
    .getByRole('button', { name: 'Find a step' })
    .click();
  const field = page.getByRole('searchbox', { name: 'Find a step' });
  await expect(field).toBeFocused();
  expect(await overflow()).toEqual({ scrollLeft: 0, over: 0 });
  const find = (await page.locator('.history-find').boundingBox())!;
  const panel = (await body.boundingBox())!;
  expect(find.x + find.width).toBeLessThanOrEqual(panel.x + panel.width);
  // Through the first row's controls to its More actions, and one past it.
  const more = page.getByRole('button', { name: 'More actions for Sketch 01' });
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Tab');
    if (await more.evaluate((element) => element === document.activeElement))
      break;
  }
  await expect(more).toBeFocused();
  expect(await overflow()).toEqual({ scrollLeft: 0, over: 0 });
  await page.keyboard.press('Tab');
  expect(await overflow()).toEqual({ scrollLeft: 0, over: 0 });
});

test('UX-009: Section view while measuring shows its controls and says so', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSketchAndExtrude(page);
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '1',
    { timeout: 30_000 }
  );
  const measure = page.getByRole('button', { name: 'Measure', exact: true });
  await measure.click();
  await expect(measure).toHaveAttribute('aria-pressed', 'true');
  const section = page.getByRole('button', { name: /^Section view/ });
  await section.click();
  // Measure yields the lane, as the views flyout does: the controls the
  // button announces are the ones on screen.
  await expect(measure).toHaveAttribute('aria-pressed', 'false');
  await expect(section).toHaveAttribute('aria-pressed', 'true');
  await expect(section).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('group', { name: 'Section view' })).toBeVisible();

  // Measure again: the controls step aside and the button says so.
  await measure.click();
  await expect(measure).toHaveAttribute('aria-pressed', 'true');
  await expect(section).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.rail-section-panel')).toBeHidden();
});
