import { DEFAULT_APP_SETTINGS } from '@openzcad/shared';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

// EDGE-02: the disclosure used to have a 14.4px layout box, with a shared
// pseudo-element extending its pointer area. Give it a real 24px row and
// prove the edges operate that disclosure without covering adjacent controls.
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 }
]) {
  for (const theme of ['dark', 'light'] as const) {
    for (const density of ['compact', 'comfortable'] as const) {
      test(`drawer disclosure targets at ${viewport.width}px in ${theme} ${density}`, async ({
        page
      }) => {
        // Populate at desktop width: the open drawer can cover the Box
        // shortcut on a narrow stage. Measure the requested viewport below.
        await page.setViewportSize({ width: 1280, height: 800 });
        await stubApi(page);
        const settings = structuredClone(DEFAULT_APP_SETTINGS);
        settings.appearance = { theme, density, reducedMotion: true };
        await page.addInitScript((value) => {
          window.localStorage.setItem(
            'openzcad-app-settings:v1',
            JSON.stringify(value)
          );
        }, settings);
        await createProject(page, 'Drawer target check');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

        // Populate History so its neighbouring Find button is present.
        await page.getByRole('button', { name: /^Box \(B\)/ }).click();
        await page
          .getByRole('region', { name: 'Feature inspector' })
          .getByRole('button', { name: 'Create', exact: true })
          .click();
        await expect(page.locator('.feature-row-main')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await page.setViewportSize(viewport);

        const drawer = page.locator('.model-drawer-float');
        const headers = drawer.locator('button.section-title');
        await expect(headers).toHaveCount(4);
        for (const title of ['Parameters', 'Objects', 'History', 'Revisions']) {
          const header = headers.filter({ hasText: title });
          await header.scrollIntoViewIfNeeded();
          const initiallyOpen = await header.getAttribute('aria-expanded');
          expect(['true', 'false']).toContain(initiallyOpen);

          // Check both states, including History with/without Find beside it.
          for (const edge of ['top', 'bottom'] as const) {
            const target = await header.evaluate((button) => {
              const box = button.getBoundingClientRect();
              const points = [0.5, box.width / 2, box.width - 0.5].flatMap(
                (x) =>
                  [0.5, box.height / 2, box.height - 0.5].map((y) => {
                    const hit = document.elementFromPoint(
                      box.left + x,
                      box.top + y
                    );
                    return hit !== null && button.contains(hit);
                  })
              );
              const overlappingControls = [
                ...button
                  .closest('.sidebar')!
                  .querySelectorAll(
                    'button, input, select, textarea, summary, a[href], [role="slider"]'
                  )
              ]
                .filter((other) => {
                  if (other === button || button.contains(other)) return false;
                  const bounds = other.getBoundingClientRect();
                  return (
                    bounds.width > 0 &&
                    bounds.height > 0 &&
                    Math.min(box.right, bounds.right) >
                      Math.max(box.left, bounds.left) &&
                    Math.min(box.bottom, bounds.bottom) >
                      Math.max(box.top, bounds.top)
                  );
                })
                .map(
                  (other) =>
                    other.getAttribute('aria-label') ?? other.textContent
                );
              return {
                width: box.width,
                height: box.height,
                ownsEveryPoint: points.every(Boolean),
                overlappingControls
              };
            });
            expect(target.width, title).toBeGreaterThanOrEqual(24);
            expect(target.height, title).toBeGreaterThanOrEqual(24);
            expect(target.ownsEveryPoint, title).toBe(true);
            expect(target.overlappingControls, title).toEqual([]);

            const before = await header.getAttribute('aria-expanded');
            await header.click({
              position: {
                x: target.width / 2,
                y: edge === 'top' ? 0.5 : target.height - 0.5
              }
            });
            await expect(header).toHaveAttribute(
              'aria-expanded',
              before === 'true' ? 'false' : 'true'
            );
          }
          await expect(header).toHaveAttribute('aria-expanded', initiallyOpen!);
        }

        if (process.env.QA_DRAWER_SCREENSHOT_DIR) {
          await drawer.screenshot({
            path: `${process.env.QA_DRAWER_SCREENSHOT_DIR}/drawer-${viewport.width}-${theme}-${density}.png`
          });
        }
      });
    }
  }
}
