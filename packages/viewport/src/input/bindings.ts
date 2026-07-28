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
 * Left orbits and right pans throughout: left is also the selection button,
 * and right already distinguishes a stationary click from a pan drag. Only
 * the middle button is genuinely free, and a laptop user without one must
 * never be stranded — which is why no option removes orbit from the left.
 */
export function pointerBindingsFor(middle: MiddleDragAction): PointerBindings {
  return { left: 'orbit', middle, right: 'pan' };
}

export const MIDDLE_DRAG_LABELS: Record<MiddleDragAction, string> = {
  pan: 'Pan',
  orbit: 'Orbit',
  zoom: 'Zoom'
};
