import { expect, test, type Locator } from '@playwright/test';
import { stubApi } from './openzcad-fixtures';

interface FaceProbe {
  bodyId: string;
  topologyId: string;
}

interface HoverFaceState {
  settling: boolean;
  slots: {
    slot: number;
    topologyKey: string;
    visible: boolean;
    opacity: number;
    triangleCount: number;
  }[];
}

const REBUILDING =
  /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Rebuilding geometry|Exact geometry is still rebuilding/i;

async function probeFace(
  canvas: Locator,
  surface: 'annulus' | 'outer-wall',
  interaction: 'hover' | 'clear'
): Promise<FaceProbe | null> {
  return canvas.evaluate(
    (element, request) =>
      new Promise<FaceProbe | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-visual-selection-probe', {
            detail: { ...request, resolve }
          })
        );
      }),
    { surface, interaction }
  );
}

async function readHoverFaceState(canvas: Locator): Promise<HoverFaceState> {
  return canvas.evaluate(
    (element) =>
      new Promise<HoverFaceState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-hover-face-state', {
            detail: { resolve }
          })
        );
      })
  );
}

async function probeFaceTransition(
  canvas: Locator,
  surface: 'annulus' | 'outer-wall'
): Promise<{ face: FaceProbe | null; state: HoverFaceState }> {
  return canvas.evaluate(
    (element, requestedSurface) =>
      new Promise<{ face: FaceProbe | null; state: HoverFaceState }>(
        (resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-visual-selection-probe', {
              detail: {
                surface: requestedSurface,
                interaction: 'hover',
                resolve: (face: FaceProbe | null) => {
                  requestAnimationFrame(() => {
                    element.dispatchEvent(
                      new CustomEvent('openzcad:e2e-hover-face-state', {
                        detail: {
                          resolve: (state: HoverFaceState) =>
                            resolve({ face, state })
                        }
                      })
                    );
                  });
                }
              }
            })
          );
        }
      ),
    surface
  );
}

test('cuts between adjacent hovered faces and removes every stale film', async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
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
    .getByRole('button', { name: /^Open demo: Visual Selection Reference/ })
    .click();
  const canvas = page.locator('.viewer-host canvas');
  const status = page.getByRole('contentinfo');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(status).not.toContainText(REBUILDING, { timeout: 60_000 });

  const oldFace = await probeFace(canvas, 'annulus', 'hover');
  expect(oldFace).not.toBeNull();
  const oldKey = `${oldFace!.bodyId}:${oldFace!.topologyId}`;
  await expect
    .poll(async () => {
      const state = await readHoverFaceState(canvas);
      return (
        !state.settling &&
        state.slots.length === 1 &&
        state.slots[0]?.topologyKey === oldKey
      );
    })
    .toBe(true);
  const restingOpacity = (await readHoverFaceState(canvas)).slots[0]!.opacity;
  expect(restingOpacity).toBeGreaterThan(0);

  const transition = await probeFaceTransition(canvas, 'outer-wall');
  expect(transition.face).not.toBeNull();
  const newKey = `${transition.face!.bodyId}:${transition.face!.topologyId}`;
  expect(newKey).not.toBe(oldKey);

  // One frame after the hop: the old film is gone and the new one is already
  // at the opacity the old one rested at — a cut, with no frame showing both.
  // Only the x-ray passes are still easing, which is what `settling` reports.
  const hop = transition.state;
  expect(hop.settling).toBe(true);
  expect(hop.slots.map((slot) => slot.topologyKey)).toEqual([newKey]);
  expect(hop.slots[0]!.visible).toBe(true);
  expect(hop.slots[0]!.opacity).toBeCloseTo(restingOpacity, 5);
  expect(hop.slots[0]!.triangleCount).toBeGreaterThan(0);
  await testInfo.attach('hover-face-hop-first-frame', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });

  await expect
    .poll(async () => {
      const state = await readHoverFaceState(canvas);
      return {
        settling: state.settling,
        keys: state.slots.map((slot) => slot.topologyKey)
      };
    })
    .toEqual({ settling: false, keys: [newKey] });
  await testInfo.attach('hover-face-hop-settled', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });

  await probeFace(canvas, 'annulus', 'clear');
  await expect
    .poll(async () => {
      const state = await readHoverFaceState(canvas);
      return { settling: state.settling, slotCount: state.slots.length };
    })
    .toEqual({ settling: false, slotCount: 0 });
  expect(consoleErrors).toEqual([]);
});
