import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { BodyRepresentation, MeshGeometry } from '@openzcad/shared';

function geometryFromMesh(mesh: MeshGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(mesh.vertices, 3)
  );
  geometry.setIndex(mesh.indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Studio PBR body material: a low-metalness base with a tight clearcoat reads
 * like painted machined metal under the environment rig, which is how the
 * shipping CAD programs make solids look "expensive" instead of plasticky.
 */
export function createBodyMaterial(body: BodyRepresentation) {
  return new THREE.MeshPhysicalMaterial({
    color: body.color,
    metalness: 0.1,
    roughness: 0.48,
    clearcoat: 0.32,
    clearcoatRoughness: 0.38,
    envMapIntensity: 0.55,
    specularIntensity: 0.55
  });
}

/**
 * Builds the render object for one body: a studio-shaded mesh plus a subtle
 * feature-edge overlay for the classic CAD look. Body vertices are already
 * in world space (the kernel bakes transforms), so no placement is applied.
 */
export function createObjectForBody(body: BodyRepresentation): THREE.Object3D {
  const geometry = geometryFromMesh(body.mesh);
  const material = createBodyMaterial(body);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = body.name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 24),
    new THREE.LineBasicMaterial({
      color: '#0a0f16',
      transparent: true,
      opacity: 0.55
    })
  );
  edges.raycast = () => undefined; // selection picks faces, not edge lines
  mesh.add(edges);
  return mesh;
}

/**
 * Neutral studio rig baked to a PMREM environment map. One RoomEnvironment
 * render at startup gives every standard material soft studio reflections —
 * the single biggest step away from the flat "janky" WebGL look.
 */
export function createStudioEnvironment(
  renderer: THREE.WebGLRenderer
): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04);
  pmrem.dispose();
  return texture.texture;
}

/** Vertical engineering-studio gradient: graphite above, near-black below. */
export function createGradientBackground(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, '#131922');
  gradient.addColorStop(0.45, '#0b0f15');
  gradient.addColorStop(1, '#05070a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Construction-plane grid drawn in a fragment shader: anti-aliased minor and
 * major lines with a radial falloff, so the floor reads as an infinite
 * engineering plane instead of a hard-edged helper cage. Lies in the Z-up XY
 * plane, a whisker below z=0 to avoid z-fighting with grounded bottom faces.
 */
export function createStudioGrid(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(640, 640);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      minorStep: { value: 10 },
      majorStep: { value: 50 },
      minorColor: { value: new THREE.Color('#3d5073') },
      majorColor: { value: new THREE.Color('#5c78ac') },
      axisXColor: { value: new THREE.Color('#6d4757') },
      axisYColor: { value: new THREE.Color('#456352') },
      fadeRadius: { value: 300 }
    },
    vertexShader: /* glsl */ `
      varying vec2 worldXY;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        worldXY = world.xy;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 worldXY;
      uniform float minorStep;
      uniform float majorStep;
      uniform vec3 minorColor;
      uniform vec3 majorColor;
      uniform vec3 axisXColor;
      uniform vec3 axisYColor;
      uniform float fadeRadius;

      float gridLine(vec2 p, float step) {
        vec2 coord = p / step;
        vec2 grid = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
        return 1.0 - min(min(grid.x, grid.y), 1.0);
      }

      void main() {
        float minor = gridLine(worldXY, minorStep) * 0.6;
        float major = gridLine(worldXY, majorStep);
        // Axis lines: X line runs along X at y=0, Y line along Y at x=0.
        float axisX = 1.0 - min(abs(worldXY.y) / (fwidth(worldXY.y) * 1.2 + 0.4), 1.0);
        float axisY = 1.0 - min(abs(worldXY.x) / (fwidth(worldXY.x) * 1.2 + 0.4), 1.0);
        float fade = 1.0 - smoothstep(fadeRadius * 0.55, fadeRadius, length(worldXY));
        vec3 color = minorColor;
        float alpha = minor * 0.7;
        color = mix(color, majorColor, major);
        alpha = max(alpha, major);
        color = mix(color, axisXColor, axisX);
        alpha = max(alpha, axisX);
        color = mix(color, axisYColor, axisY);
        alpha = max(alpha, axisY);
        if (alpha * fade < 0.004) discard;
        gl_FragColor = vec4(color, alpha * fade);
      }
    `
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = 0; // PlaneGeometry is already XY; grid lives at z≈0.
  mesh.position.z = -0.02;
  mesh.name = 'studio-grid';
  mesh.raycast = () => undefined;
  return mesh;
}

/** Invisible floor that only receives soft shadows, grounding the model. */
export function createShadowCatcher(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.ShadowMaterial({ color: '#000000', opacity: 0.55 })
  );
  mesh.position.z = -0.05;
  mesh.receiveShadow = true;
  mesh.name = 'shadow-catcher';
  mesh.raycast = () => undefined;
  return mesh;
}

/** Configures the key light's shadow frustum for a model of `radius` size. */
export function tuneShadowFrustum(light: THREE.DirectionalLight, radius: number) {
  const extent = Math.max(radius * 2.2, 40);
  const { camera } = light.shadow;
  camera.left = -extent;
  camera.right = extent;
  camera.top = extent;
  camera.bottom = -extent;
  camera.near = 1;
  camera.far = extent * 6;
  camera.updateProjectionMatrix();
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.bias = -0.0002;
  light.shadow.normalBias = 0.02;
  light.shadow.radius = 5;
}

export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  near: number;
  far: number;
}

/** Computes the Z-up isometric fit pose without touching the live camera. */
export function computeFitPose(
  camera: THREE.PerspectiveCamera,
  objects: THREE.Object3D[]
): CameraPose {
  const box = new THREE.Box3();
  for (const object of objects) {
    box.expandByObject(object);
  }
  if (box.isEmpty()) {
    return {
      position: new THREE.Vector3(80, -80, 80),
      target: new THREE.Vector3(0, 0, 0),
      near: 0.1,
      far: 2000
    };
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const distance = (maxDim / 2 / Math.tan(halfFov)) * 2.1;
  // Right, front, above — matching the historical fit direction.
  const direction = new THREE.Vector3(1, -1, 0.9).normalize();
  return {
    position: center.clone().addScaledVector(direction, distance),
    target: center,
    near: Math.max(distance / 1000, 0.05),
    far: distance * 12 + maxDim * 4
  };
}

export function fitCameraToObjects(
  camera: THREE.PerspectiveCamera,
  controlsTarget: THREE.Vector3,
  objects: THREE.Object3D[]
) {
  const pose = computeFitPose(camera, objects);
  camera.position.copy(pose.position);
  controlsTarget.copy(pose.target);
  camera.near = pose.near;
  camera.far = pose.far;
  camera.updateProjectionMatrix();
}
