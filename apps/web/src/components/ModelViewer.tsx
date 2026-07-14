import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  CSS2DObject,
  CSS2DRenderer
} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { createObjectForBody, fitCameraToObjects } from '@openzcad/viewport';
import type {
  BodyRepresentation,
  BodyTopology,
  TopologySelection
} from '@openzcad/shared';

export type DisplayMode = 'shaded-edges' | 'shaded' | 'wireframe';

export type StandardView = 'iso' | 'front' | 'top' | 'right';

export type ProjectionMode = 'perspective' | 'orthographic';

/** Screen-space projections of the world axes, for the orientation widget. */
export interface AxisProjection {
  x: { x: number; y: number };
  y: { x: number; y: number };
  z: { x: number; y: number };
}

export type DirectEditAxis = 'x' | 'y' | 'z';

export interface FaceResizeCommit {
  bodyId: TopologySelection['bodyId'];
  axis: DirectEditAxis;
  value: number;
}

export interface DirectEditDirection {
  axis: DirectEditAxis;
  side: -1 | 1;
}

/** Maps an exact picked face normal to the parametric box dimension it edits. */
export function directEditDirectionFromNormal(
  normal: Pick<THREE.Vector3, 'x' | 'y' | 'z'>
): DirectEditDirection {
  const components = [
    ['x', normal.x],
    ['y', normal.y],
    ['z', normal.z]
  ] as const;
  const [axis, value] = components.reduce((largest, candidate) =>
    Math.abs(candidate[1]) > Math.abs(largest[1]) ? candidate : largest
  );
  return { axis, side: value < 0 ? -1 : 1 };
}

export interface ViewerSettings {
  showGrid: boolean;
  displayMode: DisplayMode;
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

export interface ExtrudePreview {
  sketchId: string;
  distance: number;
}

interface ModelViewerProps {
  bodies: BodyRepresentation[];
  sketches: SketchOverlay[];
  /** Bodies highlighted in the viewport, in pick order. */
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  /** Exact edges highlighted for a single edge-modifier operation. */
  selectedEdges: TopologySelection[];
  settings: ViewerSettings;
  /** Increment to re-fit the camera to the current geometry. */
  fitSignal: number;
  /** Set to move the camera to a standard view; nonce forces re-runs. */
  viewRequest: { view: StandardView; nonce: number } | null;
  units: string;
  /** Primitive box bodies whose planar faces can drive document dimensions. */
  editableBodyIds: string[];
  extrudePreview: ExtrudePreview | null;
  projection: ProjectionMode;
  /** Imperative sink for per-frame axis projections (no React re-render). */
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  onSelectTopology(
    selection: TopologySelection | null,
    additive: boolean
  ): void;
  onSelectSketchProfile(sketchId: string): void;
  onResizePrimitiveFace(commit: FaceResizeCommit): void;
  onExtrudeDistanceChange(distance: number): void;
  /** Stationary right-click; right-drag stays a pan. */
  onContextMenu(
    x: number,
    y: number,
    selection: TopologySelection | null
  ): void;
}

interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  orthographic: THREE.OrthographicCamera;
  activeCamera: THREE.Camera;
  projection: ProjectionMode;
  /** Switches projection, rebinding controls and syncing camera poses. */
  applyProjection(mode: ProjectionMode): void;
  /** Mirrors the perspective pose onto the ortho camera and its frustum. */
  syncOrthographic(resetZoom: boolean): void;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  controls: OrbitControls;
  bodyGroup: THREE.Group;
  sketchGroup: THREE.Group;
  overlayGroup: THREE.Group;
  gizmoGroup: THREE.Group;
  grid: THREE.GridHelper;
  raycaster: THREE.Raycaster;
  objectsByBodyId: Map<string, THREE.Object3D>;
  hasFitCamera: boolean;
  hoveredBodyId: string | null;
  hoveredEdge: Line2 | null;
  /** Fat-line materials that need their resolution refreshed on resize. */
  edgeMaterials: Set<LineMaterial>;
}

interface PickResult {
  selection: TopologySelection | null;
  sketchId?: string;
  hit: THREE.Intersection<THREE.Object3D>;
  faceNormal?: THREE.Vector3;
}

interface FaceDragState {
  pointerId: number;
  selection: TopologySelection;
  object: THREE.Object3D;
  axis: DirectEditAxis;
  side: -1 | 1;
  initialValue: number;
  latestValue: number;
  startX: number;
  startY: number;
  directionX: number;
  directionY: number;
  pixelsPerUnit: number;
  initialPosition: THREE.Vector3;
  initialScale: THREE.Vector3;
}

interface ExtrudeDragState {
  pointerId: number;
  startX: number;
  startY: number;
  initialDistance: number;
  directionX: number;
  directionY: number;
  pixelsPerUnit: number;
}

type ViewerMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

const SELECTION_EMISSIVE = 0x1d4f86;
const HOVER_EMISSIVE = 0x14283f;
const SKETCH_COLOR = 0x4da3ff;
const SKETCH_SELECTED_COLOR = 0x9ecbff;
const RIGHT_DRAG_THRESHOLD_PX = 5;
const RIGHT_PAN_TARGET_EPSILON = 1e-9;

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

// Exact topology edges render as screen-space fat lines so they read clearly
// and their states are unmistakable: idle slate, hover glow, selected accent.
const EDGE_IDLE_COLOR = 0x7d8ca0;
const EDGE_HOVER_COLOR = 0xbfdcff;
const EDGE_SELECTED_COLOR = 0x60a5fa;
const EDGE_IDLE_WIDTH = 2;
const EDGE_HOVER_WIDTH = 4;
const EDGE_SELECTED_WIDTH = 4.5;
const EDGE_IDLE_OPACITY = 0.85;
/**
 * An edge hit wins over a face hit when it lies within this many world units
 * behind the nearest hit — otherwise the face in front of an edge swallows
 * nearly every click aimed at the edge.
 */
const EDGE_PICK_SLOP = 2.5;

interface EdgeVisualState {
  selected: boolean;
}

const VIEW_DIRECTIONS: Record<StandardView, THREE.Vector3> = {
  // Direction from the target toward the camera. Top keeps a hair of X/Z so
  // OrbitControls never sees the camera axis parallel to its up vector.
  iso: new THREE.Vector3(1, 0.9, 1).normalize(),
  front: new THREE.Vector3(0, 0, 1),
  top: new THREE.Vector3(0.0001, 1, 0.0001).normalize(),
  right: new THREE.Vector3(1, 0, 0)
};

export function isViewerMesh(object: THREE.Object3D): object is ViewerMesh {
  return (
    object instanceof THREE.Mesh &&
    object.material instanceof THREE.MeshStandardMaterial
  );
}

function forEachMesh(
  object: THREE.Object3D,
  visit: (mesh: ViewerMesh) => void
) {
  object.traverse((child: THREE.Object3D) => {
    if (isViewerMesh(child)) {
      visit(child);
    }
  });
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child: THREE.Object3D) => {
    const disposable = child as unknown as {
      geometry?: { dispose(): void };
      material?: { dispose(): void } | { dispose(): void }[];
    };
    disposable.geometry?.dispose();
    if (Array.isArray(disposable.material)) {
      for (const material of disposable.material) {
        material.dispose();
      }
    } else {
      disposable.material?.dispose();
    }
  });
}

/** CSS2D label elements stay in the DOM unless removed explicitly. */
function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    child.traverse((node: THREE.Object3D) => {
      if (node instanceof CSS2DObject) {
        node.element.remove();
      }
    });
    group.remove(child);
    disposeObject(child);
  }
}

function makeLabel(className: string, text: string): CSS2DObject {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  return new CSS2DObject(element);
}

function findBodyId(object: THREE.Object3D): string | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    const bodyId = (current.userData as { bodyId?: string }).bodyId;
    if (bodyId) {
      return bodyId;
    }
    current = current.parent;
  }
  return null;
}

function normalForTriangle(
  body: BodyRepresentation,
  triangleStart: number
): THREE.Vector3 | null {
  const offset = triangleStart * 3;
  const indices = body.mesh.indices.slice(offset, offset + 3);
  if (indices.length !== 3) {
    return null;
  }
  const [aIndex, bIndex, cIndex] = indices;
  if (aIndex === undefined || bIndex === undefined || cIndex === undefined) {
    return null;
  }
  const a = new THREE.Vector3().fromArray(body.mesh.vertices, aIndex * 3);
  const b = new THREE.Vector3().fromArray(body.mesh.vertices, bIndex * 3);
  const c = new THREE.Vector3().fromArray(body.mesh.vertices, cIndex * 3);
  return new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3());
}

/**
 * Meshes render solid or wireframe; the baked feature-edge overlay
 * (LineSegments) toggles with the mode. Exact topology edge curves are
 * `THREE.Line` pick targets and stay visible in every mode.
 */
function applyDisplayMode(bodyGroup: THREE.Group, mode: DisplayMode) {
  bodyGroup.traverse((child: THREE.Object3D) => {
    if (isViewerMesh(child)) {
      child.material.wireframe = mode === 'wireframe';
    } else if (child instanceof THREE.LineSegments) {
      child.visible = mode === 'shaded-edges';
    }
  });
}

function sketchCentroid(sketch: SketchOverlay): THREE.Vector3 {
  const centroid = new THREE.Vector3();
  for (const point of sketch.points) {
    centroid.add(new THREE.Vector3(point.x, point.y, point.z));
  }
  return centroid.divideScalar(Math.max(sketch.points.length, 1));
}

/** A lightweight live prism; the canonical B-rep is only created on confirm. */
export function createExtrudePreviewGeometry(
  sketch: SketchOverlay,
  distance: number
): THREE.BufferGeometry {
  const count = sketch.points.length;
  const normal = new THREE.Vector3(
    sketch.normal.x,
    sketch.normal.y,
    sketch.normal.z
  );
  const vertices: number[] = [];
  for (const point of sketch.points) {
    vertices.push(point.x, point.y, point.z);
  }
  for (const point of sketch.points) {
    vertices.push(
      point.x + normal.x * distance,
      point.y + normal.y * distance,
      point.z + normal.z * distance
    );
  }

  const localPoints = sketch.profile.map(
    (point) => new THREE.Vector2(point.x, point.y)
  );
  const capTriangles = THREE.ShapeUtils.triangulateShape(localPoints, []);
  const indices: number[] = [];
  for (const triangle of capTriangles) {
    const [a, b, c] = triangle;
    if (a === undefined || b === undefined || c === undefined) {
      continue;
    }
    indices.push(a, c, b, a + count, b + count, c + count);
  }
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    indices.push(index, next, next + count, index, next + count, index + count);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function markExtrudeGizmo(object: THREE.Object3D) {
  object.traverse((child) => {
    child.userData.extrudeGizmo = true;
    child.renderOrder = 20;
    const material = (child as THREE.Mesh | THREE.Line).material;
    if (material instanceof THREE.Material) {
      material.depthTest = false;
      material.transparent = true;
    }
  });
}

export function ModelViewer({
  bodies,
  sketches,
  selectedBodyIds,
  selectedTopology,
  selectedEdges,
  settings,
  fitSignal,
  viewRequest,
  units,
  editableBodyIds,
  extrudePreview,
  projection,
  orientationRef,
  onSelectTopology,
  onSelectSketchProfile,
  onResizePrimitiveFace,
  onExtrudeDistanceChange,
  onContextMenu
}: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<SceneContext | null>(null);
  const onSelectTopologyRef = useRef(onSelectTopology);
  onSelectTopologyRef.current = onSelectTopology;
  const onResizePrimitiveFaceRef = useRef(onResizePrimitiveFace);
  onResizePrimitiveFaceRef.current = onResizePrimitiveFace;
  const onSelectSketchProfileRef = useRef(onSelectSketchProfile);
  onSelectSketchProfileRef.current = onSelectSketchProfile;
  const onExtrudeDistanceChangeRef = useRef(onExtrudeDistanceChange);
  onExtrudeDistanceChangeRef.current = onExtrudeDistanceChange;
  const extrudePreviewRef = useRef(extrudePreview);
  extrudePreviewRef.current = extrudePreview;
  const sketchesRef = useRef(sketches);
  sketchesRef.current = sketches;
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const editableBodyIdsRef = useRef(new Set(editableBodyIds));
  editableBodyIdsRef.current = new Set(editableBodyIds);
  const unitsRef = useRef(units);
  unitsRef.current = units;
  const displayModeRef = useRef(settings.displayMode);
  displayModeRef.current = settings.displayMode;

  // Scene, renderers, controls, and the render loop live for the component's
  // lifetime; only the body/sketch/overlay groups rebuild on data changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#070b10');

    const aspect = host.clientWidth / Math.max(host.clientHeight, 1);
    const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 4000);
    camera.position.set(90, 80, 90);
    const orthographic = new THREE.OrthographicCamera(
      -90,
      90,
      90 / aspect,
      -90 / aspect,
      -2000,
      4000
    );
    orthographic.position.copy(camera.position);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(host.clientWidth, host.clientHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.inset = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    host.appendChild(labelRenderer.domElement);

    let controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.HemisphereLight('#dbeafe', '#070b10', 1.25));
    const keyLight = new THREE.DirectionalLight('#ffffff', 1.45);
    keyLight.position.set(90, 140, 100);
    keyLight.castShadow = true;
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight('#7aa3d0', 0.5);
    rimLight.position.set(-80, 40, -90);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(240, 24, '#243140', '#141d28');
    scene.add(grid);

    const axes = new THREE.AxesHelper(18);
    (axes.material as THREE.Material).transparent = true;
    (axes.material as THREE.Material).opacity = 0.7;
    scene.add(axes);

    const bodyGroup = new THREE.Group();
    bodyGroup.name = 'bodies';
    scene.add(bodyGroup);

    const sketchGroup = new THREE.Group();
    sketchGroup.name = 'sketches';
    scene.add(sketchGroup);

    const overlayGroup = new THREE.Group();
    overlayGroup.name = 'overlays';
    scene.add(overlayGroup);

    const gizmoGroup = new THREE.Group();
    gizmoGroup.name = 'direct-modeling-gizmo';
    scene.add(gizmoGroup);

    function syncOrthographic(resetZoom: boolean) {
      orthographic.position.copy(camera.position);
      orthographic.quaternion.copy(camera.quaternion);
      if (resetZoom) {
        orthographic.zoom = 1;
      }
      const distance = camera.position.distanceTo(controls.target);
      const halfHeight =
        distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const currentAspect = host!.clientWidth / Math.max(host!.clientHeight, 1);
      orthographic.left = -halfHeight * currentAspect;
      orthographic.right = halfHeight * currentAspect;
      orthographic.top = halfHeight;
      orthographic.bottom = -halfHeight;
      orthographic.updateProjectionMatrix();
    }

    function rebindControls(nextCamera: THREE.Camera) {
      const target = controls.target.clone();
      controls.dispose();
      controls = new OrbitControls(nextCamera, renderer.domElement);
      controls.enableDamping = true;
      controls.target.copy(target);
      context.controls = controls;
    }

    function applyProjection(mode: ProjectionMode) {
      if (context.projection === mode) {
        return;
      }
      context.projection = mode;
      if (mode === 'orthographic') {
        syncOrthographic(true);
        context.activeCamera = orthographic;
      } else {
        // Bake the ortho dolly zoom back into a perspective distance so the
        // framing survives the switch.
        const direction = orthographic.position
          .clone()
          .sub(controls.target)
          .normalize();
        const distance =
          orthographic.position.distanceTo(controls.target) /
          Math.max(orthographic.zoom, 0.0001);
        camera.position
          .copy(controls.target)
          .addScaledVector(direction, distance);
        camera.quaternion.copy(orthographic.quaternion);
        context.activeCamera = camera;
      }
      rebindControls(context.activeCamera);
    }

    const context: SceneContext = {
      scene,
      camera,
      orthographic,
      activeCamera: camera,
      projection: 'perspective',
      applyProjection,
      syncOrthographic,
      renderer,
      labelRenderer,
      controls,
      bodyGroup,
      sketchGroup,
      overlayGroup,
      gizmoGroup,
      grid,
      raycaster: new THREE.Raycaster(),
      objectsByBodyId: new Map(),
      hasFitCamera: false,
      hoveredBodyId: null,
      hoveredEdge: null,
      edgeMaterials: new Set()
    };
    contextRef.current = context;

    const observer = new ResizeObserver(() => {
      camera.aspect = host.clientWidth / Math.max(host.clientHeight, 1);
      camera.updateProjectionMatrix();
      if (context.projection === 'orthographic') {
        const zoom = orthographic.zoom;
        syncOrthographic(false);
        orthographic.zoom = zoom;
        orthographic.updateProjectionMatrix();
      }
      renderer.setSize(host.clientWidth, host.clientHeight);
      labelRenderer.setSize(host.clientWidth, host.clientHeight);
      // Screen-space fat lines rasterize against the drawing-buffer size.
      for (const material of context.edgeMaterials) {
        material.resolution.set(host.clientWidth, host.clientHeight);
      }
    });
    observer.observe(host);

    const pointer = new THREE.Vector2();
    let downPosition: { x: number; y: number } | null = null;
    const rightClickGesture = new RightClickGestureTracker();
    let rightPanStartTarget: THREE.Vector3 | null = null;
    let faceDrag: FaceDragState | null = null;
    let extrudeDrag: ExtrudeDragState | null = null;
    const dragHud = document.createElement('div');
    dragHud.className = 'direct-edit-hud';
    dragHud.hidden = true;
    host.appendChild(dragHud);

    context.raycaster.params.Line = { threshold: 3 };

    function setRayFromEvent(event: PointerEvent | MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      context.raycaster.setFromCamera(pointer, context.activeCamera);
    }

    function pickExtrudeGizmo(event: PointerEvent) {
      if (!extrudePreviewRef.current) {
        return null;
      }
      setRayFromEvent(event);
      return (
        context.raycaster
          .intersectObjects(gizmoGroup.children, true)
          .find((hit) => hit.object.userData.extrudeGizmo) ?? null
      );
    }

    function pick(event: PointerEvent | MouseEvent): PickResult | null {
      setRayFromEvent(event);
      const sketchHits = context.raycaster.intersectObjects(
        sketchGroup.children,
        true
      );
      const sketchHit = sketchHits.find(
        (hit) => typeof hit.object.userData.sketchId === 'string'
      );
      if (sketchHit) {
        return {
          selection: null,
          sketchId: sketchHit.object.userData.sketchId as string,
          hit: sketchHit
        };
      }
      const hits = context.raycaster
        .intersectObjects(bodyGroup.children, true)
        .filter((hit) => hit.object.visible);
      // An edge that lies barely behind the nearest face hit still wins the
      // pick — otherwise the face swallows nearly every click aimed at an
      // edge that runs across it.
      const nearestDistance = hits[0]?.distance ?? Infinity;
      const edgeHit = hits.find(
        (hit) =>
          (hit.object.userData as { topologyKind?: string }).topologyKind ===
            'edge' && hit.distance <= nearestDistance + EDGE_PICK_SLOP
      );
      const ordered = edgeHit
        ? [edgeHit, ...hits.filter((hit) => hit !== edgeHit)]
        : hits;
      for (const hit of ordered) {
        const data = hit.object.userData as {
          bodyId?: string;
          topologyKind?: 'edge';
          topologyId?: string;
          topologyHash?: number;
          topology?: BodyTopology;
        };
        const bodyId = data.bodyId ?? findBodyId(hit.object);
        if (!bodyId) {
          continue;
        }
        if (data.topologyKind === 'edge' && data.topologyId) {
          return {
            selection: {
              bodyId: bodyId as TopologySelection['bodyId'],
              kind: 'edge',
              topologyId: data.topologyId,
              hash: data.topologyHash
            },
            hit
          };
        }
        const faceIndex = hit.faceIndex;
        const face =
          typeof faceIndex === 'number'
            ? data.topology?.faces.find(
                (candidate) =>
                  faceIndex >= candidate.triangleStart &&
                  faceIndex < candidate.triangleStart + candidate.triangleCount
              )
            : undefined;
        if (face) {
          return {
            selection: {
              bodyId: bodyId as TopologySelection['bodyId'],
              kind: 'face',
              topologyId: face.topologyId,
              hash: face.hash
            },
            hit,
            faceNormal: hit.face?.normal
              .clone()
              .transformDirection(hit.object.matrixWorld)
          };
        }
        return {
          selection: {
            bodyId: bodyId as TopologySelection['bodyId'],
            kind: 'body'
          },
          hit
        };
      }
      return null;
    }

    function setEdgeHover(next: Line2 | null) {
      if (context.hoveredEdge === next) {
        return;
      }
      const restore = context.hoveredEdge;
      if (restore) {
        const material = restore.material;
        const state = restore.userData as EdgeVisualState;
        material.color.setHex(
          state.selected ? EDGE_SELECTED_COLOR : EDGE_IDLE_COLOR
        );
        material.linewidth = state.selected
          ? EDGE_SELECTED_WIDTH
          : EDGE_IDLE_WIDTH;
        material.opacity = state.selected ? 1 : EDGE_IDLE_OPACITY;
      }
      context.hoveredEdge = next;
      if (next && !(next.userData as EdgeVisualState).selected) {
        const material = next.material;
        material.color.setHex(EDGE_HOVER_COLOR);
        material.linewidth = EDGE_HOVER_WIDTH;
        material.opacity = 1;
      }
    }

    function applyHover(result: PickResult | null) {
      const bodyId = result?.selection?.bodyId ?? null;
      const canDragFace =
        result?.selection?.kind === 'face' &&
        editableBodyIdsRef.current.has(result.selection.bodyId);
      const hoveredEdge =
        result?.selection?.kind === 'edge'
          ? ((result.hit.object.userData as { visual?: Line2 }).visual ?? null)
          : null;
      setEdgeHover(hoveredEdge);
      renderer.domElement.style.cursor = extrudePreviewRef.current
        ? 'grab'
        : canDragFace
          ? 'grab'
          : bodyId || result?.sketchId
            ? 'pointer'
            : '';
      if (context.hoveredBodyId === bodyId) {
        return;
      }
      context.hoveredBodyId = bodyId;
      forEachMesh(bodyGroup, (mesh) => {
        const meshBodyId = findBodyId(mesh);
        const base =
          (mesh.userData as { baseEmissive?: number }).baseEmissive ?? 0x000000;
        mesh.material.emissive.setHex(
          bodyId && meshBodyId === bodyId && base === 0 ? HOVER_EMISSIVE : base
        );
      });
    }

    function positionDragHud(
      event: PointerEvent,
      value: number,
      axis: DirectEditAxis
    ) {
      const hostRect = hostRef.current?.getBoundingClientRect();
      if (!hostRect) {
        return;
      }
      const label = axis === 'x' ? 'Width' : axis === 'y' ? 'Height' : 'Depth';
      dragHud.textContent = `${label} ${Math.round(value * 100) / 100} ${unitsRef.current}`;
      dragHud.style.left = `${event.clientX - hostRect.left + 14}px`;
      dragHud.style.top = `${event.clientY - hostRect.top - 36}px`;
      dragHud.hidden = false;
    }

    function restoreFaceDrag() {
      if (!faceDrag) {
        return;
      }
      faceDrag.object.position.copy(faceDrag.initialPosition);
      faceDrag.object.scale.copy(faceDrag.initialScale);
      controls.enabled = true;
      dragHud.hidden = true;
      renderer.domElement.style.cursor = 'grab';
      if (renderer.domElement.hasPointerCapture(faceDrag.pointerId)) {
        renderer.domElement.releasePointerCapture(faceDrag.pointerId);
      }
    }

    function positionExtrudeHud(event: PointerEvent, distance: number) {
      const hostRect = hostRef.current?.getBoundingClientRect();
      if (!hostRect) {
        return;
      }
      const side = distance < 0 ? 'opposite side' : 'positive side';
      dragHud.textContent = `Extrude ${distance > 0 ? '+' : ''}${Math.round(distance * 10) / 10} ${unitsRef.current} · ${side}`;
      dragHud.style.left = `${event.clientX - hostRect.left + 14}px`;
      dragHud.style.top = `${event.clientY - hostRect.top - 36}px`;
      dragHud.hidden = false;
    }

    function restoreExtrudeDrag() {
      if (!extrudeDrag) {
        return;
      }
      controls.enabled = true;
      dragHud.hidden = true;
      renderer.domElement.style.cursor = 'grab';
      if (renderer.domElement.hasPointerCapture(extrudeDrag.pointerId)) {
        renderer.domElement.releasePointerCapture(extrudeDrag.pointerId);
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      rightClickGesture.move(event.pointerId, event.clientX, event.clientY);
      if (extrudeDrag && event.pointerId === extrudeDrag.pointerId) {
        event.preventDefault();
        const dx = event.clientX - extrudeDrag.startX;
        const dy = event.clientY - extrudeDrag.startY;
        const projected =
          dx * extrudeDrag.directionX + dy * extrudeDrag.directionY;
        const distance =
          Math.round(
            (extrudeDrag.initialDistance +
              projected / extrudeDrag.pixelsPerUnit) *
              2
          ) / 2;
        onExtrudeDistanceChangeRef.current(distance);
        renderer.domElement.style.cursor = 'grabbing';
        positionExtrudeHud(event, distance);
        return;
      }
      if (faceDrag && event.pointerId === faceDrag.pointerId) {
        event.preventDefault();
        const dx = event.clientX - faceDrag.startX;
        const dy = event.clientY - faceDrag.startY;
        const projected = dx * faceDrag.directionX + dy * faceDrag.directionY;
        const value =
          Math.round(
            Math.max(
              0.1,
              faceDrag.initialValue + projected / faceDrag.pixelsPerUnit
            ) * 10
          ) / 10;
        faceDrag.latestValue = value;
        const scale = value / faceDrag.initialValue;
        faceDrag.object.scale[faceDrag.axis] =
          faceDrag.initialScale[faceDrag.axis] * scale;
        faceDrag.object.position[faceDrag.axis] =
          faceDrag.initialPosition[faceDrag.axis] +
          (faceDrag.side * (value - faceDrag.initialValue)) / 2;
        renderer.domElement.style.cursor = 'grabbing';
        positionDragHud(event, value, faceDrag.axis);
        return;
      }
      applyHover(pick(event));
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 2) {
        rightClickGesture.begin(
          event.pointerId,
          event.clientX,
          event.clientY
        );
        rightPanStartTarget = controls.target.clone();
        return;
      }
      if (event.button !== 0) {
        return;
      }
      downPosition = { x: event.clientX, y: event.clientY };
      const activeExtrude = extrudePreviewRef.current;
      if (activeExtrude && pickExtrudeGizmo(event)) {
        const sketch = sketchesRef.current.find(
          (candidate) => candidate.sketchId === activeExtrude.sketchId
        );
        if (sketch) {
          const rect = renderer.domElement.getBoundingClientRect();
          const centroid = sketchCentroid(sketch);
          const normal = new THREE.Vector3(
            sketch.normal.x,
            sketch.normal.y,
            sketch.normal.z
          ).normalize();
          const projectedStart = centroid.clone().project(camera);
          const projectedEnd = centroid.clone().add(normal).project(camera);
          const projectedX =
            ((projectedEnd.x - projectedStart.x) * rect.width) / 2;
          const projectedY =
            (-(projectedEnd.y - projectedStart.y) * rect.height) / 2;
          const projectedLength = Math.hypot(projectedX, projectedY);
          const fallback = Math.max(rect.height / 120, 1);
          extrudeDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            initialDistance: activeExtrude.distance,
            directionX:
              projectedLength > 0.1 ? projectedX / projectedLength : 0,
            directionY:
              projectedLength > 0.1 ? projectedY / projectedLength : -1,
            pixelsPerUnit: Math.max(projectedLength, fallback)
          };
          controls.enabled = false;
          renderer.domElement.setPointerCapture(event.pointerId);
          positionExtrudeHud(event, activeExtrude.distance);
          renderer.domElement.style.cursor = 'grabbing';
          event.preventDefault();
          return;
        }
      }
      const result = pick(event);
      if (
        !result?.faceNormal ||
        result.selection?.kind !== 'face' ||
        !editableBodyIdsRef.current.has(result.selection.bodyId)
      ) {
        return;
      }
      const object = context.objectsByBodyId.get(result.selection.bodyId);
      if (!object) {
        return;
      }
      const direction = directEditDirectionFromNormal(result.faceNormal);
      const size = new THREE.Box3()
        .setFromObject(object)
        .getSize(new THREE.Vector3());
      const initialValue = size[direction.axis];
      if (!Number.isFinite(initialValue) || initialValue <= 0) {
        return;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      const projectedStart = result.hit.point
        .clone()
        .project(context.activeCamera);
      const projectedEnd = result.hit.point
        .clone()
        .add(result.faceNormal)
        .project(context.activeCamera);
      const projectedX = ((projectedEnd.x - projectedStart.x) * rect.width) / 2;
      const projectedY =
        (-(projectedEnd.y - projectedStart.y) * rect.height) / 2;
      const projectedLength = Math.hypot(projectedX, projectedY);
      const distance = Math.max(
        camera.position.distanceTo(result.hit.point),
        1
      );
      const fallbackPixelsPerUnit =
        context.projection === 'orthographic'
          ? (rect.height * orthographic.zoom) /
            Math.max(orthographic.top - orthographic.bottom, 0.0001)
          : rect.height /
            (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance);
      const useProjectedDirection =
        projectedLength >= fallbackPixelsPerUnit * 0.15;

      faceDrag = {
        pointerId: event.pointerId,
        selection: result.selection,
        object,
        axis: direction.axis,
        side: direction.side,
        initialValue,
        latestValue: initialValue,
        startX: event.clientX,
        startY: event.clientY,
        directionX: useProjectedDirection ? projectedX / projectedLength : 0,
        directionY: useProjectedDirection ? projectedY / projectedLength : -1,
        pixelsPerUnit: Math.max(
          useProjectedDirection ? projectedLength : fallbackPixelsPerUnit,
          0.1
        ),
        initialPosition: object.position.clone(),
        initialScale: object.scale.clone()
      };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(event.pointerId);
      positionDragHud(event, initialValue, direction.axis);
      event.preventDefault();
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (event.button === 2) {
        const panStartTarget = rightPanStartTarget;
        rightPanStartTarget = null;
        if (
          panStartTarget &&
          controls.target.distanceToSquared(panStartTarget) >
            RIGHT_PAN_TARGET_EPSILON * RIGHT_PAN_TARGET_EPSILON
        ) {
          // OrbitControls changed the camera target, so this gesture panned
          // even if this element missed or coalesced its pointermove events.
          rightClickGesture.markDragged(event.pointerId);
        }
        if (
          rightClickGesture.end(
            event.pointerId,
            event.clientX,
            event.clientY
          )
        ) {
          onContextMenuRef.current(
            event.clientX,
            event.clientY,
            pick(event)?.selection ?? null
          );
        }
        return;
      }
      if (extrudeDrag && event.pointerId === extrudeDrag.pointerId) {
        restoreExtrudeDrag();
        extrudeDrag = null;
        downPosition = null;
        return;
      }
      if (faceDrag && event.pointerId === faceDrag.pointerId) {
        const completed = faceDrag;
        const moved = Math.hypot(
          event.clientX - completed.startX,
          event.clientY - completed.startY
        );
        restoreFaceDrag();
        faceDrag = null;
        downPosition = null;
        onSelectTopologyRef.current(completed.selection, false);
        if (moved >= 4 && completed.latestValue !== completed.initialValue) {
          onResizePrimitiveFaceRef.current({
            bodyId: completed.selection.bodyId,
            axis: completed.axis,
            value: completed.latestValue
          });
        }
        return;
      }
      if (event.button !== 0) {
        return;
      }
      if (!downPosition) {
        return;
      }
      const moved = Math.hypot(
        event.clientX - downPosition.x,
        event.clientY - downPosition.y
      );
      downPosition = null;
      if (moved < 5) {
        const result = pick(event);
        if (result?.sketchId) {
          onSelectSketchProfileRef.current(result.sketchId);
        } else {
          onSelectTopologyRef.current(
            result?.selection ?? null,
            event.shiftKey
          );
        }
      }
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (extrudeDrag && event.pointerId === extrudeDrag.pointerId) {
        restoreExtrudeDrag();
        extrudeDrag = null;
      }
      if (faceDrag && event.pointerId === faceDrag.pointerId) {
        restoreFaceDrag();
        faceDrag = null;
      }
      rightClickGesture.cancel(event.pointerId);
      rightPanStartTarget = null;
      downPosition = null;
    };
    const handleDoubleClick = () => {
      if (bodyGroup.children.length === 0) {
        return;
      }
      fitCameraToObjects(camera, controls.target, bodyGroup.children);
      if (context.projection === 'orthographic') {
        syncOrthographic(true);
      }
      controls.update();
    };

    const handleContextMenu = (event: MouseEvent) => {
      // Browsers may dispatch this before the right-button gesture finishes.
      // Suppress the native menu here; pointerup decides whether to open ours.
      event.preventDefault();
    };

    renderer.domElement.addEventListener(
      'pointermove',
      handlePointerMove,
      true
    );
    renderer.domElement.addEventListener(
      'pointerdown',
      handlePointerDown,
      true
    );
    renderer.domElement.addEventListener('pointerup', handlePointerUp, true);
    renderer.domElement.addEventListener(
      'pointercancel',
      handlePointerCancel,
      true
    );
    renderer.domElement.addEventListener('dblclick', handleDoubleClick);
    renderer.domElement.addEventListener('contextmenu', handleContextMenu);

    const lastQuaternion = new THREE.Quaternion();
    let animationFrame = window.requestAnimationFrame(function animate() {
      controls.update();
      // The perspective camera stays the pose master; mirror it while the
      // ortho camera drives so switches and fits never jump.
      if (context.projection === 'orthographic') {
        camera.position.copy(orthographic.position);
        camera.quaternion.copy(orthographic.quaternion);
      }
      renderer.render(scene, context.activeCamera);
      labelRenderer.render(scene, context.activeCamera);

      // Push camera orientation to the view widget only when it changes.
      if (!camera.quaternion.equals(lastQuaternion)) {
        lastQuaternion.copy(camera.quaternion);
        const sink = orientationRef.current;
        if (sink) {
          const inverse = camera.quaternion.clone().invert();
          const project = (axis: THREE.Vector3) => {
            const view = axis.clone().applyQuaternion(inverse);
            return { x: view.x, y: -view.y };
          };
          sink({
            x: project(new THREE.Vector3(1, 0, 0)),
            y: project(new THREE.Vector3(0, 1, 0)),
            z: project(new THREE.Vector3(0, 0, 1))
          });
        }
      }
      animationFrame = window.requestAnimationFrame(animate);
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      renderer.domElement.removeEventListener(
        'pointermove',
        handlePointerMove,
        true
      );
      renderer.domElement.removeEventListener(
        'pointerdown',
        handlePointerDown,
        true
      );
      renderer.domElement.removeEventListener(
        'pointerup',
        handlePointerUp,
        true
      );
      renderer.domElement.removeEventListener(
        'pointercancel',
        handlePointerCancel,
        true
      );
      renderer.domElement.removeEventListener('dblclick', handleDoubleClick);
      renderer.domElement.removeEventListener('contextmenu', handleContextMenu);
      clearGroup(bodyGroup);
      clearGroup(sketchGroup);
      clearGroup(overlayGroup);
      clearGroup(gizmoGroup);
      grid.dispose();
      axes.dispose();
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      host.removeChild(labelRenderer.domElement);
      host.removeChild(dragHud);
      contextRef.current = null;
    };
  }, []);

  // Rebuild bodies + selection callout when derived geometry changes.
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }

    clearGroup(context.bodyGroup);
    clearGroup(context.overlayGroup);
    context.hoveredBodyId = null;
    context.hoveredEdge = null;
    context.edgeMaterials.clear();
    context.objectsByBodyId.clear();
    const edgeResolution = {
      width: context.renderer.domElement.clientWidth || 1,
      height: context.renderer.domElement.clientHeight || 1
    };
    const selectedEdgeKeys = new Set(
      selectedEdges.map((edge) => `${edge.bodyId}:${edge.topologyId ?? ''}`)
    );

    for (const body of bodies) {
      const object = createObjectForBody(body);
      object.userData.bodyId = body.bodyId;
      const isSelected = selectedBodyIds.includes(body.bodyId);

      forEachMesh(object, (mesh) => {
        const baseEmissive = isSelected ? SELECTION_EMISSIVE : 0x000000;
        mesh.material.emissive.setHex(baseEmissive);
        mesh.userData.baseEmissive = baseEmissive;
        mesh.userData.bodyId = body.bodyId;
        mesh.userData.topology = body.topology;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });

      for (const edge of body.topology?.edges ?? []) {
        if (edge.points.length < 6) {
          continue;
        }
        const active = selectedEdgeKeys.has(
          `${body.bodyId}:${edge.topologyId}`
        );

        // Visible fat line: WebGL ignores LineBasicMaterial linewidth, so
        // edges render via Line2 with a real screen-space width.
        const fatGeometry = new LineGeometry();
        fatGeometry.setPositions(edge.points);
        const fatMaterial = new LineMaterial({
          color: active ? EDGE_SELECTED_COLOR : EDGE_IDLE_COLOR,
          linewidth: active ? EDGE_SELECTED_WIDTH : EDGE_IDLE_WIDTH,
          transparent: true,
          opacity: active ? 1 : EDGE_IDLE_OPACITY,
          depthTest: true
        });
        fatMaterial.resolution.set(edgeResolution.width, edgeResolution.height);
        context.edgeMaterials.add(fatMaterial);
        const visual = new Line2(fatGeometry, fatMaterial);
        visual.computeLineDistances();
        // Picking goes through the thin proxy below; the fat line is display only.
        visual.raycast = () => undefined;
        (visual.userData as EdgeVisualState).selected = active;
        object.add(visual);

        // Invisible pick proxy: a plain THREE.Line raycasts reliably with the
        // raycaster's Line threshold, giving the edge a generous hit target.
        const proxyGeometry = new THREE.BufferGeometry();
        proxyGeometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(edge.points, 3)
        );
        const proxy = new THREE.Line(
          proxyGeometry,
          new THREE.LineBasicMaterial({ visible: false })
        );
        proxy.userData.bodyId = body.bodyId;
        proxy.userData.topologyKind = 'edge';
        proxy.userData.topologyId = edge.topologyId;
        proxy.userData.topologyHash = edge.hash;
        proxy.userData.visual = visual;
        object.add(proxy);
      }

      const selectedFace =
        selectedTopology?.kind === 'face' &&
        selectedTopology.bodyId === body.bodyId
          ? body.topology?.faces.find(
              (face) => face.topologyId === selectedTopology.topologyId
            )
          : undefined;
      if (selectedFace) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(body.mesh.vertices, 3)
        );
        geometry.setIndex(
          body.mesh.indices.slice(
            selectedFace.triangleStart * 3,
            (selectedFace.triangleStart + selectedFace.triangleCount) * 3
          )
        );
        geometry.computeVertexNormals();
        const highlight = new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color: 0x3b82f6,
            transparent: true,
            opacity: 0.42,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2
          })
        );
        highlight.raycast = () => undefined;
        object.add(highlight);

        if (editableBodyIds.includes(body.bodyId)) {
          const normal = normalForTriangle(body, selectedFace.triangleStart);
          if (normal) {
            const { axis } = directEditDirectionFromNormal(normal);
            const value = body.bbox.max[axis] - body.bbox.min[axis];
            geometry.computeBoundingBox();
            const center = geometry.boundingBox?.getCenter(new THREE.Vector3());
            if (center) {
              const dimension =
                axis === 'x' ? 'Width' : axis === 'y' ? 'Height' : 'Depth';
              const rounded = Math.round(value * 100) / 100;
              // Editable dimension pill: drag the face for a rough size, or
              // click the value and type an exact one.
              const element = document.createElement('div');
              element.className =
                'selection-callout direct-edit-callout editable';
              element.style.pointerEvents = 'auto';
              const valueButton = document.createElement('button');
              valueButton.type = 'button';
              valueButton.className = 'callout-value';
              valueButton.title = `Click to type an exact ${dimension.toLowerCase()}`;
              valueButton.textContent = `${dimension} ${rounded} ${units}`;
              element.appendChild(valueButton);
              const bodyId = body.bodyId;
              valueButton.addEventListener('click', () => {
                const input = document.createElement('input');
                input.className = 'callout-input';
                input.value = String(rounded);
                input.inputMode = 'decimal';
                input.setAttribute(
                  'aria-label',
                  `${dimension} in ${unitsRef.current}`
                );
                element.replaceChildren(input);
                input.focus();
                input.select();
                let done = false;
                const finish = (commit: boolean) => {
                  if (done) {
                    return;
                  }
                  done = true;
                  element.replaceChildren(valueButton);
                  const next = Number.parseFloat(input.value);
                  if (
                    commit &&
                    Number.isFinite(next) &&
                    next > 0 &&
                    Math.abs(next - rounded) > 1e-9
                  ) {
                    onResizePrimitiveFaceRef.current({
                      bodyId,
                      axis,
                      value: next
                    });
                  }
                };
                input.addEventListener('keydown', (keyEvent) => {
                  keyEvent.stopPropagation();
                  if (keyEvent.key === 'Enter') {
                    finish(true);
                  } else if (keyEvent.key === 'Escape') {
                    finish(false);
                  }
                });
                input.addEventListener('blur', () => finish(true));
              });
              const label = new CSS2DObject(element);
              label.position.copy(center);
              context.overlayGroup.add(label);
            }
          }
        }
      }

      context.bodyGroup.add(object);
      context.objectsByBodyId.set(body.bodyId, object);
    }

    applyDisplayMode(context.bodyGroup, displayModeRef.current);

    // Name callout on the primary (last picked) selected body.
    const primaryId = selectedBodyIds.at(-1);
    if (primaryId) {
      const target = context.objectsByBodyId.get(primaryId);
      const body = bodies.find((candidate) => candidate.bodyId === primaryId);
      if (target && body) {
        const box = new THREE.Box3().setFromObject(target);
        if (!box.isEmpty()) {
          const top = box.getCenter(new THREE.Vector3());
          top.y =
            box.max.y + Math.max(box.getSize(new THREE.Vector3()).y * 0.12, 5);
          const suffix =
            selectedTopology?.bodyId === primaryId &&
            selectedTopology.topologyId
              ? ` · ${selectedTopology.topologyId}`
              : '';
          const count =
            selectedBodyIds.length > 1 ? ` +${selectedBodyIds.length - 1}` : '';
          const label = makeLabel(
            'selection-callout',
            `${body.name}${suffix}${count}`
          );
          label.position.copy(top);
          context.overlayGroup.add(label);
        }
      }
    }

    if (!context.hasFitCamera && context.bodyGroup.children.length > 0) {
      fitCameraToObjects(
        context.camera,
        context.controls.target,
        context.bodyGroup.children
      );
      if (context.projection === 'orthographic') {
        context.syncOrthographic(true);
      }
      context.controls.update();
      context.hasFitCamera = true;
    }
  }, [
    bodies,
    editableBodyIds,
    selectedBodyIds,
    selectedEdges,
    selectedTopology,
    units
  ]);

  useEffect(() => {
    contextRef.current?.applyProjection(projection);
  }, [projection]);

  // Sketch profiles render as line loops on their planes so upcoming
  // extrudes/revolves are visible before they exist.
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }
    clearGroup(context.sketchGroup);
    for (const sketch of sketches) {
      if (sketch.points.length < 2) {
        continue;
      }
      const profileGeometry = new THREE.BufferGeometry();
      profileGeometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          sketch.points.flatMap((point) => [point.x, point.y, point.z]),
          3
        )
      );
      profileGeometry.setIndex(
        THREE.ShapeUtils.triangulateShape(
          sketch.profile.map((point) => new THREE.Vector2(point.x, point.y)),
          []
        ).flat()
      );
      const profileFill = new THREE.Mesh(
        profileGeometry,
        new THREE.MeshBasicMaterial({
          color: sketch.selected ? 0x3b82f6 : 0x2f78c9,
          transparent: true,
          opacity: sketch.selected ? 0.3 : 0.1,
          side: THREE.DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1
        })
      );
      profileFill.userData.sketchId = sketch.sketchId;
      context.sketchGroup.add(profileFill);

      const geometry = new THREE.BufferGeometry().setFromPoints(
        sketch.points.map(
          (point) => new THREE.Vector3(point.x, point.y, point.z)
        )
      );
      const line = new THREE.LineLoop(
        geometry,
        new THREE.LineBasicMaterial({
          color: sketch.selected ? SKETCH_SELECTED_COLOR : SKETCH_COLOR,
          transparent: true,
          opacity: sketch.selected ? 1 : 0.5
        })
      );
      line.raycast = () => undefined;
      context.sketchGroup.add(line);

      if (sketch.selected) {
        const centroid = new THREE.Vector3();
        for (const point of sketch.points) {
          centroid.add(new THREE.Vector3(point.x, point.y, point.z));
        }
        centroid.divideScalar(sketch.points.length);
        const label = makeLabel(
          'selection-callout sketch-callout',
          sketch.name
        );
        label.position.copy(centroid);
        context.sketchGroup.add(label);
      }
    }

    if (
      bodies.length === 0 &&
      !context.hasFitCamera &&
      context.sketchGroup.children.length > 0
    ) {
      fitCameraToObjects(
        context.camera,
        context.controls.target,
        context.sketchGroup.children
      );
      context.controls.update();
      context.hasFitCamera = true;
    }
  }, [bodies.length, sketches]);

  // Direct extrusion stays an ephemeral viewport preview until the user
  // confirms, keeping document history as the only durable modeling truth.
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }
    clearGroup(context.gizmoGroup);
    if (!extrudePreview) {
      return;
    }
    const sketch = sketches.find(
      (candidate) => candidate.sketchId === extrudePreview.sketchId
    );
    if (!sketch || sketch.points.length < 3) {
      return;
    }

    const normal = new THREE.Vector3(
      sketch.normal.x,
      sketch.normal.y,
      sketch.normal.z
    ).normalize();
    const centroid = sketchCentroid(sketch);
    const distance = extrudePreview.distance;

    if (Math.abs(distance) >= 0.01) {
      const previewGeometry = createExtrudePreviewGeometry(sketch, distance);
      const previewMesh = new THREE.Mesh(
        previewGeometry,
        new THREE.MeshStandardMaterial({
          color: 0x4da3ff,
          emissive: 0x102f54,
          transparent: true,
          opacity: 0.36,
          roughness: 0.5,
          metalness: 0.05,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      );
      previewMesh.raycast = () => undefined;
      context.gizmoGroup.add(previewMesh);
      const previewEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(previewGeometry, 25),
        new THREE.LineBasicMaterial({
          color: 0x8fc8ff,
          transparent: true,
          opacity: 0.9
        })
      );
      previewEdges.raycast = () => undefined;
      context.gizmoGroup.add(previewEdges);
    }

    const activeDirection = distance < 0 ? normal.clone().negate() : normal;
    // Keep the handle head outside the translucent preview so it remains an
    // obvious drag target even after the solid grows past the sketch plane.
    const activeLength = Math.max(Math.abs(distance) + 7, 13);
    const activeArrow = new THREE.ArrowHelper(
      activeDirection,
      centroid,
      activeLength,
      0x4da3ff,
      Math.min(4, activeLength * 0.32),
      2.2
    );
    markExtrudeGizmo(activeArrow);
    context.gizmoGroup.add(activeArrow);

    const oppositeArrow = new THREE.ArrowHelper(
      activeDirection.clone().negate(),
      centroid,
      distance === 0 ? activeLength : 8,
      distance === 0 ? 0x4da3ff : 0x365779,
      3,
      1.8
    );
    markExtrudeGizmo(oppositeArrow);
    context.gizmoGroup.add(oppositeArrow);

    const hitLength = Math.max(activeLength * 2.4, 52);
    const hitTarget = new THREE.Mesh(
      new THREE.CylinderGeometry(2.8, 2.8, hitLength, 10),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false
      })
    );
    hitTarget.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    hitTarget.position.copy(centroid);
    hitTarget.userData.extrudeGizmo = true;
    context.gizmoGroup.add(hitTarget);

    const valuePosition = centroid
      .clone()
      .addScaledVector(activeDirection, activeLength + 3);
    const valueLabel = makeLabel(
      'selection-callout extrude-value-callout',
      distance === 0
        ? 'Drag either direction'
        : `${distance > 0 ? '+' : ''}${Math.round(distance * 10) / 10} ${units}`
    );
    valueLabel.position.copy(valuePosition);
    context.gizmoGroup.add(valueLabel);
  }, [extrudePreview, sketches, units]);

  useEffect(() => {
    const context = contextRef.current;
    if (context) {
      context.grid.visible = settings.showGrid;
      applyDisplayMode(context.bodyGroup, settings.displayMode);
    }
  }, [settings.showGrid, settings.displayMode]);

  useEffect(() => {
    const context = contextRef.current;
    if (
      !context ||
      fitSignal === 0 ||
      context.bodyGroup.children.length === 0
    ) {
      return;
    }
    fitCameraToObjects(
      context.camera,
      context.controls.target,
      context.bodyGroup.children
    );
    if (context.projection === 'orthographic') {
      context.syncOrthographic(true);
    }
    context.controls.update();
  }, [fitSignal]);

  // Standard views keep the current zoom and orbit the camera to the axis.
  useEffect(() => {
    const context = contextRef.current;
    if (!context || !viewRequest) {
      return;
    }
    const { camera, controls } = context;
    const distance = Math.max(camera.position.distanceTo(controls.target), 1);
    const direction = VIEW_DIRECTIONS[viewRequest.view];
    camera.position.copy(controls.target).addScaledVector(direction, distance);
    camera.updateProjectionMatrix();
    if (context.projection === 'orthographic') {
      // Keep the dolly zoom; only the orbit direction changes.
      const zoom = context.orthographic.zoom;
      context.syncOrthographic(false);
      context.orthographic.zoom = zoom;
      context.orthographic.updateProjectionMatrix();
    }
    controls.update();
  }, [viewRequest]);

  return <div className="viewer-host" ref={hostRef} />;
}
