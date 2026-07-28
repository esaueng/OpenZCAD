const RIGHT_DRAG_THRESHOLD_PX = 5;

interface ActiveRightClickGesture {
  pointerId: number;
  startX: number;
  startY: number;
  dragged: boolean;
}

/**
 * Separates a stationary right-click from OrbitControls' right-button pan.
 * Once the pointer crosses the threshold, returning to the start still counts
 * as a drag and must not open the context menu.
 */
export class RightClickGestureTracker {
  private active: ActiveRightClickGesture | null = null;

  begin(pointerId: number, x: number, y: number) {
    this.active = { pointerId, startX: x, startY: y, dragged: false };
  }

  move(pointerId: number, x: number, y: number) {
    const active = this.active;
    if (!active || active.pointerId !== pointerId || active.dragged) {
      return;
    }
    const dx = x - active.startX;
    const dy = y - active.startY;
    active.dragged =
      dx * dx + dy * dy >= RIGHT_DRAG_THRESHOLD_PX * RIGHT_DRAG_THRESHOLD_PX;
  }

  markDragged(pointerId: number) {
    if (this.active?.pointerId === pointerId) {
      this.active.dragged = true;
    }
  }

  end(pointerId: number, x: number, y: number) {
    const active = this.active;
    if (!active || active.pointerId !== pointerId) {
      return false;
    }
    this.move(pointerId, x, y);
    const shouldOpenMenu = !active.dragged;
    this.active = null;
    return shouldOpenMenu;
  }

  cancel(pointerId: number) {
    if (this.active?.pointerId === pointerId) {
      this.active = null;
    }
  }
}
