import {
  addPrimitiveFeature,
  createProjectDocument,
  type PrimitiveInput
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * The Thread command's Options panel: terse rows, custom numbers typed in
 * place, rarely used ones folded under More.
 */

async function openPart(
  page: Page,
  name: string,
  primitiveKind: PrimitiveInput['primitiveKind'],
  dimensions: PrimitiveInput['dimensions']
): Promise<Locator> {
  const document: ProjectDocument = addPrimitiveFeature(
    createProjectDocument(name, toUserId('user_e2e')),
    { name: 'Blank', primitiveKind, dimensions }
  );
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
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
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  return canvas;
}

async function startTool(page: Page, tool: RegExp, title: string) {
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: tool }).click();
  await expect(
    page.getByRole('group', { name: `${title} command` })
  ).toBeVisible();
}

test('Thread options: custom numbers show where they apply, More folds shut', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  const canvas = await openPart(page, 'Thread options', 'cylinder', {
    radius: 8,
    height: 30
  });
  await startTool(page, /^Thread/, 'Thread');
  const bar = page.getByRole('group', { name: 'Thread command' });
  await expect(bar).toContainText('Pick a cylindrical face');
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          new Promise<unknown>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-cylinder', {
                detail: { surface: 'wall', select: true, resolve }
              })
            );
          })
      )
    )
    .not.toBeNull();
  await expect(bar).toContainText('Enter to finish');
  await bar.getByLabel('Thread options').click();
  const panel = page.locator('.in-place-params');
  await expect(panel.getByRole('radio', { name: 'Printable' })).toBeVisible();
  // Folded: More's rows stay out of sight until it is opened.
  const hand = panel.getByRole('radiogroup', { name: 'Hand' });
  await expect(hand).toBeHidden();
  await panel.getByRole('button', { name: 'More' }).click();
  await expect(hand).toBeVisible();
  await expect(panel.getByText('Starts', { exact: true })).toBeVisible();
  // A custom fit is a gap typed in place.
  await expect(panel.getByText('Gap', { exact: true })).toHaveCount(0);
  await panel
    .getByRole('radiogroup', { name: 'Fit' })
    .getByRole('radio', { name: 'Custom' })
    .click();
  await expect(panel.getByText('Gap', { exact: true })).toBeVisible();
});
