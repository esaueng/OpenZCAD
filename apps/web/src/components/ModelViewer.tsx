import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  CSS2DObject,
  CSS2DRenderer
} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { createObjectForBody, fitCameraToObjects } from '@openzcad/viewport';
import type { BodyRepresentation } from '@openzcad/shared';

export type DisplayMode = 'shaded-edges' | 'shaded' | 'wireframe';

export type StandardView = 'iso' | 'front' | 'top' | 'right';

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
  selectedBodyIds: string[];
  settings: ViewerSettings;
  /** Increment to re-fit the camera to the current geometry. */
  fitSignal: number;
  /** Set to move the camera to a standard view; nonce forces re-runs. */
  viewRequest: { view: StandardView; nonce: number } | null;
  onSelectBody(bodyId: string | null, additive: boolean): void;
}

interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  controls: OrbitControls;
  bodyGroup: THREE.Group;
  sketchGroup: THREE.Group;
  overlayGroup: THREE.Group;
  grid: THREE.GridHelper;
  raycaster: THREE.Raycaster;
  hasFitCamera: boolean;
  hoveredBodyId: string | null;
}

type ViewerMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

const SELECTION_EMISSIVE = 0x1d4f86;
const HOVER_EMISSIVE = 0x14283f;
const SKETCH_COLOR = 0x4da3ff;
const SKETCH_SELECTED_COLOR = 0x9ecbff;

const VIEW_DIRECTIONS: Record<StandardView, THREE.Vector3> = {
  // Direction from the target toward the camera. Top keeps a hair of Z so
  // OrbitControls never sees the camera axis parallel to its up vector.
  iso: new THREE.Vector3(1, 0.9, 1).normalize(),
  front: new THREE.Vector3(0, 0, 1),
  top: new THREE.Vector3(0.0001, 1, 0.0001).normalize(),
  right: new THREE.Vector3(1, 0, 0)
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

/** Meshes render solid or wireframe; the baked feature-edge lines toggle. */
function applyDisplayMode(bodyGroup: THREE.Group, mode: DisplayMode) {
  bodyGroup.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.Mesh) {
      const material = (child as ViewerMesh).material;
      material.wireframe = mode === 'wireframe';
    } else if (child instanceof THREE.LineSegments) {
      child.visible = mode === 'shaded-edges';
    }
  });
}

export function ModelViewer({
  bodies,
  sketches,
  selectedBodyIds,
  settings,
  fitSignal,
  viewRequest,
  onSelectBody
}: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<SceneContext | null>(null);
  const onSelectBodyRef = useRef(onSelectBody);
  onSelectBodyRef.current = onSelectBody;
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

    const controls = new OrbitControls(camera, renderer.domElement);
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

    const context: SceneContext = {
      scene,
      camera,
      renderer,
      labelRenderer,
      controls,
      bodyGroup,
      sketchGroup,
      overlayGroup,
      grid,
      raycaster: new THREE.Raycaster(),
      hasFitCamera: false,
      hoveredBodyId: null
    };
    contextRef.current = context;

    const observer = new ResizeObserver(() => {
      camera.aspect = host.clientWidth / Math.max(host.clientHeight, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
      labelRenderer.setSize(host.clientWidth, host.clientHeight);
    });
    observer.observe(host);

    const pointer = new THREE.Vector2();
    let downPosition: { x: number; y: number } | null = null;

    function pickBodyId(event: PointerEvent | MouseEvent): string | null {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      context.raycaster.setFromCamera(pointer, camera);
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

    function applyHover(bodyId: string | null) {
      if (context.hoveredBodyId === bodyId) {
        return;
      }
      context.hoveredBodyId = bodyId;
      renderer.domElement.style.cursor = bodyId ? 'pointer' : '';
      forEachMesh(bodyGroup, (mesh) => {
        const meshBodyId = findBodyId(mesh);
        const base = (mesh.userData as { baseEmissive?: number }).baseEmissive ?? 0x000000;
        mesh.material.emissive.setHex(
          bodyId && meshBodyId === bodyId && base === 0 ? HOVER_EMISSIVE : base
        );
      });
    }

    const handlePointerMove = (event: PointerEvent) => {
      applyHover(pickBodyId(event));
    };
    const handlePointerDown = (event: PointerEvent) => {
      downPosition = { x: event.clientX, y: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (!downPosition) {
        return;
      }
      const moved = Math.hypot(event.clientX - downPosition.x, event.clientY - downPosition.y);
      downPosition = null;
      if (moved < 5) {
        onSelectBodyRef.current(pickBodyId(event), event.shiftKey);
      }
    };
    const handleDoubleClick = () => {
      if (bodyGroup.children.length === 0) {
        return;
      }
      fitCameraToObjects(camera, controls.target, bodyGroup.children);
      controls.update();
    };

    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('dblclick', handleDoubleClick);

    let animationFrame = window.requestAnimationFrame(function animate() {
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('dblclick', handleDoubleClick);
      clearGroup(bodyGroup);
      clearGroup(sketchGroup);
      clearGroup(overlayGroup);
      grid.dispose();
      axes.dispose();
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      host.removeChild(labelRenderer.domElement);
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

    const objectsByBodyId = new Map<string, THREE.Object3D>();

    for (const body of bodies) {
      const object = createObjectForBody(body);
      object.userData.bodyId = body.bodyId;
      const isSelected = selectedBodyIds.includes(body.bodyId);

      forEachMesh(object, (mesh) => {
        const baseEmissive = isSelected ? SELECTION_EMISSIVE : 0x000000;
        mesh.material.emissive.setHex(baseEmissive);
        mesh.userData.baseEmissive = baseEmissive;
      });

      context.bodyGroup.add(object);
      objectsByBodyId.set(body.bodyId, object);
    }

    applyDisplayMode(context.bodyGroup, displayModeRef.current);

    // Name callout on the primary (last picked) selected body.
    const primaryId = selectedBodyIds.at(-1);
    if (primaryId) {
      const target = objectsByBodyId.get(primaryId);
      const body = bodies.find((candidate) => candidate.bodyId === primaryId);
      if (target && body) {
        const box = new THREE.Box3().setFromObject(target);
        if (!box.isEmpty()) {
          const top = box.getCenter(new THREE.Vector3());
          top.y = box.max.y + Math.max(box.getSize(new THREE.Vector3()).y * 0.12, 5);
          const text =
            selectedBodyIds.length > 1
              ? `${body.name} +${selectedBodyIds.length - 1}`
              : body.name;
          const label = makeLabel('selection-callout', text);
          label.position.copy(top);
          context.overlayGroup.add(label);
        }
      }
    }

    if (!context.hasFitCamera && context.bodyGroup.children.length > 0) {
      fitCameraToObjects(context.camera, context.controls.target, context.bodyGroup.children);
      context.controls.update();
      context.hasFitCamera = true;
    }
  }, [bodies, selectedBodyIds]);

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
        sketch.points.map((point) => new THREE.Vector3(point.x, point.y, point.z))
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
        const label = makeLabel('selection-callout sketch-callout', sketch.name);
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
    if (!context || fitSignal === 0 || context.bodyGroup.children.length === 0) {
      return;
    }
    fitCameraToObjects(context.camera, context.controls.target, context.bodyGroup.children);
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
    camera.position
      .copy(controls.target)
      .addScaledVector(direction, distance);
    camera.updateProjectionMatrix();
    controls.update();
  }, [viewRequest]);

  return <div className="viewer-host" ref={hostRef} />;
}
