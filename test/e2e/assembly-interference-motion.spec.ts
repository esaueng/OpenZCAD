import type { Page } from '@playwright/test';
import {
  addAssemblyComponents,
  addAssemblyJoint,
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  IDENTITY_PLACEMENT,
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
 * AS04 interference through motion in a real browser: the exact clash query
 * at positions along a slider's travel, in the geometry worker, locating
 * where a pin passing through a block starts and stops overlapping it, and
 * posing the assembly at the worst position on request.
 */
const along = (x: number): AssemblyFrame => ({
  origin: { x, y: 0, z: 0 },
  zAxis: { x: 1, y: 0, z: 0 },
  xAxis: { x: 0, y: 1, z: 0 }
});

/** A 10 mm block, and a 10 mm pin 40 mm left of it on a 0–80 mm slide. */
function passThrough(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  for (const bodyName of ['Block', 'Pin'])
    document = addPrimitiveFeature(document, {
      name: bodyName,
      bodyName,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
  const [block, pin] = document.bodyOrder as [BodyId, BodyId];
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'c_block', name: 'Block', bodyId: block, grounded: true },
      {
        componentId: 'c_pin',
        name: 'Pin',
        bodyId: pin,
        grounded: false,
        placement: {
          ...IDENTITY_PLACEMENT,
          translation: { x: -40, y: 0, z: 0 }
        }
      }
    ]
  });
  return addAssemblyJoint(document, {
    joint: {
      id: 'j_slide',
      name: 'Slide',
      kind: 'slider',
      parent: { componentId: 'c_block', frame: along(-40) },
      child: { componentId: 'c_pin', frame: along(0) },
      values: [0],
      limits: [{ min: 0, max: 80 }]
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
  'checks interference through a slide and shows the worst position (AS04)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDocument(page, passThrough('Interference through motion'));
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Assembly' });
    const interference = panel.getByRole('region', { name: 'Interference' });
    await expect(
      interference
        .getByRole('combobox', { name: 'Motion to check' })
        .locator('option:checked')
    ).toHaveText('Slide (0.0 mm to 80.0 mm)');

    // At the rest position the pin is clear, and the check says that is
    // the pose it read (#2154).
    const status = interference.getByRole('status');
    await interference
      .getByRole('button', { name: 'Check', exact: true })
      .click();
    await expect(status).toHaveText('No parts overlap at the rest position.', {
      timeout: 60_000
    });

    // Along the slide it passes through.
    await interference.getByRole('button', { name: 'Sweep' }).click();
    const row = interference.getByRole('button', {
      name: /^Block and Pin: 30\.\d mm to 49\.\d mm$/
    });
    await expect(row).toBeVisible({ timeout: 90_000 });
    await expect(interference).toContainText(
      '1 pair overlaps along the motion.'
    );
    await expect(interference).toContainText(
      'Sampled: 45 positions, every 2.2 mm'
    );
    await expect(interference).toContainText(
      'An overlap shorter than one step can fall between positions.'
    );

    // The worst position: fully inside, 1000 mm³, and Show poses it.
    await row.click();
    const witness = interference.locator('.assembly-interference-witness');
    await expect(witness).toContainText('Largest overlap at 40.0 mm');
    await expect(witness).toContainText(
      '1000 mm³ shared, measured by an exact intersection.'
    );
    await witness.getByRole('button', { name: 'Show at 40.0 mm' }).click();
    const joints = panel.getByRole('region', { name: 'Joints' });
    await expect(joints).toContainText('40.0 mm');
    // The view now shows the clash; the static result is still of the rest
    // position, and says the view is somewhere else rather than reading as
    // "no parts overlap" over it (#2154).
    await expect(status).toHaveText(
      'No parts overlap at the rest position. The view shows another position, which this check does not cover.'
    );
  }
);
