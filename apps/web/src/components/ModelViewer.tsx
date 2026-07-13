import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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
  points: { x: number; y: number; z: number }[];
}

interface ModelViewerProps {
  bodies: BodyRepresentation[];
  sketches: SketchOverlay[];
  /** Bodies highlighted in the viewport, in pick order. */
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  settings: ViewerSettings;
  /** Increment to re-fit the camera to the current geometry. */
  fitSignal: number;
  /** Set to move the camera to a standard view; nonce forces re-runs. */
  viewRequest: { view: StandardView; nonce: number } | null;
  units: string;
  /** Primitive box bodies whose planar faces can drive document dimensions. */
  editableBodyIds: string[];
  projection: ProjectionMode;
  /** Imperative sink for per-frame axis projections (no React re-render). */
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  onSelectTopology(
    selection: TopologySelection | null,
    additive: boolean
  ): void;
  onResizePrimitiveFace(commit: FaceResizeCommit): void;
  /** Stationary right-click; right-drag stays a pan. */
  onContextMenu(x: number, y: number, selection: TopologySelection | null): void;
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
  grid: THREE.GridHelper;
  raycaster: THREE.Raycaster;
  objectsByBodyId: Map<string, THREE.Object3D>;
  hasFitCamera: boolean;
  hoveredBodyId: string | null;
}

interface PickResult {
  selection: TopologySelection;
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

type ViewerMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

const SELECTION_EMISSIVE = 0x1d4f86;
const HOVER_EMISSIVE = 0x14283f;
const SKETCH_COLOR = 0x4da3ff;
const SKETCH_SELECTED_COLOR = 0x9ecbff;

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

export function ModelViewer({
  bodies,
  sketches,
  selectedBodyIds,
  selectedTopology,
  settings,
  fitSignal,
  viewRequest,
  units,
  editableBodyIds,
  projection,
  orientationRef,
  onSelectTopology,
  onResizePrimitiveFace,
  onContextMenu
}: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<SceneContext | null>(null);
  const onSelectTopologyRef = useRef(onSelectTopology);
  onSelectTopologyRef.current = onSelectTopology;
  const onResizePrimitiveFaceRef = useRef(onResizePrimitiveFace);
  onResizePrimitiveFaceRef.current = onResizePrimitiveFace;
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
      grid,
      raycaster: new THREE.Raycaster(),
      objectsByBodyId: new Map(),
      hasFitCamera: false,
      hoveredBodyId: null
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
    });
    observer.observe(host);

    const pointer = new THREE.Vector2();
    let downPosition: { x: number; y: number } | null = null;
    let faceDrag: FaceDragState | null = null;
    const dragHud = document.createElement('div');
    dragHud.className = 'direct-edit-hud';
    dragHud.hidden = true;
    host.appendChild(dragHud);

    context.raycaster.params.Line = { threshold: 2.4 };

    function pick(event: PointerEvent | MouseEvent): PickResult | null {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      context.raycaster.setFromCamera(pointer, context.activeCamera);
      const hits = context.raycaster.intersectObjects(bodyGroup.children, true);
      for (const hit of hits) {
        if (!hit.object.visible) {
          continue;
        }
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

    function applyHover(result: PickResult | null) {
      const bodyId = result?.selection.bodyId ?? null;
      const canDragFace =
        result?.selection.kind === 'face' &&
        editableBodyIdsRef.current.has(result.selection.bodyId);
      renderer.domElement.style.cursor = canDragFace
        ? 'grab'
        : bodyId
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

    const handlePointerMove = (event: PointerEvent) => {
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
      downPosition = { x: event.clientX, y: event.clientY };
      if (event.button !== 0) {
        return;
      }
      const result = pick(event);
      if (
        !result?.faceNormal ||
        result.selection.kind !== 'face' ||
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
      if (!downPosition) {
        return;
      }
      const moved = Math.hypot(
        event.clientX - downPosition.x,
        event.clientY - downPosition.y
      );
      downPosition = null;
      if (moved < 5) {
        onSelectTopologyRef.current(
          pick(event)?.selection ?? null,
          event.shiftKey
        );
      }
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (faceDrag && event.pointerId === faceDrag.pointerId) {
        restoreFaceDrag();
        faceDrag = null;
      }
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

    let rightDownPosition: { x: number; y: number } | null = null;
    const handleRightDown = (event: PointerEvent) => {
      if (event.button === 2) {
        rightDownPosition = { x: event.clientX, y: event.clientY };
      }
    };
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      // A right-drag is a pan (OrbitControls); only a stationary right-click
      // opens the context menu.
      const moved = rightDownPosition
        ? Math.hypot(
            event.clientX - rightDownPosition.x,
            event.clientY - rightDownPosition.y
          )
        : 0;
      rightDownPosition = null;
      if (moved < 5) {
        onContextMenuRef.current(
          event.clientX,
          event.clientY,
          pick(event)?.selection ?? null
        );
      }
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
    renderer.domElement.addEventListener('pointerdown', handleRightDown, true);
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
      renderer.domElement.removeEventListener(
        'pointerdown',
        handleRightDown,
        true
      );
      renderer.domElement.removeEventListener('contextmenu', handleContextMenu);
      clearGroup(bodyGroup);
      clearGroup(sketchGroup);
      clearGroup(overlayGroup);
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
    context.objectsByBodyId.clear();

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
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(edge.points, 3)
        );
        const active =
          selectedTopology?.kind === 'edge' &&
          selectedTopology.bodyId === body.bodyId &&
          selectedTopology.topologyId === edge.topologyId;
        const line = new THREE.Line(
          geometry,
          new THREE.LineBasicMaterial({
            color: active ? 0x60a5fa : 0x202a36,
            transparent: true,
            opacity: active ? 1 : 0.52,
            depthTest: true
          })
        );
        line.userData.bodyId = body.bodyId;
        line.userData.topologyKind = 'edge';
        line.userData.topologyId = edge.topologyId;
        line.userData.topologyHash = edge.hash;
        object.add(line);
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
              const label = makeLabel(
                'selection-callout direct-edit-callout',
                `Drag face · ${dimension} ${Math.round(value * 100) / 100} ${units}`
              );
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
  }, [bodies, editableBodyIds, selectedBodyIds, selectedTopology, units]);

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
  }, [sketches]);

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
