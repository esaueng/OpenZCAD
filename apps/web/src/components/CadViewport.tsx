import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createObjectForBody, fitCameraToObjects } from '@openzcad/viewport';
import type { BodyRepresentation } from '@openzcad/shared';

interface CadViewportProps {
  bodies: BodyRepresentation[];
  selectedBodyId: string | null;
}

export function CadViewport({ bodies, selectedBodyId }: CadViewportProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f1ece1');

    const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.1, 1000);
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

    const objects = bodies.map((body) => {
      const object = createObjectForBody(body);
      if (body.bodyId === selectedBodyId) {
        object.traverse((child: THREE.Object3D) => {
          if (child instanceof THREE.Mesh) {
            child.material = new THREE.MeshStandardMaterial({
              color: '#ff6e4a',
              metalness: 0.2,
              roughness: 0.5
            });
          }
        });
      }
      scene.add(object);
      return object;
    });

    fitCameraToObjects(camera, controls.target, objects);
    controls.update();

    const onResize = () => {
      if (!host) {
        return;
      }
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    };
    window.addEventListener('resize', onResize);

    let animationFrame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, [bodies, selectedBodyId]);

  return <div className="viewport" ref={hostRef} />;
}
