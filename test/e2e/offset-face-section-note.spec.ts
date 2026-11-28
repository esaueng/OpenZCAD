import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  expect,
  expectBodyCount,
  MODEL_ONLY,
  stubApi,
  test
} from './openzcad-fixtures';

const ready = { timeout: 30_000 };

/** The +X face's world bounds along X, read from the rendered body. */
async function boxSpanX(canvas: Locator) {
  return canvas.evaluate(
    (element) =>
      new Promise<{ min: number; max: number }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                bodyFaces: { worldBounds: { min: number[]; max: number[] } }[];
              }) => {
                const bounds = state.bodyFaces[0]!.worldBounds;
                resolve({ min: bounds.min[0]!, max: bounds.max[0]! });
              }
            }
          })
        );
      })
  );
}

/** Arms the offset handle on the box's +X face, as a click on it would. */
async function armSideFace(canvas: Locator) {
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: { normal: { x: 1, y: 0, z: 0 } }
          })
        )
      );
      return canvas.getAttribute('data-e2e-handle-x');
    }, ready)
    .not.toBeNull();
}

/** Puts a Side (YZ) cut at `position`, then puts the controls away. */
async function cutSideAt(page: Page, position: number, flipped = false) {
  const toggle = page.getByRole('button', { name: /^Section view — now:/ });
  const panel = page.getByRole('group', { name: 'Section view', exact: true });
  await toggle.click();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Side (YZ plane)' }).click();
  const offset = panel.getByRole('spinbutton', { name: 'Cut position' });
  await offset.fill(String(position));
  await offset.press('Enter');
  if (flipped) {
    const flip = panel.getByRole('button', { name: 'Flip cut direction' });
    await flip.click();
    await expect(flip).toHaveAttribute('aria-pressed', 'true');
  }
  await toggle.click();
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

/** Where the armed offset handle is on screen, and its screen direction. */
async function handleGrab(canvas: Locator) {
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    perUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const rect = (await canvas.boundingBox())!;
  const start = { x: rect.x + handle.x, y: rect.y + handle.y };
  return {
    start,
    /** The screen point `units` along the handle from where it is. */
    at: (units: number) => ({
      x: start.x + handle.dx * handle.perUnit * units,
      y: start.y + handle.dy * handle.perUnit * units
    })
  };
}

async function openBlock(page: Page) {
  const document = addPrimitiveFeature(
    createProjectDocument('Section note block', toUserId('user_e2e')),
    {
      name: 'Block',
      bodyName: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 20, depth: 10 }
    }
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Import project' }).click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'block.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: []
      })
    )
  });
  await expectBodyCount(page, 1);
}

test(
  'an offset face says when the section view hides part of it, and only then',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBlock(page);
    const canvas = page.locator('.viewer-host canvas');
    const span = await boxSpanX(canvas);
    const note = page.locator('.section-hidden-notice');

    // A cut beyond the face keeps all of it: nothing is said.
    await cutSideAt(page, span.max + 5);
    await armSideFace(canvas);
    await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();
    await expect(note).toHaveCount(0);
    await page.keyboard.press('Escape');

    // A cut through the block hides the +X face: the bar says so.
    await cutSideAt(page, (span.min + span.max) / 2);
    await armSideFace(canvas);
    await expect(note).toBeVisible(ready);
    await expect(note).toContainText('Section view hides part of this face');
    await expect(note).toContainText('Turn the section view off');

    // At a phone's width the note wraps inside the window, uncovered.
    await page.setViewportSize({ width: 390, height: 844 });
    const closeDrawer = page.getByRole('button', {
      name: 'Close tools drawer'
    });
    if (await closeDrawer.isVisible()) await closeDrawer.click();
    await expect(note).toBeVisible(ready);
    const turnOff = note.getByRole('button', { name: 'Turn off section' });
    await expect(turnOff).toBeVisible();
    for (const part of [
      note.locator('strong'),
      note.locator('.section-hidden-notice-detail'),
      turnOff
    ]) {
      const box = (await part.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      // Nothing stands over it, and its words are not cut short.
      expect(
        await part.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const top = element.ownerDocument.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2
          );
          return (
            top !== null &&
            element.contains(top) &&
            element.scrollWidth <= element.clientWidth + 1
          );
        })
      ).toBe(true);
    }

    // Its way out turns the cut off, and the note goes with it.
    await turnOff.click();
    await expect(note).toHaveCount(0);
  }
);

test(
  'a face held past the cut mid-drag brings the note before release',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBlock(page);
    const canvas = page.locator('.viewer-host canvas');
    const span = await boxSpanX(canvas);
    const note = page.locator('.section-hidden-notice');

    // A cut 1 mm beyond the +X face: the face at rest is whole.
    await cutSideAt(page, span.max + 1);
    await armSideFace(canvas);
    await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();
    await expect(note).toHaveCount(0);

    // Drag the face 3 mm outward and hold it there, never releasing: the
    // viewer's own mesh preview draws it past the cut, and the bar says so.
    const handle = await canvas.evaluate((element) => ({
      x: Number(element.dataset.e2eHandleX),
      y: Number(element.dataset.e2eHandleY),
      dx: Number(element.dataset.e2eHandleDx),
      dy: Number(element.dataset.e2eHandleDy),
      perUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
    }));
    const rect = (await canvas.boundingBox())!;
    const start = { x: rect.x + handle.x, y: rect.y + handle.y };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(
      start.x + handle.dx * handle.perUnit * 3,
      start.y + handle.dy * handle.perUnit * 3,
      { steps: 12 }
    );
    // The drawn body reaches past the cut while the hand holds it.
    await expect
      .poll(async () => (await boxSpanX(canvas)).max, ready)
      .toBeGreaterThan(span.max + 1.5);
    await expect(note).toBeVisible(ready);
    await expect(note).toContainText('Section view hides part of this face');
    await page.mouse.up();
  }
);

test(
  'a release the edit refuses takes the note down with the restored face',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openBlock(page);
    const canvas = page.locator('.viewer-host canvas');
    const span = await boxSpanX(canvas);
    const width = span.max - span.min;
    const note = page.locator('.section-hidden-notice');

    // A flipped cut keeps x ≥ min + 10: the +X face at rest is whole.
    await cutSideAt(page, span.min + 10, true);
    await armSideFace(canvas);
    await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();
    await expect(note).toHaveCount(0);

    // Push the face in until the viewer draws it inside the cut-away side.
    const grab = await handleGrab(canvas);
    await page.mouse.move(grab.start.x, grab.start.y);
    await page.mouse.down();
    const inside = grab.at(-(width - 6));
    await page.mouse.move(inside.x, inside.y, { steps: 8 });
    await expect(canvas).toHaveAttribute(
      'data-e2e-height-proxy-offset',
      /^-\d/,
      ready
    );
    await expect(note).toBeVisible(ready);

    // On past zero width in one move: the viewer cannot draw that and keeps
    // the last clipped mesh, so the note stays while it is on screen.
    const past = grab.at(-(width + 6));
    await page.mouse.move(past.x, past.y);
    const kept = await canvas.getAttribute('data-e2e-height-proxy-offset');
    expect(Number(kept)).toBeLessThan(-(width - 10));
    await expect(note).toBeVisible();
    await page.waitForTimeout(300);
    await expect(note).toBeVisible();

    // Let go there: the edit is refused and the viewer draws the block as
    // it was, whole on the kept side, so the note goes with the moved mesh.
    await page.mouse.up();
    await expect
      .poll(async () => (await boxSpanX(canvas)).max, ready)
      .toBeCloseTo(span.max, 3);
    await expect(canvas).not.toHaveAttribute(
      'data-e2e-height-proxy-offset',
      /.+/
    );
    // The face is whole again, so the note is gone and stays gone.
    await expect(note).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(note).toHaveCount(0);
  }
);
