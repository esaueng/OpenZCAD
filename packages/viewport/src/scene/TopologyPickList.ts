import type { PickCandidate } from '../pick/PickService';
import type { HudLayer } from './HudLayer';

export interface TopologyPickListEntry {
  candidate: PickCandidate;
  label: string;
}

export interface TopologyPickListOptions {
  hud: HudLayer;
  onHover(candidate: PickCandidate | null): void;
  onSelect(candidate: PickCandidate): void;
}

/**
 * Select-other popup for the ordered stack already produced by PickService.
 *
 * It renders intent only: the app supplies human labels and decides what a
 * chosen candidate means. In particular, this class never sees DepthCycle;
 * opening the list cannot advance the repeated-click path.
 */
export class TopologyPickList {
  readonly element: HTMLDivElement;

  private options: TopologyPickListOptions;

  /**
   * Where focus was when this list took it, so closing can give it back.
   *
   * Only recorded for a keyboard open. Hiding the element that holds focus
   * drops focus on the document body, which for a keyboard user means losing
   * their place in the app entirely — the same defect the React menus had.
   */
  private focusReturn: HTMLElement | null = null;

  constructor(options: TopologyPickListOptions) {
    this.options = options;
    this.element = options.hud.create('topology-pick-list');
    this.element.dataset.testid = 'topology-pick-list';
    this.element.setAttribute('role', 'menu');
    this.element.setAttribute('aria-label', 'Select other');
    this.element.addEventListener('pointerleave', () => {
      this.options.onHover(null);
    });
    this.element.addEventListener('keydown', (event) => {
      const buttons = this.buttons();
      if (buttons.length === 0) {
        return;
      }
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | null = null;
      if (event.key === 'ArrowDown') {
        next = current < 0 ? 0 : (current + 1) % buttons.length;
      } else if (event.key === 'ArrowUp') {
        next = current <= 0 ? buttons.length - 1 : current - 1;
      } else if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = buttons.length - 1;
      }
      if (next === null) {
        return;
      }
      buttons[next]?.focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
    });
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.element.contains(target);
  }

  show(
    entries: readonly TopologyPickListEntry[],
    event: { clientX: number; clientY: number },
    focusFirst = false
  ): boolean {
    if (entries.length === 0) {
      this.hide();
      return false;
    }

    const title = document.createElement('div');
    title.className = 'topology-pick-list-title';
    title.textContent = 'Select other';
    const hint = document.createElement('span');
    hint.textContent = `${entries.length} under pointer`;
    title.appendChild(hint);

    const rows = entries.map((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'topology-pick-list-row';
      button.setAttribute('role', 'menuitem');
      button.dataset.kind = entry.candidate.kind;
      button.dataset.depth = String(index);
      const topologyId = entry.candidate.selection?.topologyId;
      if (topologyId) {
        button.dataset.topologyId = topologyId;
      }

      const label = document.createElement('span');
      label.textContent = entry.label;
      const kind = document.createElement('small');
      kind.textContent = entry.candidate.kind;
      kind.setAttribute('aria-hidden', 'true');
      button.append(label, kind);
      button.addEventListener('pointerenter', () => {
        this.options.onHover(entry.candidate);
      });
      button.addEventListener('focus', () => {
        this.options.onHover(entry.candidate);
      });
      button.addEventListener('click', () => {
        this.options.onSelect(entry.candidate);
        this.hide();
      });
      return button;
    });
    this.element.replaceChildren(title, ...rows);
    if (
      !this.options.hud.showAtPointerClamped(this.element, event, 12, 12)
    ) {
      this.hide();
      return false;
    }
    if (focusFirst) {
      const active = document.activeElement;
      this.focusReturn =
        active instanceof HTMLElement && !this.element.contains(active)
          ? active
          : null;
      rows[0]?.focus({ preventScroll: true });
    }
    return true;
  }

  hide(): void {
    if (!this.element.hidden) {
      this.options.onHover(null);
    }
    // Read before hiding: hiding the element that holds focus is what drops it.
    const active = document.activeElement;
    const heldFocus =
      active instanceof HTMLElement && this.element.contains(active);
    const focusReturn = this.focusReturn;
    this.focusReturn = null;
    this.options.hud.hide(this.element);
    // Only when this list actually had focus. Closing on an outside click
    // while the user has tabbed elsewhere must not haul focus back.
    if (heldFocus && focusReturn?.isConnected) {
      focusReturn.focus({ preventScroll: true });
    }
  }

  private buttons(): HTMLButtonElement[] {
    return Array.from(
      this.element.querySelectorAll<HTMLButtonElement>(
        '.topology-pick-list-row'
      )
    );
  }
}
