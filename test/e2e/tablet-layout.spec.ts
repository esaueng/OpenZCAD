import {
  createProject,
  expect,
  stubAnonymousApi,
  test
} from './openzcad-fixtures';

/**
 * L02 slice 1 (docs/plans/ipad-touch-plan-2026-11-05.md): the workspace at
 * iPad sizes under touch emulation, which gives Chromium `pointer: coarse`
 * and `hover: none` as iPadOS Safari reports them. This is layout evidence
 * only; Safari's own toolbars and keyboard need a real device.
 */
const IPAD_SIZES = [
  { width: 820, height: 1180, smoke: true },
  { width: 1180, height: 820, smoke: true },
  { width: 768, height: 1024, smoke: false },
  { width: 1024, height: 768, smoke: false },
  { width: 1024, height: 1366, smoke: false },
  { width: 1366, height: 1024, smoke: false }
];

test.describe('the workspace on an iPad', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const { width, height, smoke } of IPAD_SIZES) {
    test(
      `fits ${width}×${height} with touch-sized targets`,
      smoke ? { tag: '@ci-smoke' } : {},
      async ({ page }) => {
        await page.setViewportSize({ width, height });
        await stubAnonymousApi(page);
        await createProject(page, 'Tablet layout');

        const layout = await page.evaluate(() => {
          const shell = document
            .querySelector('.app-shell')!
            .getBoundingClientRect();
          const visible = (element: Element) => {
            const box = element.getBoundingClientRect();
            return (
              box.width > 0 &&
              box.height > 0 &&
              getComputedStyle(element).visibility !== 'hidden'
            );
          };
          const name = (element: Element) =>
            element.getAttribute('aria-label') ??
            element.textContent?.trim() ??
            '';
          // A list that scrolls (the Tools catalog) reaches its own rows.
          const inScroller = (element: Element) => {
            for (
              let parent = element.parentElement;
              parent;
              parent = parent.parentElement
            ) {
              const style = getComputedStyle(parent);
              const scrolls = (overflow: string) =>
                overflow === 'auto' || overflow === 'scroll';
              if (
                (scrolls(style.overflowY) &&
                  parent.scrollHeight > parent.clientHeight) ||
                (scrolls(style.overflowX) &&
                  parent.scrollWidth > parent.clientWidth)
              ) {
                return true;
              }
            }
            return false;
          };
          const offScreen = [...document.querySelectorAll('button')]
            .filter(visible)
            .filter((button) => !inScroller(button))
            .filter((button) => {
              const box = button.getBoundingClientRect();
              return (
                box.left < -0.5 ||
                box.top < -0.5 ||
                box.right > innerWidth + 0.5 ||
                box.bottom > innerHeight + 0.5
              );
            })
            .map(name);
          const smallRailTargets = [
            ...document.querySelectorAll(
              '.instrument-rail .rail-button, button.command-rail'
            )
          ]
            .filter(visible)
            .filter((button) => {
              const box = button.getBoundingClientRect();
              return box.width < 44 || box.height < 44;
            })
            .map(name);
          return {
            coarse: matchMedia('(pointer: coarse)').matches,
            shell: { width: shell.width, height: shell.height },
            scrollWidth: document.documentElement.scrollWidth,
            offScreen,
            smallRailTargets
          };
        });

        expect(layout.coarse).toBe(true);
        expect(layout.shell.width).toBeCloseTo(width, 0);
        expect(layout.shell.height).toBeCloseTo(height, 0);
        expect(layout.scrollWidth).toBeLessThanOrEqual(width);
        expect(layout.offScreen).toEqual([]);
        expect(layout.smallRailTargets).toEqual([]);

        // A smaller focused field makes iOS zoom the page into it.
        const search = page.getByRole('combobox', { name: 'Search commands' });
        expect(
          await search.evaluate((field) =>
            parseFloat(getComputedStyle(field).fontSize)
          )
        ).toBeGreaterThanOrEqual(16);
      }
    );
  }
});
