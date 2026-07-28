/**
 * The viewport framework.
 *
 * This package projects the derived model and reports what the pointer is
 * over. It never imports React and never mutates document or kernel state:
 * it emits intent, and the app turns that intent into commands.
 */

export * from './types';

// Rendering: meshes, materials, lighting, grid, and camera fitting.
export * from './render/scene';

// Camera: the controller that owns cameras/controls/projection/glides,
// plus standard view poses and screen-space projection math.
export * from './camera/CameraController';
export * from './camera/views';

// Picking: raycasting and topology resolution, mesh classification, body
// resolution, and edge hit ordering.
export * from './pick/PickService';
export * from './pick/depthCycle';
export * from './pick/edgeChain';
export * from './pick/meshes';
export * from './pick/edges';

// Selection: hover/preselect state and its overlays.
export * from './selection/SelectionManager';

// Gizmos: the shared drag-rig contract, the selection-first handles built
// on it, and the move/rotate handle geometry, snapping, and focus.
export * from './gizmo/DragRig';
export * from './gizmo/rigs';
export * from './gizmo/move';

// Input: pointer gesture classification and drag-session bookkeeping.
export * from './input/bindings';
export * from './input/GestureRouter';
export * from './input/RightClickGestureTracker';

// Scene graph: disposal, labels, display modes, and preview geometry.
export * from './scene/HudLayer';
export * from './scene/objects';

// Labels: screen-space dimension label layout.
export * from './labels/dimensionLabel';
