import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  createProject,
  expect,
  expectBodyCount,
  promptField,
  stubApi,
  test
} from './openzcad-fixtures';

/** Three 10 mm boxes, opened as a fresh project. */
function threeBoxes(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  for (const [index, bodyName] of ['Base', 'Lug', 'Pin'].entries()) {
    document = addPrimitiveFeature(document, {
      name: bodyName,
      bodyName,
      primitiveKind: 'box',
      dimensions: { width: 10 + index * 10, height: 10, depth: 10 }
    });
  }
  return document;
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
  await expectBodyCount(page, 3);
}

const objectsList = (page: Page) => page.getByRole('list', { name: 'Objects' });

/** The names of the Objects rows, folders and bodies, top to bottom. */
async function rowNames(page: Page): Promise<string[]> {
  return objectsList(page)
    .locator('[role="listitem"] .feature-name')
    .allTextContents();
}

const row = (page: Page, name: string) =>
  objectsList(page)
    .getByRole('listitem')
    .filter({
      has: page.locator('.feature-name', { hasText: new RegExp(`^${name}$`) })
    });

/** An HTML5 drag with the real mouse: the drop target appears mid-drag. */
async function dragRow(page: Page, source: Locator, target: () => Locator) {
  const from = await source.locator('.feature-name').boundingBox();
  await page.mouse.move(from!.x + 4, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + 12, from!.y + from!.height / 2 + 6, {
    steps: 4
  });
  const to = await target().boundingBox();
  await page.mouse.move(to!.x + 20, to!.y + to!.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('renames a body and files bodies in folders, through undo and a reload (U06)', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openDocument(page, threeBoxes('Objects folders'));
  const list = objectsList(page);
  await expect.poll(() => rowNames(page)).toEqual(['Base', 'Lug', 'Pin']);

  // ZC-127: rename in place, one undoable step.
  await list.getByRole('button', { name: 'Rename body Base' }).click();
  const field = list.getByRole('textbox', { name: 'Rename body Base' });
  await expect(field).toBeFocused();
  await field.fill('Frame base');
  await field.press('Enter');
  await expect(
    list.getByRole('button', { name: 'Frame base', exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    list.getByRole('button', { name: 'Base', exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(
    list.getByRole('button', { name: 'Frame base', exact: true })
  ).toBeVisible();

  // ZC-128: a folder made from the selection, named in place.
  await list.getByRole('button', { name: 'Lug', exact: true }).click();
  await list
    .getByRole('button', { name: 'Pin', exact: true })
    .click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'New folder' }).click();
  const folderField = list.getByRole('textbox', {
    name: 'Rename folder Folder 1'
  });
  await expect(folderField).toBeFocused();
  await folderField.fill('Hardware');
  await folderField.press('Enter');
  await expect
    .poll(() => rowNames(page))
    .toEqual(['Hardware', 'Lug', 'Pin', 'Frame base']);

  // Drag a body in, then out again by the top-level target.
  await dragRow(page, row(page, 'Frame base'), () => row(page, 'Hardware'));
  // Inside a folder, bodies keep their history order.
  await expect
    .poll(() => rowNames(page))
    .toEqual(['Hardware', 'Frame base', 'Lug', 'Pin']);
  await expect(row(page, 'Hardware').locator('.feature-flag')).toHaveText('3');
  await dragRow(page, row(page, 'Frame base'), () =>
    list.getByText('Move to top level')
  );
  await expect(row(page, 'Hardware').locator('.feature-flag')).toHaveText('2');
  await expect(list.getByText('Move to top level')).toHaveCount(0);

  // The folder's eye hides everything in it; collapsing folds its rows.
  await list.getByRole('button', { name: 'Hide folder Hardware' }).click();
  await expect(
    list.getByRole('button', { name: 'Show body Lug' })
  ).toBeAttached();
  await list.getByRole('button', { name: 'Collapse folder Hardware' }).click();
  await expect.poll(() => rowNames(page)).toEqual(['Hardware', 'Frame base']);

  // The model and the folders reach the device store, then reload.
  await expect(page.locator('.save-state')).toHaveClass(/is-(synced|local)\b/);
  await page.reload();
  await expect
    .poll(() => rowNames(page), { timeout: 30_000 })
    .toEqual(['Hardware', 'Frame base']);
  // Still hidden: the folder's eye is view state kept with the project view.
  await expect(
    list.getByRole('button', { name: 'Show folder Hardware' })
  ).toHaveAttribute('aria-pressed', 'true');
  await list.getByRole('button', { name: 'Expand folder Hardware' }).click();
  await expect
    .poll(() => rowNames(page))
    .toEqual(['Hardware', 'Lug', 'Pin', 'Frame base']);
});

test('command search lists recent commands first and filters to the pick (U05)', async ({
  page
}) => {
  test.setTimeout(90_000);
  await openDocument(page, threeBoxes('Command search'));
  const search = promptField(page);
  const options = page
    .getByRole('listbox', { name: 'Commands' })
    .getByRole('option');

  // Initials find a command; running one from search makes it recent.
  await search.fill('/lp');
  await expect(options.first()).toContainText('Linear pattern');
  await search.fill('/fit');
  await expect(options.first()).toContainText('Fit view');
  await search.press('Enter');
  await search.fill('/');
  await expect(options.first()).toContainText('Fit view');
  await expect(options.first()).toContainText('Recent');

  // With a body picked, the empty search lists what acts on a body.
  await page.keyboard.press('Escape');
  await objectsList(page)
    .getByRole('button', { name: 'Lug', exact: true })
    .click();
  await search.fill('/');
  await expect(page.locator('.command-bar-keys')).toContainText('For 1 body');
  await expect(
    options.filter({
      has: page.locator('.palette-label', { hasText: /^Shell$/ })
    })
  ).toHaveCount(1);
  await expect(
    options.filter({
      has: page.locator('.palette-label', { hasText: /^Box$/ })
    })
  ).toHaveCount(0);
  // A typed search still reaches it.
  await search.fill('/box');
  await expect(options.first()).toContainText('Box');
});
