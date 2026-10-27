import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Locator, Page, TestInfo } from '@playwright/test';
import {
  editExtrudeFromHistory,
  expect,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';

async function openPart(page: Page) {
  await stubApi(page, { panelLayout: null, commandFoldClosed: true });
  const sketch = addSketchFeature(
    createProjectDocument('Design review fixture', toUserId('user_e2e')),
    {
      name: 'Sketch',
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
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('toolbar', { name: 'Model panels' })).toBeVisible(
    { timeout: 30_000 }
  );
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function reachable(control: Locator) {
  await expect(control).toBeVisible();
  await expect
    .poll(() =>
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
          element.contains(hit)
        );
      })
    )
    .toBe(true);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} review followups`, () => {
    test.use({ colorScheme, reducedMotion: 'reduce' });
    test.setTimeout(90_000);

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
        await expect(page.locator('.settings-topbar')).toHaveCSS(
          'height',
          '40px'
        );
        await page.getByRole('button', { name: 'Back to workspace' }).click();
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
      }
      await capture(page, testInfo, 'complete-tool-names');
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
      expect(
        await panel.evaluate((element) => element.scrollHeight)
      ).toBeGreaterThan(
        await panel.evaluate((element) => element.clientHeight)
      );
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
        const contained = await controls.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return Array.from(
            element.querySelectorAll('input, iframe, button')
          ).every((child) => {
            const box = child.getBoundingClientRect();
            return box.left >= bounds.left && box.right <= bounds.right + 1;
          });
        });
        expect(contained).toBe(true);
        await expect(
          page.getByRole('button', { name: 'Email me a code' })
        ).toBeDisabled();
      }
      await capture(page, testInfo, 'phone-sign-in-challenge');
    });
  });
}
