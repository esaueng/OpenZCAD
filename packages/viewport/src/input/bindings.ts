/**
 * Pointer-button navigation bindings.
 *
 * Scope note, because the plan asked for Fusion/SolidWorks/Blender presets
 * and this is deliberately less than that: those presets are defined by
 * modifier combinations — shift+middle orbits in Fusion, ctrl+middle pans in
 * SolidWorks, shift+middle pans in Blender. OrbitControls maps actions per
 * button only, with no modifier dimension, so at the button level SolidWorks
 * and Blender are identical and Fusion loses its orbit entirely. Three
 * presets that are really two, one of them broken, is worse than none.
 *
 * What does differ meaningfully per button is the middle drag, so that is
 * what this exposes. Faithful vendor presets need modifier-aware bindings,
 * which means owning the orbit gesture rather than delegating it — the
 * replacement of OrbitControls that the camera work has been building toward.
 */

/** What a drag with a given button does. */
export type NavigationAction = 'orbit' | 'pan' | 'zoom' | 'none';

/** What the middle mouse button does while dragging. */
export type MiddleDragAction = 'pan' | 'orbit' | 'zoom';

export interface PointerBindings {
  left: NavigationAction;
  middle: NavigationAction;
  right: NavigationAction;
}

/**
 * OrbitControls retains orbit on left and pan on right. The viewport captures
 * an unmodified left drag for selection before OrbitControls sees it, then
 * temporarily flips the underlying left action for Shift+drag below. Only the
 * middle button is genuinely user-configurable.
 */
export function pointerBindingsFor(middle: MiddleDragAction): PointerBindings {
  return { left: 'orbit', middle, right: 'pan' };
}

/**
 * OrbitControls swaps rotate and pan whenever Shift is held. Arming pan on the
 * left button before a Shift+drag therefore makes that gesture rotate, while
 * the viewport's capture-phase router keeps an unmodified drag for selection.
 */
export function shiftOrbitBindingsFor(
  middle: MiddleDragAction
): PointerBindings {
  return { ...pointerBindingsFor(middle), left: 'pan' };
}

export const MIDDLE_DRAG_LABELS: Record<MiddleDragAction, string> = {
  pan: 'Pan',
  orbit: 'Orbit',
  zoom: 'Zoom'
};
