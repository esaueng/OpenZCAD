import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  expectBodyCount,
  pickPlanarFace,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * PR #2048 review: a box unioned with a cylinder at the origin. The cylinder
 * (R12) swallows the box's left face, so the Union's Right face has no flat
 * face opposite it: its value tag names plain "Offset", with no Total to
 * switch to. The cylinder's wall is resized through the Union, whose drag
 * the geometry worker previews.
 */
function boxCylinderUnion() {
  const box = addPrimitiveFeature(
    createProjectDocument('Box cylinder union', toUserId('user_e2e')),
    {
      name: 'Box 1',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 10, depth: 10 }
    }
  );
  const withCylinder = addPrimitiveFeature(box, {
    name: 'Cylinder 1',
    primitiveKind: 'cylinder',
    dimensions: { radius: 12, height: 20 }
  });
  return booleanBodies(withCylinder, {
    name: 'Union 1',
    operation: 'union',
    targetBodyIds: [box.bodyOrder[0]!, withCylinder.bodyOrder[1]!]
  }).document;
}

async function openUnion(page: Page) {
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle(/OpenZCAD/);
  await page.getByRole('button', { name: 'Import project' }).click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'box-cylinder-union.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: boxCylinderUnion(),
        files: []
      })
    )
  });
  await expectBodyCount(page, 1);
  await waitForStillViewport(page);
}

test(
  "names a no-span face's mode plain Offset, which opens exact entry",
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openUnion(page);
    const canvas = page.locator('.viewer-host canvas');
    const tag = page.getByTestId('direct-manipulation-mode');
    await expect
      .poll(async () => {
        await pickPlanarFace(page, { x: 1, y: 0, z: 0 });
        return canvas.getAttribute('data-e2e-handle-x');
      })
      .not.toBeNull();
    await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
      /^\+0 /
    );
    // Settled: the body's analysis has had its chance to find a span, and
    // the tag still names Offset alone, without a switch's caret.
    await waitForStillViewport(page);
    await expect(tag).toBeVisible();
    await expect(tag).toHaveText('Offset');
    await expect(tag).toHaveAttribute(
      'title',
      /^Offset: a typed value is how far the face moves/
    );
    // The hint offers only what the tag does.
    const hint = page.locator('.workspace-hint');
    await expect(hint).toContainText(
      'Drag to push or pull the face, or type its Offset'
    );
    await expect(hint).not.toContainText('Offset or Total');

    // With nothing to switch to, the tag is the way into exact entry.
    const keypad = page.getByRole('dialog', { name: 'Offset value' });
    await expect(keypad).toHaveCount(0);
    await tag.click();
    await expect(keypad).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Total value' })).toHaveCount(
      0
    );
    await expect(tag).toHaveText('Offset');
    expect(errors).toEqual([]);
  }
);

type RefusalScope = typeof window & {
  forcedRefusals: number;
  cardLog: { name: string; detail: string }[];
};

/**
 * Refuses every worker preview of the cylinder at R18 (Ø36) or more, the
 * way the kernel turns a size down: a drag held there keeps the last frame
 * that built on screen while the hand's value is refused.
 */
async function refusePreviewsFrom(page: Page, radius: number) {
  await page.addInitScript((limit) => {
    const scope = window as RefusalScope;
    scope.forcedRefusals = 0;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      const request = message as {
        type?: string;
        requestId?: string;
        document?: {
          nodes: Record<
            string,
            {
              data?: {
                featureKind?: string;
                primitiveKind?: string;
                dimensions?: { radius?: unknown };
                operation?: { radius?: unknown; diameter?: unknown };
              };
            }
          >;
        };
      } | null;
      const document = request?.document;
      if (request?.type === 'preview-geometry' && document) {
        const radii = Object.values(document.nodes).flatMap(({ data }) => [
          ...(data?.featureKind === 'primitive' &&
          data.primitiveKind === 'cylinder' &&
          typeof data.dimensions?.radius === 'number'
            ? [data.dimensions.radius]
            : []),
          ...(data?.featureKind === 'direct-edit' &&
          typeof data.operation?.radius === 'number'
            ? [data.operation.radius]
            : []),
          ...(data?.featureKind === 'direct-edit' &&
          typeof data.operation?.diameter === 'number'
            ? [data.operation.diameter / 2]
            : [])
        ]);
        if (radii.some((value) => value >= limit - 1e-9)) {
          scope.forcedRefusals += 1;
          const reply = {
            type: 'preview-geometry',
            ok: false,
            requestId: request.requestId,
            error: 'The cylinder cannot reach this size here.'
          };
          setTimeout(() =>
            this.dispatchEvent(new MessageEvent('message', { data: reply }))
          );
          return;
        }
      }
      return send.call(this, message, transfer as StructuredSerializeOptions);
    };
  }, radius);
}

// Beta recording, 2026-11: dragging a Union's cylinder Ø12→Ø23 read
// "Union 1 · Cylindrical face Ø12 · Ø 23 mm". PR #2048's browser check then
// held the drag at a size the kernel refused and read "Cylindrical face Ø24
// · Ø 42 mm": the card's name kept the last frame that built.
test(
  "names a Union's resized cylinder by the live diameter, never the stale one",
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await refusePreviewsFrom(page, 18);
    await openUnion(page);
    const canvas = page.locator('.viewer-host canvas');
    const value = page.getByTestId('direct-manipulation-value');
    const name = page.locator('.selection-readout .selection-callout-name');
    const detail = page.locator('.selection-readout .selection-callout-detail');
    await expect
      .poll(() =>
        canvas.evaluate(
          (element) =>
            new Promise<number | null>((resolve) =>
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-cylinder', {
                  detail: {
                    surface: 'wall',
                    radius: 12,
                    resolve: (geometry: { radius?: number } | null) =>
                      resolve(geometry?.radius ?? null)
                  }
                })
              )
            )
        )
      )
      .toBe(12);
    await expect(
      page.getByRole('region', { name: 'Resize Cylinder operation' })
    ).toBeVisible();
    await expect(value).toHaveText('Ø 24 mm');
    await expect(name).toHaveText(/Cylindrical face Ø24$/);
    await expect(detail).toHaveText('Ø 24 mm');
    await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    const bounds = (await canvas.boundingBox())!;
    const start = { x: bounds.x + handle.x, y: bounds.y + handle.y };
    const moveTo = (radiusChange: number) =>
      page.mouse.move(
        start.x + handle.dx * handle.pixelsPerUnit * radiusChange,
        start.y + handle.dy * handle.pixelsPerUnit * radiusChange,
        { steps: 4 }
      );
    // Every state the card passes through, name and line together.
    await page.evaluate(() => {
      const scope = window as RefusalScope;
      const readout = document.querySelector('.selection-readout')!;
      const read = () => ({
        name:
          readout.querySelector('.selection-callout-name')?.textContent ?? '',
        detail:
          readout.querySelector('.selection-callout-detail')?.textContent ?? ''
      });
      scope.cardLog = [read()];
      new MutationObserver(() => scope.cardLog.push(read())).observe(readout, {
        subtree: true,
        childList: true,
        characterData: true
      });
    });

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    // Out to Ø28, which builds: the name reads the live size.
    await moveTo(2);
    await expect(value).toHaveText('Ø 28 mm');
    await expect(name).toHaveText(/Cylindrical face Ø28$/);
    await expect(detail).toHaveText('Ø 28 mm');

    // Out to Ø42, which is refused: the frame on screen is the last that
    // built, and the name must not carry its size beside the hand's.
    await moveTo(9);
    await expect(value).toHaveText('Ø 42 mm');
    await expect
      .poll(() => page.evaluate(() => (window as RefusalScope).forcedRefusals))
      .toBeGreaterThan(0);
    await expect(value).toHaveAttribute('data-state', 'warning');
    // The line measures the frame on screen; the name, rebuilt with it,
    // drops its number rather than repeat a size the hand has left.
    await expect(name).toHaveText(/Cylindrical face$/);

    // Back to Ø30, which builds, and released there.
    await moveTo(3);
    await expect(value).toHaveText('Ø 30 mm');
    await expect(name).toHaveText(/Cylindrical face Ø30$/);
    await page.mouse.up();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Adjusted cylinder diameter to Ø 30 mm.'
    );
    await expect(name).toHaveText(/Cylindrical face Ø30$/);
    await expect(detail).toHaveText('Ø 30 mm');

    // At no point did the name carry a size other than the line beside it.
    const log = await page.evaluate(() => (window as RefusalScope).cardLog);
    const named = (text: string) => /Ø(\d+(?:\.\d+)?)$/.exec(text)?.[1];
    const measured = (text: string) => /^Ø (\d+(?:\.\d+)?) mm$/.exec(text)?.[1];
    const torn = log.filter(
      (entry) =>
        named(entry.name) !== undefined &&
        measured(entry.detail) !== undefined &&
        named(entry.name) !== measured(entry.detail)
    );
    expect(torn).toEqual([]);
    expect(errors).toEqual([]);
  }
);
