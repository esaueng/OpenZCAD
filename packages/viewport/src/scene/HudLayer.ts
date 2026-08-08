/**
 * The viewport's DOM overlay layer.
 *
 * Value chips, drag readouts, snap glyphs, and gizmo labels are plain DOM
 * positioned over the canvas rather than React nodes, because they move with
 * the pointer or with the render loop and re-rendering the workspace at that
 * rate is exactly what the imperative viewport exists to avoid.
 *
 * Every overlay repeats the same three things — create hidden and append,
 * convert a client point into host-local pixels, remove on teardown — so
 * they live here once.
 */
export interface HudElementOptions {
  /** Decorative overlays are hidden from assistive technology. */
  ariaHidden?: boolean;
}

export class HudLayer {
  private host: HTMLElement;
  private owned: HTMLElement[] = [];

  constructor(host: HTMLElement) {
    this.host = host;
  }

  /** Creates an overlay, hidden, appended to the host, and tracked for disposal. */
  create(className: string, options: HudElementOptions = {}): HTMLDivElement {
    const element = document.createElement('div');
    element.className = className;
    element.setAttribute('data-viewport-hud', '');
    element.hidden = true;
    if (options.ariaHidden) {
      element.setAttribute('aria-hidden', 'true');
    }
    this.host.appendChild(element);
    this.owned.push(element);
    return element;
  }

  /** Where a client point falls inside the host, or null if it cannot be measured. */
  toLocal(
    clientX: number,
    clientY: number
  ): { x: number; y: number } | null {
    const rect = this.host.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      return null;
    }
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  /**
   * Positions an overlay near a pointer and reveals it. The offsets keep the
   * overlay clear of the cursor itself; returns false when the host cannot
   * be measured, so callers can leave the overlay hidden.
   */
  showAtPointer(
    element: HTMLElement,
    event: { clientX: number; clientY: number },
    offsetX = 0,
    offsetY = 0
  ): boolean {
    const local = this.toLocal(event.clientX, event.clientY);
    if (!local) {
      return false;
    }
    element.style.left = `${local.x + offsetX}px`;
    element.style.top = `${local.y + offsetY}px`;
    element.hidden = false;
    return true;
  }

  /** Positions an overlay at host-local pixels and reveals it. */
  showAt(element: HTMLElement, x: number, y: number) {
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    element.hidden = false;
  }

  hide(element: HTMLElement | null | undefined) {
    if (element) {
      element.hidden = true;
    }
  }

  /** Removes every overlay this layer created. */
  dispose() {
    for (const element of this.owned) {
      element.remove();
    }
    this.owned = [];
  }
}
