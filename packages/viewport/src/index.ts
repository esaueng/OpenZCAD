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

// Picking: mesh classification, body resolution, and edge hit ordering.
export * from './pick/meshes';
export * from './pick/edges';

// Gizmos: the move/rotate handle geometry, snapping, and focus.
export * from './gizmo/move';

// Input: pointer gesture classification.
export * from './input/RightClickGestureTracker';

// Scene graph: disposal, labels, display modes, and preview geometry.
export * from './scene/objects';

// Labels: screen-space dimension label layout.
export * from './labels/dimensionLabel';
