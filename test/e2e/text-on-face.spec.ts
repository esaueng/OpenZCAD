import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  clickWorldPoint,
  setSelectionFilter,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * U11: text starts from the face it goes on. A flat face's card offers Text
 * beside Sketch; one press opens a sketch on that face with the text card
 * focused and the word pinned, centred, where the face was picked. The
 * pointer crossing the face on its way to Place does not drag the word
 * along, and Place puts it at the pick, the whole word one object.
 */

/** A disc 40 across and 10 tall: its top is a flat face at z = 10. */
function puck(): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Text on a face', toUserId('user_e2e')),
    {
      name: 'Puck',
      primitiveKind: 'cylinder',
      dimensions: { radius: 20, height: 10 }
    }
  );
}

/** Where on the top face the pick lands, in world millimetres. */
const PICK: [number, number, number] = [6, 4, 10];

async function openDocument(page: Page, document: ProjectDocument) {
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
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
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  return canvas;
}

async function useDirectManipulation(page: Page, enabled: boolean) {
  await page.addInitScript((on) => {
    const key = 'openzcad-app-settings:v1';
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as {
      experiments?: Record<string, unknown>;
    };
    localStorage.setItem(
      key,
      JSON.stringify({
        ...stored,
        experiments: { ...stored.experiments, directManipulation: on }
      })
    );
  }, enabled);
}

/** A world point in client pixels. */
async function projected(
  canvas: Locator,
  point: [number, number, number]
): Promise<{ x: number; y: number }> {
  return canvas.evaluate(
    (element, points) =>
      new Promise<{ x: number; y: number }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points[0]!)
            }
          })
        );
      }),
    [point]
  );
}

interface LiveSketchState {
  objects: { id: string; data: SketchObjectData }[];
  textPreview: { loops: number; origin: { x: number; y: number } } | null;
  screen: { x: number; y: number }[];
}

/** The live sketch's objects, and `project` plane points in client pixels. */
async function readLiveSketch(
  canvas: Locator,
  project: { x: number; y: number }[] = []
): Promise<LiveSketchState> {
  return canvas.evaluate(
    (element, points) =>
      new Promise<LiveSketchState>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: { project: points, resolve }
          })
        );
      }),
    project
  );
}

for (const directManipulation of [true, false]) {
  test(
    `Text on a picked face opens the card there and places the word at the pick (direct manipulation ${directManipulation ? 'on' : 'off'})`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(180_000);
      await stubApi(page, { panelLayout: MODEL_ONLY });
      await useDirectManipulation(page, directManipulation);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const canvas = await openDocument(page, puck());
      await setSelectionFilter(page, 'Face');
      await clickWorldPoint(page, PICK);
      const rail = page.locator('.selection-rail');
      const text = rail.getByRole('button', { name: 'Selection: Text' });
      await expect(text).toBeEnabled({ timeout: 60_000 });

      // One press: a sketch on the face, the card focused, no tool letter
      // and no click on the plane first.
      await text.click();
      await expect(
        page.getByRole('toolbar', { name: 'Sketch tools' })
      ).toBeVisible();
      const card = page.getByRole('form', { name: 'Place text' });
      await expect(card.getByLabel('Text', { exact: true })).toBeFocused();
      await expect(card).toContainText(
        'Type the text to place where you picked the face.'
      );
      await page.keyboard.type('Hi');
      await expect(card).toContainText('Place puts it where you picked');

      // The pointer crosses the face on its way to the card: the word stays.
      await waitForStillViewport(page);
      const pick = await projected(canvas, PICK);
      await page.mouse.move(pick.x + 120, pick.y + 60, { steps: 4 });
      await page.mouse.move(pick.x - 90, pick.y - 40, { steps: 4 });
      // The live outline, not only what Place stores, is still at the pick.
      const live = await readLiveSketch(canvas);
      expect(live.textPreview?.loops ?? 0).toBeGreaterThan(0);
      const [outline] = (
        await readLiveSketch(canvas, [live.textPreview!.origin])
      ).screen;
      expect(Math.hypot(outline!.x - pick.x, outline!.y - pick.y)).toBeLessThan(
        2
      );
      await card.getByRole('button', { name: 'Place' }).click();
      await expect(page.getByRole('form', { name: 'Edit text' })).toBeVisible();

      const sketch = await readLiveSketch(canvas);
      const placed = sketch.objects.flatMap(({ data }) =>
        data.objectKind === 'text' ? [data] : []
      );
      expect(placed).toHaveLength(1);
      expect(placed[0]).toMatchObject({ text: 'Hi', align: 'center' });
      // Its baseline origin is the picked point, on screen as in the model.
      const [origin] = (
        await readLiveSketch(canvas, [{ x: placed[0]!.x, y: placed[0]!.y }])
      ).screen;
      const now = await projected(canvas, PICK);
      expect(Math.hypot(origin!.x - now.x, origin!.y - now.y)).toBeLessThan(2);
      expect(errors).toEqual([]);
    }
  );
}

test('Sketch on a picked face sketches on it with direct manipulation off', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await useDirectManipulation(page, false);
  await openDocument(page, puck());
  await setSelectionFilter(page, 'Face');
  await clickWorldPoint(page, PICK);
  const sketch = page
    .locator('.selection-rail')
    .getByRole('button', { name: 'Selection: Sketch' });
  await expect(sketch).toBeEnabled({ timeout: 60_000 });
  await sketch.click();
  // The face picked is the plane: no second question about where to draw.
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Sketching on the selected face'
  );
});

test('Text on face from a right-click places the word where the right-click landed', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  const canvas = await openDocument(page, puck());
  await setSelectionFilter(page, 'Face');
  // Picked at one point, then right-clicked at another on the same face.
  await clickWorldPoint(page, PICK);
  await expect(
    page
      .locator('.selection-rail')
      .getByRole('button', { name: 'Selection: Text' })
  ).toBeEnabled({ timeout: 60_000 });
  const OTHER: [number, number, number] = [-9, -7, 10];
  await waitForStillViewport(page);
  const other = await projected(canvas, OTHER);
  await page.mouse.click(other.x, other.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Text on face' }).click();
  const card = page.getByRole('form', { name: 'Place text' });
  await expect(card.getByLabel('Text', { exact: true })).toBeFocused();
  await page.keyboard.type('Hi');
  await card.getByRole('button', { name: 'Place' }).click();
  await expect(page.getByRole('form', { name: 'Edit text' })).toBeVisible();
  const placed = (await readLiveSketch(canvas)).objects.flatMap(({ data }) =>
    data.objectKind === 'text' ? [data] : []
  );
  expect(placed).toHaveLength(1);
  const [origin] = (
    await readLiveSketch(canvas, [{ x: placed[0]!.x, y: placed[0]!.y }])
  ).screen;
  const now = await projected(canvas, OTHER);
  expect(Math.hypot(origin!.x - now.x, origin!.y - now.y)).toBeLessThan(2);
});
