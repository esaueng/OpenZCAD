import type { Locator, Page } from '@playwright/test';
import type {
  FeatureNode,
  ProjectDocument,
  SketchObjectData
} from '@openzcad/shared';
import {
  barChoice,
  chooseBarOption,
  clickWorldPoint,
  createProject,
  expect,
  enterCommandValue,
  extrudeBar,
  finishInPlaceCommand,
  MODEL_ONLY,
  revealModelPanel,
  pressTool,
  setBarValues,
  setSelectionFilter,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

const READY = { timeout: 30_000 };
const PROJECT = 'U11 Slotted Plate';
const RECTANGLE_CORNERS: [number, number, number][] = [
  [40, 25, 0],
  [-40, 25, 0],
  [-40, -25, 0],
  [40, -25, 0]
];

async function exportDocument(page: Page): Promise<ProjectDocument> {
  const file = page.locator('details.file-menu');
  const toggle = file.locator('summary');
  await toggle.click();
  const [download] = await Promise.all([
    page.waitForEvent('download', READY),
    file.getByRole('button', { name: /^Export project/ }).click()
  ]);
  const chunks = [];
  for await (const chunk of await download.createReadStream())
    chunks.push(chunk);
  if ((await file.getAttribute('open')) !== null) await toggle.click();
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

function findSketch(document: ProjectDocument) {
  const sketch = Object.values(document.nodes).find(
    (node) => node.kind === 'sketch'
  );
  if (!sketch) throw new Error('The sketch is missing.');
  return sketch;
}

function sketchObject(document: ProjectDocument, id: string): SketchObjectData {
  const node = document.nodes[id];
  if (node?.kind !== 'sketch-object')
    throw new Error('Sketch object is missing.');
  return node.data;
}

function sketchObjects(document: ProjectDocument) {
  return findSketch(document).objectIds.map((id) => sketchObject(document, id));
}

function sketchSnapshot(document: ProjectDocument) {
  const sketch = findSketch(document);
  return {
    sketchId: sketch.sketchId,
    objects: sketch.objectIds.map((id) => ({
      id,
      data: sketchObject(document, id)
    })),
    constraints: sketch.constraints ?? [],
    composites: sketch.composites ?? []
  };
}

function expectRoundedRectangle(
  document: ProjectDocument,
  centers: string[],
  lengths: number[]
) {
  const objects = sketchObjects(document);
  const arcs = objects.filter((object) => object.objectKind === 'arc');
  expect(arcs.map((arc) => arc.radius)).toEqual(centers.map(() => 5));
  expect(arcs.map((arc) => `${arc.centerX},${arc.centerY}`).sort()).toEqual(
    [...centers].sort()
  );
  const edgeLengths = objects
    .filter((object) => object.objectKind === 'line')
    .filter((line) => !line.construction)
    .map((line) =>
      Math.hypot(
        Number(line.x2) - Number(line.x1),
        Number(line.y2) - Number(line.y1)
      )
    )
    .sort((a, b) => a - b);
  expect(edgeLengths).toHaveLength(lengths.length);
  for (const [index, length] of lengths.entries()) {
    expect(edgeLengths[index]).toBeCloseTo(length, 8);
  }
}

function sketchFilletBar(page: Page) {
  return page.getByRole('group', {
    name: 'Sketch Fillet command',
    exact: true
  });
}

function sketchFilletTool(page: Page) {
  return page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: /^Fillet(?:$| —)/ });
}

function sketchFilletCorners(page: Page, pressed: boolean) {
  return page
    .getByTestId('sketch-fillet-corner')
    .and(page.getByRole('button', { pressed }));
}

async function holdNextSketchSolve(page: Page) {
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
      const message = args[0] as { type?: string; requestId?: string };
      if (message.type !== 'solve-sketch' || !message.requestId) {
        Reflect.apply(original, this, args);
        return;
      }
      Worker.prototype.postMessage = original;
      const worker = this;
      Reflect.set(
        window,
        '__releaseSketchFilletSolve',
        () =>
          new Promise<void>((resolve) => {
            function replied(event: MessageEvent<{ requestId?: string }>) {
              if (event.data.requestId !== message.requestId) return;
              worker.removeEventListener('message', replied);
              resolve();
            }
            worker.addEventListener('message', replied);
            Reflect.apply(original, worker, args);
          })
      );
    };
  });
}

async function drawCenteredRectangle(page: Page, name: string) {
  await createProject(page, name);
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(rail).toBeVisible();
  await waitForStillViewport(page);
  await rail.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await rail
    .getByRole('radiogroup', { name: 'Shape type' })
    .getByRole('radio', { name: 'Center', exact: true })
    .click();
  await clickWorldPoint(page, [0, 0, 0]);
  const canvas = page.locator('.viewer-host canvas');
  const corner = await projectPoint(canvas, [40, 25, 0]);
  await page.mouse.move(corner.x, corner.y, { steps: 4 });
  await page.keyboard.press('8');
  await page.keyboard.press('0');
  await page.keyboard.press('Tab');
  await page.keyboard.press('5');
  await page.keyboard.press('0');
  await expect(page.locator('.sketch-dim-label')).toContainText(
    'Height: 50 mm · Width: 80'
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText(
    /Sketch 01 started|Added rectangle/
  );
}

function feature(
  document: ProjectDocument,
  kind: 'extrude' | 'fillet'
): FeatureNode {
  const matches = Object.values(document.nodes).filter(
    (node): node is FeatureNode =>
      node.kind === 'feature' && node.data.featureKind === kind
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function projectPoint(canvas: Locator, point: [number, number, number]) {
  return canvas.evaluate(
    (element, point) =>
      new Promise<{ x: number; y: number }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: [point],
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points[0]!)
            }
          })
        );
      }),
    point
  );
}

function readBlend(canvas: Locator, radius: number) {
  return canvas.evaluate(
    (element, blendRadius) =>
      new Promise<{ blendRadius: number } | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-blend', {
            detail: { inspectOnly: true, select: false, blendRadius, resolve }
          })
        );
      }),
    radius
  );
}

test(
  'U11 builds a slotted plate and edits the same two-edge fillet from History',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.route('**/api/session', (route) =>
      route.fulfill({ json: null })
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const canvas = page.locator('.viewer-host canvas');
    const status = page.getByRole('contentinfo');
    const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
    const shapeTypes = rail.getByRole('radiogroup', { name: 'Shape type' });
    const chip = page.getByTestId('command-handle-radius');
    const historyEdit = page.getByRole('group', {
      name: 'Edit Fillet command'
    });
    const filletRow = page.locator('.feature-row-main', { hasText: /^Fillet/ });

    const rectangle =
      await test.step('Create an 80 × 50 mm centered rectangle on XY', async () => {
        await drawCenteredRectangle(page, PROJECT);
        const document = await exportDocument(page);
        expect(document.units).toBe('mm');
        expect(findSketch(document).planeRef).toMatchObject({
          type: 'canonical',
          plane: 'XY',
          offset: 0
        });
        const lines = sketchObjects(document)
          .filter((object) => object.objectKind === 'line')
          .filter((line) => !line.construction);
        expect(lines).toHaveLength(4);
        const xs = new Set();
        const ys = new Set();
        for (const line of lines) {
          xs.add(line.x1);
          xs.add(line.x2);
          ys.add(line.y1);
          ys.add(line.y2);
        }
        expect(xs).toEqual(new Set([-40, 40]));
        expect(ys).toEqual(new Set([-25, 25]));
        const original = sketchSnapshot(document);
        expect(original.constraints.length).toBeGreaterThan(0);
        return original;
      });

    await test.step('Round all four sketch corners to R5 in one edit', async () => {
      await sketchFilletTool(page).click();
      const bar = sketchFilletBar(page);
      await expect(bar).toBeVisible(READY);
      await expect(sketchFilletCorners(page, false)).toHaveCount(4, READY);
      const picked = sketchFilletCorners(page, true);
      await waitForStillViewport(page);
      await clickWorldPoint(page, RECTANGLE_CORNERS[0]!);
      await expect(picked).toHaveCount(1);
      await holdNextSketchSolve(page);
      await bar.getByRole('button', { name: 'Done', exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.has(window, '__releaseSketchFilletSolve'))
        )
        .toBe(true);
      await bar.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(bar).toHaveCount(0);
      await page.evaluate(() =>
        Reflect.get(window, '__releaseSketchFilletSolve')()
      );
      expect(sketchSnapshot(await exportDocument(page))).toEqual(rectangle);

      await sketchFilletTool(page).click();
      await expect(sketchFilletCorners(page, false)).toHaveCount(4, READY);
      for (const [index, corner] of RECTANGLE_CORNERS.entries()) {
        await clickWorldPoint(page, corner);
        await expect(picked).toHaveCount(index + 1);
      }

      await bar.getByRole('button', { name: /^(?:Fillet )?Radius\b/i }).click();
      const keypad = page.getByRole('dialog', { name: 'Fillet radius value' });
      const radius = keypad.getByRole('textbox', { name: 'Fillet radius' });
      await expect(radius).toBeFocused();
      await radius.press('ControlOrMeta+a');
      await radius.press('5');
      await expect(radius).toHaveValue('5');
      await radius.press('Enter');
      await expect(keypad).toBeHidden();
      await expect(bar).toBeVisible();
      await expect(picked).toHaveCount(4);
      expect(sketchSnapshot(await exportDocument(page))).toEqual(rectangle);

      await finishInPlaceCommand(page, 'Sketch Fillet');

      const filleted = await exportDocument(page);
      expectRoundedRectangle(
        filleted,
        ['35,20', '-35,20', '-35,-20', '35,-20'],
        [40, 40, 70, 70]
      );
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect(sketchSnapshot(await exportDocument(page))).toEqual(rectangle);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      expect(sketchSnapshot(await exportDocument(page))).toEqual(
        sketchSnapshot(filleted)
      );
    });

    await test.step('Place the 40 mm center-to-center slot with R3', async () => {
      await rail
        .getByRole('button', { name: 'Rectangle', exact: true })
        .click();
      await shapeTypes
        .getByRole('radio', { name: 'Slot', exact: true })
        .click();
      await clickWorldPoint(page, [-20, 0, 0]);
      // The second pick sets the direction. Start with a shorter slot so the
      // saved center distance has to come from the numeric entry.
      await clickWorldPoint(page, [15, 0, 0]);
      const radiusPoint = await projectPoint(canvas, [15, 5, 0]);
      await page.mouse.move(radiusPoint.x, radiusPoint.y);
      await page.getByRole('button', { name: /^Center spacing / }).click();
      const spacing = page.getByRole('dialog', {
        name: 'Center spacing value'
      });
      await spacing.getByRole('textbox').fill('40');
      await spacing.getByRole('textbox').press('Enter');
      await expect(spacing).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Center spacing 40 mm' })
      ).toBeVisible();
      await page.getByRole('button', { name: /^Radius / }).click();
      const radius = page.getByRole('dialog', { name: 'Radius value' });
      await radius.getByRole('textbox').fill('3');
      await radius.getByRole('textbox').press('Enter');
      await expect(radius).toHaveCount(0);
      await expect(status).toContainText('Added slot.');
      const document = await exportDocument(page);
      const slot = findSketch(document).composites?.find(
        (composite) => composite.compositeKind === 'slot'
      );
      if (!slot) throw new Error('The slot composite is missing.');
      expect(slot.method).toBe('center-to-center');
      expect(slot.edgeIds).toHaveLength(4);
      expect(slot.helperIds).toHaveLength(1);
      const centers = sketchObject(document, slot.helperIds![0]!);
      if (centers.objectKind !== 'line')
        throw new Error('Slot center line is missing.');
      expect(centers.construction).toBe(true);
      expect(
        Math.hypot(
          Number(centers.x2) - Number(centers.x1),
          Number(centers.y2) - Number(centers.y1)
        )
      ).toBeCloseTo(40, 8);
      for (const index of [1, 3]) {
        const arc = sketchObject(document, slot.edgeIds[index]!);
        if (arc.objectKind !== 'arc')
          throw new Error('Slot end arc is missing.');
        expect(Number(arc.radius)).toBeCloseTo(3, 8);
      }
      await page.getByRole('button', { name: /^Finish sketch/i }).click();
      await expect(rail).toHaveCount(0);
    });

    const extrusion =
      await test.step('Extrude the plate region as a 10 mm New body and check the slot is open', async () => {
        await page.keyboard.press('2');
        await waitForStillViewport(page);
        await clickWorldPoint(page, [0, 14, 0]);
        const bar = extrudeBar(page);
        await expect(bar).toBeVisible();
        await expect(bar.getByRole('button', { name: 'Done' })).toBeDisabled();
        await expect(barChoice(bar, 'Operation', 'Auto')).toHaveAttribute(
          'aria-checked',
          'true'
        );
        await chooseBarOption(bar, 'Extent', 'Distance');
        await setBarValues(page, bar, { Distance: '10' });
        await expect(bar).toContainText('Preview: New body', READY);
        await finishInPlaceCommand(page, 'Extrude');
        await expect(canvas).toHaveAttribute(
          'data-e2e-rendered-bodies',
          '1',
          READY
        );
        const extrusion = feature(await exportDocument(page), 'extrude');
        expect(extrusion.data).toMatchObject({
          distance: 10,
          operation: 'new-body'
        });
        if (extrusion.data.featureKind !== 'extrude')
          throw new Error('Expected an extrusion.');
        expect(extrusion.data.endCondition ?? 'blind').toBe('blind');
        const profiles = extrusion.data.profiles ?? [extrusion.data.profile];
        expect(profiles).toHaveLength(1);
        const profile = profiles[0];
        if (!profile || profile.all)
          throw new Error('Expected a picked sketch region.');
        // The region picker measures the outline with sampled curves. Its area
        // should match the rounded 80 × 50 plate minus the 40 × 6 + end caps.
        const plateArea = 80 * 50 - (4 - Math.PI) * 5 ** 2;
        const slotArea = 40 * 6 + Math.PI * 3 ** 2;
        expect(
          Math.abs(profile.sourceArea - (plateArea - slotArea))
        ).toBeLessThan(2);

        await setSelectionFilter(page, 'Face');
        await clickWorldPoint(page, [0, 14, 10]);
        await expect(canvas).toHaveAttribute(
          'data-e2e-selected-face',
          /.+/,
          READY
        );
        await page.keyboard.press('Escape');
        await expect(canvas).not.toHaveAttribute('data-e2e-selected-face');
        const slot = await projectPoint(canvas, [0, 0, 10]);
        expect(
          await canvas.evaluate(
            (element, point) =>
              document.elementFromPoint(point.x, point.y) === element,
            slot
          )
        ).toBe(true);
        await page.mouse.click(slot.x, slot.y);
        await expect(canvas).not.toHaveAttribute('data-e2e-selected-face');
        return extrusion;
      });

    const created =
      await test.step('Pick two wall edges and apply a 1 mm solid Fillet', async () => {
        await setSelectionFilter(page, 'Edge');
        await clickWorldPoint(page, [-15, -25, 10]);
        await expect(status).toContainText('1 edge selected');
        await page.keyboard.down('Shift');
        try {
          await clickWorldPoint(page, [15, 25, 10]);
        } finally {
          await page.keyboard.up('Shift');
        }
        await expect(status).toContainText('2 edges selected');
        await expect(canvas).toHaveAttribute(
          'data-e2e-selected-edges',
          /^[^,]+,[^,]+$/
        );
        await pressTool(page, /^Fillet —/);
        const bar = page.getByRole('group', { name: 'Fillet command' });
        await expect(bar).toContainText('2 edges ·');
        await enterCommandValue(page, 'radius', '1');
        await expect(chip).toHaveText('R 1 mm');
        await finishInPlaceCommand(page, 'Fillet');
        await expect
          .poll(() => readBlend(canvas, 1), READY)
          .toMatchObject({ blendRadius: 1 });
        const document = await exportDocument(page);
        const fillet = feature(document, 'fillet');
        expect(fillet.data).toMatchObject({
          radius: 1,
          targetBodyId: extrusion.bodyId,
          edgeHashes: [expect.any(Number), expect.any(Number)]
        });
        if (fillet.data.featureKind !== 'fillet')
          throw new Error('Expected a fillet.');
        expect(new Set(fillet.data.edgeHashes).size).toBe(2);
        return document;
      });

    await test.step('Reopen the same Fillet from History, preview, cancel, and apply', async () => {
      await revealModelPanel(page);
      await expect(page.locator('.feature-row-main')).toHaveCount(3);
      await filletRow.click();
      await expect(historyEdit).toContainText('2 edges ·');
      await expect(chip).toHaveText('R 1 mm');
      await enterCommandValue(page, 'radius', '2');
      await expect
        .poll(() => readBlend(canvas, 2), READY)
        .toMatchObject({ blendRadius: 2 });
      await historyEdit.getByRole('button', { name: 'Cancel' }).click();
      await expect(historyEdit).toHaveCount(0);
      await expect
        .poll(() => readBlend(canvas, 1), READY)
        .toMatchObject({ blendRadius: 1 });
      expect(feature(await exportDocument(page), 'fillet')).toEqual(
        feature(created, 'fillet')
      );

      await filletRow.click();
      await expect(chip).toHaveText('R 1 mm');
      await enterCommandValue(page, 'radius', '2');
      await expect
        .poll(() => readBlend(canvas, 2), READY)
        .toMatchObject({ blendRadius: 2 });
      await finishInPlaceCommand(page, 'Edit Fillet');
      await expect(status).toContainText('Edited Fillet', READY);
      await expect(page.locator('.feature-row-main')).toHaveCount(3);
    });

    await test.step('Undo, redo, reload, and reopen that History feature', async () => {
      const identity = feature(created, 'fillet');
      for (const [action, radius] of [
        ['Undo', 1],
        ['Redo', 2]
      ] as const) {
        await page.getByRole('button', { name: action, exact: true }).click();
        await expect
          .poll(() => readBlend(canvas, radius), READY)
          .toMatchObject({
            blendRadius: radius
          });
        const document = await exportDocument(page);
        expect(document.featureOrder).toEqual(created.featureOrder);
        expect(feature(document, 'fillet')).toMatchObject({
          featureId: identity.featureId,
          data: { ...identity.data, radius }
        });
      }
      await expect(
        page.getByRole('status', { name: 'Local only', exact: true })
      ).toBeVisible(READY);
      await page.reload();
      await revealModelPanel(page);
      await expect(page.locator('.feature-row-main')).toHaveCount(3);
      await expect
        .poll(() => readBlend(canvas, 2), READY)
        .toMatchObject({
          blendRadius: 2
        });
      const reloaded = await exportDocument(page);
      expect(reloaded.featureOrder).toEqual(created.featureOrder);
      expect(sketchSnapshot(reloaded)).toEqual(sketchSnapshot(created));
      expect(feature(reloaded, 'fillet')).toMatchObject({
        featureId: identity.featureId,
        data: { ...identity.data, radius: 2 }
      });
      await filletRow.click();
      await expect(historyEdit).toContainText('2 edges ·');
      await expect(chip).toHaveText('R 2 mm');
    });
    expect(errors).toEqual([]);
  }
);

test.describe('Sketch Fillet on touch', () => {
  test.use({ hasTouch: true });

  test('taps toggle corners and an oversized radius leaves the picks available for retry', async ({
    page
  }) => {
    test.setTimeout(90_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.route('**/api/session', (route) =>
      route.fulfill({ json: null })
    );
    await drawCenteredRectangle(page, 'Sketch Fillet touch');
    const original = sketchSnapshot(await exportDocument(page));
    const canvas = page.locator('.viewer-host canvas');

    await sketchFilletTool(page).tap();
    const bar = sketchFilletBar(page);
    await expect(bar).toBeVisible(READY);
    await expect(sketchFilletCorners(page, false)).toHaveCount(4, READY);
    await waitForStillViewport(page);
    const picked = sketchFilletCorners(page, true);
    const done = bar.getByRole('button', { name: 'Done', exact: true });
    const tapCorner = async (point: [number, number, number]) => {
      const { x, y } = await projectPoint(canvas, point);
      await page.touchscreen.tap(x, y);
    };

    await tapCorner([-40, 25, 0]);
    await expect(picked).toHaveCount(1);
    await tapCorner([-40, 25, 0]);
    await expect(picked).toHaveCount(0);
    await tapCorner([40, 25, 0]);
    await expect(picked).toHaveCount(1);
    await tapCorner([40, -25, 0]);
    await expect(picked).toHaveCount(2);

    const radiusButton = bar.getByRole('button', {
      name: /^(?:Fillet )?Radius\b/i
    });
    const keypad = page.getByRole('dialog', { name: 'Fillet radius value' });
    const radiusInput = keypad.getByRole('textbox', { name: 'Fillet radius' });
    const applyRadius = keypad.getByRole('button', {
      name: 'Apply fillet radius',
      exact: true
    });
    const enterRadiusByTap = async (radius: string) => {
      await radiusButton.tap();
      const prefill = await radiusInput.inputValue();
      const backspace = keypad.getByRole('button', { name: 'Backspace' });
      for (let index = 0; index < prefill.length; index++) {
        await backspace.tap();
      }
      for (const digit of radius) {
        await keypad.getByRole('button', { name: digit, exact: true }).tap();
      }
      await expect(radiusInput).toHaveValue(radius);
      await applyRadius.tap();
      await expect(keypad).toBeHidden();
    };

    // Each corner alone can take R26. Together their 52 mm of setbacks
    // exceed the 50 mm edge they share.
    await enterRadiusByTap('26');
    expect(sketchSnapshot(await exportDocument(page))).toEqual(original);
    await expect(done).toBeDisabled();
    await expect(picked).toHaveCount(2);

    await enterRadiusByTap('5');
    await expect(done).toBeEnabled(READY);
    await done.tap();
    await expect(bar).toHaveCount(0, READY);
    expectRoundedRectangle(
      await exportDocument(page),
      ['35,20', '35,-20'],
      [40, 50, 75, 75]
    );
  });
});
