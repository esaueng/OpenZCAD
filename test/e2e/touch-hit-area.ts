import type { Page } from '@playwright/test';

/** One control whose hit area is under the touch minimum. */
export interface SmallTarget {
  /** Its accessible name, or its text, trimmed. */
  name: string;
  /** Its class list, to tell the allowance which control it is. */
  className: string;
  /** Its tag, and role when it has one. */
  kind: string;
  /** How far a touch reaches it, across and down its centre, in px. */
  hit: { width: number; height: number };
  /**
   * Drawn fully transparent: on a device without hover it can only be found
   * by tapping blind, which is the hover-only action the touch rule forbids.
   */
  hidden: boolean;
  /** What stops the reach on each short side, to say why it falls short. */
  blockedBy: string[];
}

/**
 * Every visible control on the page whose hit area is shorter than `min` on
 * either axis, measured the way a finger meets it: from the control's centre
 * outwards, `elementFromPoint` must keep landing on the control (or on its
 * label) for `min` px across and `min` px down. A pseudo-element that
 * reaches past the drawn box counts, as it does for a touch; a neighbour
 * drawn over that reach does not. The screen's edge counts as reach, since
 * a finger at the edge of the glass still lands on the edge pixel.
 *
 * A control whose centre something else covers is not in reach at all, and
 * is left to the checks for what covers it.
 */
export function smallTouchTargets(
  page: Page,
  { min = 44, within }: { min?: number; within?: string } = {}
): Promise<SmallTarget[]> {
  return page.evaluate(
    ({ min, within }) => {
      const roots = within
        ? [...document.querySelectorAll(within)]
        : [document.documentElement];
      const selector = [
        'button',
        'a[href]',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        '[role="button"]',
        '[role="menuitem"]',
        '[role="menuitemradio"]',
        '[role="menuitemcheckbox"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[role="switch"]',
        '[role="option"]',
        '[role="radio"]'
      ].join(',');
      const controls = new Set<Element>();
      for (const root of roots) {
        if (root.matches(selector)) controls.add(root);
        for (const control of root.querySelectorAll(selector)) {
          controls.add(control);
        }
      }
      /** The control a point lands on, through labels to their field. */
      const lands = (control: Element, x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        if (!hit) return false;
        if (control === hit || control.contains(hit)) return true;
        const labels = (control as HTMLInputElement).labels;
        if (labels) {
          for (const label of labels) {
            if (label.contains(hit)) return true;
          }
        }
        // A field drawn inside a control's own label or wrapper.
        const wrapper = hit.closest('label');
        return wrapper !== null && wrapper.contains(control);
      };
      /** A short description of whatever a point lands on. */
      const describe = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
          return 'screen edge';
        }
        const hit = document.elementFromPoint(x, y);
        if (!hit)
          return `nothing at ${Math.round(x)},${Math.round(y)} of ${innerWidth}×${innerHeight}`;
        const name = hit.getAttribute('aria-label');
        const className =
          typeof hit.className === 'string' && hit.className
            ? `.${hit.className.trim().split(/\s+/).join('.')}`
            : '';
        return `${hit.tagName.toLowerCase()}${className}${name ? ` "${name}"` : ''}`;
      };
      /** Reach from the centre to one side, capped at `min`. */
      const reach = (
        control: Element,
        cx: number,
        cy: number,
        dx: number,
        dy: number
      ) => {
        for (let step = 1; step <= min; step += 1) {
          const x = cx + dx * step;
          const y = cy + dy * step;
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
            return min;
          }
          if (!lands(control, x, y)) return step - 1;
        }
        return min;
      };
      const small = [];
      for (const control of controls) {
        let box = control.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const style = getComputedStyle(control);
        if (style.visibility !== 'visible' || style.pointerEvents === 'none') {
          continue;
        }
        if (control.closest('[inert], [aria-hidden="true"]')) continue;
        // A visually hidden field behind a styled stand-in (a file input,
        // a native checkbox under its drawn box) is measured through it.
        if (box.width <= 1 || box.height <= 1) continue;
        // Off screen in a scrolling list or page: bring it to the middle,
        // as a finger scrolling to it would, and measure it there.
        if (
          box.bottom <= 0 ||
          box.right <= 0 ||
          box.top >= innerHeight ||
          box.left >= innerWidth
        ) {
          control.scrollIntoView({ block: 'center', inline: 'center' });
          box = control.getBoundingClientRect();
        }
        /** How opaque an element is drawn, through its ancestors. */
        const drawn = (element: Element) => {
          let opacity = 1;
          for (
            let node: Element | null = element;
            node;
            node = node.parentElement
          ) {
            opacity *= Number(getComputedStyle(node).opacity);
          }
          return opacity;
        };
        // A transparent field drawn by its label (a switch, a segment) is
        // as visible as the label.
        const labels = [...((control as HTMLInputElement).labels ?? [])];
        const opacity = Math.max(drawn(control), ...labels.map(drawn));
        let cx = box.x + box.width / 2;
        let cy = box.y + box.height / 2;
        // Clipped by a scrolling list it stands at the edge of: scroll it
        // to the list's middle and look again.
        if (!lands(control, cx, cy)) {
          control.scrollIntoView({ block: 'center', inline: 'center' });
          box = control.getBoundingClientRect();
          cx = box.x + box.width / 2;
          cy = box.y + box.height / 2;
        }
        if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) {
          continue;
        }
        if (!lands(control, cx, cy)) continue;
        const width =
          1 + reach(control, cx, cy, -1, 0) + reach(control, cx, cy, 1, 0);
        const height =
          1 + reach(control, cx, cy, 0, -1) + reach(control, cx, cy, 0, 1);
        const hidden = opacity < 0.05;
        if (width >= min && height >= min && !hidden) continue;
        const blockedBy: string[] = [];
        for (const [dx, dy, side] of [
          [-1, 0, 'left'],
          [1, 0, 'right'],
          [0, -1, 'up'],
          [0, 1, 'down']
        ] as const) {
          const along = dx === 0 ? height : width;
          if (along >= min) continue;
          const step = reach(control, cx, cy, dx, dy) + 1;
          if (step > min) continue;
          blockedBy.push(
            `${side} ${step}px: ${describe(cx + dx * step, cy + dy * step)}`
          );
        }
        const name = (
          control.getAttribute('aria-label') ??
          (control as HTMLInputElement).placeholder ??
          control.textContent ??
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);
        const role = control.getAttribute('role');
        small.push({
          name:
            name ||
            control.getAttribute('title') ||
            (control as HTMLInputElement).type ||
            '',
          className:
            typeof control.className === 'string' ? control.className : '',
          kind: role
            ? `${control.tagName.toLowerCase()}[${role}]`
            : control.tagName.toLowerCase(),
          hit: { width, height },
          hidden,
          blockedBy
        });
      }
      return small;
    },
    { min, within }
  );
}
