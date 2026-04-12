import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createObjectForBody, fitCameraToObjects } from '@openzcad/viewport';
import type { BodyRepresentation } from '@openzcad/shared';
import type { ViewPreset } from '../lib/view';

interface CadViewportProps {
  bodies: BodyRepresentation[];
  selectedBodyId: string | null;
  viewPreset: ViewPreset;
  fitToken: number;
  onViewPresetChange(preset: ViewPreset): void;
}

export function CadViewport({
  bodies,
  selectedBodyId,
  viewPreset,
  fitToken,
  onViewPresetChange
}: CadViewportProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#202833');

    const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.1, 1000);
    camera.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.screenSpacePanning = true;
    controls.target.set(0, 0, 0);

    const hemi = new THREE.HemisphereLight('#8cb5d4', '#0c1117', 1.1);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight('#ffffff', 1.5);
    dir.position.set(120, 90, 120);
    scene.add(dir);
    scene.add(new THREE.AxesHelper(72));

    const grid = new THREE.GridHelper(260, 26, '#47596b', '#2a343e');
    grid.rotateX(Math.PI / 2);
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

    const applyViewPreset = (preset: ViewPreset) => {
      const box = new THREE.Box3();
      for (const object of objects) {
        box.expandByObject(object);
      }

      if (box.isEmpty()) {
        fitCameraToObjects(camera, controls.target, objects);
        return;
      }

      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const distance = Math.max(size.x, size.y, size.z, 16) * 2.35;

      const direction =
        preset === 'top'
          ? new THREE.Vector3(0, 0, 1)
          : preset === 'front'
            ? new THREE.Vector3(0, -1, 0.4)
            : preset === 'right'
              ? new THREE.Vector3(1, -0.24, 0.32)
              : new THREE.Vector3(1, -1, 0.78).normalize();

      camera.position.copy(center.clone().add(direction.normalize().multiplyScalar(distance)));
      controls.target.copy(center);
      camera.near = 0.1;
      camera.far = distance * 20;
      camera.updateProjectionMatrix();
      controls.update();
    };

    applyViewPreset(viewPreset);

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
  }, [bodies, selectedBodyId, viewPreset, fitToken]);

  return (
    <div className="viewport-shell">
      <div className="viewport" ref={hostRef} />

      <div className="viewport-overlay viewport-overlay--top">
        <div className="view-dock">
          <button
            className={`view-dock__button ${viewPreset === 'top' ? 'is-active' : ''}`}
            onClick={() => onViewPresetChange('top')}
          >
            Top
          </button>
          <button
            className={`view-dock__button ${viewPreset === 'front' ? 'is-active' : ''}`}
            onClick={() => onViewPresetChange('front')}
          >
            Front
          </button>
          <button
            className={`view-dock__button ${viewPreset === 'right' ? 'is-active' : ''}`}
            onClick={() => onViewPresetChange('right')}
          >
            Right
          </button>
          <button
            className={`view-dock__button ${viewPreset === 'iso' ? 'is-active' : ''}`}
            onClick={() => onViewPresetChange('iso')}
          >
            Iso
          </button>
        </div>
      </div>

      <div className="viewport-overlay viewport-overlay--bottom">
        <div className="axis-widget">
          <button className="axis-widget__button axis-widget__button--x" onClick={() => onViewPresetChange('right')}>
            +X
          </button>
          <button className="axis-widget__button axis-widget__button--y" onClick={() => onViewPresetChange('front')}>
            +Y
          </button>
          <button className="axis-widget__button axis-widget__button--z" onClick={() => onViewPresetChange('top')}>
            +Z
          </button>
          <button className="axis-widget__button axis-widget__button--iso" onClick={() => onViewPresetChange('iso')}>
            ISO
          </button>
        </div>
        <p className="viewport-hint">Orbit with drag. Use XYZ snap buttons to orient the camera.</p>
      </div>
    </div>
  );
}
