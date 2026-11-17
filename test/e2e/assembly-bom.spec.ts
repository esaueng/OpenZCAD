import type { Download, Page } from '@playwright/test';
import {
  addAssemblyComponents,
  addAssemblyJoint,
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type AssemblyFrame,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createProject,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * AS03 bill of materials in a real browser: its rows are the table the CSV
 * and later drawing rows read (item numbers included), a part picked on the
 * model lights up its row, a row picks its parts, and dragging a part about
 * its joint changes neither the rows nor the exported CSV.
 */
const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

function blades(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
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
  return addAssemblyJoint(document, {
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
  await expectBodyCount(page, document.bodyOrder.length);
}

async function text(download: Promise<Download>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of await (await download).createReadStream())
    chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

test(
  'picks parts from the BOM and the model, and a drag leaves the BOM and its CSV unchanged (AS03)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    // The camera fit, and so where Blade B lands on screen, follows the size.
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDocument(page, blades('Assembly BOM pick'));
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Assembly' });
    const joints = panel.getByRole('region', { name: 'Joints' });
    const parts = panel.getByRole('region', { name: 'Parts' });
    const bom = panel.getByRole('region', { name: 'Bill of materials' });
    const row = (item: number) =>
      bom.getByRole('button', { name: new RegExp(`^Item ${item}: `) });

    // Swing Blade B clear of Blade A so each can be picked on the model.
    await joints.getByText('Pivot', { exact: true }).click();
    const angle = page.getByRole('textbox', { name: 'Angle', exact: true });
    await angle.fill('25');
    await angle.press('Enter');
    await angle.blur();
    await expect(joints).toContainText('25.0°');

    // Item numbers are the table's, the same ones the CSV carries.
    await expect(bom.getByRole('listitem')).toHaveText([
      '1Blade A×1',
      '2Blade B×1'
    ]);
    await expect(row(1)).toHaveAccessibleName('Item 1: Blade A, quantity 1');
    const csvBefore = await text(
      (async () => {
        const pending = page.waitForEvent('download');
        await bom
          .getByRole('button', { name: 'Download bill of materials as CSV' })
          .click();
        return pending;
      })()
    );
    expect(csvBefore.trim().split('\n').slice(0, 1)).toEqual([
      'item,quantity,part,instances,source_body,status'
    ]);
    expect(
      csvBefore
        .trim()
        .split('\n')
        .slice(1)
        .map((line) => line.split(',').slice(0, 4))
    ).toEqual([
      ['1', '1', 'Blade A', 'Blade A'],
      ['2', '1', 'Blade B', 'Blade B']
    ]);

    // A part picked on the model lights up its BOM row.
    await page.mouse.click(930, 445);
    await expect(row(2).locator('xpath=ancestor::li[1]')).toHaveClass(
      /\bis-selected\b/
    );
    await expect(row(1).locator('xpath=ancestor::li[1]')).not.toHaveClass(
      /\bis-selected\b/
    );

    // A BOM row picks its part, shown in Parts too.
    await row(1).click();
    await expect(row(1)).toHaveAttribute('aria-pressed', 'true');
    await expect(row(2)).toHaveAttribute('aria-pressed', 'false');
    await expect(parts.locator('.assembly-row.is-selected')).toHaveCount(1);
    await expect(parts.locator('.assembly-row.is-selected')).toContainText(
      'Blade A'
    );

    // Drag Blade B about its joint to the limit: a pose, not a new part.
    await page.mouse.move(930, 445);
    await page.mouse.down();
    await page.mouse.move(925, 420, { steps: 5 });
    await page.mouse.move(900, 330, { steps: 10 });
    await expect(page.getByText('35.0° · max')).toBeVisible();
    await page.mouse.up();
    await expect(joints).toContainText('35.0°');

    await expect(bom.getByRole('listitem')).toHaveText([
      '1Blade A×1',
      '2Blade B×1'
    ]);
    const csvAfter = await text(
      (async () => {
        const pending = page.waitForEvent('download');
        await bom
          .getByRole('button', { name: 'Download bill of materials as CSV' })
          .click();
        return pending;
      })()
    );
    expect(csvAfter).toBe(csvBefore);
  }
);
