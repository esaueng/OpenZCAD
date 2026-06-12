import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createObjectForBody, fitCameraToObjects } from '@openzcad/viewport';
import type { BodyRepresentation } from '@openzcad/shared';

interface CadViewportProps {
  bodies: BodyRepresentation[];
  selectedBodyId: string | null;
}

interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  bodyGroup: THREE.Group;
  hasFitCamera: boolean;
}

type DisposableMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;

function disposeObject(object: THREE.Object3D) {
  object.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.Mesh) {
      const mesh = child as DisposableMesh;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        for (const entry of mesh.material) {
          entry.dispose();
        }
      } else {
        mesh.material.dispose();
      }
    }
  });
}

function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function applySelectionMaterial(object: THREE.Object3D) {
  object.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.Mesh) {
      const mesh = child as DisposableMesh;
      if (!Array.isArray(mesh.material)) {
        mesh.material.dispose();
      }
      mesh.material = new THREE.MeshStandardMaterial({
        color: '#ff6e4a',
        metalness: 0.2,
        roughness: 0.5
      });
    }
  });
}

export function CadViewport({ bodies, selectedBodyId }: CadViewportProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<SceneContext | null>(null);

  // Scene, renderer, controls, and render loop are created once per mount;
  // recreating the WebGL context on every document change churned GPU
  // resources and reset the user's camera on every edit.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f1ece1');

    const aspect = host.clientWidth / Math.max(host.clientHeight, 1);
    const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
    camera.position.set(80, 80, 80);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    const hemi = new THREE.HemisphereLight('#fff6dd', '#67491c', 1.4);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight('#ffffff', 1.2);
    dir.position.set(80, 120, 90);
    scene.add(dir);

    const grid = new THREE.GridHelper(240, 24, '#b18147', '#dcc6a5');
    scene.add(grid);

    const bodyGroup = new THREE.Group();
    bodyGroup.name = 'bodies';
    scene.add(bodyGroup);

    contextRef.current = {
      scene,
      camera,
      renderer,
      controls,
      bodyGroup,
      hasFitCamera: false
    };

    const observer = new ResizeObserver(() => {
      camera.aspect = host.clientWidth / Math.max(host.clientHeight, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    });
    observer.observe(host);

    let animationFrame = window.requestAnimationFrame(function animate() {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      clearGroup(bodyGroup);
      grid.dispose();
      controls.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      contextRef.current = null;
    };
  }, []);

  // Rebuild only the body objects when the derived geometry or selection
  // changes; the camera keeps the user's orbit position after the first fit.
  useEffect(() => {
    const context = contextRef.current;
    if (!context) {
      return;
    }

    clearGroup(context.bodyGroup);
    const objects = bodies.map((body) => {
      const object = createObjectForBody(body);
      if (body.bodyId === selectedBodyId) {
        applySelectionMaterial(object);
      }
      context.bodyGroup.add(object);
      return object;
    });

    if (!context.hasFitCamera && objects.length > 0) {
      fitCameraToObjects(context.camera, context.controls.target, objects);
      context.controls.update();
      context.hasFitCamera = true;
    }
  }, [bodies, selectedBodyId]);

  return <div className="viewport" ref={hostRef} />;
}
