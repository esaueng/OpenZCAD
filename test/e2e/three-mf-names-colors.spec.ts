import type { Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  setNodeMetadata,
  transformBody
} from '@openzcad/document-core';
import {
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_COLOR_METADATA_KEY,
  DEFAULT_BODY_COLOR,
  toUserId
} from '@openzcad/shared';
import {
  createProject,
  enableFullRender,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';
import { reimportSolids } from '../support/exchange-harness';
import { threeMfObjectLabels } from '../support/three-mf-export';

async function download(page: Page, click: () => Promise<void>) {
  const pending = page.waitForEvent('download');
  await click();
  const file = await pending;
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) {
    chunks.push(chunk as Buffer);
  }
  return { name: file.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

test(
  'the 3MF export names every body and colours it for a slicer',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    let document = createProjectDocument('Slicer parts', toUserId('user_e2e'));
    for (const [index, name] of ['Base & lid', 'Knob'].entries()) {
      document = addPrimitiveFeature(document, {
        name,
        bodyName: name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 5 }
      });
      document = transformBody(document, {
        name: `Place ${name}`,
        targetBodyId: document.bodyOrder.at(-1)!,
        translation: { x: 30 * index, y: 0, z: 0 }
      }).document;
    }
    const knob = Object.values(document.nodes).find(
      (node) => node.kind === 'body' && node.name === 'Knob'
    )!;
    document = setNodeMetadata(document, {
      nodeId: knob.id,
      metadata: {
        [BODY_COLOR_METADATA_KEY]: '#d0342c',
        [BODY_COLOR_CHOSEN_METADATA_KEY]: true
      }
    });

    await enableFullRender(page);
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
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await createProject(page, document.name);
    await expect(
      page.getByRole('region', { name: '3D viewport' })
    ).toBeVisible();
    await expect(page.locator('.body-row', { hasText: 'Knob' })).toBeVisible();

    const fileMenu = page.locator('details.file-menu');
    await fileMenu.locator('summary').click();
    await fileMenu.getByRole('button', { name: /Export mesh/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Export mesh' });
    await dialog.getByRole('radio', { name: '3MF', exact: true }).check();
    const file = await download(page, () =>
      dialog.getByRole('button', { name: 'Export 3MF', exact: true }).click()
    );
    expect(file.name).toMatch(/\.3mf$/);

    const bytes = Uint8Array.from(file.bytes);
    expect(threeMfObjectLabels(bytes)).toEqual([
      { name: 'Base & lid', color: DEFAULT_BODY_COLOR.toUpperCase() },
      { name: 'Knob', color: '#D0342C' }
    ]);
    // Still one object per body, placed and closed.
    const measure = await reimportSolids('3mf', bytes);
    expect(measure.fileObjects).toBe(2);
    expect(measure.watertight).toBe(true);
    expect(measure.volume).toBeCloseTo(1000, 2);
    expect(errors).toEqual([]);
  }
);
