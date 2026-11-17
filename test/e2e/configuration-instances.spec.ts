import {
  addAssemblyComponents,
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  createConfigurations,
  createProjectDocument,
  listParameters,
  setConfigurationCell,
  setParameter,
  updateAssemblyComponent,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type FeatureNode } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

/**
 * F06 slice 4: one configuration per view and per assembly instance. The
 * model's active row is Small (a 20 mm plate with a lug); Large is a 45 mm
 * plate without it. An assembly part, and the View workspace, can each show
 * Large while the model being edited stays Small.
 */
function bracket() {
  let document = createProjectDocument('Bracket', toUserId('user_e2e'));
  document = setParameter(document, { name: 'width', expression: '20' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    bodyName: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 4 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Lug',
    bodyName: 'Lug',
    primitiveKind: 'box',
    dimensions: { width: 4, height: 4, depth: 4 }
  });
  const [plate, lugBody] = document.bodyOrder;
  document = transformBody(document, {
    name: 'Lug placement',
    targetBodyId: lugBody!,
    translation: { x: 0, y: 0, z: 20 }
  }).document;
  const width = listParameters(document)[0]!.parameterId;
  const feature = (name: string) =>
    Object.values(document.nodes).find(
      (node): node is FeatureNode =>
        node.kind === 'feature' && node.name === name
    )!;
  const lug = feature('Lug');
  const placement = feature('Lug placement');
  document = createConfigurations(document, { rowId: 'small', name: 'Small' });
  for (const column of [
    { kind: 'parameter', parameterId: width },
    { kind: 'suppression', featureId: lug.featureId },
    { kind: 'suppression', featureId: placement.featureId }
  ] as const)
    document = addConfigurationColumn(document, { column });
  document = addConfigurationRow(document, { rowId: 'large', name: 'Large' });
  for (const [column, value] of [
    [{ kind: 'parameter', parameterId: width }, '45'],
    [{ kind: 'suppression', featureId: lug.featureId }, true],
    [{ kind: 'suppression', featureId: placement.featureId }, true]
  ] as const)
    document = setConfigurationCell(document, {
      rowId: 'large',
      column,
      value
    });
  document = addAssemblyComponents(document, {
    components: [
      {
        componentId: 'plate',
        name: 'Plate part',
        bodyId: plate!,
        grounded: true
      },
      {
        componentId: 'lug',
        name: 'Lug part',
        bodyId: lugBody!,
        grounded: true
      }
    ]
  });
  // The lug part always shows Small, where its feature is built.
  return updateAssemblyComponent(document, {
    componentId: 'lug',
    configurationId: 'small'
  });
}

/** Each saved assembly part's configuration, by part id. */
async function storedComponents(
  page: Page
): Promise<Record<string, string | null>> {
  return page.evaluate(
    () =>
      new Promise<Record<string, string | null>>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () =>
          reject(new Error('Cannot open saved projects.'));
        request.onsuccess = () => {
          const database = request.result;
          const read = database
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          read.onerror = () => {
            database.close();
            reject(new Error('Cannot read saved projects.'));
          };
          read.onsuccess = () => {
            database.close();
            const project = (
              read.result as {
                assembly?: {
                  components: { id: string; configurationId?: string }[];
                };
              }[]
            ).find((entry) => entry.assembly);
            resolve(
              Object.fromEntries(
                (project?.assembly?.components ?? []).map((component) => [
                  component.id,
                  component.configurationId ?? null
                ])
              )
            );
          };
        };
      })
  );
}

/** Each drawn body's width along X, by name (E2E builds only). */
async function drawn(page: Page): Promise<Record<string, number | null>> {
  return page.evaluate(
    () =>
      JSON.parse(
        window.document.documentElement.dataset.e2eDrawnBodies ?? '{}'
      ) as Record<string, number | null>
  );
}

async function openProject(page: Page) {
  const document = bracket();
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
  await expect
    .poll(() => drawn(page), { timeout: 30_000 })
    .toEqual({
      Plate: 20,
      Lug: 4
    });
}

test(
  'an assembly part and the View workspace each show their own configuration',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openProject(page);

    // Assemble: the part shows Large; the model stays Small.
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Assembly' });
    await panel
      .getByRole('button', { name: 'Plate part', exact: true })
      .click();
    const details = panel.getByLabel('Plate part details');
    const picker = details.getByRole('combobox', { name: 'Configuration' });
    await expect(picker).toHaveValue('');
    await picker.selectOption({ label: 'Large' });
    // The part is drawn 45 wide; the lug, not a part, is still Small's.
    await expect
      .poll(() => drawn(page), { timeout: 30_000 })
      .toEqual({ Plate: 45, Lug: 4 });

    // The choice is one undoable step and survives a reload.
    await page.keyboard.press('Control+z');
    await expect.poll(() => drawn(page)).toEqual({ Plate: 20, Lug: 4 });
    await page.keyboard.press('Control+Shift+z');
    await expect
      .poll(() => drawn(page), { timeout: 30_000 })
      .toEqual({ Plate: 45, Lug: 4 });
    // Reload only once the choice is in the saved project, as a person's
    // next visit would read it.
    await expect
      .poll(async () => (await storedComponents(page)).plate, {
        timeout: 30_000
      })
      .toBe('large');
    await page.reload();
    await expect
      .poll(() => drawn(page), { timeout: 30_000 })
      .toEqual({ Plate: 45, Lug: 4 });

    // View: its own choice, the whole Large row; the model is untouched.
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await expect
      .poll(() => drawn(page), { timeout: 30_000 })
      .toEqual({ Plate: 20, Lug: 4 });
    // The parts list, open unless this device closed it.
    const showParts = page.getByRole('button', {
      name: 'Show the parts list'
    });
    if (await showParts.isVisible()) await showParts.click();
    const viewPicker = page
      .getByRole('complementary', { name: 'Parts' })
      .getByRole('combobox', { name: 'Configuration' });
    await expect(viewPicker).toHaveValue('');
    await viewPicker.selectOption({ label: 'Large' });
    await expect
      .poll(() => drawn(page), { timeout: 30_000 })
      .toEqual({ Plate: 45 });
    // Build still edits Small, and View forgets its choice on the way out.
    await page.getByRole('button', { name: 'Build', exact: true }).click();
    await expect(
      page.getByLabel('Expression for width', { exact: true })
    ).toHaveValue('20');
    await expect
      .poll(() => drawn(page), { timeout: 30_000 })
      .toEqual({ Plate: 20, Lug: 4 });

    // Make Large the model: it suppresses the lug, so the active build has no
    // lug body at all. The lug part still shows Small, built on its own and
    // placed like any part.
    await page.getByRole('radio', { name: 'Use Large', exact: true }).check();
    await expect(
      page.getByLabel('Expression for width', { exact: true })
    ).toHaveValue('45');
    await expect
      .poll(() => drawn(page), { timeout: 30_000 })
      .toEqual({ Plate: 45 });
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    await expect
      .poll(() => drawn(page), { timeout: 30_000 })
      .toEqual({ Plate: 45, Lug: 4 });
    await expect(
      page
        .getByRole('complementary', { name: 'Assembly' })
        .getByText('Body deleted')
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  }
);
