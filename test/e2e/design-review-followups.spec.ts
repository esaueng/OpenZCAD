import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Locator, Page, TestInfo } from '@playwright/test';
import {
  editExtrudeFromHistory,
  createPrimitiveInPlace,
  featureCardFromHistory,
  expect,
  revealModelPanel,
  stubApi,
  type SeedPanelLayout,
  test
} from './openzcad-fixtures';

async function openPart(
  page: Page,
  panelLayout: SeedPanelLayout | null = null
) {
  await stubApi(page, { panelLayout, commandFoldClosed: true });
  const sketch = addSketchFeature(
    createProjectDocument('Design review fixture', toUserId('user_e2e')),
    {
      name: 'Sketch 01',
      plane: 'XY',
      offset: 0,
      objects: [
        {
          objectKind: 'rectangle',
          width: 25,
          height: 10,
          centerX: 0,
          centerY: 0
        }
      ]
    }
  );
  const document = extrudeSketch(sketch.document, {
    name: 'Extrude',
    sketchId: sketch.sketchId,
    distance: '12'
  }).document;
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
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('toolbar', { name: 'Model panels' })).toBeVisible(
    { timeout: 30_000 }
  );
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function reachable(control: Locator) {
  await expect(control).toBeVisible();
  await expect
    .poll(
      () =>
        control.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2
          );
          return (
            box.width >= 1 &&
            box.height >= 1 &&
            box.x >= 0 &&
            box.right <= innerWidth &&
            box.y >= 0 &&
            box.bottom <= innerHeight &&
            hit !== null &&
            element.contains(hit) &&
            [0.15, 0.5, 0.85].every((x) =>
              [0.15, 0.5, 0.85].every((y) => {
                const sample = document.elementFromPoint(
                  box.x + box.width * x,
                  box.y + box.height * y
                );
                return sample !== null && element.contains(sample);
              })
            )
          );
        }),
      {
        message: `Reachable: ${(await control.getAttribute('aria-label')) ?? (await control.textContent())}`
      }
    )
    .toBe(true)
    .catch(async (error: unknown) => {
      console.info(
        await control.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            control: element.getAttribute('aria-label'),
            box: { x: box.x, y: box.y, width: box.width, height: box.height },
            viewport: { width: innerWidth, height: innerHeight },
            hits: [0.15, 0.5, 0.85].map((x) =>
              [0.15, 0.5, 0.85].map((y) =>
                document
                  .elementFromPoint(
                    box.x + box.width * x,
                    box.y + box.height * y
                  )
                  ?.getAttribute('class')
              )
            )
          };
        })
      );
      throw error;
    });
}

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 100; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} review followups`, () => {
    test.use({ colorScheme, reducedMotion: 'reduce' });
    test.setTimeout(90_000);

    test(
      'keyboard modeling, catalog and help preserve visible focus',
      { tag: '@ci-smoke' },
      async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 768, height: 600 });
        await openPart(page);
        await page.keyboard.press('b');
        await expect(
          page.getByRole('group', { name: 'Box command', exact: true })
        ).toBeFocused();
        await expect(
          page
            .getByRole('group', { name: 'Box command', exact: true })
            .getByRole('button', { name: 'Done', exact: true })
        ).toBeEnabled();
        await page.keyboard.press('Enter');
        await expect(
          page.getByRole('group', { name: 'Box command', exact: true })
        ).toBeHidden();
        const more = page.getByRole('button', { name: /^More tools/ });
        await tabTo(page, more);
        await page.keyboard.press('Enter');
        const search = page.getByRole('searchbox', { name: 'Find a tool' });
        await expect(search).toBeFocused();
        await page.keyboard.type('Loft');
        await reachable(search);
        await capture(page, testInfo, 'keyboard-catalog');
        await page.keyboard.press('Escape');
        await expect(search).toHaveValue('');
        await page.keyboard.press('Escape');
        await expect(search).toBeHidden();
        await page.keyboard.press('?');
        const help = page.getByRole('dialog', { name: 'Help & controls' });
        await expect(help).toBeVisible();
        await tabTo(
          page,
          help.getByRole('button', { name: 'Close', exact: true })
        );
        await capture(page, testInfo, 'keyboard-help');
        await page.keyboard.press('Enter');
        await expect(help).toBeHidden();
      }
    );

    test(
      'modeling guide survives keyboard commands and compact help stays readable',
      { tag: '@ci-smoke' },
      async ({ page }, testInfo) => {
        await stubApi(page, {
          workspaceTour: true,
          panelLayout: null,
          commandFoldClosed: true
        });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/');
        await page.getByLabel('Project name').fill('Guided first part');
        await page.getByRole('button', { name: 'New project' }).click();
        const guide = page.getByRole('region', {
          name: 'Modeling guide',
          exact: true
        });
        await expect(
          guide.getByRole('heading', { name: 'Create your first feature' })
        ).toBeVisible();
        await capture(page, testInfo, 'guide-expanded');
        await guide
          .getByRole('button', { name: 'Minimize modeling guide' })
          .click();
        await expect(
          guide.getByRole('button', { name: 'Expand modeling guide' })
        ).toBeVisible();
        await page.keyboard.press('b');
        const box = page.getByRole('group', {
          name: 'Box command',
          exact: true
        });
        await expect(box).toBeVisible();
        await expect(guide).toBeHidden();
        await expect(
          box.getByRole('button', { name: 'Done', exact: true })
        ).toBeEnabled();
        await page.keyboard.press('Enter');
        await expect(box).toBeHidden();
        await expect(
          guide.getByRole('button', { name: 'Expand modeling guide' })
        ).toBeVisible();
        await expect(guide.getByRole('status')).toContainText('Select to edit');
        await capture(page, testInfo, 'guide-minimized-after-command');
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          await reachable(
            guide.getByRole('button', { name: 'Expand modeling guide' })
          );
          await page.keyboard.press('?');
          const help = page.getByRole('dialog', { name: 'Help & controls' });
          await expect(help).toBeVisible();
          await reachable(
            help.getByRole('button', { name: 'Close', exact: true })
          );
          await expect
            .poll(() =>
              help
                .getByRole('region', { name: 'Controls list' })
                .evaluate(
                  (element) => element.scrollWidth <= element.clientWidth + 1
                )
            )
            .toBe(true);
          await capture(page, testInfo, `help-${width}`);
          await page.keyboard.press('Escape');
          await expect(help).toBeHidden();
        }
      }
    );

    test(
      'invalid dimensions recover without losing the committed model',
      { tag: '@ci-smoke' },
      async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openPart(page);
        await page.getByRole('button', { name: /^Box \(B\)/ }).click();
        const box = page.getByRole('group', {
          name: 'Box command',
          exact: true
        });
        await box.getByLabel('Box options').click();
        const width = box.getByRole('textbox', { name: 'Width', exact: true });
        await width.fill('-10');
        await width.press('Enter');
        await expect(width).toHaveAttribute('aria-invalid', 'true');
        await capture(page, testInfo, 'invalid-dimension');
        await width.fill('32');
        await width.press('Enter');
        await expect(width).not.toHaveAttribute('aria-invalid', 'true');
        await box.getByLabel('Box options').click();
        await box.getByRole('button', { name: 'Done', exact: true }).click();
        await expect(box).toBeHidden();
        const summary = page.getByRole('group', { name: 'Workspace status' });
        await expect(
          summary.getByLabel(/ · 3 features · 2 bodies\. Sync /)
        ).toBeVisible();
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(
          summary.getByLabel(/ · 2 features · 1 body\. Sync /)
        ).toBeVisible();
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect(
          summary.getByLabel(/ · 3 features · 2 bodies\. Sync /)
        ).toBeVisible();
        await capture(page, testInfo, 'dimension-recovered');
      }
    );

    test(
      'docked panels preserve Objects by default and follow deliberate activity',
      { tag: '@ci-smoke' },
      async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openPart(page, { left: [['bodies']], right: [['parameters']] });
        const objects = page.getByRole('region', {
          name: 'Objects',
          exact: true
        });
        const parameters = page.getByRole('region', {
          name: 'Parameters',
          exact: true
        });
        await expect(objects).toBeVisible();
        await expect(parameters).toBeVisible();
        await capture(page, testInfo, 'panels-1440');
        await page.setViewportSize({ width: 1000, height: 844 });
        await expect(objects).toBeVisible();
        await expect(parameters).toBeHidden();
        await capture(page, testInfo, 'panels-1000-objects');
        await page.setViewportSize({ width: 1440, height: 900 });
        await parameters
          .getByRole('textbox', { name: 'New parameter name' })
          .click();
        await page.setViewportSize({ width: 1000, height: 844 });
        await expect(parameters).toBeVisible();
        await expect(objects).toBeHidden();
        await capture(page, testInfo, 'panels-1000-parameters');
        await page
          .getByRole('button', { name: 'Objects panel', exact: true })
          .click();
        await expect(objects).toBeVisible();
        await capture(page, testInfo, 'panels-temporary-objects');
        await page
          .getByRole('button', { name: 'Objects panel', exact: true })
          .click();
        await expect(objects).toBeHidden();
        await expect(parameters).toBeVisible();
      }
    );

    test(
      'modeling previews, recovery and searchable tools remain clear across widths',
      { tag: '@ci-smoke' },
      async ({ page }, testInfo) => {
        await openPart(page);
        await createPrimitiveInPlace(page, 'box', {
          sizes: { width: '20', depth: '15', height: '8' }
        });
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(
          page.getByRole('button', { name: 'Redo', exact: true })
        ).toBeEnabled();
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        for (const width of [1440, 1280, 1000, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          await page.getByRole('button', { name: /^Box \(B\)/ }).click();
          const command = page.getByRole('group', {
            name: 'Box command',
            exact: true
          });
          await expect(command).toContainText('Preview');
          await reachable(
            command.getByRole('button', { name: 'Cancel', exact: true })
          );
          await reachable(
            command.getByRole('button', { name: 'Done', exact: true })
          );
          await command.getByLabel('Box options').click();
          for (const field of [
            'Width',
            'Depth',
            'Height',
            'Corner X',
            'Corner Y',
            'Corner Z'
          ]) {
            await reachable(
              command.getByRole('textbox', { name: field, exact: true })
            );
          }
          await capture(page, testInfo, `modeling-${width}`);
          await command
            .getByRole('button', { name: 'Cancel', exact: true })
            .click();
          await expect(command).toBeHidden();
          await page.getByRole('button', { name: /^More tools/ }).click();
          const search = page.getByRole('searchbox', { name: 'Find a tool' });
          await expect(search).toBeVisible();
          await search.fill('Loft');
          await reachable(search);
          await reachable(
            page.getByRole('button', { name: 'Ready now', exact: true })
          );
          await reachable(
            page.getByRole('button', { name: 'All 35', exact: true })
          );
          const loft = page
            .locator('.command-tile')
            .filter({ hasText: 'Loft' });
          await expect(loft).toHaveCount(1);
          await expect(loft).toContainText('closed sketch');
          await capture(page, testInfo, `catalog-${width}`);
          await search.fill('');
          await page.getByRole('button', { name: /^More tools/ }).click();
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.keyboard.press('?');
        await expect(
          page.getByRole('heading', { name: 'Modeling guide' })
        ).toBeVisible();
        await capture(page, testInfo, 'modeling-help');
      }
    );

    test(
      'drawing tools clear sheet actions at desktop, tablet and phone widths',
      { tag: '@ci-smoke' },
      async ({ page }, testInfo) => {
        await openPart(page);
        await page
          .getByRole('group', { name: 'Workspace mode' })
          .getByRole('button', { name: 'Draw', exact: true })
          .click();
        await page.getByRole('button', { name: 'New drawing sheet' }).click();
        const drawing = page.getByRole('region', { name: 'Drawings' });
        await expect(
          drawing.locator(
            '.drawing-canvas [data-view="front"]:not(.is-placeholder)'
          )
        ).toHaveCount(1, { timeout: 30_000 });
        await expect(
          page.getByRole('status', { name: 'Saved', exact: true })
        ).toBeVisible({ timeout: 10_000 });
        for (const width of [1440, 1280, 1000, 768, 390, 320]) {
          await page.setViewportSize({ width, height: 812 });
          await reachable(
            drawing.getByRole('button', { name: 'Export PDF', exact: true })
          );
          await expect
            .poll(async () => {
              const rail = await drawing
                .getByRole('toolbar', { name: 'Annotation tools' })
                .boundingBox();
              const bar = await drawing
                .locator('.drawing-stage-bar')
                .boundingBox();
              return Boolean(rail && bar && rail.y >= bar.y + bar.height - 1);
            })
            .toBe(true);
          if (width <= 1100) {
            const properties = drawing.getByRole('complementary', {
              name: 'Drawing properties'
            });
            await expect(properties).toBeHidden();
            await drawing
              .getByRole('button', { name: 'Properties', exact: true })
              .click();
            await expect(properties).toBeVisible();
            await capture(page, testInfo, `drawing-properties-${width}`);
            await reachable(
              drawing.getByRole('button', { name: 'Export PDF', exact: true })
            );
            await drawing
              .getByRole('button', { name: 'Hide properties', exact: true })
              .click();
            await expect(properties).toBeHidden();
          }
          const tools = drawing.getByRole('toolbar', {
            name: 'Annotation tools'
          });
          for (const tool of await tools.getByRole('button').all()) {
            await reachable(tool);
          }
          await tools
            .getByRole('button', { name: 'Note', exact: true })
            .click();
          await expect(
            page.locator('.workspace-toast:not(.hidden)')
          ).toContainText('Note placement started.');
          await reachable(drawing.locator('.drawing-tool-hint-cancel'));
          const instruction = drawing.locator('.drawing-tool-hint > span');
          await expect
            .poll(async () => (await instruction.boundingBox())!.width)
            .toBeGreaterThan(140);
          await expect
            .poll(async () => (await instruction.boundingBox())!.height)
            .toBeLessThan(100);
          await capture(page, testInfo, `drawing-note-${width}`);
          if (width <= 1100) {
            await drawing
              .getByRole('button', { name: 'Properties', exact: true })
              .click();
            await expect(drawing.locator('.drawing-tool-hint')).toBeHidden();
            await expect(
              page.locator('.workspace-toast:not(.hidden)')
            ).toContainText('Placement canceled. Drawing properties opened.');
            await expect(
              tools.getByRole('button', { name: 'Note', exact: true })
            ).toHaveAttribute('aria-pressed', 'false');
            await capture(
              page,
              testInfo,
              `drawing-properties-after-placement-${width}`
            );
            await tools
              .getByRole('button', { name: 'Note', exact: true })
              .click();
            await expect(
              drawing.getByRole('complementary', { name: 'Drawing properties' })
            ).toBeHidden();
            await expect
              .poll(
                async () =>
                  (await drawing.locator('.drawing-paper').boundingBox())!.width
              )
              .toBeGreaterThan(250);
            await expect
              .poll(
                async () =>
                  (await drawing.locator('.drawing-paper').boundingBox())!
                    .height
              )
              .toBeGreaterThan(175);
            await capture(
              page,
              testInfo,
              `drawing-placement-after-properties-${width}`
            );
          }
          await drawing.locator('.drawing-tool-hint-cancel').click();
          await expect(
            page
              .locator(
                '.workspace-toast:not(.hidden) .workspace-toast-body > span'
              )
              .first()
          ).toHaveText('Placement canceled.');
          // Compact properties change the available canvas height. Wait for
          // the SVG's measured pixel scale, rather than capturing between a
          // ResizeObserver delivery and the label-size render it schedules.
          await expect
            .poll(() =>
              drawing
                .locator('.drawing-view-label')
                .first()
                .evaluate((label) => {
                  const transform = (label as SVGTextElement).getScreenCTM();
                  return transform
                    ? parseFloat(getComputedStyle(label).fontSize) *
                        Math.hypot(transform.a, transform.b)
                    : 0;
                })
            )
            .toBeCloseTo(11, 0);
          await capture(page, testInfo, `drawing-${width}`);
          if (width === 1440) {
            const units = drawing
              .locator('.drawing-texts text')
              .filter({ hasText: /^Millimetres$/ });
            await expect(units).toHaveCSS('fill', 'rgb(0, 0, 0)');
            await drawing.locator('.drawing-title-hit').screenshot({
              path: testInfo.outputPath('drawing-title-block-1440.png')
            });
          }
        }
        await drawing
          .getByRole('toolbar', { name: 'Annotation tools' })
          .getByRole('button', { name: 'Note', exact: true })
          .click();
        const paper = (await drawing.locator('.drawing-paper').boundingBox())!;
        await page.mouse.click(paper.x + 18, paper.y + paper.height - 25);
        const text = drawing
          .getByRole('complementary', { name: 'Drawing properties' })
          .getByLabel('Text', { exact: true });
        await expect(text).toBeVisible();
        await text.fill('REVIEW NOTE');
        await text.press('Enter');
        await expect(drawing.locator('.drawing-texts')).toContainText(
          'REVIEW NOTE'
        );
        await expect(
          page.locator('.workspace-toast:not(.hidden)')
        ).toContainText('Note added.');
        await expect
          .poll(
            async () =>
              (await drawing.locator('.drawing-paper').boundingBox())!.height
          )
          .toBeGreaterThan(100);
        await capture(page, testInfo, 'drawing-note-created-320');
      }
    );

    test('320px navigation and sparse phone panels stay reachable', async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await openPart(page);
      for (const density of ['compact', 'comfortable'] as const) {
        await page.getByRole('button', { name: 'Open settings' }).click();
        await page
          .getByRole('button', { name: 'Appearance', exact: true })
          .click();
        await page
          .getByRole('radiogroup', { name: 'Interface density' })
          .getByRole('radio', {
            name: density === 'compact' ? 'Compact' : 'Comfortable',
            exact: true
          })
          .click();
        await capture(page, testInfo, `settings-appearance-${density}-320`);
        // Column first: the way back heads the sections rail at any width.
        await reachable(
          page.getByRole('button', { name: /^Close settings and go back/ })
        );
        await page
          .getByRole('button', {
            name: 'Close settings and go back to workspace',
            exact: true
          })
          .click();
        await reachable(page.getByRole('button', { name: /OpenZCAD/ }));
        await reachable(page.getByRole('button', { name: /Rename project/ }));
        for (const mode of await page.locator('.mode-switch-option').all())
          await reachable(mode);
      }
      await capture(page, testInfo, '320px-comfortable-header');
      await page.setViewportSize({ width: 390, height: 844 });
      for (const panel of ['History', 'Objects', 'Parameters'] as const) {
        await revealModelPanel(page, panel);
        const surface = page.locator('.panel-lane-float .model-panel');
        await expect(surface).toHaveAttribute('aria-label', panel);
        await expect
          .poll(async () => (await surface.boundingBox())!.height)
          .toBeLessThan(300);
        const rail = page.locator('.workspace-column-float');
        const box = (await surface.boundingBox())!;
        const railBox = (await rail.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
        await reachable(
          surface.getByRole('button', { name: `Close ${panel}` })
        );
        await reachable(page.getByRole('button', { name: /^Box \(B\)/ }));
      }
      await capture(page, testInfo, 'phone-panel-and-navigation');
    });

    test('More tools exposes complete names at desktop and phone widths', async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openPart(page);
      await page.getByRole('button', { name: /^More tools/ }).click();
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(page.locator('.command-tile')).toHaveCount(35);
        await reachable(page.getByRole('searchbox', { name: 'Find a tool' }));
        await reachable(
          page.getByRole('button', { name: 'All 35', exact: true })
        );
        const labels = await page
          .locator('.command-tile > span')
          .evaluateAll((elements) =>
            elements.map((element) => ({
              name: element.textContent,
              width: element.clientWidth,
              scrollWidth: element.scrollWidth,
              height: element.clientHeight,
              scrollHeight: element.scrollHeight
            }))
          );
        expect(labels.length).toBeGreaterThan(10);
        for (const label of labels) {
          expect(label.scrollWidth, label.name ?? '').toBeLessThanOrEqual(
            label.width + 1
          );
          expect(label.scrollHeight, label.name ?? '').toBeLessThanOrEqual(
            label.height + 1
          );
        }
        const last = page.locator('.command-tile').last();
        await last.scrollIntoViewIfNeeded();
        await reachable(last);
        await capture(page, testInfo, `full-catalog-end-${width}`);
        await page.locator('.command-tile').first().scrollIntoViewIfNeeded();
        await capture(page, testInfo, `full-catalog-${width}`);
      }
      await capture(page, testInfo, 'complete-tool-names');
    });

    test(
      'section controls clear both rails and short-screen rail buttons fit',
      { tag: '@ci-smoke' },
      async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 320, height: 568 });
        await openPart(page);
        for (const size of [
          { width: 320, height: 568 },
          { width: 390, height: 844 },
          { width: 844, height: 390 },
          { width: 1440, height: 900 }
        ]) {
          await page.setViewportSize(size);
          // Before clicking, so automatic scroll-into-view cannot conceal a
          // rail that initially extends beyond the viewport.
          for (const control of await page
            .locator('.instrument-rail .rail-button')
            .all()) {
            await reachable(control);
          }
          await page
            .getByRole('button', { name: /^Section view — now: Off$/ })
            .click();
          const section = page.getByRole('group', {
            name: 'Section view',
            exact: true
          });
          await expect(section).toBeVisible();
          await expect(
            page.locator('.workspace-toast:not(.hidden)')
          ).toContainText('Section view on:');
          // Reduced motion must not introduce a tiny translate transition:
          // the clamp reads placement again during the same layout delivery.
          const sameFrameMove = await section.evaluate((element) => {
            const panel = element as HTMLElement;
            const original = panel.style.translate;
            const [x, y] = original
              .split(/\s+/)
              .map((value) => Number.parseFloat(value) || 0);
            const before = panel.getBoundingClientRect().top;
            try {
              panel.style.translate = `${x ?? 0}px ${(y ?? 0) + 1}px`;
              return panel.getBoundingClientRect().top - before;
            } finally {
              panel.style.translate = original;
            }
          });
          expect(sameFrameMove).toBeCloseTo(1, 5);
          const dxf = section.getByRole('button', {
            name: 'Export the exact section as DXF'
          });
          await expect
            .poll(() =>
              dxf.evaluate((element) => {
                const r = element.getBoundingClientRect();
                return [0.15, 0.5, 0.85, 0.95].every((fraction) => {
                  const hit = document.elementFromPoint(
                    r.x + r.width * fraction,
                    r.y + r.height / 2
                  );
                  return hit !== null && element.contains(hit);
                });
              })
            )
            .toBe(true)
            .catch(async (error: unknown) => {
              await testInfo.attach('section-placement.json', {
                body: JSON.stringify(
                  await section.evaluate((element) => ({
                    viewport: { width: innerWidth, height: innerHeight },
                    elements: [
                      element,
                      element.closest('.viewer-rail'),
                      element.closest('.instrument-rail')
                    ].map((item) => {
                      if (!item) return null;
                      const style = getComputedStyle(item);
                      const bounds = item.getBoundingClientRect();
                      return {
                        className: item.getAttribute('class'),
                        bounds: {
                          x: bounds.x,
                          y: bounds.y,
                          width: bounds.width,
                          height: bounds.height
                        },
                        translate: style.translate,
                        transform: style.transform
                      };
                    })
                  })),
                  null,
                  2
                ),
                contentType: 'application/json'
              });
              throw error;
            });
          await reachable(section.getByRole('switch', { name: 'Section cut' }));
          await reachable(
            page.getByRole('combobox', { name: 'Search commands' })
          );
          for (const button of await section.getByRole('button').all())
            await reachable(button);
          const status = page.locator(
            '.workspace-toast:not(.hidden) .workspace-toast-body'
          );
          if (await status.count()) await reachable(status);
          await capture(page, testInfo, `section-${size.width}x${size.height}`);
          // The switch ends the cut and keeps the panel; the button puts it away.
          await section.getByRole('switch', { name: 'Section cut' }).click();
          await page
            .getByRole('button', { name: /^Section view — now: Off$/ })
            .press('Enter');
          await expect(section).toHaveCount(0);
        }
      }
    );

    test('animated section controls stay reachable on a short landscape screen', async ({
      page
    }) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.setViewportSize({ width: 844, height: 390 });
      await openPart(page);
      for (let opening = 0; opening < 3; opening += 1) {
        const toggle = page.getByRole('button', {
          name: /^Section view — now:/
        });
        await toggle.click();
        const section = page.getByRole('group', {
          name: 'Section view',
          exact: true
        });
        await reachable(section.getByRole('switch', { name: 'Section cut' }));
        const dxf = section.getByRole('button', {
          name: 'Export the exact section as DXF'
        });
        // Keep it open through Computing → Exact, when the result changes
        // its height and another placement pass must preserve the clamp.
        await expect(dxf).toBeEnabled({ timeout: 30_000 });
        await reachable(dxf);
        await toggle.press('Enter');
        await expect(section).toHaveCount(0);
      }
    });

    test('narrow shortcut descriptions and compact settings rows do not collide', async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await openPart(page);
      await page.keyboard.press('?');
      const controls = page.getByRole('dialog', {
        name: 'Help & controls',
        exact: true
      });
      await expect(controls).toBeVisible();
      const list = controls.getByRole('region', { name: 'Controls list' });
      await expect
        .poll(() =>
          list.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1
          )
        )
        .toBe(true);
      const descriptions = await list
        .locator('dd')
        .evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().width)
        );
      expect(Math.min(...descriptions)).toBeGreaterThan(150);
      await capture(page, testInfo, '320px-shortcut-descriptions');
      for (const size of [
        { width: 390, height: 844 },
        { width: 768, height: 900 },
        { width: 1440, height: 900 }
      ]) {
        await page.setViewportSize(size);
        await expect
          .poll(() =>
            list.evaluate(
              (element) => element.scrollWidth <= element.clientWidth + 1
            )
          )
          .toBe(true);
        await reachable(
          controls.getByRole('button', { name: 'Close', exact: true })
        );
        await capture(page, testInfo, `shortcuts-${size.width}x${size.height}`);
        const actions = list.locator('.shortcut-row dt');
        await expect
          .poll(() =>
            actions.evaluateAll((elements) =>
              Math.min(
                ...elements.map(
                  (element) => element.getBoundingClientRect().width
                )
              )
            )
          )
          .toBeGreaterThan(150);
        const firstShortcut = list.locator('.shortcut-row').first();
        await firstShortcut.evaluate((element) =>
          element.scrollIntoView({ block: 'start' })
        );
        await reachable(firstShortcut.locator('dd'));
        await capture(page, testInfo, `shortcuts-list-${size.width}`);
      }
      await controls
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await page.getByRole('button', { name: 'Open settings' }).click();
      await page.getByRole('button', { name: 'Advanced', exact: true }).click();
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({
          width,
          height: width === 320 ? 568 : 900
        });
        const row = page
          .locator('.setting-row')
          .filter({ has: page.getByText('Kernel version', { exact: true }) });
        await expect
          .poll(() =>
            row.evaluate((element) => {
              const label = element
                .querySelector('.setting-title')!
                .getBoundingClientRect();
              const value = element
                .querySelector('.settings-state')!
                .getBoundingClientRect();
              const overlapX =
                Math.min(label.right, value.right) -
                Math.max(label.left, value.left);
              const overlapY =
                Math.min(label.bottom, value.bottom) -
                Math.max(label.top, value.top);
              return overlapX <= 0 || overlapY <= 0;
            })
          )
          .toBe(true);
        await capture(page, testInfo, `build-version-${width}px`);
      }
      await page.setViewportSize({ width: 320, height: 568 });
      await capture(page, testInfo, '320px-build-version');
    });

    test('phone history names and inspector titles keep room for their text', async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await openPart(page);
      await revealModelPanel(page, 'History');
      const names = page
        .getByRole('region', { name: 'History', exact: true })
        .locator('.feature-name');
      for (const size of [
        { width: 320, height: 568 },
        { width: 390, height: 844 },
        { width: 1440, height: 900 }
      ]) {
        await page.setViewportSize(size);
        await expect
          .poll(() =>
            names.evaluateAll((elements) =>
              elements.every(
                (element) => element.clientWidth >= element.scrollWidth
              )
            )
          )
          .toBe(true);
        await capture(page, testInfo, `history-names-${size.width}px`);
      }
      await page.setViewportSize({ width: 320, height: 568 });
      const sketchMore = page.getByRole('button', {
        name: 'More actions for Sketch 01'
      });
      await reachable(sketchMore);
      await sketchMore.click();
      await expect(
        page.getByRole('menuitem', { name: 'Suppress', exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole('menuitem', { name: 'Roll back to here', exact: true })
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await capture(page, testInfo, '320px-history-names');
      // The extrude's edit is its bar alone; its card is the readout.
      const row = page.locator('.feature-row', {
        has: page.locator('.feature-row-main[title^="Extrude — "]')
      });
      const inspector = await featureCardFromHistory(page, row);
      const title = inspector.getByRole('heading', {
        name: 'Extrude',
        exact: true
      });
      for (const size of [
        { width: 320, height: 568 },
        { width: 390, height: 844 },
        { width: 1440, height: 900 }
      ]) {
        await page.setViewportSize(size);
        await expect
          .poll(() =>
            title.evaluate(
              (element) => element.clientWidth >= element.scrollWidth
            )
          )
          .toBe(true);
        await capture(page, testInfo, `inspector-title-${size.width}px`);
      }
      await page.keyboard.press('Escape');
    });

    test('sketch modify flyout follows a scrolled trigger and stays inside the viewport', async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 320, height: 568 });
      await openPart(page);
      await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
      await page.getByRole('button', { name: 'Top (XY)', exact: true }).click();
      const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
      const toggle = rail.getByRole('button', { name: 'More modify tools' });
      await toggle.click();
      const flyout = page.getByRole('group', {
        name: 'More modify tools',
        exact: true
      });
      const checkDialogStack = async () => {
        await page.locator('details.file-menu > summary').click();
        await expect(flyout).toHaveCount(0);
        await page.getByRole('button', { name: /^Export mesh/ }).click();
        const dialog = page.getByRole('dialog', {
          name: 'Export mesh',
          exact: true
        });
        await expect(dialog).toBeVisible();
        await capture(
          page,
          testInfo,
          `modify-under-dialog-${page.viewportSize()!.width}px`
        );
        await dialog
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
        await expect(dialog).toHaveCount(0);
        await toggle.click();
        await expect(flyout).toBeVisible();
      };
      const follows = () =>
        flyout.evaluate((element) => {
          const r = element.getBoundingClientRect();
          const trigger = document
            .querySelector<HTMLButtonElement>(
              'button[aria-label="More modify tools"]'
            )!
            .getBoundingClientRect();
          const expectedY = Math.max(
            8,
            Math.min(
              trigger.top,
              (innerWidth <= 600
                ? Math.min(
                    document
                      .querySelector('.workspace-toast:not(.hidden)')
                      ?.getBoundingClientRect().top ?? innerHeight,
                    document
                      .querySelector('.command-bar-lane')
                      ?.getBoundingClientRect().top ?? innerHeight
                  )
                : innerHeight) -
                r.height -
                8
            )
          );
          return (
            r.left >= 8 &&
            r.right <= innerWidth - 8 &&
            r.top >= 8 &&
            r.bottom <= innerHeight - 8 &&
            Math.abs(r.top - expectedY) < 1
          );
        });
      await expect.poll(follows).toBe(true);
      await reachable(
        flyout.getByRole('button', { name: 'Circular pattern', exact: true })
      );
      await capture(page, testInfo, '320px-sketch-modify');
      const search = page.getByRole('combobox', { name: 'Search commands' });
      const status = page.locator(
        '.workspace-toast:not(.hidden) .workspace-toast-body'
      );
      await reachable(search);
      await reachable(status);
      expect((await search.boundingBox())!.width).toBeGreaterThan(160);
      expect((await status.boundingBox())!.width).toBeGreaterThan(160);
      await checkDialogStack();
      const scroller = page.locator('.workspace-column-tools');
      const bounds = (await scroller.boundingBox())!;
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2
      );
      await page.mouse.wheel(0, -70);
      await expect.poll(follows).toBe(true);
      for (const size of [
        { width: 390, height: 844 },
        { width: 844, height: 390 },
        { width: 1440, height: 900 }
      ]) {
        await page.setViewportSize(size);
        await expect.poll(follows).toBe(true);
        await reachable(
          flyout.getByRole('button', { name: 'Circular pattern', exact: true })
        );
      }
      await capture(page, testInfo, 'desktop-sketch-modify');
      await checkDialogStack();
      await toggle.press('Escape');
      await expect(flyout).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(rail).toHaveCount(0);
    });

    test('options scroll on rotation and exact entry remains clickable through resize and cancel', async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openPart(page);
      await revealModelPanel(page, 'History');
      const row = page.locator('.feature-row-main[title^="Extrude — "]');
      const bar = await editExtrudeFromHistory(page, row, 'Extrude');
      const options = bar.locator('details.in-place-command-options');
      await options.locator('summary').click();
      await page.setViewportSize({ width: 844, height: 390 });
      const panel = options.locator('.in-place-command-options-panel');
      const bounds = (await panel.boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(50);
      await reachable(
        bar.getByRole('radio', { name: 'New body', exact: true })
      );
      // The compact form fits at 390 px. Constrain it further to exercise
      // actual overflow, then prove its final control can be scrolled into view.
      await page.setViewportSize({ width: 844, height: 260 });
      await expect
        .poll(() =>
          panel.evaluate(
            (element) => element.scrollHeight > element.clientHeight
          )
        )
        .toBe(true);
      await panel.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await reachable(
        bar.getByRole('button', { name: 'Reverse direction', exact: true })
      );
      await page.setViewportSize({ width: 844, height: 390 });
      await capture(page, testInfo, 'landscape-options');
      await bar.getByRole('button', { name: 'Distance', exact: true }).click();
      const keypad = page.getByRole('dialog', { name: 'Distance value' });
      await expect(options).not.toHaveAttribute('open');
      await page.setViewportSize({ width: 390, height: 844 });
      await keypad.getByLabel('Distance', { exact: true }).fill('14');
      await reachable(keypad.getByRole('button', { name: 'Apply distance' }));
      await capture(page, testInfo, 'clickable-phone-keypad');
      await keypad.getByRole('button', { name: 'Apply distance' }).click();
      await expect(keypad).toHaveCount(0);
      await options.locator('summary').click();
      await bar.getByRole('button', { name: 'Distance', exact: true }).click();
      await expect(page.getByRole('contentinfo')).toContainText('Preview ·');
      await keypad.getByLabel('Distance', { exact: true }).press('Escape');
      await bar.getByRole('button', { name: 'Cancel' }).click();
      await expect(bar).toHaveCount(0);
      await expect(page.getByRole('contentinfo')).toContainText(
        'Edit canceled; no change was applied.'
      );
      await expect(page.getByRole('contentinfo')).not.toContainText(
        'Apply to save'
      );
      await capture(page, testInfo, 'canceled-edit-status');
      // Reopening proves the preview never changed the stored extrusion.
      await revealModelPanel(page, 'History');
      const reopened = await editExtrudeFromHistory(page, row, 'Extrude');
      await reopened.locator('summary').click();
      await expect(
        reopened.getByRole('button', { name: 'Distance', exact: true })
      ).toHaveText('12 mm');
      await reopened.getByRole('button', { name: 'Cancel' }).click();
    });

    test('disabled action keeps its explanation at readable contrast', async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openPart(page);
      await revealModelPanel(page, 'History');
      await page
        .locator('.feature-row-main[title^="Extrude — "]')
        .click({ button: 'right' });
      const action = page.getByRole('menuitem', { name: /^Duplicate/ });
      await expect(action).toBeDisabled();
      await expect(action).toHaveCSS('opacity', '1');
      const detail = action.locator('.context-menu-detail');
      await expect(detail).toBeVisible();
      const ratio = await detail.evaluate((element) => {
        const rgb = (color: string) =>
          color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number);
        const luminance = (color: string) => {
          const c = rgb(color).map((v) =>
            v / 255 <= 0.04045
              ? v / 255 / 12.92
              : ((v / 255 + 0.055) / 1.055) ** 2.4
          );
          return c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722;
        };
        const a = luminance(getComputedStyle(element).color);
        const b = luminance(
          getComputedStyle(element.closest('.context-menu')!).backgroundColor
        );
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      await capture(page, testInfo, 'readable-disabled-explanation');
    });

    test('sign-in controls fit a loaded challenge and resize without granting a token', async ({
      page
    }, testInfo) => {
      await stubApi(page);
      await page.route('**/api/session', (route) =>
        route.fulfill({
          status: 401,
          json: { error: 'Authentication required.', code: 'AUTH_REQUIRED' }
        })
      );
      await page.route('**/api/auth/config', (route) =>
        route.fulfill({
          json: {
            mode: 'email-code',
            emailCodeEnabled: true,
            turnstileSiteKey: 'test-key'
          }
        })
      );
      // Model the vendor's documented intrinsic sizes; the challenge remains
      // unverified and the email action must stay disabled throughout.
      await page.route(
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
        (route) =>
          route.fulfill({
            contentType: 'application/javascript',
            body: `window.turnstile = {
        render(container, options) { const frame = document.createElement('iframe'); frame.title = 'Security challenge'; frame.width = options.size === 'compact' ? '150' : '300'; frame.height = options.size === 'compact' ? '140' : '65'; frame.style.border = '0'; frame.srcdoc = '<p>Security verification</p>'; container.append(frame); return 'widget'; },
        remove() { document.querySelector('.settings-turnstile')?.replaceChildren(); }, reset() {}
      };`
          })
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/');
      await page.getByRole('button', { name: 'Open settings' }).click();
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      for (const width of [390, 360, 320, 1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const frame = page.getByTitle('Security challenge');
        await expect(frame).toHaveAttribute(
          'width',
          width <= 390 ? '150' : '300'
        );
        const controls = page.locator('.settings-auth-controls').last();
        await expect
          .poll(() =>
            controls.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return Array.from(
                element.querySelectorAll('input, iframe, button')
              ).flatMap((child) => {
                const box = child.getBoundingClientRect();
                return box.left >= bounds.left && box.right <= bounds.right + 1
                  ? []
                  : [
                      {
                        tag: child.tagName,
                        left: box.left,
                        right: box.right,
                        containerLeft: bounds.left,
                        containerRight: bounds.right
                      }
                    ];
              });
            })
          )
          .toEqual([]);
        await expect(
          page.getByRole('button', { name: 'Email me a code' })
        ).toBeDisabled();
      }
      await capture(page, testInfo, 'phone-sign-in-challenge');
    });
  });
}

test.describe('touch review followups', () => {
  test.use({ hasTouch: true, isMobile: true, colorScheme: 'dark' });
  test(
    'touch targets and the full catalog remain usable through rotation',
    { tag: '@ci-smoke' },
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openPart(page);
      for (const size of [
        { width: 390, height: 844 },
        { width: 844, height: 390 }
      ]) {
        await page.setViewportSize(size);
        await capture(
          page,
          testInfo,
          `touch-rails-${size.width}x${size.height}`
        );
        await reachable(page.getByRole('button', { name: /^More tools/ }));
        await reachable(
          page.getByRole('combobox', { name: 'Search commands' })
        );
        const status = page.locator(
          '.workspace-toast:not(.hidden) .workspace-toast-body'
        );
        if (await status.count()) await reachable(status);
        for (const control of await page
          .locator('button.command-rail, .instrument-rail .rail-button')
          .all()) {
          await reachable(control);
          const box = await control.boundingBox();
          expect(box!.width).toBeGreaterThanOrEqual(40);
          expect(box!.height).toBeGreaterThanOrEqual(40);
        }
        const more = page.getByRole('button', { name: /^More tools/ });
        await more.tap();
        await reachable(page.getByRole('searchbox', { name: 'Find a tool' }));
        await expect(page.locator('.command-tile')).toHaveCount(35);
        const last = page.locator('.command-tile').last();
        await last.scrollIntoViewIfNeeded();
        await reachable(last);
        await capture(
          page,
          testInfo,
          `touch-catalog-${size.width}x${size.height}`
        );
        await more.tap();
      }
    }
  );
});
