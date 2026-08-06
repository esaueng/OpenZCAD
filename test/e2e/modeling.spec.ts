import { fileURLToPath } from 'node:url';
import {
  test,
  expect,
  openAssistant,
  shiftSelectTwoVisibleBoxEdges,
  stubApi
} from './openzcad-fixtures';

test('suppresses features and rolls the timeline back as one undoable edit', async ({
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
  await page.getByLabel('Project name').fill('Suppression Timeline');
  await page.getByRole('button', { name: 'Create project' }).click();

  for (const tool of [/^Box \(B\)/, /^Cylinder \(C\)/]) {
    await page.getByRole('button', { name: tool }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();
  }
  await expect(page.locator('.vp-hud-bl')).toContainText('2 bodies');

  const box = page.locator('.feature-row', { hasText: /^Box/ });
  const cylinder = page.locator('.feature-row', { hasText: /^Cylinder/ });
  await box.getByRole('button', { name: 'Suppress Box' }).click();
  await expect(box).toContainText('suppressed');
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');

  await box.getByRole('button', { name: 'Resume Box' }).click();
  await expect(box).not.toContainText('suppressed');
  await expect(page.locator('.vp-hud-bl')).toContainText('2 bodies');

  const rollback = box.getByRole('button', {
    name: 'Roll back history after Box'
  });
  await rollback.click();
  await expect(rollback).toHaveAttribute('aria-pressed', 'true');
  await expect(cylinder).toContainText('suppressed');
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(cylinder).not.toContainText('suppressed');
  await expect(page.locator('.vp-hud-bl')).toContainText('2 bodies');
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(cylinder).toContainText('suppressed');
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  expect(consoleErrors).toEqual([]);
});

test('resizes a cylinder wall concentrically with one undoable radius edit', async ({
  page
}) => {
  // Five gestures on one body, each of which the kernel has to answer
  // exactly: create, drag the wall out, undo/redo, drag and cancel, then
  // offset the cap. A trace of a passing run spends ~6 s on the first tool
  // click alone (viewer cold start behind a software rasteriser) and ~7 s
  // more inside the two drags, because every intermediate pointermove
  // rebuilds the exact preview and repaints. That is ~30 s of real work on a
  // CI runner with no GPU, which leaves the 30 s default with no margin at
  // all — the same budget the multi-region extrude test already raises.
  test.setTimeout(90_000);
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Cylinder Radius Drag');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');

  const canvas = page.locator('.viewer-host canvas');
  const selectCylinderSurface = async (surface: 'wall' | 'cap') => {
    await canvas.evaluate((element, requestedSurface) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: { surface: requestedSurface }
        })
      );
    }, surface);
  };
  await selectCylinderSurface('wall');

  const radiusOperation = page.getByRole('region', {
    name: 'Resize Cylinder Radius operation'
  });
  await expect(radiusOperation).toBeVisible();
  await expect(page.getByTestId('live-cylinder-radius')).toHaveText('14 mm');
  await expect(page.getByRole('region', { name: '3D viewport' })).toContainText(
    'Cylindrical face Ø28'
  );
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);

  const handle = await canvas.evaluate((element) => {
    const values = [
      element.dataset.e2eHandleX,
      element.dataset.e2eHandleY,
      element.dataset.e2eHandleDx,
      element.dataset.e2eHandleDy,
      element.dataset.e2eHandlePixelsPerUnit
    ].map((value) => Number(value));
    if (values.some((value) => !Number.isFinite(value))) {
      return null;
    }
    return {
      x: values[0]!,
      y: values[1]!,
      dx: values[2]!,
      dy: values[3]!,
      pixelsPerUnit: values[4]!
    };
  });
  const bounds = await canvas.boundingBox();
  expect(handle).not.toBeNull();
  expect(bounds).not.toBeNull();
  const start = {
    x: bounds!.x + handle!.x,
    y: bounds!.y + handle!.y
  };
  const end = {
    x: start.x + handle!.dx * handle!.pixelsPerUnit * 4,
    y: start.y + handle!.dy * handle!.pixelsPerUnit * 4
  };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(page.getByTestId('live-cylinder-radius')).toHaveText('18 mm');
  await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
    'R 18 mm'
  );
  await expect(page.getByRole('region', { name: '3D viewport' })).toContainText(
    'Cylindrical face Ø36'
  );
  await page.mouse.up();

  await expect(page.getByRole('contentinfo')).toContainText(
    'Adjusted cylinder radius to R 18 mm.'
  );
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('18');
  await expect(page.getByLabel('Height', { exact: true })).toHaveValue('28');
  await expect(page.locator('.panel-body')).toContainText('36 × 36 × 28 mm');

  await page.getByRole('button', { name: 'Undo' }).click();
  await page.locator('.feature-row-main', { hasText: 'Cylinder' }).click();
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('14');
  await page.getByRole('button', { name: 'Redo' }).click();
  await page.locator('.feature-row-main', { hasText: 'Cylinder' }).click();
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('18');

  await selectCylinderSurface('wall');
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  const cancelHandle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const cancelBounds = await canvas.boundingBox();
  const cancelStart = {
    x: cancelBounds!.x + cancelHandle.x,
    y: cancelBounds!.y + cancelHandle.y
  };
  await page.mouse.move(cancelStart.x, cancelStart.y);
  await page.mouse.down();
  await page.mouse.move(
    cancelStart.x + cancelHandle.dx * cancelHandle.pixelsPerUnit * 2,
    cancelStart.y + cancelHandle.dy * cancelHandle.pixelsPerUnit * 2,
    { steps: 6 }
  );
  await expect(page.getByTestId('live-cylinder-radius')).toHaveText('20 mm');
  await expect(radiusOperation).toContainText('Dragging');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('live-cylinder-radius')).toHaveText('18 mm');
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('18');
  await page.mouse.up();

  await selectCylinderSurface('cap');
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toBeVisible();
  await expect(radiusOperation).toHaveCount(0);
  await page.getByTestId('direct-manipulation-value').click();
  const offsetKeypad = page.getByRole('dialog', { name: 'Offset value' });
  await offsetKeypad.getByRole('textbox').fill('-4.5');
  await offsetKeypad.getByRole('button', { name: 'Apply offset' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Offset face by -4.5 mm.'
  );
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toBeVisible();
  await expect(page.locator('.panel-body')).toContainText('36 × 36 × 23.5 mm');
  expect(consoleErrors).toEqual([]);
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

test('switches a planar-face selection into an editable arc sketch', async ({
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
  await page.getByLabel('Project name').fill('Context Sketch Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

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
  await page.mouse.click(facePoint!.x, facePoint!.y);

  const offsetCard = page.getByRole('region', {
    name: 'Offset Face operation'
  });
  await expect(offsetCard).toBeVisible();
  await expect(
    offsetCard.getByRole('tab', { name: 'Offset Face' })
  ).toHaveAttribute('aria-selected', 'true');
  await offsetCard.getByRole('tab', { name: 'Sketch' }).click();

  await expect(
    page.getByRole('region', { name: 'Sketch operation' })
  ).toBeVisible();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await sketchTools.getByRole('button', { name: /^Arc/ }).click();
  const sketchBounds = await canvas.boundingBox();
  expect(sketchBounds).not.toBeNull();
  const center = {
    x: sketchBounds!.x + sketchBounds!.width / 2,
    y: sketchBounds!.y + sketchBounds!.height / 2
  };
  await page.mouse.click(center.x, center.y);
  await page.mouse.click(center.x + 80, center.y);
  await page.mouse.click(center.x, center.y - 80);

  await expect(
    page.locator('.feature-row-main', { hasText: 'Sketch' })
  ).toBeVisible();
  await sketchTools.getByRole('button', { name: /^Select/ }).click();
  await page.mouse.click(center.x + 56, center.y - 56);
  const editor = page.getByRole('form', { name: 'Edit arc' });
  await expect(editor).toBeVisible();
  const radiusInput = editor.getByLabel('Radius');
  await expect(radiusInput).not.toHaveValue('');
  const radius = await radiusInput.inputValue();
  await radiusInput.fill('-1');
  await expect(editor.getByRole('alert')).toContainText(
    'Lengths and radii must be greater than zero.'
  );
  await expect(editor.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await radiusInput.fill(radius);
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Updated arc geometry'
  );

  await page.setViewportSize({ width: 390, height: 844 });
  const editorBounds = await editor.boundingBox();
  expect(editorBounds).not.toBeNull();
  expect(editorBounds!.x).toBeGreaterThanOrEqual(0);
  expect(editorBounds!.x + editorBounds!.width).toBeLessThanOrEqual(390.5);
  expect(editorBounds!.y + editorBounds!.height).toBeLessThanOrEqual(844.5);
  expect(consoleErrors).toEqual([]);
});

test('shows and recovers a stale face-attached sketch when its source is suppressed', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Stale Face Attachment');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

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
  await page.mouse.click(facePoint!.x, facePoint!.y);
  await page
    .getByRole('region', { name: 'Offset Face operation' })
    .getByRole('tab', { name: 'Sketch' })
    .click();

  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await sketchTools.getByRole('button', { name: /^Rectangle/ }).click();
  const sketchBounds = await canvas.boundingBox();
  expect(sketchBounds).not.toBeNull();
  const center = {
    x: sketchBounds!.x + sketchBounds!.width / 2,
    y: sketchBounds!.y + sketchBounds!.height / 2
  };
  await page.mouse.move(center.x - 45, center.y - 35);
  await page.mouse.down();
  await page.mouse.move(center.x + 45, center.y + 35, { steps: 4 });
  await page.mouse.up();
  await expect(
    page.locator('.feature-row', { hasText: /^Sketch/ })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Finish Sketch' }).click();

  const box = page.locator('.feature-row', { hasText: /^Box/ });
  await box.getByRole('button', { name: 'Suppress Box' }).click();
  await expect(box).toContainText('suppressed');
  const diagnostic = page.locator('.diagnostic-row', {
    hasText: /cannot attach because source body/
  });
  await expect(diagnostic).toContainText(
    "is unavailable at the sketch's history position"
  );
  await expect(page.getByRole('contentinfo')).not.toContainText('warnings0');

  await box.getByRole('button', { name: 'Resume Box' }).click();
  await expect(box).not.toContainText('suppressed');
  await expect(page.locator('.diagnostic-row')).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(consoleErrors).toEqual([]);
});

test('refuses a new face sketch after a hash-only direct edit', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Direct Edit Sketch Guard');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  const canvas = page.locator('.viewer-host canvas');
  const findPlanarFacePoint = async () => {
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
    return null;
  };

  const sourceFacePoint = await findPlanarFacePoint();
  expect(sourceFacePoint).not.toBeNull();
  await page.mouse.click(sourceFacePoint!.x, sourceFacePoint!.y);
  await page.getByTestId('direct-manipulation-value').click();
  const offsetKeypad = page.getByRole('dialog', { name: 'Offset value' });
  await offsetKeypad.getByRole('textbox').fill('2');
  await offsetKeypad.getByRole('button', { name: 'Apply offset' }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toBeVisible();

  const editedFacePoint = await findPlanarFacePoint();
  expect(editedFacePoint).not.toBeNull();
  await page.mouse.click(editedFacePoint!.x, editedFacePoint!.y);
  const offsetCard = page.getByRole('region', {
    name: 'Offset Face operation'
  });
  const sketchAction = offsetCard.getByRole('tab', {
    name: /Sketch: This edited face has no stable topology reference/
  });
  await expect(sketchAction).toBeDisabled();
  await expect(sketchAction).toHaveAttribute(
    'title',
    /no stable topology reference/
  );

  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.mouse.click(editedFacePoint!.x, editedFacePoint!.y);
  await expect(page.getByRole('contentinfo')).toContainText(
    'This edited face has no stable topology reference'
  );
  await expect(
    page.locator('.feature-row-main', { hasText: /^Sketch/ })
  ).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(consoleErrors).toEqual([]);
});

test('keeps a source circle stable over its coincident extrude edge', async ({
  page
}) => {
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Sketch Edge Regression');
  await page.getByRole('button', { name: 'Create project' }).click();

  const canvas = page.locator('.viewer-host canvas');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await expect(
    page.getByText('Pick a sketch plane', { exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Front (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(sketchTools).toBeVisible();
  await sketchTools.getByRole('button', { name: /^Circle/ }).click();

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const center = {
    // Stay clear of the empty-viewport getting-started card while keeping the
    // whole circle inside the real WebGL canvas.
    x: bounds!.x + bounds!.width * 0.72,
    y: bounds!.y + bounds!.height * 0.64
  };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 64, center.y, { steps: 6 });
  await page.mouse.up();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Sketch 01' })
  ).toBeVisible();

  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await page.getByRole('button', { name: 'Apply Extrude' }).click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Sketch 01' })
  ).toBeVisible();

  const renderPolicy = await canvas.evaluate(
    (element) =>
      new Promise<{
        bodyFaces: {
          depthTest: boolean;
          depthWrite: boolean;
          polygonOffset: boolean;
          polygonOffsetFactor: number;
          polygonOffsetUnits: number;
          renderOrder: number;
        }[];
        bodyEdges: {
          depthTest: boolean;
          depthWrite: boolean;
          name: string;
          renderOrder: number;
          visible: boolean;
        }[];
        sketchLines: {
          depthTest: boolean;
          depthWrite: boolean;
          name: string;
          renderOrder: number;
          visible: boolean;
        }[];
      }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: { resolve }
          })
        );
      })
  );

  expect(renderPolicy.bodyFaces.length).toBeGreaterThan(0);
  expect(
    renderPolicy.bodyFaces.every(
      (face) =>
        face.depthTest &&
        face.depthWrite &&
        face.polygonOffset &&
        face.polygonOffsetFactor === 1 &&
        face.polygonOffsetUnits === 1
    )
  ).toBe(true);
  expect(renderPolicy.bodyEdges.length).toBeGreaterThan(0);
  const idleBodyEdges = renderPolicy.bodyEdges.filter(
    (edge) => edge.name === 'body-edge'
  );
  expect(idleBodyEdges.length).toBeGreaterThan(0);
  expect(
    renderPolicy.bodyFaces.every(
      (face) => face.renderOrder < idleBodyEdges[0]!.renderOrder
    )
  ).toBe(true);
  expect(
    idleBodyEdges.every(
      (edge) => edge.visible && edge.depthTest && !edge.depthWrite
    )
  ).toBe(true);
  expect(
    renderPolicy.bodyEdges
      .filter((edge) => edge.name !== 'body-edge')
      .every(
        (edge) =>
          !edge.visible &&
          edge.depthTest &&
          !edge.depthWrite &&
          (edge.name === 'body-edge-hover' ||
            edge.name === 'body-edge-selected')
      )
  ).toBe(true);
  const sketchCurves = renderPolicy.sketchLines.filter(
    (line) => line.name === 'sketch-curve'
  );
  const idleRegionBoundaries = renderPolicy.sketchLines.filter(
    (line) => line.name === 'sketch-region-boundary'
  );
  expect(sketchCurves).toHaveLength(1);
  expect(
    sketchCurves.every(
      (line) =>
        line.visible &&
        line.depthTest &&
        !line.depthWrite &&
        line.renderOrder > idleBodyEdges[0]!.renderOrder
    )
  ).toBe(true);
  expect(idleRegionBoundaries).toHaveLength(1);
  expect(idleRegionBoundaries.every((line) => !line.visible)).toBe(true);
});

test('extrudes and edits one of multiple closed sketch regions', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Multi Region Extrude');
  await page.getByRole('button', { name: 'Create project' }).click();

  const canvas = page.locator('.viewer-host canvas');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Front (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const centers = [
    {
      x: bounds!.x + bounds!.width * 0.58,
      y: bounds!.y + bounds!.height * 0.76
    },
    {
      x: bounds!.x + bounds!.width * 0.78,
      y: bounds!.y + bounds!.height * 0.76
    }
  ];
  for (const [index, center] of centers.entries()) {
    await sketchTools.getByRole('button', { name: /^Circle/ }).click();
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 38, center.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByRole('contentinfo')).toContainText(
      index === 0 ? 'Sketch 01 started.' : 'Add circle'
    );
  }

  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    '2 valid profiles available'
  );
  // Profile picking itself is covered by the viewport package. Select one
  // detected region through the e2e-only canvas hook so this lifecycle test
  // cannot race the camera tween on slower machines.
  await canvas.dispatchEvent('openzcad:e2e-select-profile', {
    detail: { index: 0 }
  });
  const extrude = page.getByRole('form', { name: 'Extrude controls' });
  await expect(extrude).toContainText('1 selected');
  await expect(
    extrude.getByRole('button', { name: 'Select all valid' })
  ).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText(
    '1 profile selected · exact preview ready',
    { timeout: 20_000 }
  );
  await extrude.getByRole('button', { name: 'Select all valid' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    '2 profiles selected · exact preview ready',
    { timeout: 20_000 }
  );
  await expect(extrude).toContainText('2 selected');
  await extrude.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Select one or more closed profiles.'
  );
  await canvas.dispatchEvent('openzcad:e2e-select-profile', {
    detail: { index: 0 }
  });
  await expect(page.getByRole('contentinfo')).toContainText(
    '1 profile selected · exact preview ready',
    { timeout: 20_000 }
  );
  await expect(extrude).toContainText('1 selected');
  await extrude.getByRole('button', { name: 'Apply Extrude' }).click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Extrude 1' })
  ).toBeVisible();

  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await expect(inspector).toBeVisible();
  await inspector.getByRole('textbox', { name: /^Distance/ }).fill('32');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edit Extrude 1');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Redo');
  await page.locator('.feature-row-main', { hasText: 'Extrude 1' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('textbox', { name: /^Distance/ })
  ).toHaveValue('32');
  expect(consoleErrors).toEqual([]);
});

test('infers and stores an additive extrude from exact overlap', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Stored Extrude Operation');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  const canvas = page.locator('.viewer-host canvas');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Front (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await sketchTools.getByRole('button', { name: /^Circle/ }).click();
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const center = {
    x: bounds!.x + bounds!.width * 0.5,
    y: bounds!.y + bounds!.height * 0.5
  };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 50, center.y, { steps: 6 });
  await page.mouse.up();

  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  const extrude = page.getByRole('form', { name: 'Extrude controls' });
  await expect(extrude.getByLabel('Extrude operation')).toHaveValue('add', {
    timeout: 20_000
  });
  await expect(extrude).toContainText(/overlaps Box Body; Add is stored/);
  await expect(page.getByRole('contentinfo')).toContainText(
    'exact preview ready · Add to Box Body',
    { timeout: 20_000 }
  );
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await extrude.getByRole('button', { name: 'Apply Extrude' }).click();

  const extrudeFeature = page.getByRole('button', {
    name: 'Extrude 1',
    exact: true
  });
  await expect(extrudeFeature).toBeVisible();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByLabel('Stored extrude operation')).toHaveValue(
    'add'
  );
  await inspector.getByRole('textbox', { name: /^Distance/ }).fill('32');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edit Extrude 1');
  await expect(inspector.getByLabel('Stored extrude operation')).toHaveValue(
    'add'
  );
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  expect(consoleErrors).toEqual([]);
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

test('keeps a two-rim fillet while editing a cylinder from 4.6 to 6.4 mm', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Filleted Cylinder Resize');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('4.6');
  await inspector.getByLabel('Height', { exact: true }).fill('12');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  await page.getByRole('button', { name: /^Fillet/ }).click();
  await inspector.getByRole('button', { name: 'Select all 2 edges' }).click();
  await inspector.getByLabel('Radius', { exact: true }).fill('1');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const cylinder = page.locator('.feature-row', { hasText: /^Cylinder/ });
  const fillet = page.locator('.feature-row', { hasText: /^Fillet/ });
  await expect(fillet).toBeVisible();
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);

  await cylinder.locator('.feature-row-main').click();
  await inspector.getByLabel('Radius', { exact: true }).fill('6.4');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edit Cylinder');
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);

  // A radius smaller than the stored 1 mm fillet is invalid. Exact preflight
  // must refuse it without adding an undo entry or changing the live document.
  await inspector.getByLabel('Radius', { exact: true }).fill('0.5');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Fillet could not be created on 2 selected edges with radius 1.'
  );
  await fillet.locator('.feature-row-main').click();
  await cylinder.locator('.feature-row-main').click();
  await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
    '6.4'
  );

  await page.getByRole('button', { name: 'Undo' }).click();
  await cylinder.locator('.feature-row-main').click();
  await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
    '4.6'
  );
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo' }).click();
  await cylinder.locator('.feature-row-main').click();
  await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
    '6.4'
  );
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  expect(consoleErrors).toEqual([]);
});

for (const modifier of [
  { label: 'Fillet', sizeLabel: 'Radius' },
  { label: 'Chamfer', sizeLabel: 'Distance' }
] as const) {
  test(`drags a cylinder radius through its two-rim ${modifier.label.toLowerCase()} ancestry`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    await page.goto('/');
    await page
      .getByLabel('Project name')
      .fill(`${modifier.label} Cylinder Radius Drag`);
    await page.getByRole('button', { name: 'Create project' }).click();

    await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    await inspector.getByLabel('Radius', { exact: true }).fill('4.6');
    await inspector.getByLabel('Height', { exact: true }).fill('12');
    await inspector.getByRole('button', { name: /^Create/ }).click();

    await page
      .getByRole('button', { name: new RegExp(`^${modifier.label}`) })
      .click();
    await inspector.getByRole('button', { name: 'Select all 2 edges' }).click();
    await inspector.getByLabel(modifier.sizeLabel, { exact: true }).fill('1');
    await inspector.getByRole('button', { name: /^Create/ }).click();

    const cylinder = page.locator('.feature-row', { hasText: /^Cylinder/ });
    const blend = page.locator('.feature-row', {
      hasText: new RegExp(`^${modifier.label}`)
    });
    await expect(blend).toBeVisible();
    await expect(blend.getByTitle('Feature failed to build')).toHaveCount(0);
    await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
    await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
    await expect(page.locator('.feature-row')).toHaveCount(2);

    const canvas = page.locator('.viewer-host canvas');
    await canvas.evaluate((element) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: { surface: 'wall' }
        })
      );
    });
    await expect(
      page.getByRole('region', { name: 'Resize Cylinder Radius operation' })
    ).toBeVisible();
    await expect(page.getByTestId('live-cylinder-radius')).toHaveText('4.6 mm');
    await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);

    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    const bounds = await canvas.boundingBox();
    expect(bounds).not.toBeNull();
    expect(Object.values(handle).every(Number.isFinite)).toBe(true);
    const start = {
      x: bounds!.x + handle.x,
      y: bounds!.y + handle.y
    };
    const end = {
      x: start.x + handle.dx * handle.pixelsPerUnit * 1.8,
      y: start.y + handle.dy * handle.pixelsPerUnit * 1.8
    };

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // Shift disables radius snapping only after the handle owns the pointer;
    // holding it on pointerdown intentionally routes the gesture to orbit.
    await page.keyboard.down('Shift');
    try {
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await expect(page.getByTestId('live-cylinder-radius')).toHaveText(
        '6.4 mm'
      );
      await page.mouse.up();
    } finally {
      await page.keyboard.up('Shift');
    }

    await expect(page.getByRole('contentinfo')).toContainText(
      'Adjusted cylinder radius to R 6.4 mm.'
    );
    await expect(page.locator('.feature-row')).toHaveCount(2);
    await expect(blend.getByTitle('Feature failed to build')).toHaveCount(0);
    await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
    await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
    await cylinder.locator('.feature-row-main').click();
    await expect
      .poll(async () =>
        Number(
          await inspector.getByLabel('Radius', { exact: true }).inputValue()
        )
      )
      .toBeCloseTo(6.4, 5);

    await page.getByRole('button', { name: 'Undo' }).click();
    await cylinder.locator('.feature-row-main').click();
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
      '4.6'
    );
    await expect(blend.getByTitle('Feature failed to build')).toHaveCount(0);
    await page.getByRole('button', { name: 'Redo' }).click();
    await cylinder.locator('.feature-row-main').click();
    await expect
      .poll(async () =>
        Number(
          await inspector.getByLabel('Radius', { exact: true }).inputValue()
        )
      )
      .toBeCloseTo(6.4, 5);
    await expect(blend.getByTitle('Feature failed to build')).toHaveCount(0);
    await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  });
}

test('preflights and creates an exact open-top shell', async ({ page }) => {
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Open Top Shell');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  await page.getByRole('button', { name: /^Shell/ }).click();
  const openings = page.getByRole('group', { name: 'Opening faces' });
  await openings.getByRole('button', { name: /Plane face box.*z max/ }).click();
  await page.getByRole('button', { name: 'Check exact result' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Exact preflight passed' })
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Create shell' }).click();

  await expect(
    page.locator('.feature-row-main', { hasText: 'Shell' })
  ).toBeVisible();
  await expect(page.locator('.body-row.consumed')).toContainText('Box Body');
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(consoleErrors).toEqual([]);
});

for (const modifier of [
  {
    label: 'fillet',
    tool: 'Fillet — Pick an edge, then set its radius'
  },
  {
    label: 'chamfer',
    tool: 'Chamfer — Pick an edge, then set its distance'
  }
] as const) {
  test(`Shift+left click applies one exact ${modifier.label} to two selected edges`, async ({
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
    await page.getByLabel('Project name').fill(`Multi-edge ${modifier.label}`);
    await page.getByRole('button', { name: 'Create project' }).click();

    await page.getByRole('button', { name: /^Box \(B\)/ }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();

    await shiftSelectTwoVisibleBoxEdges(page);
    await page
      .getByRole('button', { name: modifier.tool, exact: true })
      .click();
    const inspector = page.getByRole('region', {
      name: 'Feature inspector'
    });
    await expect(inspector.locator('.selection-summary')).toContainText(
      '2 exact edges selected'
    );
    await inspector.getByRole('button', { name: /^Create/ }).click();

    const feature = page.locator('.feature-row', {
      hasText: modifier.label === 'fillet' ? 'Fillet' : 'Chamfer'
    });
    await expect(feature).toBeVisible();
    await expect(feature.getByTitle('Feature failed to build')).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    expect(consoleErrors).toEqual([]);
  });
}

test('applies an assistant-created sketch and same-proposal extrude', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'sketch-alias-test',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', (route) => {
    const proposal = {
      proposalId: 'proposal_ai_sketch_e2e',
      summary: 'Create a closed rectangular sketch and extrude it.',
      assumptions: [],
      operations: [
        {
          kind: 'add_sketch',
          name: 'AI profile',
          localId: '$profile',
          plane: 'XY',
          offset: 0,
          objects: [
            {
              objectKind: 'rectangle',
              width: 36,
              height: 24,
              centerX: 18,
              centerY: 12
            }
          ]
        },
        {
          kind: 'add_extrude',
          name: 'AI plate',
          localId: '$plate',
          sketchId: '$profile',
          distance: 6,
          samplePoint: null
        }
      ]
    };
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: JSON.stringify({
          replyKind: 'patch',
          proposal,
          questions: null,
          message: null,
          readings: null
        })
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('AI Sketch Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await openAssistant(page);
  await page
    .getByLabel('CAD change request')
    .fill('Create a 36 by 24 by 6 millimetre plate from a sketch');
  await page.getByLabel('CAD change request').press('Enter');

  const proposal = page.locator('.assistant-card.proposal.open');
  await expect(proposal).toContainText(
    'Create a closed rectangular sketch and extrude it.'
  );
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();

  await expect(
    page.locator('.feature-row-main', { hasText: 'AI profile' })
  ).toBeVisible();
  await expect(
    page.locator('.feature-row-main', { hasText: 'AI plate' })
  ).toBeVisible();
  await expect(page.locator('.assistant-card.proposal.applied')).toContainText(
    'Applied'
  );
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(consoleErrors).toEqual([]);
});

test('shows a stable failure when the assistant completes with invalid structured output', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'invalid-output-test',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: {
        'x-openzcad-request-id': '019fcf75-2cc4-7832-befc-50ae06c9e985'
      },
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: 'I could not return the requested JSON object.'
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    })
  );

  await page.goto('/');
  await page.getByLabel('Project name').fill('AI Failure Handling');
  await page.getByRole('button', { name: 'Create project' }).click();
  await openAssistant(page);
  await page
    .getByLabel('CAD change request')
    .fill('Create a simple bottle bumper');
  await page.getByLabel('CAD change request').press('Enter');

  const failure = page.locator('.assistant-card.message.error');
  await expect(failure).toContainText(
    'The provider returned invalid structured output.'
  );
  await expect(failure).toContainText(
    'Reference: 019fcf75-2cc4-7832-befc-50ae06c9e985.'
  );
  await expect(failure).not.toContainText('JSON.parse');
  await expect(
    failure.getByRole('button', { name: 'Try again' })
  ).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('grounds an AI fillet request onto every selected edge', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
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
    const assistantRequest = route.request().postDataJSON() as AssistantRequest;
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
        text: JSON.stringify({
          replyKind: 'patch',
          proposal,
          questions: null,
          message: null,
          readings: null
        })
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('AI Selection Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await openAssistant(page);
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
    'Ask about 12 selected edges…'
  );
  await page
    .getByLabel('CAD change request')
    .fill('Add fillets of 1 mm on the selected edges');
  await page.getByLabel('CAD change request').press('Enter');

  await expect(page.locator('.assistant-card.proposal.open')).toContainText(
    'Fillet every selected edge by 1 mm.'
  );
  const assistantRequest = await assistantRequestPromise;
  expect(assistantRequest?.digest?.selection?.featureIds).toHaveLength(1);
  expect(assistantRequest?.digest?.selection?.bodyIds).toHaveLength(1);
  expect(assistantRequest?.digest?.selection?.topologies).toHaveLength(12);

  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const fillet = page.locator('.feature-row', {
    hasText: 'AI selected edge fillets'
  });
  await expect(fillet).toBeVisible();
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(page.getByLabel('CAD change request')).toHaveAttribute(
    'placeholder',
    'Describe a part, or attach a drawing…'
  );
  await expect(page.getByRole('button', { name: 'Deselect all' })).toHaveCount(
    0
  );
});

test('rejects a disconnected Union proposed by the assistant before commit', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'union-validation-test',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', (route) => {
    const request = route.request().postDataJSON() as {
      digest?: {
        bodies?: Array<{
          bodyId: string;
          consumed: boolean;
        }>;
      };
    };
    const liveBodyIds =
      request.digest?.bodies
        ?.filter((body) => !body.consumed)
        .map((body) => body.bodyId) ?? [];
    const proposal = {
      proposalId: 'proposal_disconnected_union_e2e',
      summary: 'Union the two separated bodies.',
      assumptions: [],
      operations: [
        {
          kind: 'add_boolean',
          name: 'AI disconnected Union',
          localId: null,
          operation: 'union',
          targetBodyIds: liveBodyIds
        }
      ]
    };
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: JSON.stringify({
          replyKind: 'patch',
          proposal,
          questions: null,
          message: null,
          readings: null
        })
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('AI Union Guard');
  await page.getByRole('button', { name: 'Create project' }).click();
  await openAssistant(page);
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Lower');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Upper');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await inspector.getByLabel('Name').fill('Separate upper');
  await inspector.getByLabel('Move Z').fill('32');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByLabel('CAD change request').fill('Union the two bodies');
  await page.getByLabel('CAD change request').press('Enter');
  const failure = page.locator('.assistant-card.message.error');
  await expect(failure).toContainText('did not pass exact geometry preflight');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Union does not fill empty space.'
  );
  await expect(page.locator('.assistant-card.proposal.open')).toHaveCount(0);
  await expect(
    page.locator('.feature-row', { hasText: 'AI disconnected Union' })
  ).toHaveCount(0);
  await expect(page.locator('.body-row.consumed')).toHaveCount(0);

  await page
    .locator('.feature-row-main', { hasText: 'Separate upper' })
    .click();
  await inspector.getByLabel('Move Z').fill('24');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await failure.getByRole('button', { name: 'Try again' }).click();
  const proposal = page.locator('.assistant-card.proposal.open');
  await expect(proposal).toContainText('Union the two separated bodies.');
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();

  await expect(
    page.locator('.feature-row', { hasText: 'AI disconnected Union' })
  ).toBeVisible();
  await expect(page.locator('.assistant-card.proposal.applied')).toContainText(
    'Applied'
  );
  await expect(page.locator('.body-row.consumed')).toHaveCount(2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
});

test('preflights and applies the verified chamfered-shaft suggestion without an AI provider', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { assistantEnabled: true });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  let providerRequests = 0;
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: false,
        provider: 'openrouter',
        model: 'not-needed-for-verified-recipes',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', (route) => {
    providerRequests += 1;
    return route.abort();
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('Verified Chamfered Shaft');
  await page.getByRole('button', { name: 'Create project' }).click();
  await openAssistant(page);

  await page
    .getByRole('button', {
      name: /Make a Ø30 × 60 mm shaft with a 1 mm chamfer on both ends/
    })
    .click();
  const request = page.getByLabel('CAD change request');
  await expect(request).toHaveValue(
    'Make a Ø30 × 60 mm shaft with a 1 mm chamfer on both ends'
  );
  await request.press('Enter');

  const proposal = page.locator('.assistant-card.proposal.open');
  await expect(proposal).toContainText(
    'A Ø30 × 60 mm shaft will be created with 1 mm chamfers'
  );
  await expect(proposal.getByText('in the viewport')).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(providerRequests).toBe(0);

  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(
    page.locator('.feature-row', { hasText: 'Chamfered Shaft' })
  ).toBeVisible();
  await expect(
    page.getByRole('contentinfo').locator('[title*="1 bodies"]')
  ).toBeVisible();
  await expect(page.locator('.assistant-card.proposal.applied')).toContainText(
    'Applied'
  );

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(
    page.getByRole('contentinfo').locator('[title*="0 bodies"]')
  ).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('grounds all cylinder edges onto its two visible rims', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  type AssistantBody = {
    bodyId: string;
    bbox?: {
      min: { z: number };
      max: { z: number };
    };
    topology?: {
      edgeCount: number;
      modifierEdgeCount: number;
      edgeInventoryComplete: boolean;
      edges: Array<{
        hash: number;
        modelingRole: string;
        modifierCandidate: boolean;
        center?: { z: number };
      }>;
    };
  };
  type AssistantRequest = {
    digest?: {
      bodies?: AssistantBody[];
      selection?: { topologies?: unknown[] };
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
        model: 'topology-aware-test',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', (route) => {
    const assistantRequest = route.request().postDataJSON() as AssistantRequest;
    resolveAssistantRequest(assistantRequest);
    const body = assistantRequest.digest?.bodies?.find(
      (candidate) => candidate.topology?.modifierEdgeCount === 2
    );
    const proposal = {
      proposalId: 'proposal_cylinder_rims_e2e',
      summary: 'Fillet the cylinder top and bottom rims by 2 mm.',
      assumptions: [],
      operations: [
        {
          kind: 'add_edge_modifier',
          name: 'AI cylinder rim fillets',
          localId: null,
          modifier: 'fillet',
          targetBodyId: body?.bodyId ?? 'body_hallucinated',
          // Deliberately wrong: client grounding must replace it with the two
          // modifier candidates and must not include the periodic seam.
          edgeHashes: [999],
          size: 2
        }
      ]
    };
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: JSON.stringify({
          replyKind: 'patch',
          proposal,
          questions: null,
          message: null,
          readings: null
        })
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('AI Cylinder Rims');
  await page.getByRole('button', { name: 'Create project' }).click();
  await openAssistant(page);
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  // The document feature lands before its asynchronously derived B-rep and
  // topology. The assistant digest must be captured only after that geometry
  // is ready, especially on a slower single-worker CI runner.
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  await page
    .getByLabel('CAD change request')
    .fill('Round every outside edge by 2 mm');
  await page.getByLabel('CAD change request').press('Enter');

  const assistantRequest = await assistantRequestPromise;
  expect(assistantRequest.digest?.selection?.topologies).toHaveLength(0);
  const body = assistantRequest.digest?.bodies?.find(
    (candidate) => candidate.topology?.modifierEdgeCount === 2
  );
  expect(body?.topology).toMatchObject({
    edgeCount: 3,
    modifierEdgeCount: 2,
    edgeInventoryComplete: true
  });
  expect(
    body?.topology?.edges.filter((edge) => edge.modifierCandidate)
  ).toHaveLength(2);
  expect(
    body?.topology?.edges.filter((edge) => edge.modelingRole === 'seam')
  ).toHaveLength(1);
  expect(
    body?.topology?.edges
      .filter((edge) => edge.modifierCandidate)
      .map((edge) => edge.center?.z)
      .sort((left, right) => (left ?? 0) - (right ?? 0))
  ).toEqual([body?.bbox?.min.z, body?.bbox?.max.z]);

  await expect(page.locator('.assistant-card.proposal.open')).toContainText(
    'Fillet the cylinder top and bottom rims by 2 mm.',
    { timeout: 15_000 }
  );
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const fillet = page.locator('.feature-row', {
    hasText: 'AI cylinder rim fillets'
  });
  await expect(fillet).toBeVisible();
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
});

test('imports a STEP solid, fillets it, and re-exports it', async ({
  page
}) => {
  // Z3: imported STEP documents build on BrepKit like everything else. This
  // is the only e2e that drives a real imported B-rep through the product --
  // import, exact measurement, a blend on IMPORTED topology, and re-export --
  // so it is what says the routing flip works in the app rather than only in
  // the adapter suite.
  test.setTimeout(90_000);
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Imported Solid');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();

  // The import affordance is a hidden <input type=file> the File menu clicks.
  // a-export-box is the corpus's 10x20x30 box: 6000 mm3, twelve edges.
  await page
    .getByLabel('Import STEP or STL…')
    .setInputFiles(
      fileURLToPath(
        new URL('../parity/corpus/a-export-box.step', import.meta.url)
      )
    );

  // The app names the import from the file's own PRODUCT entity, so the row
  // title is evidence the STEP header was parsed, not just the geometry.
  const importedRow = page.locator('.feature-row', {
    hasText: 'brepkit_solid'
  });
  await expect(importedRow).toBeVisible();
  // The static preview serves no Worker API, so the artifact archive is
  // unreachable and the app must keep the STEP source in the document rather
  // than lose the import. It says so.
  await expect(page.getByRole('contentinfo')).toContainText(
    'cloud archive unavailable; source saved locally'
  );
  await expect(importedRow.getByTitle('Feature failed to build')).toHaveCount(
    0
  );
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');

  // The kernel measured the imported solid, not a mesh approximation of it.
  await importedRow.locator('.feature-row-main').click();
  await expect(page.locator('.panel-body')).toContainText('6000');

  // Blend imported topology: the twelve edges have to be pickable, which
  // means the import published exact edges with resolvable identities.
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
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  // Re-export the edited import as STEP and check it is a real B-rep file.
  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  const downloadPromise = page.waitForEvent('download');
  await fileMenu.getByRole('button', { name: /STEP/ }).click();
  const download = await downloadPromise;
  await fileMenu.locator('summary').click();
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text.startsWith('ISO-10303-21;')).toBe(true);
  expect(text).toContain('MANIFOLD_SOLID_BREP');
  expect(text).toContain('CLOSED_SHELL');
  // The twelve blend bands and eight corner patches are in the file, and they
  // are exact. This used to assert B_SPLINE_SURFACE and say "the day K0.4
  // lands this fails and gets corrected to CYLINDRICAL_SURFACE". K0.4's blend
  // phases landed, the `fillet-on-import` / surfaceTypes pin is retired from
  // corpus-pins.ts, and the file now carries no spline at all. Measured on
  // this exact construction: 12 CYLINDRICAL_SURFACE, 8 SPHERICAL_SURFACE, 6
  // planes, 5804.3375 mm3 against the Minkowski closed form 5804.6961.
  expect(text).toContain('CYLINDRICAL_SURFACE');
  expect(text).toContain('SPHERICAL_SURFACE');
  expect(text).not.toContain('B_SPLINE_SURFACE');
  expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
  // Only the two artifact-archive uploads (import and export) may fail, and
  // only because the preview host has no /api/uploads. Anything else is a
  // real console error and this stays an equality assertion so it shows up.
  expect(consoleErrors.filter((message) => !message.includes('404'))).toEqual(
    []
  );
  expect(consoleErrors).toHaveLength(2);
});

test('archives a browser-generated STEP export and lists the stored file', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);

  let projectId = '';
  let uploadedStep = '';
  let finalized = false;
  const artifactId = 'artifact_e6_browser_export';
  const uploadSessionId = 'upload_e6_browser_export';
  const artifact = () => ({
    artifactId,
    projectId,
    kind: 'step-export' as const,
    name: 'Archived-Part.step',
    objectKey: `${projectId}/uploads/archived-part.step`,
    contentType: 'model/step',
    bytes: uploadedStep.length,
    createdAt: '2026-08-03T12:00:00.000Z',
    metadata: { documentVersion: 1, units: 'mm' }
  });

  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: finalized ? [artifact()] : [] } })
  );
  await page.route(`**/api/artifacts/${artifactId}`, (route) =>
    route.fulfill({ json: { artifact: finalized ? artifact() : null } })
  );
  await page.route('**/api/artifacts/finalize', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      projectId,
      uploadSessionId,
      artifactId
    });
    finalized = true;
    await route.fulfill({ json: { artifactId } });
  });
  await page.route(
    `**/api/uploads/${uploadSessionId}/content`,
    async (route) => {
      expect(route.request().method()).toBe('PUT');
      expect(route.request().headers()['content-type']).toContain('model/step');
      uploadedStep = route.request().postData() ?? '';
      await route.fulfill({ status: 204 });
    }
  );
  await page.route('**/api/uploads', async (route) => {
    const payload = route.request().postDataJSON() as {
      projectId: string;
      fileName: string;
      contentType: string;
      kind: string;
    };
    projectId = payload.projectId;
    expect(payload).toMatchObject({
      fileName: 'Archived-Part.step',
      contentType: 'model/step',
      kind: 'step-export'
    });
    await route.fulfill({
      status: 201,
      json: {
        session: {
          uploadSessionId,
          artifactId,
          projectId,
          objectKey: `${projectId}/uploads/archived-part.step`,
          uploadUrl: `/api/uploads/${uploadSessionId}/content`,
          expiresAt: '2026-08-04T12:00:00.000Z',
          fileName: payload.fileName,
          contentType: payload.contentType,
          kind: payload.kind,
          metadata: {}
        }
      }
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('Archived Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');

  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  const downloadPromise = page.waitForEvent('download');
  await fileMenu.getByRole('button', { name: /STEP/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Archived-Part.step');
  await expect(page.getByRole('contentinfo')).toContainText('and archived it');
  expect(uploadedStep.startsWith('ISO-10303-21;')).toBe(true);
  expect(uploadedStep).toContain('MANIFOLD_SOLID_BREP');

  await expect(fileMenu.locator('summary')).toContainText('File 1');
  await expect(
    fileMenu.getByRole('link', { name: /Archived-Part\.step/ })
  ).toHaveAttribute('href', `/api/artifacts/${artifactId}/download`);
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

  // Move the cutter into the box instead of leaving it tangent to the box's
  // origin corner, which is a deliberately degenerate boolean setup.
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const moveInspector = page.getByRole('region', {
    name: 'Feature inspector'
  });
  await moveInspector.getByLabel('Move X').fill('30');
  await moveInspector.getByLabel('Move Y').fill('9');
  await moveInspector.getByRole('button', { name: /^Create/ }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Move' })
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
  await expect(
    page
      .locator('.feature-row', { hasText: 'Subtract' })
      .getByTitle('Feature failed to build')
  ).toHaveCount(0);
  // One warning, and it is a true finding rather than noise. The cylinder is
  // r=14 centred at y=9 in a box only 18 deep, so its circle spans y −5..23 and
  // severs the box outright. The kernel does not answer that cut with exact
  // surfaces: measured at the binding, 9 operand faces (1 curved) become 46
  // result faces with **0 curved** — the cylindrical wall comes back as planar
  // facets. The boolean face census reports exactly that, which is what it was
  // added for. The build still succeeds and the volume and STEP export below
  // still hold, which is precisely why nothing caught it before.
  //
  // Asserting the specific message rather than a count: a second, different
  // warning appearing here should still fail this test.
  await expect(page.getByRole('contentinfo')).toContainText('warnings1');

  // Export STEP and verify the download is a real ISO 10303-21 file. Import
  // and export live inside the collapsed File menu, so open it first: a
  // hidden button never becomes actionable and the click waits forever. The
  // summary is a <summary>, which is exposed as a generic rather than a
  // button, and the item's accessible name tracks the export scope
  // ("all bodies" vs "selected body") — so scope the match to the menu.
  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  const downloadPromise = page.waitForEvent('download');
  await fileMenu.getByRole('button', { name: /STEP/ }).click();
  const download = await downloadPromise;
  await fileMenu.locator('summary').click(); // collapse; it overlays the sidebar
  expect(download.suggestedFilename()).toBe('E2E-Part.step');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text.startsWith('ISO-10303-21;')).toBe(true);
  expect(text).toMatch(
    /FILE_SCHEMA\(\('(AUTOMOTIVE_DESIGN|CONFIG_CONTROL_DESIGN)/
  );
  expect(text).toContain('MANIFOLD_SOLID_BREP');
  expect(text).toContain('CLOSED_SHELL');
  expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);

  // Export the sanitized support bundle and verify that it preserves native
  // modeling inputs without leaking account identity or cloud history.
  await fileMenu.locator('summary').click();
  const diagnosticDownloadPromise = page.waitForEvent('download');
  await fileMenu.getByRole('button', { name: /Export diagnostics/ }).click();
  const diagnosticDownload = await diagnosticDownloadPromise;
  await fileMenu.locator('summary').click();
  expect(diagnosticDownload.suggestedFilename()).toBe(
    'E2E-Part.openzcad-diagnostic.json'
  );
  const diagnosticStream = await diagnosticDownload.createReadStream();
  const diagnosticChunks: Buffer[] = [];
  for await (const chunk of diagnosticStream) {
    diagnosticChunks.push(chunk as Buffer);
  }
  const diagnosticText = Buffer.concat(diagnosticChunks).toString('utf8');
  const diagnostic = JSON.parse(diagnosticText) as {
    format: string;
    formatVersion: number;
    kernel: {
      packageVersion: string;
      sourceCommit: string;
    };
    document: {
      projectId: string;
      ownerUserId: string;
      revisions: unknown[];
      checkpoints: unknown[];
      assets: Record<string, unknown>;
      derived: {
        bodyRepresentations: Record<string, unknown>;
      };
    };
  };
  expect(diagnostic).toMatchObject({
    format: 'openzcad-project-diagnostic',
    formatVersion: 1,
    document: {
      projectId: 'project_diagnostic',
      ownerUserId: 'user_diagnostic',
      revisions: [],
      checkpoints: [],
      assets: {},
      derived: {
        bodyRepresentations: {}
      }
    }
  });
  expect(diagnostic.kernel.packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(diagnostic.kernel.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(diagnosticText).not.toContain('user_e2e');

  // Parametric regen: change w and confirm the box volume follows (60->80 => 80*18*24).
  const paramInput = page.getByLabel('Expression for w');
  await paramInput.fill('40');
  await paramInput.press('Enter');
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await expect(page.locator('.panel-body')).toContainText('34560');

  // Undo while the untouched input is focused must not let the stale visible
  // draft recommit over the newer canonical expression on blur. Dispatching on
  // window keeps focus in the field while exercising the app shortcut.
  await paramInput.focus();
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true
      })
    );
  });
  await expect(page.locator('.param-row')).toHaveAttribute('title', 'w = 30');
  await paramInput.blur();
  await expect(paramInput).toHaveValue('30');
});

test('rejects a disconnected Union and succeeds after the gap is closed', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Connected Union');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Lower');
  await inspector.getByLabel('Width (X)').fill('10');
  await inspector.getByLabel('Height (Y)').fill('10');
  await inspector.getByLabel('Depth (Z)').fill('10');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Upper');
  await inspector.getByLabel('Width (X)').fill('10');
  await inspector.getByLabel('Height (Y)').fill('10');
  await inspector.getByLabel('Depth (Z)').fill('10');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await inspector.getByLabel('Name').fill('Lift upper');
  await inspector.getByLabel('Move Z').fill('12');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Union \(U\)/ }).click();
  await expect(inspector).toContainText(
    'Union joins solids that touch or overlap. It does not fill empty gaps.'
  );
  await inspector.locator('.pick-row', { hasText: 'Lower Body' }).click();
  await inspector.locator('.pick-row', { hasText: 'Upper Body' }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await expect(page.getByRole('contentinfo')).toContainText(
    'Union does not fill empty space.'
  );
  await expect(page.locator('.feature-row', { hasText: 'Union' })).toHaveCount(
    0
  );
  await expect(inspector.locator('.pick-row.selected')).toHaveCount(2);
  await expect(page.locator('.body-row.consumed')).toHaveCount(0);

  await page.locator('.feature-row-main', { hasText: 'Lift upper' }).click();
  await inspector.getByLabel('Move Z').fill('10');
  await inspector.getByRole('button', { name: /^Apply/ }).click();

  await page.getByRole('button', { name: /^Union \(U\)/ }).click();
  await inspector.locator('.pick-row', { hasText: 'Lower Body' }).click();
  await inspector.locator('.pick-row', { hasText: 'Upper Body' }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const union = page.locator('.feature-row', { hasText: 'Union' });
  await expect(union).toBeVisible();
  await expect(union.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.locator('.body-row.consumed')).toHaveCount(2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
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
