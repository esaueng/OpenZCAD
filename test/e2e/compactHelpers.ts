import type { Locator, Page } from '@playwright/test';
import { expect } from './openzcad-fixtures';

/**
 * Shared steps for the compact workspace's specs (U12): turning the compact
 * layout on for this device, reachability, target sizes and the plan's text
 * budget (`docs/plans/compact-mobile-workspace-plan-2026-11-26.md`, "Less
 * text").
 */

export const LAYOUT_KEY = 'openzcad.layout:v1';

/** The compact layout for this page's first load; a later choice sticks. */
export async function preferCompact(page: Page) {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem('compact-seeded')) {
      sessionStorage.setItem('compact-seeded', '1');
      localStorage.setItem(key, 'compact');
    }
  }, LAYOUT_KEY);
}

/** Waits for the compact frame and its stage. */
export async function expectCompactWorkspace(page: Page) {
  await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole('group', { name: 'Workspace mode' })).toBeVisible(
    { timeout: 60_000 }
  );
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 60_000
  });
}

/**
 * On screen and the topmost thing at its middle: a control the sheet clips,
 * or something stands over, is not reachable.
 */
export async function expectReachable(control: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2
        );
        return hit !== null && element.contains(hit);
      })
    )
    .toBe(true);
}

/**
 * The visible controls under `selector` smaller than 44 px either way, by
 * name and size; empty when every target is large enough.
 */
export function smallTargets(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((root) => {
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        `${root} :is(button, [role="button"], [role="radio"], [role="slider"], summary, select, input:not([type="hidden"]), a[href])`
      )
    ];
    return controls
      .filter((element) => {
        if (element.closest('[hidden], [inert], .visually-hidden')) {
          return false;
        }
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          box.width > 1 &&
          box.height > 1 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          box.bottom > 0 &&
          box.top < window.innerHeight
        );
      })
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width < 43.5 || box.height < 43.5;
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        const name =
          element.getAttribute('aria-label') ??
          element.textContent?.trim() ??
          '';
        return `${name} (${element.tagName.toLowerCase()}.${element.className}) ${Math.round(box.width)}×${Math.round(box.height)}`;
      });
  }, selector);
}

/** The plan's text budget: words on the stage at rest, and in the tray. */
export const STAGE_WORD_BUDGET = 12;
export const TRAY_WORD_BUDGET = 4;

/**
 * The words drawn on screen under `selector`, leaving out what `exclude`
 * matches: each visible text node's words, where visible means laid out,
 * painted, not clipped away (a visually hidden name for assistive
 * technology is not drawn) and inside the viewport.
 */
export function visibleWords(
  page: Page,
  selector: string,
  exclude: readonly string[] = []
): Promise<string[]> {
  return page.evaluate(
    ({ root, skip }) => {
      const scope = document.querySelector(root);
      if (!scope) return [];
      const drawn = (element: Element): boolean => {
        for (
          let current: Element | null = element;
          current && current !== document.documentElement;
          current = current.parentElement
        ) {
          const style = getComputedStyle(current);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0 ||
            style.clipPath === 'inset(50%)' ||
            /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(style.clip)
          ) {
            return false;
          }
          // Clipped to a pixel: a name kept for assistive technology.
          if (style.overflow !== 'visible') {
            const box = current.getBoundingClientRect();
            if (box.width <= 1 || box.height <= 1) return false;
          }
          if (current.hasAttribute('hidden')) return false;
        }
        return true;
      };
      const words: string[] = [];
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent) continue;
        if (skip.some((selector) => parent.closest(selector))) continue;
        if (!/[\p{L}\p{N}]/u.test(node.textContent ?? '')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const boxes = [...range.getClientRects()].filter(
          (box) =>
            box.width > 1 &&
            box.height > 1 &&
            box.right > 0 &&
            box.bottom > 0 &&
            box.left < window.innerWidth &&
            box.top < window.innerHeight
        );
        if (boxes.length === 0 || !drawn(parent)) continue;
        words.push(
          ...(node.textContent ?? '')
            .split(/\s+/)
            .filter((word) => /[\p{L}\p{N}]/u.test(word))
        );
      }
      return words;
    },
    { root: selector, skip: [...exclude] }
  );
}

/**
 * The compact stage's words at rest: everything the compact shell draws,
 * less the project's name and the selection chip, which name the user's own
 * things (the plan's budget leaves them out).
 */
export function stageWords(page: Page): Promise<string[]> {
  return visibleWords(page, '.app-shell[data-shell="compact"]', [
    '.compact-project-name',
    '.compact-selection-chip'
  ]);
}

/** The running tool's tray row's words. */
export function trayWords(page: Page): Promise<string[]> {
  return visibleWords(page, '.compact-sheet .compact-tray-row');
}
