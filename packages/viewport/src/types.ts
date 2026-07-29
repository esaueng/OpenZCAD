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

/** Screen-space projections of the world axes, for the orientation widget. */
export interface AxisProjection {
  x: { x: number; y: number };
  y: { x: number; y: number };
  z: { x: number; y: number };
}

export interface ViewerSettings {
  showGrid: boolean;
  displayMode: DisplayMode;
  /** Runtime-only accessibility preference; omitted by older saved views. */
  reducedMotion?: boolean;
  /** Runtime-only navigation preference; omitted by older saved views. */
  zoomToCursor?: boolean;
  /** Runtime-only navigation preference; omitted by older saved views. */
  middleDrag?: 'pan' | 'orbit' | 'zoom';
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
