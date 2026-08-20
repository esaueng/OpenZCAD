/**
 * Viewport-wide value types.
 *
 * These describe what the viewport renders and reports, never what the
 * document holds. The package projects and picks; the app turns the intents
 * below into commands.
 */

export type DisplayMode = 'shaded-edges' | 'shaded' | 'wireframe';

export type StandardView =
  'iso' | 'front' | 'back' | 'top' | 'bottom' | 'right' | 'left';

/** A cube-corner diagonal: which side of each world axis the camera sits on. */
export type CubeCorner = readonly [1 | -1, 1 | -1, 1 | -1];

/**
 * What a view request can aim the camera at: a named standard view, or one of
 * the view cube's bevelled corner facets — the eight diagonal isometric
 * directions, which are legion enough that naming each would bloat
 * `StandardView` without any of them being a view the rest of the interface
 * needs to refer to.
 */
export type ViewTarget = StandardView | { corner: CubeCorner };

export type ProjectionMode = 'perspective' | 'orthographic';

/**
 * What the pointer is allowed to select.
 *
 * A filter is how you reach an edge on a crowded model without fighting the
 * face in front of it. `any` is the default and picks whatever is nearest;
 * every other value narrows to one kind, so anything else under the pointer
 * is passed straight through rather than competing for the click.
 */
export type SelectionFilter = 'any' | 'body' | 'face' | 'edge' | 'sketch';

export const SELECTION_FILTERS: SelectionFilter[] = [
  'any',
  'body',
  'face',
  'edge',
  'sketch'
];

export const SELECTION_FILTER_LABELS: Record<SelectionFilter, string> = {
  any: 'Any',
  body: 'Body',
  face: 'Face',
  edge: 'Edge',
  sketch: 'Sketch'
};

/**
 * Screen-space projections of the world axes, for the orientation widget.
 * `x`/`y` are screen direction (y already flipped for SVG); `z` is view-space
 * depth toward the camera, which the view cube needs to cull its back faces.
 */
export interface AxisProjection {
  x: { x: number; y: number; z: number };
  y: { x: number; y: number; z: number };
  z: { x: number; y: number; z: number };
}

/** Canonical cutting planes the section view can cycle through. */
export type SectionPlaneId = 'XY' | 'XZ' | 'YZ';

/**
 * Display-only cutaway: geometry on the positive side of the chosen canonical
 * plane (above `offset` along its axis) is clipped from rendering. Never a
 * document mutation — the model is untouched, only its rasterization.
 */
export interface SectionViewSettings {
  plane: SectionPlaneId;
  /** Plane position along its axis, in model units. */
  offset: number;
}

export interface ViewerSettings {
  showGrid: boolean;
  displayMode: DisplayMode;
  /** Runtime-only cutaway state; absent means no section is active. */
  sectionView?: SectionViewSettings;
  /** Runtime-only accessibility preference; omitted by older saved views. */
  reducedMotion?: boolean;
  /** Runtime-only navigation preference; omitted by older saved views. */
  zoomToCursor?: boolean;
  /** Runtime-only navigation preference; omitted by older saved views. */
  middleDrag?: 'pan' | 'orbit' | 'zoom';
  /** Runtime-only navigation preference; omitted by older saved views. */
  pointerNavigation?: 'auto' | 'mouse' | 'trackpad';
}

/**
 * Where a selection click landed: the world-space hit point and, for faces,
 * the outward normal. Selection-first editing anchors its drag handle here so
 * the affordance appears under the cursor rather than at the face center.
 */
export interface PickDetail {
  point: { x: number; y: number; z: number };
  normal?: { x: number; y: number; z: number };
}

/** Pick payload attached to region meshes via userData. */
export interface RegionPickData {
  sketchId: string;
  profileId: string;
  regionFingerprint: number;
  samplePoint: { x: number; y: number };
  centroid: { x: number; y: number };
  boundingBox: {
    min: { x: number; y: number };
    max: { x: number; y: number };
  };
  sourceEntityIds: string[];
  area: number;
}

/** Sketch profile polyline, already lifted onto its 3D plane. */
export interface SketchOverlay {
  sketchId: string;
  name: string;
  selected: boolean;
  /** Original local coordinates are used to triangulate the selectable region. */
  profile: { x: number; y: number }[];
  normal: { x: number; y: number; z: number };
  points: { x: number; y: number; z: number }[];
}
