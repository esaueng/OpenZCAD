import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  CSS2DObject,
  CSS2DRenderer
} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { createObjectForBody, fitCameraToObjects } from '@openzcad/viewport';
import type { BodyRepresentation } from '@openzcad/shared';

export interface ViewerSettings {
  showGrid: boolean;
}

interface ModelViewerProps {
  bodies: BodyRepresentation[];
  selectedBodyId: string | null;
  settings: ViewerSettings;
  /** Increment to re-fit the camera to the current geometry. */
  fitSignal: number;
  onSelectBody(bodyId: string | null): void;
}

interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  controls: OrbitControls;
  bodyGroup: THREE.Group;
  overlayGroup: THREE.Group;
  grid: THREE.GridHelper;
  raycaster: THREE.Raycaster;
  hasFitCamera: boolean;
  hoveredBodyId: string | null;
}

type ViewerMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

const SELECTION_EMISSIVE = 0x1d4f86;
const HOVER_EMISSIVE = 0x14283f;

function forEachMesh(
  object: THREE.Object3D,
  visit: (mesh: ViewerMesh) => void
) {
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

export function ModelViewer({
  bodies,
  selectedBodyId,
  settings,
  fitSignal,
  onSelectBody
}: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<SceneContext | null>(null);
  const onSelectBodyRef = useRef(onSelectBody);
  onSelectBodyRef.current = onSelectBody;

  // Scene, renderers, controls, and the render loop live for the component's
  // lifetime; only the body/overlay groups rebuild on data changes.
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

    function pickBodyId(event: PointerEvent): string | null {
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
        const base =
          (mesh.userData as { baseEmissive?: number }).baseEmissive ?? 0x000000;
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
      const moved = Math.hypot(
        event.clientX - downPosition.x,
        event.clientY - downPosition.y
      );
      downPosition = null;
      if (moved < 5) {
        onSelectBodyRef.current(pickBodyId(event));
      }
    };

    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);

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
      clearGroup(bodyGroup);
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
      const isSelected = body.bodyId === selectedBodyId;

      forEachMesh(object, (mesh) => {
        const baseEmissive = isSelected ? SELECTION_EMISSIVE : 0x000000;
        mesh.material.emissive.setHex(baseEmissive);
        mesh.userData.baseEmissive = baseEmissive;
      });

      context.bodyGroup.add(object);
      objectsByBodyId.set(body.bodyId, object);
    }

    if (selectedBodyId) {
      const target = objectsByBodyId.get(selectedBodyId);
      const body = bodies.find(
        (candidate) => candidate.bodyId === selectedBodyId
      );
      if (target && body) {
        const box = new THREE.Box3().setFromObject(target);
        if (!box.isEmpty()) {
          const top = box.getCenter(new THREE.Vector3());
          top.y =
            box.max.y + Math.max(box.getSize(new THREE.Vector3()).y * 0.12, 5);
          const label = makeLabel('selection-callout', body.name);
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
      context.controls.update();
      context.hasFitCamera = true;
    }
  }, [bodies, selectedBodyId]);

  useEffect(() => {
    const context = contextRef.current;
    if (context) {
      context.grid.visible = settings.showGrid;
    }
  }, [settings.showGrid]);

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
    context.controls.update();
  }, [fitSignal]);

  return <div className="viewer-host" ref={hostRef} />;
}
