import {
  addPrimitiveFeature,
  configureParameterToggle,
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { expect, stubApi, test } from './openzcad-fixtures';

test.use({ actionTimeout: 10_000 });

test(
  'long panels retain keyboard targets and restore nearby actions',
  { tag: '@ci-smoke' },
  async ({ page, browserName }) => {
    test.setTimeout(90_000);
    let document = createProjectDocument(
      'Long panel controls',
      toUserId('user_e2e')
    );
    for (let index = 0; index < 100; index++)
      document = addPrimitiveFeature(document, {
        name: `Box ${index}`,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
    document = setParameter(
      configureParameterToggle(document, {
        name: 'context_parts',
        bodyIds: document.bodyOrder.slice(1)
      }),
      { name: 'context_parts', expression: '0' }
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
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
        : route.fallback()
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill(document.name);
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(
      page.getByRole('heading', { name: 'Objects 100', exact: true })
    ).toBeVisible({ timeout: 30_000 });
    const objects = page.getByRole('region', { name: 'Objects', exact: true });
    const rows = objects.locator('.body-row');
    const last = rows.last();
    await expect(rows).toHaveCount(100);
    await expect(rows.locator('.body-row-main')).toHaveCount(100);
    await expect(last).toHaveAttribute('data-row-windowed', '');
    await expect(
      last.getByRole('button', { name: 'Change color of Box 99 Body' })
    ).toHaveCount(1);
    await expect(last.locator('.object-rename svg')).toHaveCount(0);
    if (browserName === 'chromium') {
      // DOM role queries alone can miss display-locked controls disappearing
      // from Chromium's real accessibility tree. Keep offscreen actions in
      // screen-reader button lists before any row is focused or scrolled in.
      const accessibility = await page.context().newCDPSession(page);
      await accessibility.send('Accessibility.enable');
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          })
      );
      const tree = await accessibility.send('Accessibility.getFullAXTree');
      const buttonNames = tree.nodes
        .filter((node) => !node.ignored && node.role?.value === 'button')
        .map((node): unknown => node.name?.value);
      expect(buttonNames).toEqual(
        expect.arrayContaining([
          'Change color of Box 99 Body',
          'Rename body Box 99 Body',
          'Isolate body Box 99 Body',
          'Show body Box 99 Body',
          'Suppress Box 99',
          'Roll back history after Box 99',
          'More actions for Box 99',
          'Show Box 99'
        ])
      );
      await accessibility.detach();
    }
    // Actions remain in the accessibility tree even before their row expands.
    await expect(
      last.getByRole('button', { name: 'Show body Box 99 Body', exact: true })
    ).toHaveCount(1);
    // Entering from below must reach the last action, not skip straight to
    // the primary target because the other buttons have not mounted yet.
    await last.evaluate((row) => {
      const after = window.document.createElement('button');
      after.dataset.afterWindowedRow = '';
      row.after(after);
      after.focus({ preventScroll: true });
    });
    await expect(last).toHaveAttribute('data-row-windowed', '');
    await page.keyboard.press('Shift+Tab');
    await expect(
      last.getByRole('button', { name: 'Show body Box 99 Body', exact: true })
    ).toBeFocused();
    await page
      .locator('[data-after-windowed-row]')
      .evaluate((node) => node.remove());
    const parameters = page.getByRole('region', {
      name: 'Parameters',
      exact: true
    });
    const bindingChoices = parameters.locator('.param-body-choices');
    const bindingSummary = parameters.getByText('Bodies (99)', { exact: true });
    await expect(bindingChoices).toHaveCount(0);
    await bindingSummary.click();
    await expect(bindingChoices.getByRole('checkbox')).toHaveCount(100);
    await expect(
      bindingChoices.getByRole('checkbox', { name: 'Box 99 Body', exact: true })
    ).toBeChecked();
    await bindingSummary.click();
    await expect(bindingChoices).toHaveCount(0);
    await bindingSummary.click();
    await expect(
      bindingChoices.getByRole('checkbox', { name: 'Box 99 Body', exact: true })
    ).toBeChecked();
    await bindingSummary.click();

    // Native focus scrolling can still reach a row whose visual details
    // were omitted. Focus pins those details before the observer catches up.
    const main = last.getByRole('button', { name: 'Box 99 Body', exact: true });
    await expect(main).toHaveAccessibleName('Box 99 Body');
    await main.focus();
    await expect(last.locator('.feature-name')).toBeVisible();
    const swatch = last.getByRole('button', {
      name: 'Change color of Box 99 Body'
    });
    await expect(swatch).toBeVisible();
    await swatch.click();
    const editor = page.getByRole('group', {
      name: 'Appearance of Box 99 Body',
      exact: true
    });
    await expect(editor).toBeVisible();
    await objects.locator('.model-panel-body').evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(last).not.toHaveAttribute('data-row-windowed');
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(swatch).toBeFocused();
    await main.focus();
    await main.press('F2');
    const rename = objects.getByRole('textbox', {
      name: 'Rename body Box 99 Body'
    });
    await rename.fill('Last body');
    await rename.press('Enter');
    await expect(
      last.getByRole('button', { name: 'Last body', exact: true })
    ).toBeFocused();

    const history = page.getByRole('region', { name: 'History', exact: true });
    const steps = history.locator('.feature-row');
    await expect(steps).toHaveCount(100);
    await expect(history.locator('.feature-row-main')).toHaveCount(100);
    await expect(
      steps.last().getByRole('button', { name: 'More actions for Box 99' })
    ).toHaveCount(1);
    await history.locator('.model-panel-body').evaluate((element) => {
      element.scrollTop = 0;
    });
    await steps.last().evaluate((row) => {
      const after = window.document.createElement('button');
      after.dataset.afterWindowedRow = '';
      row.after(after);
      after.focus({ preventScroll: true });
    });
    await expect(steps.last()).toHaveAttribute('data-row-windowed', '');
    await page.keyboard.press('Shift+Tab');
    await expect(
      steps.last().getByRole('button', { name: 'Show Box 99', exact: true })
    ).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(
      steps.last().getByRole('button', { name: 'More actions for Box 99' })
    ).toBeFocused();
    await page
      .locator('[data-after-windowed-row]')
      .evaluate((node) => node.remove());
    const firstStep = steps.first();
    await firstStep.locator('.feature-row-main').focus();
    await expect(firstStep.locator('.history-row-actions')).toBeVisible();
    const more = firstStep.getByRole('button', {
      name: 'More actions for Box 0'
    });
    await more.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await history.locator('.model-panel-body').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(more).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(more).toBeFocused();
    // A distant reorder grip stays reachable too, with its original row index.
    const lastGrip = steps.last().locator('.feature-row-grip');
    await lastGrip.focus();
    await expect(lastGrip).toBeFocused();
    await expect(lastGrip).toHaveAttribute('draggable', 'true');
    await expect(steps.last()).toHaveAttribute('data-history-index', '99');
    await history
      .getByRole('button', { name: 'Find a step', exact: true })
      .click();
    const find = history.getByRole('searchbox', { name: 'Find a step' });
    await find.fill('Box 45');
    await expect(steps).toHaveCount(1);
    await expect(steps.locator('.history-row-actions')).toBeVisible();
    await find.press('Escape');
    await expect(steps).toHaveCount(100);
    expect(errors).toEqual([]);
  }
);
