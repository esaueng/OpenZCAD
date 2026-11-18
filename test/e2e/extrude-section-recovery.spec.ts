import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  barChoice,
  createProject,
  expect,
  extrudeBar,
  revealModelPanel,
  setBarValues,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

const ready = { timeout: 30_000 };

async function projectedPlatePoints(canvas: Locator) {
  return canvas.evaluate(
    (element) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: [
                [10, 10, 0],
                [70, 20, 3],
                [40, 40, 8],
                [50, 31, 2]
              ],
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      })
  );
}

async function renderedSections(canvas: Locator) {
  return canvas.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                sectionCaps: unknown[];
                exactSections: unknown[];
              }) =>
                resolve(state.sectionCaps.length + state.exactSections.length)
            }
          })
        );
      })
  );
}

async function exportedExtrude(page: Page) {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', ready),
    menu.getByRole('button', { name: /^Export project/ }).click()
  ]);
  const chunks = [];
  for await (const chunk of await download.createReadStream())
    chunks.push(chunk);
  const { document } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    document: ProjectDocument;
  };
  return listFeaturesInOrder(document).find(
    (feature) => feature.featureKind === 'extrude'
  );
}

test(
  'a section-hidden Auto Cut can reveal the same blind Extrude draft',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.addInitScript(() => {
      const requests = new Set<string>();
      Reflect.set(window, '__sectionRecoveryExtrudeRequests', requests);
      const postMessage = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, transfer) {
        const request = message as {
          type?: string;
          requestId?: string;
          document?: { nodes: Record<string, { featureKind?: string }> };
        };
        if (
          request.type === 'sync' &&
          request.requestId &&
          request.document &&
          Object.values(request.document.nodes).some(
            (node) => node.featureKind === 'extrude'
          )
        )
          requests.add(request.requestId);
        Reflect.apply(postMessage, this, [message, transfer]);
      };
    });
    const extrudeRequests = () =>
      page.evaluate(
        () =>
          (
            Reflect.get(
              window,
              '__sectionRecoveryExtrudeRequests'
            ) as Set<string>
          ).size
      );
    await stubApi(page, { commandFoldClosed: true });
    await page.route('**/api/projects/*/artifacts', (route) =>
      route.fulfill({ json: { artifacts: [] } })
    );
    const name = 'Section recovery plate';
    const plate = addPrimitiveFeature(
      createProjectDocument(name, toUserId('user_e2e')),
      {
        name: 'Plate',
        bodyName: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 74, height: 53, depth: 8 }
      }
    );
    const { document, sketchId } = addSketchFeature(plate, {
      name: 'Bore layout',
      plane: 'XY',
      offset: 8,
      objects: [{ objectKind: 'circle', radius: 2.5, centerX: 57, centerY: 20 }]
    });
    await page.route('**/api/projects', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 201,
            json: {
              project: {
                projectId: document.projectId,
                name,
                revisionCount: 1,
                updatedAt: document.derived.updatedAt
              },
              document
            }
          })
        : route.fallback()
    );
    await createProject(page, name);
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toBeVisible(ready);
    await expect(canvas).toHaveAttribute(
      'data-e2e-rendered-bodies',
      '1',
      ready
    );
    const renderedTriangles = async () =>
      Number(await canvas.getAttribute('data-e2e-rendered-triangles'));
    const plateTriangles = await renderedTriangles();
    await revealModelPanel(page, 'History');
    const row = page.locator('.feature-row', {
      has: page.locator('.feature-row-main[title^="Extrude"]')
    });
    await page.keyboard.press('f');
    await waitForStillViewport(page);

    // The bore spans X=54.5 to 59.5. The flipped cut first keeps some of
    // the bore, then leaves only the plate when moved to X=66.
    const section = page.getByRole('button', { name: /^Section view — now:/ });
    const panel = page.getByRole('group', {
      name: 'Section view',
      exact: true
    });
    const side = panel.getByRole('button', { name: 'Side (YZ plane)' });
    const offset = panel.getByRole('spinbutton', { name: 'Cut position' });
    const flip = panel.getByRole('button', { name: 'Flip cut direction' });
    await section.click();
    await side.click();
    await offset.fill('58');
    await offset.press('Enter');
    await flip.click();
    await expect(flip).toHaveAttribute('aria-pressed', 'true');
    await section.click();
    await expect(panel).toBeHidden();
    await expect(section).toHaveAttribute('aria-pressed', 'true');

    const bar = extrudeBar(page);
    const done = bar.getByRole('button', { name: 'Done', exact: true });
    const cancel = bar.getByRole('button', { name: 'Cancel', exact: true });
    const hint = bar.getByText('Section view hides this change', {
      exact: true
    });
    const reveal = bar.getByRole('button', {
      name: 'Show full model',
      exact: true
    });
    const boreSketch = page.locator('.feature-row-main', {
      hasText: 'Bore layout'
    });
    async function previewBore() {
      await boreSketch.click();
      await page.keyboard.press('e');
      await setBarValues(page, bar, { Distance: '-6' });
      await expect(bar).toContainText('Preview: Cut · Plate', ready);
      await expect(done).toBeEnabled();
    }

    await previewBore();
    await expect(section).toHaveAttribute('aria-pressed', 'true');
    await expect(hint).toHaveCount(0);
    await expect(reveal).toHaveCount(0);
    await cancel.click();
    await expect(bar).toHaveCount(0);
    await section.click();
    await offset.fill('66');
    await offset.press('Enter');
    await section.click();
    await expect(panel).toBeHidden();

    // History can pick the clipped sketch. The command still builds the
    // exact preview and resolves Auto to the plate.
    await previewBore();
    await expect(row).toHaveCount(0);
    await expect.poll(() => renderedSections(canvas)).toBeGreaterThan(0);
    await expect.poll(renderedTriangles).toBeGreaterThan(plateTriangles);
    const previewTriangles = await renderedTriangles();
    await expect(hint).toBeVisible();
    await expect(reveal).toBeVisible();
    const display = page.getByRole('button', { name: /^Display mode/ });
    const displayMenu = page.getByRole('group', {
      name: 'Display',
      exact: true
    });
    const xray = displayMenu.getByRole('button', { name: /^X-ray/ });
    await display.click();
    await displayMenu
      .getByRole('button', { name: 'Wireframe', exact: true })
      .click();
    await expect(display).toHaveAccessibleName(/Wireframe/);
    await expect(reveal).toBeVisible();
    await display.click();
    await xray.click();
    await expect(xray).toHaveAttribute('aria-pressed', 'true');
    await expect(reveal).toBeVisible();
    await xray.click();
    await displayMenu
      .getByRole('button', { name: 'Shaded + edges', exact: true })
      .click();
    await waitForStillViewport(page);
    const before = await projectedPlatePoints(canvas);
    const requestsBeforeReveal = await extrudeRequests();
    expect(requestsBeforeReveal).toBeGreaterThan(0);

    await reveal.focus();
    await reveal.press('Enter');
    await expect(section).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => renderedSections(canvas)).toBe(0);
    await expect.poll(renderedTriangles).toBe(previewTriangles);
    await expect(hint).toHaveCount(0);
    await expect(reveal).toHaveCount(0);
    await expect(bar).toContainText('Preview: Cut · Plate');
    await expect(barChoice(bar, 'Operation', 'Auto')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(barChoice(bar, 'Sides', 'One side')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await expect(
      bar.getByRole('button', {
        name: 'Distance',
        exact: true,
        includeHidden: true
      })
    ).toHaveText('-6 mm');
    await expect(done).toBeEnabled();
    await expect(row).toHaveCount(0);
    await expect(bar).toBeFocused();
    await waitForStillViewport(page);
    const after = await projectedPlatePoints(canvas);
    for (const [index, point] of before.entries()) {
      expect(
        Math.hypot(after[index]!.x - point.x, after[index]!.y - point.y)
      ).toBeLessThan(0.1);
    }
    expect(await extrudeRequests()).toBe(requestsBeforeReveal);

    // A live numeric entry also survives the recovery action. Opening the
    // Options panel first makes the keypad placement deterministic.
    await section.click();
    await expect(section).toHaveAccessibleName(/YZ plane/);
    await expect(section).toHaveAttribute('aria-pressed', 'true');
    await expect(reveal).toBeVisible();
    expect(await extrudeRequests()).toBe(requestsBeforeReveal);
    await page.setViewportSize({ width: 390, height: 844 });
    await bar.locator('details.in-place-command-options summary').click();
    await bar.getByRole('button', { name: 'Distance', exact: true }).click();
    const keypad = page.getByRole('dialog', { name: 'Distance value' });
    const keypadInput = keypad.locator('input.keypad-value');
    const sheetReveal = keypad.getByRole('button', {
      name: 'Show full model',
      exact: true
    });
    await keypadInput.fill('-5.5');
    await expect
      .poll(extrudeRequests, ready)
      .toBeGreaterThan(requestsBeforeReveal);
    await expect(sheetReveal).toBeVisible(ready);
    await expect(reveal).toBeHidden();
    await sheetReveal.click();
    await expect(section).toHaveAttribute('aria-pressed', 'false');
    await expect(reveal).toHaveCount(0);
    await expect(keypadInput).toHaveValue('-5.5');
    await expect(keypadInput).toBeFocused();
    await expect(row).toHaveCount(0);
    await keypadInput.press('Enter');
    await expect(keypadInput).toBeHidden();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await cancel.click();
    await expect(bar).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect.poll(renderedTriangles).toBe(plateTriangles);

    await previewBore();

    await done.click();
    await expect(bar).toHaveCount(0, ready);
    await expect(row).toHaveCount(1);
    const committedId = await row.getAttribute('data-node-id');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(row).toHaveAttribute('data-node-id', committedId!);

    await section.click();
    await expect(section).toHaveAttribute('aria-pressed', 'true');
    await expect(side).toHaveAttribute('aria-pressed', 'true');
    await expect(offset).toHaveValue('66');
    await expect(flip).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => renderedSections(canvas)).toBeGreaterThan(0);

    expect(await exportedExtrude(page)).toMatchObject({
      id: committedId,
      data: {
        featureKind: 'extrude',
        sketchId,
        distance: -6,
        operation: 'cut',
        targetBodyId: plate.bodyOrder[0],
        profiles: [{ samplePoint: { x: 57 } }]
      }
    });
    await expect(
      page.getByRole('status', { name: /^(Local only|Saved)$/ })
    ).toBeVisible(ready);
    await page.reload();
    await revealModelPanel(page, 'History');
    await expect(row).toHaveAttribute('data-node-id', committedId!);
    await expect(section).toHaveAttribute('aria-pressed', 'true');
    expect(await exportedExtrude(page)).toMatchObject({
      id: committedId,
      data: { distance: -6, operation: 'cut', targetBodyId: plate.bodyOrder[0] }
    });
  }
);
