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
 * AS04 and M09 in a real browser. Assemble's Interference check runs the
 * exact kernel clash query on every pair of posed parts in the geometry
 * worker and shows each overlap's witness; moving a part marks the result out
 * of date. The section cut highlights bodies overlapping inside it and says
 * that highlight is display evidence, not an exact check.
 */
const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

/**
 * Two 60 × 4 × 12 blades modelled in the same place (so, as assembled at
 * 0°, they share all 2880 mm³), pinned about Z, and a pin parked 100 mm away.
 */
function clashingBlades(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  for (const bodyName of ['Blade A', 'Blade B']) {
    document = addPrimitiveFeature(document, {
      name: bodyName,
      bodyName,
      primitiveKind: 'box',
      dimensions: { width: 60, height: 4, depth: 12 }
    });
  }
  document = addPrimitiveFeature(document, {
    name: 'Pin',
    bodyName: 'Pin',
    primitiveKind: 'cylinder',
    dimensions: { radius: 3, height: 10 }
  });
  const [a, b, pin] = document.bodyOrder as [BodyId, BodyId, BodyId];
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'comp_a', name: 'Blade A', bodyId: a, grounded: true },
      { componentId: 'comp_b', name: 'Blade B', bodyId: b, grounded: false },
      {
        componentId: 'comp_pin',
        name: 'Pin',
        bodyId: pin,
        grounded: true,
        placement: {
          ...IDENTITY_PLACEMENT,
          translation: { x: 100, y: 0, z: 0 }
        }
      }
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

interface OverlapRenderState {
  sectionOverlaps: { pair: string[]; triangles: number }[];
}

async function overlapState(page: Page): Promise<OverlapRenderState> {
  return page.locator('.viewer-host canvas').evaluate(
    (canvas: HTMLCanvasElement) =>
      new Promise<OverlapRenderState>((resolve) => {
        canvas.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: { resolve }
          })
        );
      })
  );
}

test(
  'checks assembled parts for exact interference with witnesses, and highlights overlap in the section cut as display evidence (AS04, M09)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const document = clashingBlades('Assembly interference');
    await openDocument(page, document);
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Assembly' });
    const interference = panel.getByRole('region', { name: 'Interference' });
    const status = interference.getByRole('status');
    await expect(status).toHaveText(
      'Checks every pair of parts as assembled, with the exact kernel.'
    );

    // Exact check of all three pairs in the geometry worker.
    await interference.getByRole('button', { name: 'Check' }).click();
    await expect(status).toHaveText('1 pair overlap.', { timeout: 60_000 });
    const overlap = interference.getByRole('button', {
      name: 'Blade A and Blade B: 2880 mm³'
    });
    await expect(overlap).toBeVisible();
    // The pin, 100 mm away, is clear of both blades.
    await expect(interference).toContainText('2 pairs clear');

    // The witness: which exact boolean measured it, the shared region and a
    // point inside both parts. Picking the pair picks both parts.
    await overlap.click();
    await expect(overlap).toHaveAttribute('aria-expanded', 'true');
    const witness = interference.locator('.assembly-interference-witness');
    await expect(witness).toContainText(
      '2880 mm³ shared, measured by an exact intersection.'
    );
    await expect(witness).toContainText('Overlap region 60 × 4 × 12 mm.');
    await expect(witness).toContainText('Inside both at (');
    await expect(
      overlap.locator('xpath=ancestor::li[1]')
    ).toHaveClass(/\bis-selected\b/);

    // M09: the section cut through the blades shows their overlap, drawn on
    // the cut and labelled as display evidence. The pin is not in it.
    const sectionButton = page.getByRole('button', { name: /^Section view/ });
    await sectionButton.click();
    await expect(sectionButton).toHaveAttribute('aria-pressed', 'true');
    // Assemble keeps the toolbox put away and says the cut is on in a chip,
    // which carries the overlap note. The default cut is XY through the
    // middle of the model, across both blades.
    const chip = page.getByRole('group', { name: 'Section view on' });
    await expect(chip).toContainText('XY plane');
    const note = chip.getByRole('note');
    await expect(note).toHaveText(
      /^Overlap in this cut: Blade A and Blade B \(about 240 mm²\)\. Display evidence from the meshes on screen, not an exact clash check\.$/
    );
    await expect
      .poll(async () =>
        (await overlapState(page)).sectionOverlaps.map((o) => o.pair.length)
      )
      .toEqual([2]);
    // Turning the cut off clears the highlight with it.
    await chip.getByRole('button', { name: 'Turn off' }).click();
    await expect(chip).toHaveCount(0);
    await expect
      .poll(async () => (await overlapState(page)).sectionOverlaps.length)
      .toBe(0);

    // Turning Blade B about the pivot changes the assembly: the result says
    // it is out of date, and checking again measures the new pose.
    const joints = panel.getByRole('region', { name: 'Joints' });
    await joints.getByText('Pivot', { exact: true }).click();
    const angle = page.getByRole('textbox', { name: 'Angle', exact: true });
    await angle.fill('25');
    await angle.press('Enter');
    await angle.blur();
    await expect(joints).toContainText('25.0°');
    await expect(interference).toContainText(
      'Out of date: the parts or their positions changed since this check.'
    );
    await interference.getByRole('button', { name: 'Check again' }).click();
    await expect(status).toHaveText('1 pair overlap.', { timeout: 60_000 });
    await expect(interference).not.toContainText('Out of date');
    const turned = interference.getByRole('button', {
      name: /^Blade A and Blade B: /
    });
    // Turned 25°, the blades share only a wedge near the pivot.
    const name = (await turned.getAttribute('aria-label')) ?? '';
    const volume = Number(/: ([\d.]+) mm³$/.exec(name)?.[1]);
    expect(volume).toBeGreaterThan(0);
    expect(volume).toBeLessThan(2880);
  }
);
