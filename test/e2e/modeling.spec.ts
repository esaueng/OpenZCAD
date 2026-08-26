import { fileURLToPath } from 'node:url';
import {
  test,
  expect,
  bareCanvasDrags,
  expectBodyCount,
  expectConsumedBodyCount,
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
  await expectBodyCount(page, 2);

  const box = page.locator('.feature-row', { hasText: /^Box/ });
  const cylinder = page.locator('.feature-row', { hasText: /^Cylinder/ });
  await box.getByRole('button', { name: 'Suppress Box' }).click();
  await expect(box).toContainText('suppressed');
  await expectBodyCount(page, 1);

  await box.getByRole('button', { name: 'Resume Box' }).click();
  await expect(box).not.toContainText('suppressed');
  await expectBodyCount(page, 2);

  const rollback = box.getByRole('button', {
    name: 'Roll back history after Box'
  });
  await rollback.click();
  await expect(rollback).toHaveAttribute('aria-pressed', 'true');
  await expect(cylinder).toContainText('suppressed');
  await expectBodyCount(page, 1);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(cylinder).not.toContainText('suppressed');
  await expectBodyCount(page, 2);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(cylinder).toContainText('suppressed');
  await expectBodyCount(page, 1);
  expect(consoleErrors).toEqual([]);
});

test('resizes a cylinder wall concentrically with one undoable radius edit', async ({
  page
}) => {
  // Five gestures on one body: create, drag the wall out, undo/redo, drag and
  // cancel, then offset the cap. The wall drag uses a disposable viewport
  // projection and performs one exact kernel validation on release.
  test.setTimeout(90_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
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
  await expect(page.getByRole('button', { name: 'Bodies 1' })).toBeVisible();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
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
    name: 'Resize Cylinder operation'
  });
  await expect(radiusOperation).toBeVisible();
  await expect(page.getByTestId('direct-manipulation-value')).toHaveText('Ø 28 mm');
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
  await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
    'Ø 36 mm'
  );
  await expect(page.getByRole('region', { name: '3D viewport' })).toContainText(
    'Cylindrical face Ø36'
  );
  await expect(canvas).toHaveAttribute('data-e2e-cylinder-proxy-radius', '18');
  await page.mouse.up();

  await expect(page.getByRole('contentinfo')).toContainText(
    'Adjusted cylinder diameter to Ø 36 mm.'
  );
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('18');
  await expect(page.getByLabel('Height', { exact: true })).toHaveValue('28');
  await expect(page.locator('.panel-body')).toContainText('36 × 36 × 28 mm');
  await expect(canvas).not.toHaveAttribute(
    'data-e2e-cylinder-proxy-radius',
    /.+/
  );

  await page
    .getByRole('button', { name: 'Undo' })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await page
    .locator('.feature-row-main', { hasText: 'Cylinder' })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('14');
  await page
    .getByRole('button', { name: 'Redo' })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await page
    .locator('.feature-row-main', { hasText: 'Cylinder' })
    .evaluate((element) => (element as HTMLButtonElement).click());
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
  await expect(page.getByTestId('direct-manipulation-value')).toHaveText('Ø 40 mm');
  await expect(radiusOperation).toContainText('Dragging');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('direct-manipulation-value')).toHaveText('Ø 36 mm');
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('18');
  await expect(canvas).not.toHaveAttribute(
    'data-e2e-cylinder-proxy-radius',
    /.+/
  );
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
    page.getByLabel('Depth (Y)').inputValue(),
    page.getByLabel('Height (Z)').inputValue()
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

// Until the kernel adapter re-derived primitive lineage on direct-edit
// results, this scenario pinned a REFUSAL: the offset box face lost its
// reference and sketching on it was blocked. The box is still a box after a
// face offset, so its roles — and the face reference — now survive, and the
// sketch attaches associatively. The reference-less refusal itself stays
// pinned in faceSketchAttachment.test.ts and capabilities.test.ts, where
// non-primitive bodies still exercise it.
test('keeps face sketching available after a primitive direct edit', async ({
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
  await expect(offsetCard).toBeVisible();
  const sketchAction = offsetCard.getByRole('tab', { name: 'Sketch' });
  await expect(sketchAction).toBeEnabled();
  await sketchAction.click();
  await expect(
    page.getByRole('region', { name: 'Sketch operation' })
  ).toBeVisible();
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
  await page.getByRole('button', { name: 'Top (XY)' }).click();
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
  await page.getByTestId('direct-manipulation-value').click();
  const heightKeypad = page.getByRole('dialog', { name: 'Height value' });
  await heightKeypad.getByRole('textbox').fill('24');
  await heightKeypad.getByRole('button', { name: 'Apply height' }).click();
  await expectBodyCount(page, 1);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Sketch 01' })
  ).toBeVisible();

  // The extrude consumed this sketch, so it hides itself. Show it again: the
  // coincident-edge render policy below is exactly what makes a re-shown
  // source curve readable over the extrude edge it sits on.
  await page.getByRole('button', { name: 'Show Sketch 01' }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Sketch shown.');

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
  const overlayEdges = renderPolicy.bodyEdges.filter(
    (edge) => edge.name !== 'body-edge'
  );
  expect(
    overlayEdges.every(
      (edge) =>
        edge.depthTest &&
        !edge.depthWrite &&
        (edge.name === 'body-edge-hover' ||
          edge.name === 'body-edge-hover-hidden' ||
          edge.name === 'body-edge-selected' ||
          edge.name === 'body-edge-selected-hidden' ||
          edge.name === 'body-face-boundary-selected' ||
          edge.name === 'body-face-boundary-selected-hidden')
    ),
    JSON.stringify(overlayEdges, null, 2)
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
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  // Both circles have to be drawn on bare canvas, and sketch mode floats the
  // palette over the right of it. Wait for that palette, then measure around
  // it: a fraction of the canvas box is not an anchor, and the fractions this
  // test used put the second circle's row 0.96px below the palette's lower
  // edge, with both of its drag points inside the palette's column.
  await expect(page.locator('.sketch-palette')).toBeVisible();
  const centers = await bareCanvasDrags(page, { count: 2, dragX: 38 });
  // Closed regions the sketch has actually detected. The status bar cannot
  // stand in for this: every circle after the first reports the same "Add
  // circle", so a dropped gesture leaves the previous iteration's message in
  // place and reads as success. The count only advances when a gesture really
  // committed.
  const detectedRegions = () =>
    canvas.evaluate(
      (element) =>
        new Promise<number>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-render-policy', {
              detail: {
                resolve: (policy: { sketchLines: { name: string }[] }) =>
                  resolve(
                    policy.sketchLines.filter(
                      (line) => line.name === 'sketch-region-boundary'
                    ).length
                  )
              }
            })
          );
        })
    );
  const circleTool = sketchTools.getByRole('button', { name: /^Circle/ });
  const gridReadout = page.locator('.sketch-grid-indicator');
  for (const [index, center] of centers.entries()) {
    await circleTool.click();
    // The rail button is React state and flips first; the viewport only owns
    // the tool once its render loop has the sketch rig, and the adaptive grid
    // readout is written from that same pass. A user draws once they can see
    // the plane. Dragging before it, the pointerdown reaches a viewport with
    // no sketch plane to project onto and the whole gesture is discarded.
    await expect(circleTool).toHaveAttribute('aria-pressed', 'true');
    await expect(gridReadout).toBeVisible();
    await expect(gridReadout).not.toHaveText('');
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 38, center.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByRole('contentinfo')).toContainText(
      index === 0 ? 'Sketch 01 started.' : 'Add circle'
    );
    await expect.poll(detectedRegions).toBe(index + 1);
  }

  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  // Extrude stays in place: every valid profile is selected and armed on the
  // drag-arrow rig — there is no create form. The e2e-only canvas hook then
  // narrows the selection the way a click on a region would, so this
  // lifecycle test cannot race the camera glide on slower machines, and the
  // value chip's keypad commits an exact height.
  await expect(page.getByRole('contentinfo')).toContainText(
    '2 profiles selected · drag the arrow to extrude them together.'
  );
  await canvas.dispatchEvent('openzcad:e2e-select-profile', {
    detail: { index: 0 }
  });
  await expect(page.getByRole('contentinfo')).toContainText(
    'Closed sketch profile selected'
  );
  await page.getByTestId('direct-manipulation-value').click();
  const heightKeypad = page.getByRole('dialog', { name: 'Height value' });
  await heightKeypad.getByRole('textbox').fill('24');
  await heightKeypad.getByRole('button', { name: 'Apply height' }).click();
  await expectBodyCount(page, 1);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Extrude' })
  ).toBeVisible();

  // The rig commit leaves nothing selected; editing goes through the history
  // row, same as any committed feature.
  await page.locator('.feature-row-main', { hasText: 'Extrude' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await expect(inspector).toBeVisible();
  await inspector.getByRole('textbox', { name: /^Distance/ }).fill('32');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edit Extrude');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  // The feature inspector intentionally floats over the rail at this viewport.
  // Exercise the same history commands through their supported shortcuts.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByRole('contentinfo')).toContainText('Redo');
  await page.locator('.feature-row-main', { hasText: 'Extrude' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('textbox', { name: /^Distance/ })
  ).toHaveValue('32');
  expect(consoleErrors).toEqual([]);
});

test('resolves a negative free-plane extrude preview', async ({ page }) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Negative Extrude Preview');
  await page.getByRole('button', { name: 'Create project' }).click();

  const canvas = page.locator('.viewer-host canvas');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('region', { name: 'Editing Sketch: New Sketch operation' })
  ).toBeVisible();
  await page.waitForTimeout(800);

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const center = {
    x: bounds!.x + bounds!.width * 0.65,
    y: bounds!.y + bounds!.height * 0.65
  };
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await sketchTools.getByRole('button', { name: /^Circle/ }).click();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 40, center.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Sketch 01 started.'
  );

  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Closed sketch profile selected'
  );
  // A negative height extrudes to the opposite side of the plane and, with
  // nothing there to meet, the exact classification stores a new body.
  await page.getByTestId('direct-manipulation-value').click();
  const heightKeypad = page.getByRole('dialog', { name: 'Height value' });
  await heightKeypad.getByRole('textbox').fill('-24');
  await heightKeypad.getByRole('button', { name: 'Apply height' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Extruded region by -24 mm (new-body)',
    { timeout: 20_000 }
  );
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
  await page.getByRole('button', { name: 'Top (XY)' }).click();
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
  await expect(page.getByRole('contentinfo')).toContainText(
    'Closed sketch profile selected'
  );
  await expectBodyCount(page, 1);
  // The commit classifies against the exact kernel: the extrusion overlaps
  // the box, so Add is stored and no second body appears.
  await page.getByTestId('direct-manipulation-value').click();
  const heightKeypad = page.getByRole('dialog', { name: 'Height value' });
  await heightKeypad.getByRole('textbox').fill('24');
  await heightKeypad.getByRole('button', { name: 'Apply height' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Extruded region by 24 mm (add)',
    { timeout: 20_000 }
  );

  const extrudeFeature = page.getByRole('button', {
    name: 'Extrude',
    exact: true
  });
  await expect(extrudeFeature).toBeVisible();
  await extrudeFeature.click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByLabel('Stored extrude operation')).toHaveValue(
    'add'
  );
  await inspector.getByRole('textbox', { name: /^Distance/ }).fill('32');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edit Extrude');
  await expect(inspector.getByLabel('Stored extrude operation')).toHaveValue(
    'add'
  );
  await expectBodyCount(page, 1);
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

test('radius drag resizes an offset-and-filleted cylinder as one body', async ({
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
  await page.getByLabel('Project name').fill('One Body Radius');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  // Stated rather than inherited: this test drags the radius by a fixed screen
  // distance and asserts where it lands, so it owns its starting size.
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

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

  // A cap offset, recorded exactly as the direct-manipulation flow records
  // it — the in-chain direct edit that used to force every later radius
  // change onto the single-face path.
  await selectCylinderSurface('cap');
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toBeVisible();
  await page.getByTestId('direct-manipulation-value').click();
  const offsetKeypad = page.getByRole('dialog', { name: 'Offset value' });
  await offsetKeypad.getByRole('textbox').fill('4');
  await offsetKeypad.getByRole('button', { name: 'Apply offset' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Offset face by 4 mm.'
  );

  await page.getByRole('button', { name: /^Fillet/ }).click();
  await inspector.getByRole('button', { name: 'Select all 2 edges' }).click();
  await inspector.getByLabel('Radius', { exact: true }).fill('1');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  const offsetRow = page.locator('.feature-row', { hasText: 'Offset face' });
  const fillet = page.locator('.feature-row', { hasText: /^Fillet/ });
  await expect(fillet).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  // Drag the wall. The parametric ancestry now crosses the referenced cap
  // offset, so this must edit the Cylinder's radius parameter — one body —
  // instead of appending a Resize Cylinder direct edit that would
  // move the wall and leave the offset cap behind.
  // The prior exact projection remains visible while the filleted revision
  // rebuilds. Wait for the revision barrier so the e2e hook cannot select the
  // stale pre-fillet cylinder that topology actions must reject.
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 30_000 }
  );
  await selectCylinderSurface('wall');
  await expect(
    page.getByRole('region', { name: 'Resize Cylinder operation' })
  ).toBeVisible();
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = await canvas.boundingBox();
  const start = { x: bounds!.x + handle.x, y: bounds!.y + handle.y };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(
    start.x + handle.dx * handle.pixelsPerUnit * 4,
    start.y + handle.dy * handle.pixelsPerUnit * 4,
    { steps: 8 }
  );
  await expect(page.getByTestId('direct-manipulation-value')).toHaveText('Ø 36 mm');
  await page.mouse.up();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Adjusted cylinder diameter to Ø 36 mm.'
  );

  // Parametric, not stacked: the Cylinder feature carries the new radius, no
  // Resize feature was appended, and the whole chain rebuilt warning-free.
  await expect(
    page.locator('.feature-row', { hasText: 'Resize Cylinder' })
  ).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
  await expect(offsetRow.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await page
    .locator('.feature-row-main', { hasText: 'Cylinder' })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('18');
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
  await expectBodyCount(page, 1);
  await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);

  await cylinder.locator('.feature-row-main').click();
  await inspector.getByLabel('Radius', { exact: true }).fill('6.4');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edit Cylinder');
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expectBodyCount(page, 1);
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

  await page.keyboard.press('Control+z');
  await cylinder.locator('.feature-row-main').click();
  await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
    '4.6'
  );
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await cylinder.locator('.feature-row-main').click();
  await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
    '6.4'
  );
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
  await expectBodyCount(page, 1);
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
    await page.setViewportSize({ width: 1440, height: 1000 });
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
    await expect(page.getByRole('button', { name: 'Bodies 1' })).toBeVisible();
    await expectConsumedBodyCount(page, 1);
    await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
    await expect(page.locator('.feature-row')).toHaveCount(2);

    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toBeVisible({ timeout: 120_000 });
    await canvas.evaluate((element) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: { surface: 'wall' }
        })
      );
    });
    await expect(
      page.getByRole('region', { name: 'Resize Cylinder operation' })
    ).toBeVisible();
    await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
      'Ø 9.2 mm'
    );
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
      await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
        'Ø 12.8 mm'
      );
      await expect(canvas).not.toHaveAttribute(
        'data-e2e-cylinder-proxy-radius',
        /.+/
      );
      await page.mouse.up();
    } finally {
      await page.keyboard.up('Shift');
    }

    await expect(page.getByRole('contentinfo')).toContainText(
      'Adjusted cylinder diameter to Ø 12.8 mm.'
    );
    await expect(page.locator('.feature-row')).toHaveCount(2);
    await expect(blend.getByTitle('Feature failed to build')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Bodies 1' })).toBeVisible();
    await expectConsumedBodyCount(page, 1);
    await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
    await cylinder.locator('.feature-row-main').click();
    await expect
      .poll(async () =>
        Number(
          await inspector.getByLabel('Radius', { exact: true }).inputValue()
        )
      )
      .toBeCloseTo(6.4, 5);

    await page
      .getByRole('button', { name: 'Undo' })
      .evaluate((element) => (element as HTMLButtonElement).click());
    await cylinder
      .locator('.feature-row-main')
      .evaluate((element) => (element as HTMLButtonElement).click());
    await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
      '4.6'
    );
    await expect(blend.getByTitle('Feature failed to build')).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Redo' })
      .evaluate((element) => (element as HTMLButtonElement).click());
    await cylinder
      .locator('.feature-row-main')
      .evaluate((element) => (element as HTMLButtonElement).click());
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

test('preflights and splits a box into two live half bodies', async ({
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
  await page.getByLabel('Project name').fill('Split Halves');
  await page.getByRole('button', { name: 'Create project' }).click();

  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Width (X)').fill('20');
  await inspector.getByLabel('Depth (Y)').fill('20');
  await inspector.getByLabel('Height (Z)').fill('20');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Split/ }).click();
  // The default plane sits on the box's x=0 face, which the kernel refuses
  // (the plane must cross the interior); move it to a quarter of the width.
  await page
    .getByRole('group', { name: 'Plane origin' })
    .getByLabel('X')
    .fill('5');
  await page.getByRole('button', { name: 'Check exact result' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Exact preflight passed' })
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Create split body' }).click();

  await expect(
    page.locator('.feature-row-main', { hasText: 'Split' })
  ).toBeVisible();
  // The input is consumed; its two halves are live bodies of their own.
  await expectConsumedBodyCount(page, 1);
  await page.locator('.consumed-toggle').click();
  await expect(page.locator('.body-row.consumed')).toContainText('Box Body');
  await expect(
    page.locator('.body-row', { hasText: 'Split (back)' })
  ).toBeVisible();
  await expectBodyCount(page, 2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(consoleErrors).toEqual([]);
});

test('preflights and drills a through hole into the top face', async ({
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
  await page.getByLabel('Project name').fill('Drilled Block');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  await page.getByRole('button', { name: /^Hole/ }).click();
  const entry = page.getByRole('group', { name: 'Entry face' });
  await entry.getByRole('button', { name: /Plane face box.*z max/ }).click();
  await page.getByRole('button', { name: 'Check exact result' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Exact preflight passed' })
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Create hole' }).click();

  await expect(
    page.locator('.feature-row-main', { hasText: 'Hole' })
  ).toBeVisible();
  await expectConsumedBodyCount(page, 1);
  await page.locator('.consumed-toggle').click();
  await expect(page.locator('.body-row.consumed')).toContainText('Box Body');
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(consoleErrors).toEqual([]);
});

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
  await expectConsumedBodyCount(page, 1);
  await page.locator('.consumed-toggle').click();
  await expect(page.locator('.body-row.consumed')).toContainText('Box Body');
  await expectBodyCount(page, 1);
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
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(consoleErrors).toEqual([]);
});

test('resumes a clarified request from an OpenRouter Responses stream', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  const consoleErrors: string[] = [];
  const assistantRequests: Array<Record<string, unknown>> = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'openrouter',
        model: 'openai/gpt-5.6-sol',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', (route) => {
    assistantRequests.push(
      route.request().postDataJSON() as Record<string, unknown>
    );
    const reply =
      assistantRequests.length === 1
        ? {
            replyKind: 'questions',
            proposal: null,
            questions: [
              {
                id: 'import_strategy',
                prompt: 'How should the imported body be parameterized?',
                options: [
                  {
                    label: 'Rebuild exactly',
                    value:
                      'Rebuild the part parametrically while preserving its exact geometry, units, and placement.'
                  }
                ],
                allowFreeText: false,
                unit: null
              }
            ],
            message: 'The imported body has no editable feature history.',
            readings: null
          }
        : {
            replyKind: 'patch',
            proposal: {
              proposalId: 'proposal_openrouter_resume_e2e',
              summary: 'Rebuild the selected body parametrically.',
              assumptions: [],
              operations: [
                {
                  kind: 'add_primitive',
                  name: 'Parametric Body',
                  localId: null,
                  primitiveKind: 'box',
                  dimensions: {
                    width: 10,
                    height: 10,
                    depth: 10,
                    radius: null,
                    bottomRadius: null,
                    topRadius: null,
                    majorRadius: null,
                    minorRadius: null
                  }
                }
              ]
            },
            questions: null,
            message: null,
            readings: null
          };
    const output = JSON.stringify(reply);
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.content_part.delta',
        delta: output.slice(0, 50)
      })}\n\ndata: ${JSON.stringify({
        type: 'response.content_part.delta',
        delta: output.slice(50)
      })}\n\ndata: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          status: 'completed',
          content: [{ type: 'output_text', text: output }]
        }
      })}\n\ndata: ${JSON.stringify({
        type: 'response.done',
        response: { status: 'completed' }
      })}\n\ndata: [DONE]\n\n`
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('Assistant Clarification');
  await page.getByRole('button', { name: 'Create project' }).click();
  await openAssistant(page);
  await page
    .getByLabel('CAD change request')
    .fill('Parameterize the selected imported body');
  await page.getByLabel('CAD change request').press('Enter');

  const questions = page.locator('.assistant-card.questions');
  await expect(questions).toContainText(
    'The imported body has no editable feature history.'
  );
  await questions.getByRole('button', { name: 'Rebuild exactly' }).click();
  await questions.getByRole('button', { name: 'Build it' }).click();

  await expect(page.locator('.assistant-card.proposal.open')).toContainText(
    'Rebuild the selected body parametrically.'
  );
  await expect(page.locator('.assistant-card.message.error')).toHaveCount(0);
  expect(assistantRequests).toHaveLength(2);
  expect(assistantRequests[1]?.prompt).toBe(
    'Rebuild the part parametrically while preserving its exact geometry, units, and placement.'
  );
  expect(assistantRequests[1]?.history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        text: expect.stringContaining(
          'How should the imported body be parameterized?'
        )
      })
    ])
  );
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
  const separateMove = page.getByRole('form', { name: 'Move controls' });
  await separateMove.getByLabel('Name').fill('Separate upper');
  await separateMove.getByLabel('Move Z in mm').fill('32');
  await separateMove.getByRole('button', { name: /Apply move/ }).click();

  await page.getByLabel('CAD change request').fill('Union the two bodies');
  await page.getByLabel('CAD change request').press('Enter');
  const failure = page.locator('.assistant-card.message.error');
  await expect(failure).toContainText('did not pass exact geometry preflight');
  await expect(failure).toContainText(
    'Feature "AI disconnected Union": Union does not fill empty space.'
  );
  await expect(page.getByRole('contentinfo')).toContainText(
    'Union does not fill empty space.'
  );
  await expect(page.locator('.assistant-card.proposal.open')).toHaveCount(0);
  await expect(
    page.locator('.feature-row', { hasText: 'AI disconnected Union' })
  ).toHaveCount(0);
  await expectConsumedBodyCount(page, 0);

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
  await expectConsumedBodyCount(page, 2);
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
  await expectBodyCount(page, 1);
  await expect(page.locator('.assistant-card.proposal.applied')).toContainText(
    'Applied'
  );

  await page.getByRole('button', { name: 'Undo' }).click();
  await expectBodyCount(page, 0);
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
  // Z3: imported STEP documents build on Remus like everything else. This
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
  await expectBodyCount(page, 1);

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

test('refuses an unparseable STEP file without leaving a feature behind', async ({
  page
}) => {
  // The failure path the success path never covered. An import used to commit
  // before any geometry ran, so a file Remus cannot parse produced a success
  // toast next to a history row flagged "Feature failed to build", no body,
  // and a blank viewport that Fit View could not rescue. Nothing enters
  // history now, and the status bar carries the kernel's own verdict.
  test.setTimeout(90_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Refused Import');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();

  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeDisabled();

  // A well-formed box whose z-max face points at an entity id that does not
  // exist: the parser rejects it, the geometry never runs.
  await page
    .getByLabel('Import STEP or STL…')
    .setInputFiles(
      fileURLToPath(
        new URL(
          '../parity/corpus/f-hostile-dangling-reference.step',
          import.meta.url
        )
      )
    );

  // Verbatim, entity number included — that is the part that says which line
  // of the file to look at.
  await expect(page.getByRole('contentinfo')).toContainText(
    'parse error: entity #999999 not found'
  );
  await expect(page.getByRole('contentinfo')).not.toContainText(
    'Imported editable STEP solid'
  );
  await expect(page.locator('.feature-row')).toHaveCount(0);
  await expect(page.getByText('No features yet.')).toBeVisible();
  await expectBodyCount(page, 0);
  await expect(undo).toBeDisabled();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
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
  await expectBodyCount(page, 1);

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

  // Second body and a subtract that consumes both inputs. Radius 14 is set
  // here rather than taken from the form: the faceted-cut finding asserted
  // below is a property of a cylinder wider than the box is deep, and the
  // shipped default is now 6, which cuts cleanly.
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByLabel('Radius', { exact: true })
    .fill('14');
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
  const moveOverlay = page.getByRole('form', { name: 'Move controls' });
  await moveOverlay.getByLabel('Move X in mm').fill('30');
  await moveOverlay.getByLabel('Move Y in mm').fill('9');
  await moveOverlay.getByRole('button', { name: /Apply move/ }).click();
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
    formatVersion: 2,
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

test('exports a 3MF package through the mesh export dialog', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');

  await page.getByLabel('Project name').fill('Print Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  // Wait for the rebuild so the export scope is populated.
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await expect(page.locator('.panel-body')).toContainText('volume', {
    ignoreCase: true
  });

  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  await fileMenu.getByRole('button', { name: /Export Mesh/ }).click();

  const dialog = page.getByRole('dialog', { name: /Export mesh/ });
  await expect(dialog).toBeVisible();

  // The printability check runs the real kernel and names the body.
  await dialog.getByRole('button', { name: /Check watertightness/ }).click();
  await expect(dialog.locator('.export-dialog-report')).toContainText(
    'watertight'
  );

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /Export 3MF/ }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Print-Part.3mf');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const bytes = Buffer.concat(chunks);
  // A 3MF file is a zip package: PK local-file-header magic.
  expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  // The export closes the dialog and reports success.
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('Print-Part.3mf');
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
  await inspector.getByLabel('Depth (Y)').fill('10');
  await inspector.getByLabel('Height (Z)').fill('10');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Upper');
  await inspector.getByLabel('Width (X)').fill('10');
  await inspector.getByLabel('Depth (Y)').fill('10');
  await inspector.getByLabel('Height (Z)').fill('10');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const liftMove = page.getByRole('form', { name: 'Move controls' });
  await liftMove.getByLabel('Name').fill('Lift upper');
  await liftMove.getByLabel('Move Z in mm').fill('12');
  await liftMove.getByRole('button', { name: /Apply move/ }).click();

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
  await expectConsumedBodyCount(page, 0);

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
  await expectConsumedBodyCount(page, 2);
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

test('Remus resolves the former face-plane tangent-union refusal', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Refusal Copy');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  // A box and the default cylinder, slid until its axis lies in the box's
  // y = 0 face plane. The previous kernel could not close this tangency;
  // Remus resolves it as an exact union, cylinder wall and all.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const shift = page.getByRole('form', { name: 'Move controls' });
  await shift.getByLabel('Move X in mm').fill('15');
  await shift.getByRole('button', { name: /Apply move/ }).click();

  await page.getByRole('button', { name: /^Union \(U\)/ }).click();
  await inspector.locator('.pick-row', { hasText: 'Box Body' }).click();
  await inspector.locator('.pick-row', { hasText: 'Cylinder Body' }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const union = page.locator('.feature-row', { hasText: 'Union' });
  await expect(union).toBeVisible();
  await expect(union.getByTitle('Feature failed to build')).toHaveCount(0);
  await expectConsumedBodyCount(page, 2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
});

test('Remus resolves the former small-radius tangent-union fallback', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Tangent Union');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  // A small cylinder with its axis in the box's y = 0 face plane used to
  // facet or fail. Remus keeps the same construction exact.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await inspector.getByLabel('Radius').fill('6');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  // Moving along X keeps the axis in the y = 0 face plane.
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const shiftX = page.getByRole('form', { name: 'Move controls' });
  await shiftX.getByLabel('Move X in mm').fill('15');
  await shiftX.getByRole('button', { name: /Apply move/ }).click();

  await page.getByRole('button', { name: /^Union \(U\)/ }).click();
  await inspector.locator('.pick-row', { hasText: 'Box Body' }).click();
  await inspector.locator('.pick-row', { hasText: 'Cylinder Body' }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const union = page.locator('.feature-row', { hasText: 'Union' });
  await expect(union).toBeVisible();
  await expect(union.getByTitle('Feature failed to build')).toHaveCount(0);
  await expectConsumedBodyCount(page, 2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
});

test('the panel refuses a zero extrude and keeps a boolean name honest', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Panel Guards');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  // WF-10: a name nobody typed should say what the feature does. Switching the
  // operation used to leave "Union" on a subtract, so the history row, the body
  // and the panel heading all named an operation that never ran.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Union \(U\)/ }).click();
  await expect(inspector.getByLabel('Name')).toHaveValue('Union');
  await inspector.getByLabel('Operation').selectOption('subtract');
  await expect(inspector.getByLabel('Name')).toHaveValue('Subtract');
  // A name the user wrote is theirs and must survive the switch.
  await inspector.getByLabel('Name').fill('Pocket');
  await inspector.getByLabel('Operation').selectOption('intersect');
  await expect(inspector.getByLabel('Name')).toHaveValue('Pocket');
  await page.keyboard.press('Escape');

  // WF-09: zero distance builds nothing. It used to commit, delete the body and
  // explain itself only in a sidebar diagnostic.
  const canvas = page.locator('.viewer-host canvas');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const centre = {
    x: bounds!.x + bounds!.width * 0.62,
    y: bounds!.y + bounds!.height * 0.76
  };
  await sketchTools.getByRole('button', { name: /^Circle/ }).click();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 38, centre.y, { steps: 6 });
  await page.mouse.up();
  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await canvas.dispatchEvent('openzcad:e2e-select-profile', {
    detail: { index: 0 }
  });
  await page.getByTestId('direct-manipulation-value').click();
  const extrudeKeypad = page.getByRole('dialog', { name: 'Height value' });
  await extrudeKeypad.getByRole('textbox').fill('24');
  await extrudeKeypad.getByRole('button', { name: 'Apply height' }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Extrude' })
  ).toBeVisible();

  // Leave the extrude flow before selecting its feature: the panel stays out
  // of the way while a viewport command owns the screen.
  await page.keyboard.press('Escape');
  await page
    .locator('.feature-row-main', { hasText: 'Extrude' })
    .first()
    .click();
  // exact: the extrude panel now also carries a "Back distance" field,
  // which a substring label match resolves alongside this one.
  const distance = inspector.getByLabel('Distance', { exact: true });
  await distance.fill('0');
  await expect(inspector.getByText('Distance cannot be zero')).toBeVisible();
  await expect(
    inspector.getByRole('button', { name: /^Apply/ })
  ).toBeDisabled();

  // Negative is documented as valid — extrude below the plane — so the guard
  // must not swallow it.
  await distance.fill('-8');
  await expect(inspector.getByText('Distance cannot be zero')).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: /^Apply/ })).toBeEnabled();
});

test('each sketch plane label names the plane it actually opens', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Plane Names');
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  const status = page.getByRole('contentinfo');

  // These labels were Y-up names on Z-up planes, so each named the wrong one:
  // measured before the fix, "Ground (XZ)" built an upright wall and
  // "Front (XY)" built a slab lying on the grid. The status line is derived
  // from the plane id rather than from the label, so asserting it here pins
  // the label-to-plane mapping that was wrong — a rename that only edits
  // strings cannot keep this green.
  for (const [label, plane] of [
    ['Top (XY)', 'XY'],
    ['Front (XZ)', 'XZ'],
    ['Right (YZ)', 'YZ']
  ] as const) {
    await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
    await expect(page.getByText('Pick a sketch plane')).toBeVisible();
    await page.getByRole('button', { name: label }).click();
    await expect(status).toContainText(`Sketching on the ${plane} plane`);
    // Finish rather than Escape: leaving an empty sketch by Escape parks the
    // workspace in a state where the plane prompt will not re-open.
    await page
      .getByRole('toolbar', { name: 'Sketch tools' })
      .getByRole('button', { name: /Finish Sketch/ })
      .click();
    await expect(
      page.getByRole('toolbar', { name: 'Sketch tools' })
    ).toHaveCount(0);
  }

  // And an anchor in geometry for the one the app calls Top: a profile drawn
  // there extrudes upward, so the result is thinnest in Z.
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  const centre = {
    x: bounds.x + bounds.width * 0.55,
    y: bounds.y + bounds.height * 0.55
  };
  await sketchTools.getByRole('button', { name: /^Circle/ }).click();
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 150, centre.y, { steps: 10 });
  await page.mouse.up();
  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await canvas.dispatchEvent('openzcad:e2e-select-profile', {
    detail: { index: 0 }
  });
  await page.getByTestId('direct-manipulation-value').click();
  const extrudeKeypad = page.getByRole('dialog', { name: 'Height value' });
  await extrudeKeypad.getByRole('textbox').fill('24');
  await extrudeKeypad.getByRole('button', { name: 'Apply height' }).click();
  await expect(page.locator('.selection-chip')).toBeVisible();
  const chip = (await page.locator('.selection-chip').textContent()) ?? '';
  const triple = /([\d.]+)\s*×\s*([\d.]+)\s*×\s*([\d.]+)/.exec(chip);
  if (!triple) {
    throw new Error(`no size in selection chip: ${chip}`);
  }
  const [width, depth, height] = [
    Number(triple[1]),
    Number(triple[2]),
    Number(triple[3])
  ];
  expect(height).toBeLessThan(width);
  expect(height).toBeLessThan(depth);
});

test('Move is one UI: the gizmo names the feature and picks the body', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('One Move UI');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  // Two bodies and nothing selected — the case that used to open a different
  // Move UI from the one a selection would have opened (WF-07).
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Lower');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Upper');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const move = page.getByRole('form', { name: 'Move controls' });
  await expect(move).toBeVisible();
  // The feature inspector must not offer a second, differently-labelled Move.
  await expect(inspector).toHaveCount(0);

  // Both things the retired form carried now live here: a Name and a body
  // picker. Choosing a body from the picker is what the form existed for.
  await move.getByLabel('Body').selectOption({ label: 'Upper Body' });
  await move.getByLabel('Name').fill('Lift upper');
  await move.getByLabel('Move Z in mm').fill('40');
  await move.getByRole('button', { name: /Apply move/ }).click();

  // The name reaches the document, which is the capability whose loss kept
  // this unification unshipped.
  await expect(
    page.locator('.feature-row', { hasText: 'Lift upper' })
  ).toBeVisible();

  // And it moved the body the picker chose, not the one that happened to be
  // selected: Upper is the one now standing 40mm clear of the origin.
  await page.locator('.feature-row', { hasText: 'Lift upper' }).click();
  await expect(inspector.getByLabel('Move Z')).toHaveValue('40');
});

test('types an exact rectangle while drawing it', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Exact Rectangle');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(sketchTools).toBeVisible();
  // Screen-space clicks must wait for the head-on entry tween to settle.
  await page.waitForTimeout(800);

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  const corner = {
    x: bounds.x + bounds.width * 0.4,
    y: bounds.y + bounds.height * 0.6
  };

  await sketchTools.getByRole('button', { name: /^Rectangle/ }).click();
  // Click-click, not press-drag: a single click plants the first corner and
  // leaves the pointer free, which is the window numeric entry lives in.
  await page.mouse.click(corner.x, corner.y);
  await page.mouse.move(corner.x + 120, corner.y - 80, { steps: 5 });

  // Width, Tab, height, Enter. Tab swaps sides rather than converting, because
  // a rectangle's two sides are independent.
  await page.keyboard.type('40');
  await expect(page.locator('.sketch-dim-label')).toContainText('Width: 40');
  await page.keyboard.press('Tab');
  await page.keyboard.type('20');
  await expect(page.locator('.sketch-dim-label')).toContainText('Height: 20');
  await expect(page.locator('.sketch-dim-label')).toContainText('Width: 40');
  await page.keyboard.press('Enter');

  // Extruding is the honest check that the typed numbers reached the geometry:
  // on Top (XY) the width lands on X and the height on Y.
  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await canvas.dispatchEvent('openzcad:e2e-select-profile', {
    detail: { index: 0 }
  });
  await page.getByTestId('direct-manipulation-value').click();
  const extrudeKeypad = page.getByRole('dialog', { name: 'Height value' });
  await extrudeKeypad.getByRole('textbox').fill('24');
  await extrudeKeypad.getByRole('button', { name: 'Apply height' }).click();

  await expect(page.locator('.selection-chip')).toBeVisible();
  const chip = (await page.locator('.selection-chip').textContent()) ?? '';
  const triple = /([\d.]+)\s*×\s*([\d.]+)\s*×\s*([\d.]+)/.exec(chip);
  if (!triple) {
    throw new Error(`no size in selection chip: ${chip}`);
  }
  expect(Number(triple[1])).toBeCloseTo(40, 1);
  expect(Number(triple[2])).toBeCloseTo(20, 1);
});

test('dragging the move gizmo streams live values and commits what was dragged', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Move Drag Stream');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  const canvas = page.locator('.viewer-host canvas');
  const bounds = (await canvas.boundingBox())!;

  // Where the body sits before anything moves it. Captured on a settled model:
  // while a move preview is live the mesh is offset from the topology the hook
  // projects, so a pick there cannot be confirmed.
  const locateEdge = () =>
    canvas.evaluate(
      (element) =>
        new Promise<{ x: number; y: number } | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-locate-edge', { detail: { resolve } })
          );
        })
    );
  let before: { x: number; y: number } | null = null;
  await expect
    .poll(
      async () => {
        before = await locateEdge();
        return before !== null;
      },
      { message: 'the box should expose a pickable edge before the move' }
    )
    .toBe(true);

  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await expect(overlay).toBeVisible();

  // The gizmo has no published screen position, but the viewport switches the
  // canvas cursor to `grab` over a handle. Sweep outward from the body's
  // centre until the viewport says a handle is under the pointer, so the drag
  // below starts on a real one instead of a guessed pixel.
  const grabPoint = await (async () => {
    for (let radius = 0; radius <= 140; radius += 10) {
      const directions: readonly (readonly [number, number])[] = [
        [1, 0],
        [0.87, -0.5],
        [0.5, -0.87],
        [0, -1],
        [-0.87, -0.5],
        [-1, 0]
      ];
      for (const [dx, dy] of directions) {
        const point = {
          x: bounds.x + bounds.width / 2 + dx * radius,
          y: bounds.y + bounds.height / 2 + dy * radius
        };
        await page.mouse.move(point.x, point.y);
        const cursor = await canvas.evaluate((element) => element.style.cursor);
        if (cursor === 'grab') {
          return point;
        }
      }
    }
    throw new Error('No move-gizmo handle found under any probed point.');
  })();

  await page.mouse.move(grabPoint.x, grabPoint.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(grabPoint.x + step * 4, grabPoint.y);
    await page.waitForTimeout(12);
  }

  // Mid-drag: the panel's fields track the gesture even though the workspace
  // has not re-rendered. Before the live channel existed this only worked
  // because every pointer move committed React state.
  const draggedValues = async () =>
    Promise.all(
      ['Move X in mm', 'Move Y in mm', 'Move Z in mm'].map(async (label) =>
        Number(await overlay.getByLabel(label).inputValue())
      )
    );
  await expect
    .poll(async () => (await draggedValues()).some((value) => value !== 0), {
      message: 'the move panel should show the drag while it is happening'
    })
    .toBe(true);
  const liveValues = await draggedValues();

  await page.mouse.up();
  await page.waitForTimeout(150);

  // Releasing hands the same numbers to the workspace: what the panel showed
  // mid-drag is what a commit applies.
  expect(await draggedValues()).toEqual(liveValues);

  await overlay.getByRole('button', { name: /Apply move/ }).click();
  await expect(page.locator('.feature-row', { hasText: 'Move' })).toHaveCount(
    1
  );
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  // The committed feature has to carry the dragged distance, not the zero the
  // panel started from: a Move feature is created either way, so the body
  // moving on screen is what separates a real commit from an empty one.
  await expect
    .poll(
      async () => {
        const after = await locateEdge();
        return after ? Math.abs(after.x - before!.x) : 0;
      },
      { message: 'the committed move should displace the body on screen' }
    )
    .toBeGreaterThan(5);
});
