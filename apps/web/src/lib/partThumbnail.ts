import * as THREE from 'three';
import type { BodyRepresentation } from '@openzcad/shared';
import {
  VIEW_DIRECTIONS,
  clearGroup,
  createFatLine,
  createObjectForBody,
  shouldRenderTopologyEdge
} from '@openzcad/viewport';

const THUMBNAIL_WIDTH = 360;
const THUMBNAIL_HEIGHT = 200;
const THUMBNAIL_FOV = 34;
/**
 * How much room the part leaves around itself, as a multiple of the distance
 * that would have it touch the nearer pair of frustum walls. Just over 1 so a
 * tile reads as a part on a card rather than a part pressed against its edges.
 */
const THUMBNAIL_MARGIN = 1.06;

/**
 * Browsers keep WebGL contexts alive for a while after disposal. Rendering the
 * cards serially prevents an expanded parts grid from briefly creating enough
 * contexts to evict the live CAD viewport.
 */
let previewQueue: Promise<void> = Promise.resolve();

/**
 * Runs preview work — including whatever the caller has to read to do it — one
 * job at a time. Loading a project document belongs inside the job rather than
 * around it: filling an expanded shelf's worth of tiles then costs one document
 * held at a time instead of one per tile.
 */
export function queuePartThumbnail<T>(work: () => Promise<T> | T): Promise<T> {
  const result = previewQueue.catch(() => undefined).then(work);
  previewQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Poses the card's camera on the part: the same Z-up frame and the same iso
 * direction the viewport's Fit lands on, so a tile is recognisably the view
 * the part opens in.
 */
export function createThumbnailCamera(
  bounds: THREE.Box3
): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    THUMBNAIL_FOV,
    THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT,
    0.05,
    10_000
  );
  // Model space is Z-up, so the card's camera has to be too. Three.js cameras
  // default to Y-up and `lookAt` derives its roll from `up`: left at the
  // default, every tile came out tipped onto a corner, showing the part in an
  // orientation the viewport never puts it in.
  camera.up.set(0, 0, 1);

  const sphere = bounds.isEmpty()
    ? new THREE.Sphere(new THREE.Vector3(), 1)
    : bounds.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.001);
  // Frame the bounding sphere against the narrower of the two fields of view,
  // not the vertical one alone: the card is wider than it is tall, so a part
  // that clears the top and bottom can still run off the sides.
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov =
    2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const distance =
    (radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) *
    THUMBNAIL_MARGIN;

  camera.position
    .copy(sphere.center)
    .addScaledVector(VIEW_DIRECTIONS.iso, distance);
  // Both planes scale with the part rather than sitting at fixed millimetre
  // distances: a part measured in microns would otherwise fall entirely behind
  // a hard-coded near plane, and the tight ratio this gives buys depth
  // precision that a 1/1000th near plane spends for nothing.
  camera.near = Math.max(distance - radius * 2, distance / 1000);
  camera.far = distance + radius * 4;
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
  return camera;
}

/**
 * Draws the card. Synchronous and unqueued so a caller that had to load
 * something first can hold a single queue slot for the whole job; reach for
 * {@link renderPartThumbnail} when the meshes are already to hand.
 */
export function renderThumbnailFrame(
  bodies: BodyRepresentation[]
): string | null {
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

    const bounds = new THREE.Box3();
    for (const object of bodyGroup.children) {
      bounds.expandByObject(object);
    }
    const camera = createThumbnailCamera(bounds);

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
  return queuePartThumbnail(() => renderThumbnailFrame(bodies));
}
