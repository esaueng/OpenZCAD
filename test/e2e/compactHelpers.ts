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
 * Waits for the sheet to come to rest: no transition running on it and its
 * box the same on two reads in a row. `data-detent` changes as the sheet
 * starts its spring, so a box read on that alone can land mid-glide.
 */
export async function waitForSheetToSettle(
  page: Page,
  options: { timeout?: number } = {}
) {
  let last = '';
  await expect
    .poll(
      async () => {
        const read = await page.locator('.compact-sheet').evaluate((sheet) => {
          const moving = sheet
            .getAnimations()
            .some((animation) => animation.playState !== 'finished');
          const box = sheet.getBoundingClientRect();
          return moving
            ? 'moving'
            : [box.left, box.top, box.width, box.height]
                .map((value) => value.toFixed(1))
                .join(',');
        });
        const settled = read !== 'moving' && read === last;
        last = read;
        return settled;
      },
      { intervals: [50, 100], ...options }
    )
    .toBe(true);
}

/**
 * The stage's status (its line and its action, Undo or the like) is drawn
 * whole, clear of the sheet: not under the sheet at peek, where a strip of
 * it showed and a tap there reached its action (Section's Turn off), nor
 * under the side sheet held landscape. The action is on top; the line
 * takes no tap (one there picks the model).
 */
export async function expectStatusClearOfSheet(page: Page) {
  const status = page.locator(
    '.workspace-toast:not(.hidden) .workspace-toast-body'
  );
  await expect(status).toBeVisible();
  await waitForSheetToSettle(page);
  const parts = await page.evaluate(() => {
    const sheet = document
      .querySelector('.compact-sheet:not([hidden])')
      ?.getBoundingClientRect();
    return [
      ...document.querySelectorAll<HTMLElement>(
        '.workspace-toast:not(.hidden) :is(.workspace-toast-body, .workspace-toast-undo)'
      )
    ]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        const underSheet = sheet
          ? box.right > sheet.left + 0.5 &&
            box.left < sheet.right - 0.5 &&
            box.bottom > sheet.top + 0.5 &&
            box.top < sheet.bottom - 0.5
          : false;
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2
        );
        const undo = element.classList.contains('workspace-toast-undo');
        return {
          name: element.textContent?.trim() ?? element.className,
          underSheet,
          // The action is what a tap there reaches; the line lets a tap
          // through to the model, so nothing of the sheet's may stand over it.
          reached: undo
            ? hit !== null && element.contains(hit)
            : hit === null || hit.closest('.compact-sheet') === null,
          undo,
          takesTaps: getComputedStyle(element).pointerEvents !== 'none'
        };
      });
  });
  expect(parts.length).toBeGreaterThan(0);
  for (const part of parts) {
    expect(part.underSheet, part.name).toBe(false);
    expect(part.reached, part.name).toBe(true);
    expect(part.takesTaps, part.name).toBe(part.undo);
  }
}

/**
 * Presses `key` (Tab or Shift+Tab) from wherever focus is until `control`
 * holds it, as a keyboard user would, never moving focus by script; fails
 * after `limit` presses, as a focus trap that leaves `control` out would.
 */
export async function tabTo(
  page: Page,
  control: Locator,
  key: 'Tab' | 'Shift+Tab',
  limit = 80
) {
  for (let press = 0; press < limit; press += 1) {
    if (await control.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press(key);
  }
  await expect(control).toBeFocused();
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

/**
 * Chromium on Aura (Linux, ChromeOS) as CI runs it: a touch that swiped
 * across starts a fling, and the tap that stops the fling is suppressed, so
 * the next touch makes pointer and touch events but no mousedown, mouseup
 * or click. macOS Chromium leaves tap suppression off, so without this a
 * spec passes there and fails on Linux. Install before the first load.
 */
export async function dropTapAfterFling(page: Page) {
  await page.addInitScript(() => {
    let start: { x: number; y: number } | null = null;
    let swiped = false;
    let flinging = false;
    let suppressed = false;
    const options = { capture: true, passive: true } as const;
    const firstTouch = (event: Event) => (event as TouchEvent).touches[0];
    addEventListener(
      'touchstart',
      (event) => {
        const touch = firstTouch(event);
        if (!touch || (event as TouchEvent).touches.length > 1) return;
        suppressed = flinging;
        flinging = false;
        start = { x: touch.clientX, y: touch.clientY };
        swiped = false;
      },
      options
    );
    addEventListener(
      'touchmove',
      (event) => {
        const touch = firstTouch(event);
        if (start && touch && Math.abs(touch.clientX - start.x) >= 10) {
          swiped = true;
        }
      },
      options
    );
    addEventListener(
      'touchend',
      () => {
        if (swiped) flinging = true;
        start = null;
      },
      options
    );
    const drop = (event: Event) => {
      const fromTouch = (
        event as UIEvent & {
          sourceCapabilities?: { firesTouchEvents?: boolean } | null;
        }
      ).sourceCapabilities?.firesTouchEvents;
      if (!suppressed || !fromTouch) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const type of ['mousedown', 'mouseup', 'click']) {
      addEventListener(type, drop, true);
    }
  });
}
