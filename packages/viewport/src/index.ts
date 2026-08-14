/**
 * The viewport framework.
 *
 * This package projects the derived model and reports what the pointer is
 * over. It never imports React and never mutates document or kernel state:
 * it emits intent, and the app turns that intent into commands.
 */

export * from './types';
export * from './motion';
export * from './input/wheelGesture';

// Rendering: meshes, materials, lighting, grid, and camera fitting.
export * from './render/scene';
export * from './render/edgeOverlay';

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

// Snapping: what a pointer can lock onto, and the candidates topology gives.
export * from './snap/SnapEngine';
export * from './snap/topologySnaps';
export * from './snap/measureSnaps';

// Selection: hover/preselect state and its overlays.
export * from './selection/SelectionManager';
export * from './selection/boxSelect';
export * from './selection/boundaryEdgesOfFace';
export * from './selection/faceHighlightGeometry';
export * from './selection/analyticCylinderGhost';

// Gizmos: the shared drag-rig contract, the selection-first handles built
// on it, and the move/rotate handle geometry, snapping, and focus.
export * from './gizmo/DragRig';
export * from './gizmo/rigs';
export * from './gizmo/move';
export * from './gizmo/centerAlign';
export * from './gizmo/moveTransform';
export * from './gizmo/cylinderRadiusPreview';

// Input: pointer gesture classification and drag-session bookkeeping.
export * from './input/bindings';
export * from './input/GestureRouter';
export * from './input/RightClickGestureTracker';

// Scene graph: disposal, labels, display modes, and preview geometry.
export * from './scene/HudLayer';
export * from './scene/TopologyPickList';
export * from './scene/objects';

// Labels: screen-space dimension label layout.
export * from './labels/dimensionLabel';
export * from './annotation/dimensionGraphic';
