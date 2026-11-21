import type { Page } from '@playwright/test';
import {
  addAssemblyComponents,
  addAssemblyJoint,
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  createProject,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';
import { stepOccurrenceFrames } from './step-occurrence-frames';

/**
 * AS04 STEP hierarchy round-trip in a real browser: File › STEP writes an
 * assembly's parts as placed occurrences (its arm turned a quarter turn on
 * its pivot), and importing that file into a fresh project reads both parts
 * back, named after them.
 */
function hinge(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  for (const [bodyName, dimensions] of [
    ['Base', { width: 40, height: 10, depth: 20 }],
    ['Arm', { width: 30, height: 4, depth: 6 }]
  ] as const)
    document = addPrimitiveFeature(document, {
      name: bodyName,
      bodyName,
      primitiveKind: 'box',
      dimensions
    });
  const [base, arm] = document.bodyOrder as [BodyId, BodyId];
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'c_base', name: 'Base', bodyId: base, grounded: true },
      { componentId: 'c_arm', name: 'Arm', bodyId: arm, grounded: false }
    ]
  });
  const pivot = {
    origin: { x: 5, y: 5, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 }
  };
  return addAssemblyJoint(document, {
    joint: {
      id: 'j_pivot',
      name: 'Pivot',
      kind: 'revolute',
      parent: { componentId: 'c_base', frame: pivot },
      child: { componentId: 'c_arm', frame: pivot },
      values: [90],
      limits: [null]
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

test(
  'exports an assembly as placed STEP parts and reads it back (AS04)',
  { tag: '@ci-smoke' },
  async ({ page, browser }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDocument(page, hinge('Hinge'));

    const fileMenu = page.locator('details.file-menu');
    await fileMenu.locator('summary').click();
    const downloadPromise = page.waitForEvent('download');
    await fileMenu.getByRole('button', { name: /Export STEP/ }).click();
    const file = await downloadPromise;
    const chunks: Buffer[] = [];
    for await (const chunk of await file.createReadStream())
      chunks.push(chunk as Buffer);
    const step = Buffer.concat(chunks);
    const text = step.toString('utf8');
    // Two parts under the project. The base sits as modelled; the arm's
    // occurrence carries its pose, a quarter turn about Z through (5, 5, 0),
    // written as the inverse frame in the part: origin (0, 10, 0), x along −y.
    expect(text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('1', 'Base'");
    expect(text).toContain("NEXT_ASSEMBLY_USAGE_OCCURRENCE('2', 'Arm'");
    expect(stepOccurrenceFrames(text)).toEqual([
      { origin: [0, 0, 0], x: [1, 0, 0] },
      { origin: [0, 10, 0], x: [0, -1, 0] }
    ]);

    // A fresh project, in a browser with no saved state, reads both parts
    // back from that file.
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL
    });
    const receiver = await context.newPage();
    await stubApi(receiver);
    await receiver.goto('/');
    await receiver.getByLabel('Project name').fill('Receiver');
    await receiver.getByRole('button', { name: 'New project' }).click();
    await expect(
      receiver.getByRole('region', { name: '3D viewport' })
    ).toBeVisible();
    await receiver.getByLabel(/^Import STEP or /).setInputFiles({
      name: 'Hinge.step',
      mimeType: 'application/step',
      buffer: step
    });
    await expectBodyCount(receiver, 2);
    const rows = receiver.locator('.body-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Base' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Arm' })).toHaveCount(1);
    await context.close();
  }
);
