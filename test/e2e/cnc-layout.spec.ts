import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createProject,
  enableFullRender,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * L09: File › CNC DXF downloads every shown body laid flat, each upward
 * face on the layer of its height and each part labelled, and says which
 * bodies could not be laid flat.
 */
test(
  'CNC cut layout downloads the laid-flat parts as a layered DXF',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    let document = addPrimitiveFeature(
      createProjectDocument('Router parts', toUserId('user_e2e')),
      {
        name: 'Plate',
        bodyName: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, depth: 24, height: 6 }
      }
    );
    document = addPrimitiveFeature(document, {
      name: 'Puck',
      bodyName: 'Puck',
      primitiveKind: 'cylinder',
      dimensions: { radius: 6, height: 4 }
    });
    document = addPrimitiveFeature(document, {
      name: 'Ball',
      bodyName: 'Ball',
      primitiveKind: 'sphere',
      dimensions: { radius: 5 }
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
    await page.setViewportSize({ width: 1440, height: 900 });
    await createProject(page, document.name);
    await expect(page.locator('.body-row', { hasText: 'Ball' })).toBeVisible();

    const fileMenu = page.locator('details.file-menu');
    await fileMenu.locator('summary').click();
    const pending = page.waitForEvent('download');
    await fileMenu
      .getByRole('button', { name: 'Export CNC cut layout (DXF)' })
      .click();
    const file = await pending;
    expect(file.suggestedFilename()).toMatch(/-cnc\.dxf$/);
    const chunks: Buffer[] = [];
    for await (const chunk of await file.createReadStream()) {
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const pairs = text.split('\r\n');
    const layers: string[] = [];
    const labels: string[] = [];
    let entities = 0;
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      if (pairs[i] === '0' && pairs[i + 1] === 'LAYER') {
        layers.push(pairs[i + 3]!);
      }
      if (pairs[i] === '0' && /^(LINE|CIRCLE|ARC)$/.test(pairs[i + 1]!)) {
        entities += 1;
      }
      if (pairs[i] === '0' && pairs[i + 1] === 'TEXT') {
        for (let j = i + 2; j + 1 < pairs.length && pairs[j] !== '0'; j += 2) {
          if (pairs[j] === '1') labels.push(pairs[j + 1]!);
        }
      }
    }
    // The plate lies on a 40 × 24 face, 6 thick; the puck on a cap, 4 tall.
    expect(layers).toEqual(['Z4', 'Z6', 'LABELS']);
    expect(labels).toEqual(['Plate', 'Puck']);
    expect(entities).toBe(4 + 1);
    await expect(
      page.getByText(
        /Exported the CNC cut layout to .*-cnc\.dxf, one layer per face height\. Left out: Ball has no flat face to lay it on\./
      )
    ).toBeVisible();
    expect(errors).toEqual([]);
  }
);
