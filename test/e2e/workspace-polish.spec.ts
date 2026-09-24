import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  seedDismissedWorkspaceTour,
  seedOpenCommandFold,
  seedOpenModelDrawer
} from './openzcad-fixtures';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type SketchObjectData } from '@openzcad/shared';

interface LiveSketchState {
  objects: { id: string; data: SketchObjectData }[];
}

async function readLiveSketch(canvas: Locator): Promise<LiveSketchState> {
  return canvas.evaluate(
    (element) =>
      new Promise<LiveSketchState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: { resolve }
          })
        );
      })
  );
}

function lineAngleDegrees(state: LiveSketchState): number {
  const lines = state.objects
    .map(({ data }) => data)
    .filter(
      (data): data is Extract<SketchObjectData, { objectKind: 'line' }> =>
        data.objectKind === 'line'
    );
  const [a, b] = lines;
  if (!a || !b) {
    throw new Error('Expected two rendered sketch lines.');
  }
  const ax = Number(a.x2) - Number(a.x1);
  const ay = Number(a.y2) - Number(a.y1);
  const bx = Number(b.x2) - Number(b.x1);
  const by = Number(b.y2) - Number(b.y1);
  const cosine = Math.max(
    -1,
    Math.min(1, (ax * bx + ay * by) / Math.hypot(ax, ay) / Math.hypot(bx, by))
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

async function stubApi(page: Page) {
  await seedDismissedWorkspaceTour(page);
  await seedOpenModelDrawer(page);
  await seedOpenCommandFold(page);
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
    // GET lists save states when a project opens; only an explicit save POSTs
    // a document. Reading post data off the GET throws inside the handler and
    // strands the page, so the verb decides first.
    if (route.request().method() !== 'POST') {
      return route.fulfill({ json: { revisions: [], maxRevisions: 50 } });
    }
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

async function createBoxProject(page: Page, name: string) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
}

async function findFacePoint(page: Page) {
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
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
        return candidate;
      }
    }
  }
  throw new Error('no selectable face found');
}

test('exposes the full measurement workbench in View mode', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Measurement Workbench');
  await page.getByRole('button', { name: 'Create project' }).click();

  const workspaceMode = page.getByRole('group', { name: 'Workspace mode' });
  await workspaceMode.getByRole('button', { name: 'View' }).click();
  await page
    .getByRole('toolbar', { name: 'View tools' })
    .getByRole('button', { name: 'Measure' })
    .click();

  const workbench = page.getByLabel('Measurement workbench');
  await expect(workbench).toBeVisible();
  await expect(
    workbench.getByRole('button', { name: 'Smart' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    workbench.getByRole('button', { name: 'Distance' })
  ).toBeVisible();
  await expect(workbench.getByRole('button', { name: 'Angle' })).toBeVisible();
  await expect(workbench.getByLabel('Measurement units')).toHaveValue('mm');
  await expect(workbench.getByLabel('Measurement decimal places')).toHaveValue(
    '2'
  );
  await expect(
    workbench.getByRole('group', { name: 'Radial display' })
  ).toBeVisible();

  await workbench.getByRole('button', { name: 'Angle' }).click();
  await expect(
    workbench.getByText('Pick two straight edges or two planar faces.')
  ).toBeVisible();
});

test('lists bodies in the model browser and selects them from the tree', async ({
  page
}) => {
  await createBoxProject(page, 'Bodies Tree Part');

  const bodies = page.getByRole('list', { name: 'Bodies' });
  await expect(bodies.getByRole('button', { name: /^Box/ })).toBeVisible();

  await bodies.getByRole('button', { name: /^Box/ }).click();
  const chip = page.locator('.selection-chip');
  await expect(chip).toContainText('Box');
  await expect(bodies.getByRole('button', { name: /^Box/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  );

  // The visibility eye hides the body and the history eye restores it.
  await bodies.getByRole('button', { name: 'Hide body Box' }).click();
  await expect(page.locator('.body-row.hidden-body')).toHaveCount(1);
  await bodies.getByRole('button', { name: 'Show body Box' }).click();
  await expect(page.locator('.body-row.hidden-body')).toHaveCount(0);
});

test('names picked faces and edges without raw fingerprints', async ({
  page
}) => {
  await createBoxProject(page, 'Friendly Labels Part');

  const facePoint = await findFacePoint(page);
  await page.mouse.click(facePoint.x, facePoint.y);
  await expect(
    page.getByRole('region', { name: 'Resize Body operation' })
  ).toBeVisible();

  const chip = page.locator('.selection-chip');
  await expect(chip).toContainText('Box');
  await expect(chip).not.toContainText('face:');
  await expect(chip).toContainText(/face/i);

  // The operation card announces its lifecycle state explicitly.
  const card = page.getByRole('region', { name: 'Resize Body operation' });
  await expect(card.locator('.tool-card-phase')).toHaveText('Ready');

  // Dragging collapses the card to a compact, accessible status marker.
  await page.mouse.down();
  await page.mouse.move(facePoint.x + 30, facePoint.y - 20, { steps: 3 });
  await expect(card.locator('.tool-card-phase-dot')).toHaveAttribute(
    'aria-label',
    'Dragging'
  );
  await expect(card.locator('.tool-card-copy > small')).toBeHidden();
  await page.mouse.up();
  await page.waitForTimeout(1200);
});

test('fits the face tool card and orientation cube beside the inspector', async ({
  page
}) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await createBoxProject(page, 'Tool Card Fit Part');

  const facePoint = await findFacePoint(page);
  await page.mouse.click(facePoint.x, facePoint.y);

  const card = page.getByRole('region', { name: 'Resize Body operation' });
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await expect(card).toBeVisible();
  await expect(inspector).toBeVisible();

  const measure = () =>
    page.locator('.viewer-area').evaluate((viewer) => {
      const cardElement = viewer.querySelector<HTMLElement>('.tool-card');
      const copy = viewer.querySelector<HTMLElement>('.tool-card-copy');
      const submode = viewer.querySelector<HTMLElement>('.tool-card-submode');
      const cube = viewer.querySelector<SVGElement>('.orientation-cube');
      const inspectorElement = viewer.querySelector<HTMLElement>(
        '.inspector-float > *'
      );
      if (!cardElement || !copy || !submode || !cube || !inspectorElement) {
        throw new Error('Expected the face tool card, cube, and inspector.');
      }

      const cardBox = cardElement.getBoundingClientRect();
      const copyBox = copy.getBoundingClientRect();
      const submodeBox = submode.getBoundingClientRect();
      const cubeBox = cube.getBoundingClientRect();
      const inspectorBox = inspectorElement.getBoundingClientRect();
      const cubeHit = document.elementFromPoint(
        cubeBox.left + cubeBox.width / 2,
        cubeBox.top + cubeBox.height / 2
      );
      const intersects = (a: DOMRect, b: DOMRect) =>
        a.left < b.right &&
        a.right > b.left &&
        a.top < b.bottom &&
        a.bottom > b.top;

      const title = copy.querySelector<HTMLElement>('.tool-card-title');

      return {
        cardContainsItsContents:
          cardElement.scrollWidth <= cardElement.clientWidth &&
          cardElement.scrollHeight <= cardElement.clientHeight,
        copyIntersectsSubmode: intersects(copyBox, submodeBox),
        // The operation's own name is the last thing that may be dropped.
        titleReadsInFull: Boolean(
          title && title.scrollWidth <= title.clientWidth + 1
        ),
        copyWidth: copyBox.width,
        cubeIntersectsCard: intersects(cubeBox, cardBox),
        cubeIntersectsInspector: intersects(cubeBox, inspectorBox),
        cubeOwnsItsCentre: Boolean(cubeHit && cube.contains(cubeHit)),
        cardBox: {
          left: cardBox.left,
          right: cardBox.right,
          top: cardBox.top,
          bottom: cardBox.bottom
        },
        copyBox: {
          left: copyBox.left,
          right: copyBox.right,
          top: copyBox.top,
          bottom: copyBox.bottom
        },
        submodeBox: {
          left: submodeBox.left,
          right: submodeBox.right,
          top: submodeBox.top,
          bottom: submodeBox.bottom
        },
        cubeBox: {
          left: cubeBox.left,
          right: cubeBox.right,
          top: cubeBox.top,
          bottom: cubeBox.bottom
        },
        inspectorBox: {
          left: inspectorBox.left,
          right: inspectorBox.right,
          top: inspectorBox.top,
          bottom: inspectorBox.bottom
        }
      };
    });

  // The card used to be a single flex row whose action tabs refused to
  // shrink: below ~1000px the copy was squeezed to two characters and the
  // tabs still crossed it. Every width the app is used at has to hold.
  for (const width of [1440, 1100, 990, 900]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(150);
    const geometry = await measure();
    const where = `at ${width}px: ${JSON.stringify(geometry, null, 2)}`;

    expect(geometry.cardContainsItsContents, where).toBe(true);
    expect(geometry.copyIntersectsSubmode, where).toBe(false);
    expect(geometry.cubeIntersectsCard, where).toBe(false);
    expect(geometry.cubeIntersectsInspector, where).toBe(false);
    expect(geometry.cubeOwnsItsCentre, where).toBe(true);
    expect(geometry.titleReadsInFull, where).toBe(true);
    expect(geometry.copyWidth, where).toBeGreaterThan(150);
  }
});

test('opens long tool-card diagnostics in the Activity log', async ({
  page
}) => {
  await stubApi(page);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/');

  await page.evaluate(() => {
    // The deterministic modeling fixtures return a plain refusal, so mount
    // the production compact-card and Activity-log markup for this state.
    const card = document.createElement('section');
    card.className = 'tool-card phase-failed';
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', 'Edit Fillet operation');
    card.style.position = 'fixed';
    card.style.zIndex = '9999';
    card.innerHTML = `
      <span class="tool-card-icon" aria-hidden="true"></span>
      <span class="tool-card-copy">
        <strong>
          <span class="tool-card-title">Edit Fillet</span>
          <span class="tool-card-phase pill-failed">Failed</span>
        </strong>
        <span class="tool-card-diagnostic" role="alert">
          <span class="tool-card-error">The exact kernel could not build this result.</span>
          <button type="button" class="activity-log-link">View details</button>
        </span>
      </span>
      <button type="button" class="tool-card-close" aria-label="Dismiss Edit Fillet"></button>
    `;
    document.body.append(card);

    const log = document.createElement('section');
    log.className = 'status-log-panel';
    log.setAttribute('role', 'region');
    log.setAttribute('aria-label', 'Activity log');
    log.hidden = true;
    log.innerHTML = `
      <ol class="status-log-list">
        <li class="status-log-entry current">
          <i class="warning"></i><time>02:28:17 AM</time>
          <span class="status-log-copy">
            <span>The exact kernel could not build this result.</span>
            <span class="status-log-detail">resize-blend-failed:resize_blend_exact_reconstruction_refused:planar_support_heal_failed:defeature:unsupported_configuration:kept_face_16_is_not_cylinder_surface</span>
          </span>
        </li>
      </ol>
    `;
    document.body.append(log);
    card.querySelector('.activity-log-link')?.addEventListener('click', () => {
      log.hidden = false;
    });
  });

  const card = page.getByRole('region', { name: 'Edit Fillet operation' });
  await expect(card).not.toContainText('resize-blend-failed');
  await card.getByRole('button', { name: 'View details' }).click();
  const log = page.getByRole('region', { name: 'Activity log' });
  await expect(log).toBeVisible();
  await expect(log).toContainText('resize-blend-failed');
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1
    )
  ).toBe(true);
});

test('keeps a chained line anchored across committed sketch entities', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Continuous Line Chain');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  // The sketch rail owns the session: the modeling palette must not stay
  // mounted and live beside it.
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toHaveCount(0);
  // Screen-space clicks must wait until the head-on entry tween settles.
  await page.waitForTimeout(800);

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const center = {
    x: bounds!.x + bounds!.width / 2,
    y: bounds!.y + bounds!.height / 2
  };
  const corners = [
    { x: center.x - 80, y: center.y - 60 },
    { x: center.x + 80, y: center.y - 60 },
    { x: center.x + 80, y: center.y + 60 },
    { x: center.x - 80, y: center.y + 60 },
    { x: center.x - 80, y: center.y - 60 }
  ];
  for (const corner of corners) {
    await page.mouse.click(corner.x, corner.y);
  }

  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  // Extrude stays in place: the profile arms the drag-arrow rig directly (no
  // create form), which only happens once the chain closed into one region.
  await expect(page.getByRole('contentinfo')).toContainText(
    'Closed sketch profile selected',
    { timeout: 20_000 }
  );
});

test('places, retypes, solves, and undoes a driving angle dimension', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Driving Angle');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('New parameter name').fill('angle_target');
  await page.getByLabel('New parameter expression').fill('60');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.getByLabel('Expression for angle_target')).toHaveValue(
    '60'
  );
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await page.waitForTimeout(800);

  // The sketch settings are a disclosure under the tools, closed to begin with.
  if (
    !(await page.getByRole('checkbox', { name: 'Snap to grid' }).isVisible())
  ) {
    await page.getByRole('button', { name: /Sketch palette/ }).click();
  }
  const gridSnap = page.getByRole('checkbox', { name: 'Snap to grid' });
  if (await gridSnap.isChecked()) {
    await gridSnap.uncheck();
  }
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const p0 = {
    x: bounds!.x + bounds!.width * 0.22,
    y: bounds!.y + bounds!.height * 0.62
  };
  const p1 = {
    x: bounds!.x + bounds!.width * 0.4,
    y: p0.y
  };
  const p2 = {
    x: bounds!.x + bounds!.width * 0.52,
    y: bounds!.y + bounds!.height * 0.42
  };
  await page.mouse.click(p0.x, p0.y);
  await page.mouse.click(p1.x, p1.y);
  await page.mouse.click(p2.x, p2.y);

  const relations = page.getByRole('toolbar', { name: 'Relations' });
  const angleTool = relations.getByRole('button', {
    name: 'Angle',
    exact: true
  });
  await expect(angleTool).toBeEnabled();
  await angleTool.click();
  await page.mouse.click((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
  await page.mouse.click((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Angle: click to place the value.'
  );
  await page.mouse.click(p1.x - 20, p1.y - 120);

  const initialEditor = page.getByRole('dialog', { name: 'Angle value' });
  await expect(initialEditor).toBeVisible();
  await initialEditor.getByRole('button', { name: 'Apply angle' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Angle dimension added',
    { timeout: 30_000 }
  );
  const baseline = await readLiveSketch(canvas);

  const canvasDimension = page.getByRole('button', {
    name: /^Edit driving angle:/
  });
  await expect(canvasDimension).toBeVisible();
  await expect(canvasDimension).toContainText('Driving');
  await canvasDimension.click();
  const editor = page.getByRole('dialog', { name: 'Angle value' });
  const input = editor.getByRole('textbox');
  await input.fill('angle_target');
  await editor.getByRole('button', { name: 'Apply angle' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Angle dimension updated',
    { timeout: 30_000 }
  );

  const solved = await readLiveSketch(canvas);
  expect(lineAngleDegrees(solved)).toBeCloseTo(60, 6);
  await expect(canvasDimension).toContainText('angle_target = 60°');
  expect(solved.objects).not.toEqual(baseline.objects);

  const parameter = page.getByLabel('Expression for angle_target');
  await parameter.fill('45');
  await parameter.press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Parameter angle_target updated',
    { timeout: 30_000 }
  );
  const rebound = await readLiveSketch(canvas);
  expect(lineAngleDegrees(rebound)).toBeCloseTo(45, 6);
  await expect(canvasDimension).toContainText('angle_target = 45°');
  expect(rebound.objects).not.toEqual(solved.objects);

  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => JSON.stringify((await readLiveSketch(canvas)).objects))
    .toBe(JSON.stringify(solved.objects));
  await expect(parameter).toHaveValue('60');
  await expect(canvasDimension).toContainText('angle_target = 60°');
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => JSON.stringify((await readLiveSketch(canvas)).objects))
    .toBe(JSON.stringify(baseline.objects));
  await expect(canvasDimension).not.toContainText('angle_target');
  await page.keyboard.press('Control+Shift+z');
  await expect(canvasDimension).toContainText('angle_target = 60°');

  // A large persisted offset may project below the orientation rail after a
  // cold reopen. Drag it there, save the document, and verify the presentation
  // clamp keeps the label reachable without changing the stored dimension.
  const railStack = page.locator('.viewer-rail-stack');
  await expect(canvasDimension).toBeVisible();
  const beforeDrag = await canvasDimension.boundingBox();
  const railBounds = await railStack.boundingBox();
  expect(beforeDrag).not.toBeNull();
  expect(railBounds).not.toBeNull();
  await page.mouse.move(
    beforeDrag!.x + beforeDrag!.width / 2,
    beforeDrag!.y + beforeDrag!.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    railBounds!.x + railBounds!.width / 2,
    railBounds!.y + railBounds!.height / 2,
    { steps: 6 }
  );
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).not.toContainText('Saving', { timeout: 30_000 });

  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Sketch 01', exact: true })
  ).toBeVisible({
    timeout: 30_000
  });
  await page.getByRole('button', { name: 'Sketch 01', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
    .click();
  const reopenedDimension = page.getByRole('button', {
    name: /^Edit driving angle:/
  });
  await expect(reopenedDimension).toBeVisible({ timeout: 30_000 });
  await expect(reopenedDimension).toContainText('angle_target = 60°');
  const reopenedBounds = await reopenedDimension.boundingBox();
  const reopenedRailBounds = await railStack.boundingBox();
  expect(reopenedBounds).not.toBeNull();
  expect(reopenedRailBounds).not.toBeNull();
  expect(
    reopenedBounds!.x + reopenedBounds!.width <= reopenedRailBounds!.x ||
      reopenedBounds!.x >= reopenedRailBounds!.x + reopenedRailBounds!.width ||
      reopenedBounds!.y + reopenedBounds!.height <= reopenedRailBounds!.y ||
      reopenedBounds!.y >= reopenedRailBounds!.y + reopenedRailBounds!.height
  ).toBe(true);
  await reopenedDimension.click();
  await expect(page.getByRole('dialog', { name: 'Angle value' })).toBeVisible();

  await page.screenshot({ path: '/tmp/openzcad-sketch-driving-dimension.png' });
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(canvasDimension).toHaveCount(0);
});

test('edits a canvas radius with expressions, refuses zero, and undoes the solve', async ({
  page
}) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Driving Radius');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('New parameter name').fill('radius_target');
  await page.getByLabel('New parameter expression').fill('7');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(rail).toBeVisible();
  await page.waitForTimeout(800);
  // The sketch settings are a disclosure under the tools, closed to begin with.
  if (
    !(await page.getByRole('checkbox', { name: 'Snap to grid' }).isVisible())
  ) {
    await page.getByRole('button', { name: /Sketch palette/ }).click();
  }
  const gridSnap = page.getByRole('checkbox', { name: 'Snap to grid' });
  if (await gridSnap.isChecked()) await gridSnap.uncheck();
  await rail.getByRole('button', { name: /^Circle/ }).click();
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const center = {
    x: bounds!.x + bounds!.width * 0.35,
    y: bounds!.y + bounds!.height * 0.65
  };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 72, center.y, { steps: 6 });
  await page.mouse.up();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Sketch 01' })
  ).toBeVisible();
  await page
    .getByRole('toolbar', { name: 'Relations' })
    .getByRole('button', { name: 'Radius', exact: true })
    .click();
  await page.mouse.click(center.x + 72, center.y);
  const label = page.getByRole('button', { name: /^Edit driving radius:/ });
  await expect(label).toBeVisible();
  const baseline = await readLiveSketch(canvas);
  const constraintId = await label.getAttribute('data-constraint-id');
  await label.click();
  const editor = page.getByRole('dialog', { name: 'Radius value' });
  await editor.getByRole('textbox').fill('radius_target');
  await editor.getByRole('button', { name: 'Apply radius' }).click();
  await expect(label).toContainText('R radius_target = 7 mm');
  await expect(label).toHaveAttribute('data-constraint-id', constraintId!);
  const solved = await readLiveSketch(canvas);
  const radial = solved.objects[0]!.data;
  expect(radial.objectKind).toBe('circle');
  if (radial.objectKind !== 'circle') throw new Error('Expected a circle');
  expect(Number(radial.radius)).toBeCloseTo(7, 8);
  const parameter = page.getByLabel('Expression for radius_target');
  await parameter.fill('9');
  await parameter.press('Enter');
  await expect(label).toContainText('R radius_target = 9 mm');
  const rebound = (await readLiveSketch(canvas)).objects[0]!.data;
  if (rebound.objectKind !== 'circle') throw new Error('Expected a circle');
  expect(Number(rebound.radius)).toBeCloseTo(9, 8);
  await page.keyboard.press('Control+z');
  await expect(label).toContainText('R radius_target = 7 mm');
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => JSON.stringify((await readLiveSketch(canvas)).objects))
    .toBe(JSON.stringify(baseline.objects));
  await page.keyboard.press('Control+Shift+z');
  await expect(label).toContainText('R radius_target = 7 mm');
  await label.click();
  await editor.getByRole('textbox').fill('0');
  await editor.getByRole('button', { name: 'Apply radius' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Radius must be a positive number'
  );
  expect((await readLiveSketch(canvas)).objects).toEqual(solved.objects);
  await expect(label).toContainText('R radius_target = 7 mm');
  await page.screenshot({ path: '/tmp/openzcad-sketch-radius.png' });
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(label).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('clears every transient sketch HUD overlay when finishing a sketch', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Sketch HUD Cleanup');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await page.waitForTimeout(800);

  // The sketch settings are a disclosure under the tools, closed to begin with.
  if (
    !(await page.getByRole('checkbox', { name: 'Snap to grid' }).isVisible())
  ) {
    await page.getByRole('button', { name: /Sketch palette/ }).click();
  }
  const gridSnap = page.getByRole('checkbox', { name: 'Snap to grid' });
  if (await gridSnap.isChecked()) {
    await gridSnap.uncheck();
  }
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const start = {
    x: bounds!.x + bounds!.width / 2 + 100,
    y: bounds!.y + bounds!.height / 2 + 100
  };

  await page.mouse.click(start.x, start.y);
  await page.mouse.move(start.x + 2, start.y - 200);
  const marker = page.locator('.sketch-snap-marker');
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAttribute('data-kind', 'vertical');
  await expect(marker).toHaveAttribute('data-label', 'Vertical');

  // Exact: the sketch status names this control, and the activity-log button
  // folds the status into its own accessible name.
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toHaveCount(
    0
  );
  await expect(marker).toBeHidden();
  await expect(page.locator('.sketch-dim-label')).toBeHidden();
  await expect(page.locator('.sketch-center-target')).toBeHidden();
});

test('snaps sketch drawing to existing endpoints', async ({ page }) => {
  await createBoxProject(page, 'Snap Sketch Part');

  const facePoint = await findFacePoint(page);
  await page.mouse.click(facePoint.x, facePoint.y);
  const card = page.getByRole('region', { name: 'Resize Body operation' });
  await card.getByRole('tab', { name: 'Sketch' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  // Screen-space clicks must wait until the head-on entry tween settles.
  await page.waitForTimeout(800);
  // Grid snapping is on by default and would move the endpoint off the
  // release point; this test is about geometry snapping, so turn it off.
  await page.getByRole('button', { name: /Sketch palette/ }).click();
  await page.getByLabel('Snap to grid').uncheck();
  await page.getByRole('button', { name: /Sketch palette/ }).click();

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const center = {
    x: bounds!.x + bounds!.width / 2,
    y: bounds!.y + bounds!.height / 2
  };

  // Draw the first line.
  await page.mouse.click(center.x - 60, center.y - 40);
  await page.mouse.click(center.x + 60, center.y - 40);
  await page.keyboard.press('Escape');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Sketch' })
  ).toBeVisible();

  // Hovering near the first endpoint arms the endpoint snap marker.
  const marker = page.locator('.sketch-snap-marker');
  await expect(marker).toBeHidden();
  await page.mouse.move(center.x - 62, center.y - 42);
  await page.mouse.move(center.x - 59, center.y - 39, { steps: 3 });
  await expect(marker).toBeVisible();
  await expect(marker).toHaveAttribute('data-kind', 'endpoint');

  // Clicking there chains exactly onto the endpoint; moving away hides it.
  await page.mouse.click(center.x - 60, center.y - 40);
  await page.mouse.move(center.x + 150, center.y + 120, { steps: 4 });
  await expect(marker).toBeHidden();
});

test('empty-state copy points at the command card beside the history', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Empty Copy');
  await page.getByRole('button', { name: 'Create project' }).click();

  // Several sections carry a .sidebar-hint; match the History one by text.
  const hint = page.locator('.sidebar-hint', { hasText: 'No features yet' });
  await expect(hint).toContainText('Pick a tool from the command card');

  // The card it names is on screen, and it is the other side of the stage
  // from the history in the drawer.
  const tools = page.getByRole('navigation', { name: 'Feature tools' });
  await expect(tools).toBeVisible();
  const toolsBounds = await tools.boundingBox();
  const hintBounds = await hint.boundingBox();
  expect(toolsBounds!.x + toolsBounds!.width).toBeLessThanOrEqual(
    hintBounds!.x + 0.5
  );

  // Selecting an edge points at the same place, and neither tool it names has
  // a keyboard shortcut, so the rail is the only route.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(hint).toHaveCount(0);
});

test('shows profile readiness and preserves exact entity edits through extrude and undo', async ({
  page
}) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Predictable plate');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const overview = page.getByRole('region', { name: 'Sketch overview' });
  await expect(overview).toContainText('Draw a closed outline');
  await expect(overview).toContainText('XY plane');
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(
    rail.getByRole('button', { name: 'Extrude', exact: true })
  ).toBeDisabled();
  await page.waitForTimeout(800);
  const canvas = page.locator('.viewer-host canvas');
  const bounds = (await canvas.boundingBox())!;
  const corner = {
    x: bounds.x + bounds.width * 0.5,
    y: bounds.y + bounds.height * 0.6
  };
  await rail.getByRole('button', { name: /^Rectangle/ }).click();
  await page.mouse.click(corner.x, corner.y);
  await page.mouse.move(corner.x + 120, corner.y - 80, { steps: 5 });
  await page.keyboard.type('40');
  await page.keyboard.press('Tab');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await expect(overview).toContainText('1 closed profile ready to extrude');
  const first = (await readLiveSketch(canvas)).objects[0]!;
  await overview.getByLabel('Selected geometry').selectOption(first.id);
  const editor = page.getByRole('form', { name: 'Edit rectangle' });
  await expect(editor.getByLabel('Width', { exact: true })).toHaveValue('40');
  await editor.getByLabel('Width', { exact: true }).fill('50');
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect
    .poll(async () => (await readLiveSketch(canvas)).objects[0]!.data)
    .toMatchObject({ width: 50, height: 20 });
  await page.keyboard.press('Control+z');
  await expect(editor.getByLabel('Width', { exact: true })).toHaveValue('40');
  await page.keyboard.press('Control+Shift+z');
  await expect(editor.getByLabel('Width', { exact: true })).toHaveValue('50');
  await rail.getByRole('button', { name: 'Extrude', exact: true }).click();
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Height value' });
  await keypad.getByRole('textbox').fill('4');
  await keypad.getByRole('button', { name: 'Apply height' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Extruded region by 4 mm'
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sketch 01', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toHaveCount(0);
  await overview.getByLabel('Selected geometry').selectOption(first.id);
  await editor.getByLabel('Width', { exact: true }).fill('60');
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect
    .poll(async () => (await readLiveSketch(canvas)).objects[0]!.data)
    .toMatchObject({ width: 60, height: 20 });
  await expect(overview).toContainText('1 closed profile ready to extrude');
  await page.screenshot({
    path: test.info().outputPath('sketch-overview.png')
  });
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(overview).toHaveCount(0);
  await expect(page.getByText('Editing Sketch:', { exact: false })).toHaveCount(
    0
  );
  expect(pageErrors).toEqual([]);
});
