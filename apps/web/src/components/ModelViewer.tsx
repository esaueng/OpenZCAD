import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  CSS2DObject,
  CSS2DRenderer
} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { createObjectForBody, fitCameraToObjects } from '@openzcad/viewport';
import type { BodyRepresentation, Vector3 } from '@openzcad/shared';
import type { ManipulatorSpec, PreviewSpec } from '../lib/session';

export type StandardView = 'front' | 'top' | 'right' | 'iso';
export type ProjectionMode = 'perspective' | 'orthographic';
export type DisplayMode = 'shaded' | 'shaded-edges' | 'wireframe';

export interface ViewerSettings {
  showGrid: boolean;
  displayMode: DisplayMode;
}

/** Imperative camera API exposed to the app (views, projection, fit). */
export interface ViewerApi {
  setView(view: StandardView): void;
  setProjection(mode: ProjectionMode): void;
  getProjection(): ProjectionMode;
  fit(target: 'all' | 'selection'): void;
}

/** Screen-space projections of the world axes, for the orientation widget. */
export interface AxisProjection {
  x: { x: number; y: number };
  y: { x: number; y: number };
  z: { x: number; y: number };
}

export interface SketchOverlayView {
  sketchId: string;
  points: Vector3[];
  selected: boolean;
}

interface ModelViewerProps {
  bodies: BodyRepresentation[];
  /** Persistent sketch profile outlines (visible and pickable). */
  sketches: SketchOverlayView[];
  /** Selected bodies in pick order; first is primary. */
  selectedBodyIds: string[];
  settings: ViewerSettings;
  preview: PreviewSpec | null;
  manipulator: ManipulatorSpec | null;
  apiRef: MutableRefObject<ViewerApi | null>;
  /** Imperative sink for per-frame axis projections (no React re-render). */
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  onSelectBody(bodyId: string | null, additive: boolean): void;
  onSelectSketch(sketchId: string, additive: boolean): void;
  onContextMenu(x: number, y: number, bodyId: string | null): void;
  /** Fired (rAF-throttled) while a manipulator handle is dragged. */
  onManipulatorDrag(valueKey: string, value: number): void;
}

interface SceneContext {
  scene: THREE.Scene;
  perspective: THREE.PerspectiveCamera;
  orthographic: THREE.OrthographicCamera;
  activeCamera: THREE.Camera;
  projection: ProjectionMode;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  controls: OrbitControls;
  bodyGroup: THREE.Group;
  sketchGroup: THREE.Group;
  overlayGroup: THREE.Group;
  previewGroup: THREE.Group;
  manipulatorGroup: THREE.Group;
  grid: THREE.GridHelper;
  raycaster: THREE.Raycaster;
  hasFitCamera: boolean;
  hoveredBodyId: string | null;
  dragging: DragState | null;
}

interface DragState {
  valueKey: string;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  startValue: number;
  /** Axis parameter at the drag start, so dragging is relative. */
  startT: number;
  pendingValue: number | null;
  rafHandle: number | null;
}

type ViewerMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

const SELECTION_EMISSIVE = 0x1d4f86;
const HOVER_EMISSIVE = 0x14283f;
const PREVIEW_COLOR = 0x58d6c2;
const HANDLE_COLORS: Record<string, number> = {
  x: 0xef6a6a,
  y: 0x6fd66f,
  z: 0x5f8fef,
  single: 0x58d6c2
};

function forEachMesh(object: THREE.Object3D, visit: (mesh: ViewerMesh) => void) {
  object.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.Mesh) {
      visit(child as ViewerMesh);
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

function toThree(v: Vector3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function ghostMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: PREVIEW_COLOR,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    metalness: 0.1,
    roughness: 0.6
  });
}

function outline(geometry: THREE.BufferGeometry): THREE.LineSegments {
  return new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 30),
    new THREE.LineBasicMaterial({ color: PREVIEW_COLOR, transparent: true, opacity: 0.9 })
  );
}

/** Ghost geometry for a primitive session, mirroring the kernel generators. */
function primitivePreviewGeometry(
  kind: string,
  dims: Record<string, number>
): THREE.BufferGeometry | null {
  const d = (key: string) => dims[key] ?? 0;
  switch (kind) {
    case 'box':
      return new THREE.BoxGeometry(d('width'), d('height'), d('depth'));
    case 'cylinder':
      return new THREE.CylinderGeometry(d('radius'), d('radius'), d('height'), 32);
    case 'sphere':
      return new THREE.SphereGeometry(d('radius'), 32, 20);
    case 'cone':
      return new THREE.CylinderGeometry(
        Math.max(d('topRadius'), 0.0001),
        d('bottomRadius'),
        d('height'),
        32
      );
    case 'torus': {
      const geometry = new THREE.TorusGeometry(d('majorRadius'), d('minorRadius'), 20, 40);
      geometry.rotateX(Math.PI / 2); // kernel torus ring lies in XZ (Y up)
      return geometry;
    }
    default:
      return null;
  }
}

/** Watertight-enough ghost prism from a convex profile (fan triangulation). */
function extrudePreviewGeometry(
  points: Vector3[],
  normal: Vector3,
  distance: number
): THREE.BufferGeometry {
  const n = points.length;
  const offset = toThree(normal).multiplyScalar(distance);
  const bottom = points.map(toThree);
  const top = bottom.map((point) => point.clone().add(offset));
  const positions: number[] = [];
  const push = (...vertices: THREE.Vector3[]) => {
    for (const vertex of vertices) {
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  };
  for (let i = 1; i < n - 1; i++) {
    push(bottom[0]!, bottom[i + 1]!, bottom[i]!);
    push(top[0]!, top[i]!, top[i + 1]!);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(bottom[i]!, bottom[j]!, top[j]!);
    push(bottom[i]!, top[j]!, top[i]!);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function profileLine(points: Vector3[], color: number): THREE.LineLoop {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(toThree));
  return new THREE.LineLoop(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
  );
}

function buildPreviewObject(
  preview: PreviewSpec,
  bodyObjects: Map<string, THREE.Object3D>
): THREE.Object3D | null {
  switch (preview.kind) {
    case 'primitive': {
      const geometry = primitivePreviewGeometry(preview.primitiveKind, preview.dims);
      if (!geometry) {
        return null;
      }
      const mesh = new THREE.Mesh(geometry, ghostMaterial());
      mesh.add(outline(geometry));
      return mesh;
    }
    case 'profile': {
      const group = new THREE.Group();
      group.add(profileLine(preview.points, PREVIEW_COLOR));
      return group;
    }
    case 'extrude': {
      const geometry = extrudePreviewGeometry(preview.points, preview.normal, preview.distance);
      const mesh = new THREE.Mesh(geometry, ghostMaterial());
      mesh.add(outline(geometry));
      return mesh;
    }
    case 'revolve': {
      const group = new THREE.Group();
      group.add(profileLine(preview.points, PREVIEW_COLOR));
      const axisDir = toThree(preview.axisDirection).normalize();
      const origin = toThree(preview.axisOrigin);
      const axisGeometry = new THREE.BufferGeometry().setFromPoints([
        origin.clone().addScaledVector(axisDir, -80),
        origin.clone().addScaledVector(axisDir, 80)
      ]);
      const axisLine = new THREE.Line(
        axisGeometry,
        new THREE.LineDashedMaterial({
          color: PREVIEW_COLOR,
          dashSize: 3,
          gapSize: 2,
          transparent: true,
          opacity: 0.8
        })
      );
      axisLine.computeLineDistances();
      group.add(axisLine);
      return group;
    }
    case 'move': {
      // The real body object is transformed in place (kernel rotation is
      // about the world origin, which object rotation reproduces because
      // vertices are world-space); no extra ghost is needed.
      const target = bodyObjects.get(preview.bodyId);
      if (target) {
        target.position.set(
          preview.translation.x,
          preview.translation.y,
          preview.translation.z
        );
        target.rotation.set(
          THREE.MathUtils.degToRad(preview.rotationDeg.x),
          THREE.MathUtils.degToRad(preview.rotationDeg.y),
          THREE.MathUtils.degToRad(preview.rotationDeg.z)
        );
      }
      return null;
    }
  }
}

interface HandleUserData {
  manipulatorHandle: true;
  valueKey: string;
  axis: string;
}

function buildArrow(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
  color: number,
  valueKey: string,
  axis: string,
  scale: number
): THREE.Group {
  const group = new THREE.Group();
  const dir = direction.clone().normalize();
  const visualLength = Math.max(Math.abs(length), scale * 0.6);
  const sign = length < 0 ? -1 : 1;
  const end = origin.clone().addScaledVector(dir, sign * visualLength);

  const shaftGeometry = new THREE.CylinderGeometry(
    scale * 0.045,
    scale * 0.045,
    visualLength,
    12
  );
  const shaft = new THREE.Mesh(
    shaftGeometry,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false })
  );
  const mid = origin.clone().addScaledVector(dir, (sign * visualLength) / 2);
  shaft.position.copy(mid);
  shaft.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().multiplyScalar(sign)
  );

  const headGeometry = new THREE.ConeGeometry(scale * 0.14, scale * 0.34, 16);
  const head = new THREE.Mesh(
    headGeometry,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false })
  );
  head.position.copy(end);
  head.quaternion.copy(shaft.quaternion);

  // Generous invisible hit target so the handle is easy to grab.
  const hitGeometry = new THREE.CylinderGeometry(
    scale * 0.22,
    scale * 0.22,
    visualLength + scale * 0.5,
    8
  );
  const hit = new THREE.Mesh(
    hitGeometry,
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.copy(mid);
  hit.quaternion.copy(shaft.quaternion);

  const userData: HandleUserData = { manipulatorHandle: true, valueKey, axis };
  for (const part of [shaft, head, hit]) {
    part.userData = { ...userData };
    part.renderOrder = 10;
    group.add(part);
  }
  return group;
}

function buildManipulatorObject(spec: ManipulatorSpec, cameraDistance: number): THREE.Group {
  const group = new THREE.Group();
  const scale = Math.max(cameraDistance * 0.12, 8);
  if (spec.kind === 'linear-arrow') {
    group.add(
      buildArrow(
        toThree(spec.origin),
        toThree(spec.direction),
        spec.value !== 0 ? spec.value : scale,
        HANDLE_COLORS.single!,
        spec.valueKey,
        'single',
        scale
      )
    );
  } else {
    const axisNames = ['x', 'y', 'z'] as const;
    spec.axes.forEach((axis, index) => {
      group.add(
        buildArrow(
          toThree(spec.origin),
          toThree(axis.direction),
          spec.values[index] || scale,
          HANDLE_COLORS[axisNames[index] ?? 'single']!,
          axis.valueKey,
          axisNames[index] ?? 'single',
          scale
        )
      );
    });
  }
  return group;
}

/** Parameter t of the closest point on a line to a pointer ray. */
function closestAxisT(
  raycaster: THREE.Raycaster,
  origin: THREE.Vector3,
  direction: THREE.Vector3
): number | null {
  const axis = new THREE.Ray(origin.clone(), direction.clone().normalize());
  const ray = raycaster.ray;
  // Solve for the closest points of two lines (Ericson, Real-Time Collision Detection).
  const r = axis.origin.clone().sub(ray.origin);
  const a = axis.direction.dot(axis.direction);
  const b = axis.direction.dot(ray.direction);
  const c = axis.direction.dot(r);
  const e = ray.direction.dot(ray.direction);
  const f = ray.direction.dot(r);
  const denominator = a * e - b * b;
  if (Math.abs(denominator) < 1e-9) {
    return null; // axis parallel to the view ray
  }
  return (b * f - c * e) / denominator;
}

export function ModelViewer({
  bodies,
  sketches,
  selectedBodyIds,
  settings,
  preview,
  manipulator,
  apiRef,
  orientationRef,
  onSelectBody,
  onSelectSketch,
  onContextMenu,
  onManipulatorDrag
}: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<SceneContext | null>(null);
  const bodyObjectsRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const callbacksRef = useRef({ onSelectBody, onSelectSketch, onContextMenu, onManipulatorDrag });
  callbacksRef.current = { onSelectBody, onSelectSketch, onContextMenu, onManipulatorDrag };
  const manipulatorRef = useRef(manipulator);
  manipulatorRef.current = manipulator;

  // Scene, renderers, controls, and the render loop live for the component's
  // lifetime; only the body/preview/manipulator groups rebuild on data changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#070b10');

    const aspect = host.clientWidth / Math.max(host.clientHeight, 1);
    const perspective = new THREE.PerspectiveCamera(45, aspect, 0.1, 4000);
    perspective.position.set(90, 80, 90);
    const orthographic = new THREE.OrthographicCamera(-90, 90, 90 / aspect, -90 / aspect, -2000, 4000);
    orthographic.position.copy(perspective.position);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(host.clientWidth, host.clientHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.inset = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    host.appendChild(labelRenderer.domElement);

    let controls = new OrbitControls(perspective, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.HemisphereLight('#cfe2ff', '#0a0f16', 1.0));
    const keyLight = new THREE.DirectionalLight('#ffffff', 1.15);
    keyLight.position.set(90, 140, 100);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight('#7aa3d0', 0.35);
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

    const previewGroup = new THREE.Group();
    previewGroup.name = 'preview';
    scene.add(previewGroup);

    const manipulatorGroup = new THREE.Group();
    manipulatorGroup.name = 'manipulators';
    scene.add(manipulatorGroup);

    const context: SceneContext = {
      scene,
      perspective,
      orthographic,
      activeCamera: perspective,
      projection: 'perspective',
      renderer,
      labelRenderer,
      controls,
      bodyGroup,
      sketchGroup,
      overlayGroup,
      previewGroup,
      manipulatorGroup,
      grid,
      raycaster: new THREE.Raycaster(),
      hasFitCamera: false,
      hoveredBodyId: null,
      dragging: null
    };
    contextRef.current = context;

    function syncOrthoFrustum() {
      const distance = perspective.position.distanceTo(controls.target);
      const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2));
      const currentAspect = host!.clientWidth / Math.max(host!.clientHeight, 1);
      orthographic.left = -halfHeight * currentAspect;
      orthographic.right = halfHeight * currentAspect;
      orthographic.top = halfHeight;
      orthographic.bottom = -halfHeight;
      orthographic.updateProjectionMatrix();
    }

    function rebindControls() {
      const target = controls.target.clone();
      controls.dispose();
      controls = new OrbitControls(context.activeCamera, renderer.domElement);
      controls.enableDamping = true;
      controls.target.copy(target);
      context.controls = controls;
    }

    const api: ViewerApi = {
      setView(view) {
        const target = controls.target.clone();
        const distance = Math.max(
          context.activeCamera.position.distanceTo(target),
          40
        );
        const directions: Record<StandardView, THREE.Vector3> = {
          front: new THREE.Vector3(0, 0, 1),
          top: new THREE.Vector3(0, 1, 0.0001),
          right: new THREE.Vector3(1, 0, 0),
          iso: new THREE.Vector3(1, 0.85, 1).normalize()
        };
        const position = target
          .clone()
          .addScaledVector(directions[view].normalize(), distance);
        perspective.position.copy(position);
        orthographic.position.copy(position);
        perspective.lookAt(target);
        orthographic.lookAt(target);
        syncOrthoFrustum();
        controls.update();
      },
      setProjection(mode) {
        if (context.projection === mode) {
          return;
        }
        context.projection = mode;
        if (mode === 'orthographic') {
          orthographic.position.copy(perspective.position);
          orthographic.quaternion.copy(perspective.quaternion);
          syncOrthoFrustum();
          context.activeCamera = orthographic;
        } else {
          perspective.position.copy(orthographic.position);
          perspective.quaternion.copy(orthographic.quaternion);
          context.activeCamera = perspective;
        }
        rebindControls();
      },
      getProjection() {
        return context.projection;
      },
      fit(target) {
        const objects =
          target === 'selection'
            ? bodyGroup.children.filter((child) => {
                const bodyId = findBodyId(child);
                return bodyId !== null && selectedIdsRef.current.includes(bodyId);
              })
            : bodyGroup.children;
        if (objects.length === 0) {
          return;
        }
        fitCameraToObjects(perspective, controls.target, objects);
        orthographic.position.copy(perspective.position);
        orthographic.quaternion.copy(perspective.quaternion);
        syncOrthoFrustum();
        controls.update();
      }
    };
    apiRef.current = api;

    const observer = new ResizeObserver(() => {
      const width = host.clientWidth;
      const height = Math.max(host.clientHeight, 1);
      perspective.aspect = width / height;
      perspective.updateProjectionMatrix();
      syncOrthoFrustum();
      renderer.setSize(width, height);
      labelRenderer.setSize(width, height);
    });
    observer.observe(host);

    const pointer = new THREE.Vector2();
    let downPosition: { x: number; y: number } | null = null;
    let rightDownPosition: { x: number; y: number } | null = null;

    function setPointerFromEvent(event: PointerEvent | MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      context.raycaster.setFromCamera(pointer, context.activeCamera);
    }

    function pickHandle(event: PointerEvent): HandleUserData | null {
      setPointerFromEvent(event);
      const hits = context.raycaster.intersectObjects(manipulatorGroup.children, true);
      for (const hit of hits) {
        const data = hit.object.userData as Partial<HandleUserData>;
        if (data.manipulatorHandle && data.valueKey) {
          return data as HandleUserData;
        }
      }
      return null;
    }

    function pickBodyId(event: PointerEvent | MouseEvent): string | null {
      setPointerFromEvent(event);
      const hits = context.raycaster.intersectObjects(bodyGroup.children, true);
      for (const hit of hits) {
        if (!hit.object.visible) {
          continue;
        }
        const bodyId = findBodyId(hit.object);
        if (bodyId) {
          return bodyId;
        }
      }
      return null;
    }

    /** Nearest pick across bodies and sketch outlines. */
    function pickEntity(
      event: PointerEvent | MouseEvent
    ): { type: 'body' | 'sketch'; id: string } | null {
      setPointerFromEvent(event);
      context.raycaster.params.Line = { threshold: 1.5 };
      const bodyHits = context.raycaster.intersectObjects(bodyGroup.children, true);
      const sketchHits = context.raycaster.intersectObjects(sketchGroup.children, true);
      const bodyHit = bodyHits.find((hit) => hit.object.visible && findBodyId(hit.object));
      const sketchHit = sketchHits.find(
        (hit) => (hit.object.userData as { sketchId?: string }).sketchId
      );
      // Sketch outlines win narrow ties so profiles lying on faces stay pickable.
      if (sketchHit && (!bodyHit || sketchHit.distance <= bodyHit.distance + 0.75)) {
        return {
          type: 'sketch',
          id: (sketchHit.object.userData as { sketchId: string }).sketchId
        };
      }
      if (bodyHit) {
        return { type: 'body', id: findBodyId(bodyHit.object)! };
      }
      return null;
    }

    function applyHover(bodyId: string | null, handleHover: boolean) {
      renderer.domElement.style.cursor = handleHover ? 'grab' : bodyId ? 'pointer' : '';
      if (context.hoveredBodyId === bodyId) {
        return;
      }
      context.hoveredBodyId = bodyId;
      forEachMesh(bodyGroup, (mesh) => {
        const meshBodyId = findBodyId(mesh);
        const base = (mesh.userData as { baseEmissive?: number }).baseEmissive ?? 0x000000;
        mesh.material.emissive.setHex(
          bodyId && meshBodyId === bodyId && base === 0 ? HOVER_EMISSIVE : base
        );
      });
    }

    function flushDrag() {
      const drag = context.dragging;
      if (!drag || drag.pendingValue === null) {
        return;
      }
      const value = drag.pendingValue;
      drag.pendingValue = null;
      drag.rafHandle = null;
      callbacksRef.current.onManipulatorDrag(drag.valueKey, value);
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 0) {
        const handle = pickHandle(event);
        const spec = manipulatorRef.current;
        if (handle && spec) {
          const axisIndex =
            spec.kind === 'triad'
              ? spec.axes.findIndex((axis) => axis.valueKey === handle.valueKey)
              : -1;
          const origin = toThree(spec.origin);
          const direction =
            spec.kind === 'linear-arrow'
              ? toThree(spec.direction)
              : toThree(spec.axes[axisIndex]!.direction);
          const startValue =
            spec.kind === 'linear-arrow' ? spec.value : (spec.values[axisIndex] ?? 0);
          setPointerFromEvent(event);
          const startT = closestAxisT(context.raycaster, origin, direction);
          if (startT !== null) {
            context.dragging = {
              valueKey: handle.valueKey,
              origin,
              direction: direction.normalize(),
              startValue,
              startT,
              pendingValue: null,
              rafHandle: null
            };
            controls.enabled = false;
            renderer.domElement.setPointerCapture(event.pointerId);
            renderer.domElement.style.cursor = 'grabbing';
            return;
          }
        }
      }
      if (event.button === 2) {
        rightDownPosition = { x: event.clientX, y: event.clientY };
      }
      downPosition = { x: event.clientX, y: event.clientY };
    };

    const handlePointerMove = (event: PointerEvent) => {
      const drag = context.dragging;
      if (drag) {
        setPointerFromEvent(event);
        const t = closestAxisT(context.raycaster, drag.origin, drag.direction);
        if (t !== null) {
          drag.pendingValue = drag.startValue + (t - drag.startT);
          drag.rafHandle ??= window.requestAnimationFrame(flushDrag);
        }
        return;
      }
      const picked = pickEntity(event);
      applyHover(
        picked?.type === 'body' ? picked.id : null,
        pickHandle(event) !== null || picked?.type === 'sketch'
      );
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = context.dragging;
      if (drag) {
        if (drag.rafHandle !== null) {
          window.cancelAnimationFrame(drag.rafHandle);
          drag.rafHandle = null;
        }
        flushDrag();
        context.dragging = null;
        controls.enabled = true;
        renderer.domElement.releasePointerCapture(event.pointerId);
        renderer.domElement.style.cursor = '';
        return;
      }
      if (!downPosition) {
        return;
      }
      const moved = Math.hypot(event.clientX - downPosition.x, event.clientY - downPosition.y);
      downPosition = null;
      if (moved < 5 && event.button === 0) {
        const additive = event.shiftKey || event.metaKey || event.ctrlKey;
        const picked = pickEntity(event);
        if (picked?.type === 'sketch') {
          callbacksRef.current.onSelectSketch(picked.id, additive);
        } else {
          callbacksRef.current.onSelectBody(picked?.id ?? null, additive);
        }
      }
    };

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      // A right-drag is a pan (OrbitControls); only a stationary right-click
      // opens the context menu.
      const moved = rightDownPosition
        ? Math.hypot(event.clientX - rightDownPosition.x, event.clientY - rightDownPosition.y)
        : 0;
      rightDownPosition = null;
      if (moved < 5) {
        callbacksRef.current.onContextMenu(event.clientX, event.clientY, pickBodyId(event));
      }
    };

    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('contextmenu', handleContextMenu);

    const lastQuaternion = new THREE.Quaternion();
    let animationFrame = window.requestAnimationFrame(function animate() {
      context.controls.update();
      renderer.render(scene, context.activeCamera);
      labelRenderer.render(scene, context.activeCamera);

      // Push camera orientation to the view widget only when it changes.
      if (!context.activeCamera.quaternion.equals(lastQuaternion)) {
        lastQuaternion.copy(context.activeCamera.quaternion);
        const sink = orientationRef.current;
        if (sink) {
          const inverse = context.activeCamera.quaternion.clone().invert();
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
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('contextmenu', handleContextMenu);
      clearGroup(bodyGroup);
      clearGroup(sketchGroup);
      clearGroup(overlayGroup);
      clearGroup(previewGroup);
      clearGroup(manipulatorGroup);
      grid.dispose();
      axes.dispose();
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      host.removeChild(labelRenderer.domElement);
      apiRef.current = null;
      contextRef.current = null;
    };
  }, []);

  // Selection ids in a ref so the imperative fit('selection') sees fresh state.
  const selectedIdsRef = useRef(selectedBodyIds);
  selectedIdsRef.current = selectedBodyIds;

  // Rebuild bodies + selection callout when derived geometry changes.
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }

    clearGroup(context.bodyGroup);
    clearGroup(context.overlayGroup);
    context.hoveredBodyId = null;

    const objectsByBodyId = new Map<string, THREE.Object3D>();

    for (const body of bodies) {
      const object = createObjectForBody(body);
      object.userData.bodyId = body.bodyId;
      const isSelected = selectedBodyIds.includes(body.bodyId);

      forEachMesh(object, (mesh) => {
        const baseEmissive = isSelected ? SELECTION_EMISSIVE : 0x000000;
        mesh.material.emissive.setHex(baseEmissive);
        mesh.userData.baseEmissive = baseEmissive;
        if (settings.displayMode === 'wireframe') {
          mesh.material.wireframe = true;
        }
      });
      if (settings.displayMode !== 'shaded-edges') {
        object.traverse((child) => {
          if (child instanceof THREE.LineSegments) {
            child.visible = false;
          }
        });
      }

      context.bodyGroup.add(object);
      objectsByBodyId.set(body.bodyId, object);
    }
    bodyObjectsRef.current = objectsByBodyId;

    const primaryId = selectedBodyIds[0];
    if (primaryId) {
      const target = objectsByBodyId.get(primaryId);
      const body = bodies.find((candidate) => candidate.bodyId === primaryId);
      if (target && body) {
        const box = new THREE.Box3().setFromObject(target);
        if (!box.isEmpty()) {
          const top = box.getCenter(new THREE.Vector3());
          top.y = box.max.y + Math.max(box.getSize(new THREE.Vector3()).y * 0.12, 5);
          const element = document.createElement('div');
          element.className = 'selection-callout';
          element.textContent =
            selectedBodyIds.length > 1
              ? `${body.name} +${selectedBodyIds.length - 1}`
              : body.name;
          const label = new CSS2DObject(element);
          label.position.copy(top);
          context.overlayGroup.add(label);
        }
      }
    }

    if (!context.hasFitCamera && context.bodyGroup.children.length > 0) {
      fitCameraToObjects(context.perspective, context.controls.target, context.bodyGroup.children);
      context.controls.update();
      context.hasFitCamera = true;
    }
  }, [bodies, selectedBodyIds, settings.displayMode]);

  // Persistent sketch profile outlines (visible and pickable).
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }
    clearGroup(context.sketchGroup);
    for (const sketch of sketches) {
      if (sketch.points.length < 3) {
        continue;
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(sketch.points.map(toThree));
      const line = new THREE.LineLoop(
        geometry,
        new THREE.LineBasicMaterial({
          color: sketch.selected ? 0x4da3ff : 0xe1a948,
          transparent: true,
          opacity: sketch.selected ? 1 : 0.75
        })
      );
      line.userData.sketchId = sketch.sketchId;
      context.sketchGroup.add(line);
    }
  }, [sketches]);

  // Live command preview (ghost geometry / in-place transform).
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }
    clearGroup(context.previewGroup);
    // Reset any in-place move preview before applying the next one.
    for (const object of bodyObjectsRef.current.values()) {
      object.position.set(0, 0, 0);
      object.rotation.set(0, 0, 0);
    }
    if (!preview) {
      return;
    }
    const object = buildPreviewObject(preview, bodyObjectsRef.current);
    if (object) {
      context.previewGroup.add(object);
    }
  }, [preview, bodies]);

  // Manipulator handles.
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }
    // Never rebuild handles mid-drag: the drag math owns them until release.
    if (context.dragging) {
      return;
    }
    clearGroup(context.manipulatorGroup);
    if (!manipulator) {
      return;
    }
    const distance = context.activeCamera.position.distanceTo(context.controls.target);
    context.manipulatorGroup.add(buildManipulatorObject(manipulator, distance));
  }, [manipulator]);

  useEffect(() => {
    const context = contextRef.current;
    if (context) {
      context.grid.visible = settings.showGrid;
    }
  }, [settings.showGrid]);

  return <div className="viewer-host" ref={hostRef} />;
}
