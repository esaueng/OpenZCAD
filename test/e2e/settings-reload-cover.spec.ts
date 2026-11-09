import type { Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * Settings left open restores open after a reload. Its page is a lazy chunk,
 * and until it loaded the pending dialog was a transparent click shield: the
 * project library under it, still loading, painted uncovered for a few
 * frames before Settings replaced it. The reload now opens on the page's
 * empty frame instead, on the same column and head the page then fills. The
 * chunk is held back here so the race is certain.
 */

declare global {
  interface Window {
    __settingsReload?: {
      libraryUncovered: number;
      placeholderSeen: boolean;
    };
  }
}

interface Frame {
  nav: DOMRect;
  head: DOMRect;
  title: DOMRect;
  background: string;
}

/** Where the frame's column, head and title sit, and what is behind them. */
function measure(page: Page, root: string): Promise<Frame> {
  return page.evaluate((selector) => {
    const page = document.querySelector<HTMLElement>(selector)!;
    const rect = (part: string) =>
      page.querySelector(part)!.getBoundingClientRect().toJSON() as DOMRect;
    return {
      nav: rect('.settings-nav'),
      head: rect('.settings-head'),
      title: rect('.settings-head-title'),
      background: getComputedStyle(page).backgroundColor
    };
  }, root);
}

function expectSameFrame(actual: Frame, expected: Frame, headHeight: boolean) {
  const edges = ['x', 'y', 'width', 'height'] as const;
  for (const part of ['nav', 'head', 'title'] as const)
    for (const edge of edges) {
      // In a phone-width window the page's save note, once it reports,
      // wraps the head onto a further line: the page's own text, not a
      // difference in the frame.
      if (part === 'head' && edge === 'height' && !headHeight) continue;
      expect(actual[part][edge], `${part} ${edge}`).toBeCloseTo(
        expected[part][edge],
        0
      );
    }
  expect(actual.background).toBe(expected.background);
}

async function reloadWithSettingsHeld(page: Page, headHeight = true) {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings' }).first()
  ).toBeVisible();

  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(/SettingsPage[^/]*\.(js|tsx)(\?|$)/, async (route) => {
    await released;
    await route.continue();
  });
  await page.addInitScript(() => {
    const tally = { libraryUncovered: 0, placeholderSeen: false };
    window.__settingsReload = tally;
    // The library is on view unless an opaque Settings layer is over it.
    const sample = () => {
      if (!document.querySelector('.start-screen')) return;
      const dialog = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-label="Settings"]'
      );
      if (dialog?.querySelector('[data-settings-placeholder]'))
        tally.placeholderSeen = true;
      const background = dialog ? getComputedStyle(dialog).backgroundColor : '';
      if (
        !dialog ||
        background === 'transparent' ||
        /^rgba\(.*,\s*0\)$/.test(background)
      )
        tally.libraryUncovered += 1;
    };
    // Every committed DOM change, and every frame, before the first paint.
    new MutationObserver(sample).observe(document, {
      childList: true,
      subtree: true,
      attributes: true
    });
    const frame = () => {
      sample();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  await page.reload();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  // Long enough for the library's own start-up to have painted.
  await expect(page.locator('.start-screen')).toBeAttached();
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => window.__settingsReload?.libraryUncovered)
  ).toBe(0);
  await expect(page.locator('[data-settings-placeholder]')).toBeVisible();
  const placeholder = await measure(page, '[data-settings-placeholder]');

  release();
  await expect(
    page.getByRole('heading', { name: 'Settings' }).first()
  ).toBeVisible();
  await expect(dialog).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('[data-settings-placeholder]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__settingsReload)).toEqual({
    libraryUncovered: 0,
    placeholderSeen: true
  });
  // The page lands on the frame it replaces: no column or rule moves.
  expectSameFrame(
    placeholder,
    await measure(page, '.settings-page'),
    headHeight
  );
}

test(
  'a reload with Settings open never shows the project library first',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await reloadWithSettingsHeld(page);
  }
);

// Just over phone width the search field wraps the head onto a second line;
// at phone width the field is hidden. Both in the dark theme.
for (const width of [600, 390])
  test.describe(`${width}px wide, in the dark theme`, () => {
    test.use({ viewport: { width, height: 844 }, colorScheme: 'dark' });

    test('the reload frame matches the page it waits for', async ({ page }) => {
      await reloadWithSettingsHeld(page, width > 580);
    });
  });
