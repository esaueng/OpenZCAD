import { test, expect, type Page } from '@playwright/test';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

/**
 * The preview server hosts the static SPA without the Worker API, so the
 * handful of API routes the app touches are stubbed here. Everything else —
 * commands, the geometry worker, the viewport, STEP writing — is the real
 * production bundle.
 */
async function stubApi(page: Page) {
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        environment: 'beta',
        time: new Date().toISOString()
      }
    })
  );
  await page.route('**/api/projects', (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as {
        name: string;
        units?: string;
      };
      const document = createProjectDocument(
        payload.name,
        toUserId('user_e2e'),
        (payload.units as 'mm' | undefined) ?? 'mm'
      );
      return route.fulfill({
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
      });
    }
    return route.fulfill({ json: { projects: [] } });
  });
  await page.route('**/api/projects/*/revisions', (route) => {
    const payload = route.request().postDataJSON() as { document: unknown };
    return route.fulfill({ json: payload.document });
  });
  await page.route('**/api/exports', (route) =>
    route.fulfill({ status: 404, json: { error: 'stub' } })
  );
  await page.route('**/api/uploads', (route) =>
    route.fulfill({ status: 404, json: { error: 'stub' } })
  );
}

test('loads the OpenZCAD shell', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.getByText('OpenZCAD')).toBeVisible();
  await expect(page.getByText('parametric cad in the browser')).toBeVisible();
});

test('keeps command names visible at the compact desktop breakpoint', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Palette Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: 'Search commands (Ctrl+K)' }).click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(
    palette.locator('.palette-label', { hasText: 'Box' })
  ).toBeVisible();
  await palette.getByRole('textbox', { name: 'Search commands' }).fill('box');
  await expect(
    palette.locator('.palette-label', { hasText: 'Box' })
  ).toBeVisible();
});

test('keeps every workspace surface inside a narrow viewport', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Narrow Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const selectors = [
    '.topbar',
    '.workspace',
    '.sidebar',
    '.viewer-area',
    '.ai-rail',
    '.status-bar'
  ];
  for (const selector of selectors) {
    const bounds = await page.locator(selector).boundingBox();
    expect(bounds, `${selector} should be laid out`).not.toBeNull();
    expect(
      bounds!.x,
      `${selector} should not start offscreen`
    ).toBeGreaterThanOrEqual(0);
    expect(
      bounds!.x + bounds!.width,
      `${selector} should not end offscreen`
    ).toBeLessThanOrEqual(390.5);
  }

  const sidebarBounds = await page.locator('.sidebar').boundingBox();
  const viewerBounds = await page.locator('.viewer-area').boundingBox();
  expect(viewerBounds!.y).toBeGreaterThanOrEqual(
    sidebarBounds!.y + sidebarBounds!.height - 0.5
  );
  await expect(page.locator('.viewer-rail-stack')).toBeVisible();

  const overflowingTopbarChildren = await page.locator('.topbar').evaluate(
    (topbar) =>
      [...topbar.children].filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < -0.5 || bounds.right > window.innerWidth + 0.5;
      }).length
  );
  expect(overflowingTopbarChildren).toBe(0);
});

test('resizes a literal box by dragging an exact face', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Direct Edit Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  let facePoint: { x: number; y: number } | null = null;
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: bounds!.x + bounds!.width * xRatio,
        y: bounds!.y + bounds!.height * yRatio
      };
      await page.mouse.move(candidate.x, candidate.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) === 'grab'
      ) {
        facePoint = candidate;
        break;
      }
    }
    if (facePoint) {
      break;
    }
  }
  expect(facePoint).not.toBeNull();
  await page.mouse.down();
  await page.mouse.move(facePoint!.x + 72, facePoint!.y - 54, { steps: 6 });
  await page.mouse.up();

  await expect(page.getByRole('contentinfo')).toContainText('Resize Box');
  const dimensions = await Promise.all([
    page.getByLabel('Width (X)').inputValue(),
    page.getByLabel('Height (Y)').inputValue(),
    page.getByLabel('Depth (Z)').inputValue()
  ]);
  expect(dimensions).not.toEqual(['40', '18', '24']);
});

test('fillets all twelve edges of a box in one exact feature', async ({
  page
}) => {
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('All-edge Fillet');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  await page.getByRole('button', { name: /^Fillet/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByRole('button', { name: 'Select all 12 edges' }).click();
  await expect(inspector.locator('.selection-summary')).toContainText(
    '12 exact edges selected'
  );
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const fillet = page.locator('.feature-row', { hasText: 'Fillet' });
  await expect(fillet).toBeVisible();
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await fillet.locator('.feature-row-main').click();
  await expect(page.locator('.panel-body')).toContainText('volume', {
    ignoreCase: true
  });
  await expect(page.locator('.panel-body')).toContainText('faces');
  expect(consoleErrors).toEqual([]);
});

test('grounds an AI fillet request onto every selected edge', async ({ page }) => {
  await stubApi(page);
  type AssistantRequest = {
    digest?: {
      selection?: {
        featureIds?: string[];
        bodyIds?: string[];
        topologies?: Array<{
          bodyId: string;
          kind: string;
          hash: number | null;
        }>;
      };
    };
  };
  let resolveAssistantRequest!: (request: AssistantRequest) => void;
  const assistantRequestPromise = new Promise<AssistantRequest>((resolve) => {
    resolveAssistantRequest = resolve;
  });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'selection-aware-test',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', (route) => {
    const assistantRequest =
      route.request().postDataJSON() as AssistantRequest;
    resolveAssistantRequest(assistantRequest);
    const selection = assistantRequest?.digest?.selection;
    const firstEdge = selection?.topologies?.find(
      (topology) => topology.kind === 'edge' && topology.hash !== null
    );
    const proposal = {
      proposalId: 'proposal_selected_edges_e2e',
      summary: 'Fillet every selected edge by 1 mm.',
      assumptions: [],
      operations: [
        {
          kind: 'add_edge_modifier',
          name: 'AI selected edge fillets',
          localId: null,
          modifier: 'fillet',
          // Deliberately return only the first selected edge. The client-side
          // grounding guard must restore the full explicit selection.
          targetBodyId: firstEdge?.bodyId ?? 'body_hallucinated',
          edgeHashes: [firstEdge?.hash ?? 999],
          size: 1
        }
      ]
    };
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: JSON.stringify(proposal)
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('AI Selection Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  await page.getByRole('button', { name: /^Fillet/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByRole('button', { name: 'Select all 12 edges' }).click();
  await expect(page.getByLabel('CAD change request')).toHaveAttribute(
    'placeholder',
    'Ask OpenZCAD to change 12 selected edges…'
  );
  await page
    .getByLabel('CAD change request')
    .fill('Add fillets of 1 mm on the selected edges');
  await page.getByLabel('CAD change request').press('Enter');

  await expect(page.locator('.ai-proposal.ready')).toContainText(
    'Fillet every selected edge by 1 mm.'
  );
  const assistantRequest = await assistantRequestPromise;
  expect(assistantRequest?.digest?.selection?.featureIds).toHaveLength(1);
  expect(assistantRequest?.digest?.selection?.bodyIds).toHaveLength(1);
  expect(assistantRequest?.digest?.selection?.topologies).toHaveLength(12);

  await page.getByRole('button', { name: 'Apply patch' }).click();
  const fillet = page.locator('.feature-row', {
    hasText: 'AI selected edge fillets'
  });
  await expect(fillet).toBeVisible();
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(page.getByLabel('CAD change request')).toHaveAttribute(
    'placeholder',
    'Ask OpenZCAD to change the model…'
  );
  await expect(page.getByRole('button', { name: 'Deselect all' })).toHaveCount(
    0
  );
});

test('models a parametric part and exports a true STEP file', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');

  // Create a project.
  await page.getByLabel('Project name').fill('E2E Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();

  // Define a parameter the box will use.
  await page.getByLabel('New parameter name').fill('w');
  await page.getByLabel('New parameter expression').fill('30');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.locator('.param-row')).toContainText('w');

  // Box driven by the parameter: 60 x 18 x 24 = 25920.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page.getByLabel('Width (X)').fill('w * 2');
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  // The kernel worker rebuilds and reports real measurements.
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await expect(page.locator('.panel-body')).toContainText('volume', {
    ignoreCase: true
  });
  await expect(page.locator('.panel-body')).toContainText('25920');

  // Tool-first finishing stays active while the user chooses an exact edge.
  const filletTool = page.getByRole('button', { name: /^Fillet/ });
  await expect(filletTool).toBeEnabled();
  await filletTool.click();
  await expect(page.locator('.selection-summary')).toContainText(
    'Select edges in the viewport or select every edge below.'
  );
  await page.keyboard.press('Escape'); // back to the tool launcher

  // Second body and a subtract that consumes both inputs.
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Cylinder' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Subtract \(X\)/ }).click();
  await page.locator('.pick-row', { hasText: 'Box Body' }).click();
  await page.locator('.pick-row', { hasText: 'Cylinder Body' }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row', { hasText: 'Subtract' })
  ).toBeVisible();
  await expect(page.locator('.feature-row.consumed')).toHaveCount(2);

  // Export STEP and verify the download is a real ISO 10303-21 file.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'STEP' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('E2E-Part.step');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text.startsWith('ISO-10303-21;')).toBe(true);
  expect(text).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN");
  expect(text).toContain('MANIFOLD_SOLID_BREP');
  expect(text).toContain('CLOSED_SHELL');
  expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);

  // Parametric regen: change w and confirm the box volume follows (60->80 => 80*18*24).
  const paramInput = page.getByLabel('Expression for w');
  await paramInput.fill('40');
  await paramInput.press('Enter');
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await expect(page.locator('.panel-body')).toContainText('34560');
});

test('viewport context menu hides a body and the sidebar eye restores it', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Visibility Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  // Right-click the body → contextual actions → Hide Body.
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  await canvas.click({
    button: 'right',
    position: { x: bounds.width / 2, y: bounds.height / 2 }
  });
  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: /Move \/ Rotate/ })
  ).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Hide Body' }).click();
  await expect(menu).toBeHidden();

  // Hidden bodies leave the viewport (empty-state notice returns) but stay
  // in the tree with an eye toggle.
  await expect(page.locator('.viewer-notice')).toBeVisible();
  const showButton = page.getByRole('button', { name: /^Show Box/ });
  await expect(showButton).toBeVisible();
  await showButton.click();
  await expect(page.locator('.viewer-notice')).toBeHidden();
});

test('P toggles the camera projection', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Projection Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const orthoButton = page.getByRole('button', { name: /Ortho/ });
  await expect(orthoButton).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('p');
  await expect(orthoButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.status-bar')).toContainText(
    'Projection: orthographic'
  );
  await orthoButton.click();
  await expect(orthoButton).toHaveAttribute('aria-pressed', 'false');
});

test('M opens the move gizmo overlay and applies an exact move', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Move Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  // Single body: pressing M arms the gizmo flow directly.
  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await expect(overlay).toBeVisible();
  await expect(page.getByText(/Drag an arrow to move/)).toBeVisible();

  // Exact values through the overlay commit one undoable Move feature.
  await overlay.getByLabel('Move X in mm').fill('12');
  await overlay.getByLabel('Rotate Z in degrees').fill('45');
  await overlay.getByRole('button', { name: /Apply move/ }).click();

  const moveRow = page.locator('.feature-row', { hasText: 'Move' });
  await expect(moveRow).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(overlay).toBeHidden();

  // Esc cancels a fresh session without touching the model.
  await page.keyboard.press('m');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeHidden();
  await expect(page.locator('.feature-row', { hasText: 'Move' })).toHaveCount(
    1
  );
});
