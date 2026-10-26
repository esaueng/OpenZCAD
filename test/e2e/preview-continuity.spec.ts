import type { Page } from '@playwright/test';
import {
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi,
  expectBodyCount,
  setInPlaceOptionValues
} from './openzcad-fixtures';

/**
 * A preview must stay on screen until whatever replaces it arrives: the next
 * value's preview, or the committed result. Clearing it first showed the part
 * as it was (a bare sketch, sharp edges) for a whole rebuild on every
 * keystroke and on every Create. The worker's exact replies are held back so
 * that window is long enough to see, and every frame records what the
 * viewport drew.
 */

declare global {
  interface Window {
    __exactReplies?: { delayMs: number; held: number };
    __drawn?: number[];
  }
}

/** Delays the worker's replies to one-off exact rebuilds and previews. */
async function slowExactReplies(page: Page) {
  await page.addInitScript(() => {
    window.__exactReplies = { delayMs: 0, held: 0 };
    const descriptor = Object.getOwnPropertyDescriptor(
      Worker.prototype,
      'onmessage'
    )!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      ...descriptor,
      set(listener: (event: MessageEvent) => void) {
        descriptor.set!.call(this, (event: MessageEvent) => {
          const result = event.data as { type?: string; requestId?: string };
          const gate = window.__exactReplies!;
          if (
            gate.delayMs > 0 &&
            (result.type === 'sync' || result.type === 'preview-geometry') &&
            typeof result.requestId === 'string'
          ) {
            gate.held += 1;
            setTimeout(() => listener.call(this, event), gate.delayMs);
          } else listener.call(this, event);
        });
      }
    });
  });
}

/**
 * Records, every frame, the triangles the viewport draws for bodies: zero for
 * a bare sketch, a box's dozen, or a filleted body's many more.
 */
async function recordDrawn(page: Page) {
  await page.evaluate(() => {
    const canvas = document.querySelector('.viewer-host canvas')!;
    window.__drawn = [];
    const sample = () => {
      canvas.dispatchEvent(
        new CustomEvent('openzcad:e2e-render-policy', {
          detail: {
            resolve: (state: {
              bodyFaces: { visible: boolean; triangles: number }[];
            }) =>
              window.__drawn!.push(
                state.bodyFaces
                  .filter((face) => face.visible)
                  .reduce((sum, face) => sum + face.triangles, 0)
              )
          }
        })
      );
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

const drawn = (page: Page) => page.evaluate(() => window.__drawn ?? []);

test('typing a new extrude distance keeps the preview until the new one lands', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await stubApi(page);
  await slowExactReplies(page);
  const document = addSketchFeature(
    createProjectDocument('Preview continuity', toUserId('user_e2e')),
    {
      name: 'Profile',
      plane: 'XY',
      objects: [{ objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }]
    }
  ).document;
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Profile' })
  ).toBeVisible();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '0');
  await page.keyboard.press('e');
  await setInPlaceOptionValues(page, 'Extrude', { Distance: '10' });
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await recordDrawn(page);
  await page.evaluate(() => {
    window.__exactReplies!.delayMs = 800;
  });
  await setInPlaceOptionValues(page, 'Extrude', { Distance: '14' });
  await expect
    .poll(() => page.evaluate(() => window.__exactReplies!.held))
    .toBeGreaterThan(0);
  // Through the held rebuild and the new preview landing.
  await page.waitForTimeout(1500);
  const frames = await drawn(page);
  expect(frames.length).toBeGreaterThan(5);
  expect(frames.filter((triangles) => triangles === 0)).toEqual([]);
});

test('applying a fillet radius never shows the unfilleted part', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  await stubApi(page);
  await slowExactReplies(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet continuity');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  const canvas = page.locator('.viewer-host canvas');
  await recordDrawn(page);
  await expect.poll(async () => (await drawn(page)).at(-1)).toBeGreaterThan(0);
  const box = (await drawn(page)).at(-1)!;
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              setTimeout(() => resolve(false), 1500);
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-edge', {
                  detail: {
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        ),
      { timeout: 30_000 }
    )
    .toBe(true);
  const card = page.locator('.selection-callout-chip');
  await card.getByRole('button', { name: /Select all \d+ edges/ }).click();
  const fillet = card.getByRole('button', {
    name: 'Selection: Fillet',
    exact: true
  });
  if ((await fillet.getAttribute('aria-pressed')) !== 'true')
    await fillet.click();
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('1');
  // The preview rounds every edge.
  await expect
    .poll(async () => (await drawn(page)).at(-1), { timeout: 30_000 })
    .toBeGreaterThan(box * 2);
  // A new radius whose preview is still rebuilding when Apply lands: the
  // release outruns its preview, and the 1 mm preview is what is on screen.
  await page.evaluate(() => {
    window.__exactReplies!.delayMs = 800;
  });
  await keypad.getByRole('textbox').fill('2');
  await expect
    .poll(() => page.evaluate(() => window.__exactReplies!.held), {
      timeout: 10_000
    })
    .toBeGreaterThan(0);
  const from = (await drawn(page)).length;
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Filleted 12 edges at 2',
    { timeout: 30_000 }
  );
  await page.waitForTimeout(500);
  const frames = (await drawn(page)).slice(from);
  expect(frames.length).toBeGreaterThan(5);
  // Every frame from Apply to the committed result shows a rounded part.
  expect(frames.filter((triangles) => triangles <= box)).toEqual([]);
});
