import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  clickWorldPoint,
  createProject,
  expect,
  modelPanel,
  pressTool,
  revealModelPanel,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U11: Enter on an Objects row reached by keyboard picks that row, as Space
 * does, over an armed face pick and during a Boolean's body picks. It used
 * to open the face's value entry, or run the command's Done, and the row was
 * never picked. A row focused by a click leaves Enter to the command.
 *
 * Synthetic fixture, in mm: Block 20 × 10 × 10 at the origin, Post
 * 10 × 10 × 30 moved by (15, 5, 0), overlapping it.
 */
function twoBoxes(name: string) {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    bodyName: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 10 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Post',
    bodyName: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 30 }
  });
  const [block, post] = document.bodyOrder as [BodyId, BodyId];
  document = transformBody(document, {
    name: 'Place Post',
    targetBodyId: post,
    translation: { x: 15, y: 5, z: 0 }
  }).document;
  return { document, block, post };
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await createProject(page, document.name);
}

/** Tabs from the Objects find field until `row` has keyboard focus. */
async function tabTo(page: Page, row: Locator) {
  await modelPanel(page, 'Objects')
    .getByLabel('Find an object by name')
    .click();
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    if (await row.evaluate((element) => element === document.activeElement))
      return;
  }
  throw new Error('Tab never reached the row.');
}

test('Enter on a keyboard-focused Objects row picks it, over an armed face and during a Subtract', async ({
  page
}) => {
  test.setTimeout(120_000);
  const { document, block, post } = twoBoxes('Objects Enter');
  await openDocument(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  await revealModelPanel(page, 'Objects');
  const objects = modelPanel(page, 'Objects');
  const row = (bodyId: BodyId) =>
    objects.locator(`.body-row-main[data-body-row="${bodyId}"]`);
  const keypad = page.locator('.numeric-keypad');

  // Normal selection: Block's top is the armed pick, so Enter in the
  // viewport would open its value entry. Enter on Post's row picks Post.
  await clickWorldPoint(page, [5, 2, 10]);
  await waitForStillViewport(page);
  await tabTo(page, row(post));
  await page.keyboard.press('Enter');
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', post);
  await expect(row(post)).toHaveAttribute('aria-pressed', 'true');
  await expect(keypad).toHaveCount(0);
  await expect(row(post)).toBeFocused();

  // A Subtract's body picks: Enter on each row picks it, and runs no Done.
  await page.keyboard.press('Escape');
  await pressTool(page, /^Subtract \(X\)/);
  const bar = page.getByRole('group', { name: 'Subtract command' });
  const done = bar.getByRole('button', { name: 'Done' });
  await tabTo(page, row(block));
  await page.keyboard.press('Enter');
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', block);
  await tabTo(page, row(post));
  await page.keyboard.press('Enter');
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${block},${post}`
  );
  await expect(done).toBeEnabled({ timeout: 30_000 });
  // Still running: the second Enter picked Post, it did not finish.
  await expect(bar).toBeVisible();
  await expect(keypad).toHaveCount(0);

  // A row focused by a click leaves Enter to the command: Post clicked off
  // and back on, then Enter is Done.
  await row(post).click();
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', block);
  await row(post).click();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${block},${post}`
  );
  await expect(row(post)).toBeFocused();
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(bar).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.feature-row')).toHaveCount(4);
});
