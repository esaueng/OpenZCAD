import * as THREE from 'three';
import type { BodyRepresentation } from '@openzcad/shared';
import {
  clearGroup,
  computeFitPose,
  createFatLine,
  createObjectForBody,
  shouldRenderTopologyEdge
} from '@openzcad/viewport';

const THUMBNAIL_WIDTH = 360;
const THUMBNAIL_HEIGHT = 200;

/**
 * Browsers keep WebGL contexts alive for a while after disposal. Rendering the
 * cards serially prevents an expanded parts grid from briefly creating enough
 * contexts to evict the live CAD viewport.
 */
let renderQueue: Promise<void> = Promise.resolve();

function renderThumbnailNow(bodies: BodyRepresentation[]): string | null {
  const visibleBodies = bodies.filter(
    (body) =>
      !body.consumed &&
      body.mesh.vertices.length >= 9 &&
      body.mesh.indices.length >= 3
  );
  if (visibleBodies.length === 0) {
    return null;
  }

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'low-power',
    preserveDrawingBuffer: true
  });
  const scene = new THREE.Scene();
  const bodyGroup = new THREE.Group();

  try {
    renderer.setPixelRatio(1);
    renderer.setSize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, false);
    renderer.setClearColor('#05080c', 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;

    scene.add(bodyGroup);
    scene.add(new THREE.HemisphereLight('#d7e6f7', '#28384b', 1.25));

    const keyLight = new THREE.DirectionalLight('#ffffff', 2.4);
    keyLight.position.set(80, -100, 140);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight('#6daeff', 0.9);
    rimLight.position.set(-80, 70, 50);
    scene.add(rimLight);

    const resolution = {
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT
    };
    for (const body of visibleBodies) {
      const object = createObjectForBody(body, resolution);
      for (const edge of body.topology?.edges ?? []) {
        if (!shouldRenderTopologyEdge(edge)) {
          continue;
        }
        const points: THREE.Vector3[] = [];
        for (let index = 0; index + 2 < edge.points.length; index += 3) {
          points.push(
            new THREE.Vector3(
              edge.points[index],
              edge.points[index + 1],
              edge.points[index + 2]
            )
          );
        }
        if (points.length < 2) {
          continue;
        }
        const line = createFatLine(points, {
          color: '#162437',
          linewidth: 1.25,
          opacity: 0.92,
          resolution
        });
        line.name = 'thumbnail-edge';
        object.add(line);
      }
      bodyGroup.add(object);
    }

    const camera = new THREE.PerspectiveCamera(
      34,
      THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT,
      0.05,
      10_000
    );
    const pose = computeFitPose(camera, bodyGroup.children);
    const fittedOffset = pose.position
      .clone()
      .sub(pose.target)
      .multiplyScalar(0.68);
    camera.position.copy(pose.target).add(fittedOffset);
    camera.near = Math.max(pose.near * 0.5, 0.01);
    camera.far = pose.far;
    camera.lookAt(pose.target);
    camera.updateProjectionMatrix();

    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/webp', 0.86);
  } finally {
    clearGroup(bodyGroup);
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

/**
 * Builds a disposable image projection from saved derived meshes. The
 * ProjectDocument remains canonical; this result is only a card-sized cache.
 */
export function renderPartThumbnail(
  bodies: BodyRepresentation[]
): Promise<string | null> {
  const result = renderQueue
    .catch(() => undefined)
    .then(() => renderThumbnailNow(bodies));
  renderQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
