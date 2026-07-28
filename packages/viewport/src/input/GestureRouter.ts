/** Pixels a press may travel and still count as a click rather than a drag. */
export const CLICK_THRESHOLD_PX = 5;

/**
 * A pointer press the viewport is tracking.
 *
 * Every drag needs the same three facts — which pointer, where it started,
 * and whether it has travelled far enough to stop being a click — so they
 * live here rather than being re-derived by each gesture.
 */
export interface PointerPress {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /** True once the press has travelled past the click threshold. */
  moved: boolean;
  /** True while this press owns the pointer capture. */
  captured: boolean;
}

export interface GestureRouterOptions {
  /** The element that captures the pointer and shows the cursor. */
  domElement: HTMLElement;
  /**
   * Parks the orbit controls while a gesture owns the pointer. A drag and an
   * orbit competing for the same pointer is the classic symptom of a handle
   * that "doesn't work" — it orbits the camera instead.
   */
  setControlsEnabled(enabled: boolean): void;
  clickThresholdPx?: number;
}

/**
 * Pointer bookkeeping shared by every viewport drag.
 *
 * The router does not know what any gesture means. It owns the mechanics all
 * of them repeat: pointer capture, parking the orbit controls, the drag
 * cursor, click-versus-drag, and tearing all of that down exactly once no
 * matter whether the gesture ended, was cancelled, or lost its capture.
 */
export class GestureRouter {
  private options: GestureRouterOptions;
  private tracked: PointerPress | null = null;
  private restoreCursor = '';

  constructor(options: GestureRouterOptions) {
    this.options = options;
  }

  get active(): PointerPress | null {
    return this.tracked;
  }

  private get threshold(): number {
    return this.options.clickThresholdPx ?? CLICK_THRESHOLD_PX;
  }

  /**
   * Records a press without claiming it. Use this for gestures that may turn
   * out to be clicks — the press can still be promoted with `capture`.
   */
  begin(event: PointerEvent): PointerPress {
    const press: PointerPress = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      captured: false
    };
    this.tracked = press;
    return press;
  }

  /**
   * Claims the pointer for a drag: captures it, parks the orbit controls, and
   * switches the cursor. Safe to call on a press already recorded by
   * `begin`.
   */
  capture(
    event: PointerEvent,
    cursor: string | null = 'grabbing'
  ): PointerPress {
    const press =
      this.tracked?.pointerId === event.pointerId
        ? this.tracked
        : this.begin(event);
    if (!press.captured) {
      this.restoreCursor = this.options.domElement.style.cursor;
      this.options.setControlsEnabled(false);
      this.options.domElement.setPointerCapture(event.pointerId);
      press.captured = true;
    }
    if (cursor !== null) {
      this.options.domElement.style.cursor = cursor;
    }
    return press;
  }

  /** True when the event belongs to the press currently being tracked. */
  owns(event: PointerEvent): boolean {
    return this.tracked?.pointerId === event.pointerId;
  }

  /**
   * Updates travel tracking. Returns the press when the event belongs to it,
   * so callers can read `moved` without a second lookup.
   */
  track(event: PointerEvent): PointerPress | null {
    const press = this.tracked;
    if (!press || press.pointerId !== event.pointerId) {
      return null;
    }
    if (!press.moved) {
      const dx = event.clientX - press.startX;
      const dy = event.clientY - press.startY;
      press.moved = dx * dx + dy * dy >= this.threshold * this.threshold;
    }
    return press;
  }

  /**
   * Whether the press travelled far enough to be a drag. A press that was
   * never recorded reads as not moved, which keeps a stray pointerup on the
   * click path rather than swallowing it.
   */
  hasMoved(event: PointerEvent): boolean {
    return this.track(event)?.moved ?? false;
  }

  /**
   * Releases the pointer and restores the orbit controls and cursor. Safe to
   * call for an unrelated pointer, twice, or when capture was already lost —
   * cancel paths and lost-capture paths both funnel here.
   */
  release(event: PointerEvent | number, cursor?: string | null): PointerPress | null {
    const pointerId = typeof event === 'number' ? event : event.pointerId;
    const press = this.tracked;
    if (!press || press.pointerId !== pointerId) {
      return null;
    }
    this.tracked = null;
    if (press.captured) {
      this.options.setControlsEnabled(true);
      if (this.options.domElement.hasPointerCapture(pointerId)) {
        this.options.domElement.releasePointerCapture(pointerId);
      }
      this.options.domElement.style.cursor =
        cursor === undefined ? this.restoreCursor : (cursor ?? '');
    } else if (cursor !== undefined && cursor !== null) {
      this.options.domElement.style.cursor = cursor;
    }
    return press;
  }

  /** Drops all tracking, restoring the controls if a drag held them. */
  reset() {
    if (this.tracked) {
      this.release(this.tracked.pointerId, '');
    }
  }
}
