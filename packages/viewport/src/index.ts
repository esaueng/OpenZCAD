import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type {
  BodyRepresentation,
  BodyTopology,
  MeshGeometry
} from '@openzcad/shared';

const CAD_CREASE_ANGLE = THREE.MathUtils.degToRad(30);
const DOT_EPSILON = 1e-10;

interface MeshFace {
  normal: THREE.Vector3;
  cornerAngles: [number, number, number];
}

interface MeshEdge {
  start: number;
  end: number;
  faces: number[];
}

function cornerAngle(
  center: THREE.Vector3,
  first: THREE.Vector3,
  second: THREE.Vector3
): number {
  const firstDirection = first.clone().sub(center);
  const secondDirection = second.clone().sub(center);
  const crossLength = firstDirection.cross(secondDirection).length();
  const dot = first.clone().sub(center).dot(second.clone().sub(center));
  return Math.atan2(crossLength, dot);
}

/**
 * Builds angle-weighted smoothing groups from triangle adjacency. Adjacent
 * triangles share a render vertex only when their dihedral angle is below the
 * CAD crease threshold, so large planar faces cannot borrow normals from their
 * side walls while cylinders and fillets remain visually smooth.
 */
function geometryFromMesh(
  mesh: MeshGeometry,
  topology?: BodyTopology
): THREE.BufferGeometry {
  const sourcePositions = mesh.vertices;
  const sourceIndices = mesh.indices;
  const triangleCount = Math.floor(sourceIndices.length / 3);
  const topologyFaceByTriangle = new Int32Array(triangleCount);
  topologyFaceByTriangle.fill(-1);
  for (const [topologyFaceIndex, face] of (topology?.faces ?? []).entries()) {
    const start = Math.max(0, Math.floor(face.triangleStart));
    const end = Math.min(
      triangleCount,
      Math.ceil(face.triangleStart + face.triangleCount)
    );
    for (let triangleIndex = start; triangleIndex < end; triangleIndex += 1) {
      topologyFaceByTriangle[triangleIndex] = topologyFaceIndex;
    }
  }
  const faces: MeshFace[] = [];
  const edges = new Map<string, MeshEdge>();

  for (let faceIndex = 0; faceIndex < triangleCount; faceIndex += 1) {
    const cornerOffset = faceIndex * 3;
    const indices = [
      sourceIndices[cornerOffset]!,
      sourceIndices[cornerOffset + 1]!,
      sourceIndices[cornerOffset + 2]!
    ] as const;
    const points = indices.map((index) =>
      new THREE.Vector3().fromArray(sourcePositions, index * 3)
    ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    const normal = new THREE.Vector3()
      .subVectors(points[1], points[0])
      .cross(new THREE.Vector3().subVectors(points[2], points[0]))
      .normalize();
    faces.push({
      normal,
      cornerAngles: [
        cornerAngle(points[0], points[1], points[2]),
        cornerAngle(points[1], points[2], points[0]),
        cornerAngle(points[2], points[0], points[1])
      ]
    });

    for (const [start, end] of [
      [indices[0], indices[1]],
      [indices[1], indices[2]],
      [indices[2], indices[0]]
    ] as const) {
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      const key = `${low}:${high}`;
      const edge = edges.get(key) ?? { start: low, end: high, faces: [] };
      edge.faces.push(faceIndex);
      edges.set(key, edge);
    }
  }

  const parent = sourceIndices.map((_, cornerIndex) => cornerIndex);
  const rank = sourceIndices.map(() => 0);
  const find = (cornerIndex: number): number => {
    let root = cornerIndex;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    let current = cornerIndex;
    while (parent[current] !== current) {
      const next = parent[current]!;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) {
      return;
    }
    if (rank[leftRoot]! < rank[rightRoot]!) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    parent[rightRoot] = leftRoot;
    if (rank[leftRoot] === rank[rightRoot]) {
      rank[leftRoot] = rank[leftRoot]! + 1;
    }
  };
  const cornerForVertex = (faceIndex: number, vertexIndex: number) => {
    const offset = faceIndex * 3;
    for (let corner = offset; corner < offset + 3; corner += 1) {
      if (sourceIndices[corner] === vertexIndex) {
        return corner;
      }
    }
    return null;
  };

  const creaseDot = Math.cos(CAD_CREASE_ANGLE);
  for (const edge of edges.values()) {
    // Non-manifold edges stay creased; smoothing across more than two incident
    // faces can blend unrelated shells that merely share indexed vertices.
    if (edge.faces.length !== 2) {
      continue;
    }
    const [firstFaceIndex, secondFaceIndex] = edge.faces as [number, number];
    const firstFace = faces[firstFaceIndex]!;
    const secondFace = faces[secondFaceIndex]!;
    const firstTopologyFace = topologyFaceByTriangle[firstFaceIndex]!;
    const secondTopologyFace = topologyFaceByTriangle[secondFaceIndex]!;
    const hasTopologyFace = firstTopologyFace >= 0 || secondTopologyFace >= 0;
    const shouldSmooth = hasTopologyFace
      ? firstTopologyFace >= 0 && firstTopologyFace === secondTopologyFace
      : firstFace.normal.dot(secondFace.normal) + DOT_EPSILON >= creaseDot;
    if (!shouldSmooth) {
      continue;
    }
    for (const vertexIndex of [edge.start, edge.end]) {
      const firstCorner = cornerForVertex(firstFaceIndex, vertexIndex);
      const secondCorner = cornerForVertex(secondFaceIndex, vertexIndex);
      if (firstCorner !== null && secondCorner !== null) {
        union(firstCorner, secondCorner);
      }
    }
  }

  const normalsByGroup = new Map<number, THREE.Vector3>();
  for (
    let cornerIndex = 0;
    cornerIndex < sourceIndices.length;
    cornerIndex += 1
  ) {
    const root = find(cornerIndex);
    const faceIndex = Math.floor(cornerIndex / 3);
    const face = faces[faceIndex]!;
    const angle = face.cornerAngles[cornerIndex % 3]!;
    const contribution = face.normal.clone().multiplyScalar(angle);
    const accumulated = normalsByGroup.get(root) ?? new THREE.Vector3();
    accumulated.add(contribution);
    normalsByGroup.set(root, accumulated);
  }

  const vertices: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const outputIndexByGroup = new Map<number, number>();
  for (
    let cornerIndex = 0;
    cornerIndex < sourceIndices.length;
    cornerIndex += 1
  ) {
    const root = find(cornerIndex);
    let outputIndex = outputIndexByGroup.get(root);
    if (outputIndex === undefined) {
      outputIndex = vertices.length / 3;
      outputIndexByGroup.set(root, outputIndex);
      const sourceIndex = sourceIndices[cornerIndex]!;
      vertices.push(
        sourcePositions[sourceIndex * 3]!,
        sourcePositions[sourceIndex * 3 + 1]!,
        sourcePositions[sourceIndex * 3 + 2]!
      );
      const normal = normalsByGroup.get(root)!.normalize();
      normals.push(normal.x, normal.y, normal.z);
    }
    indices.push(outputIndex);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Classic CAD body material. Phong gives planar faces an even technical shade
 * and broad highlights on curves without environment-map reflections crawling
 * across tessellation triangles.
 */
export function createBodyMaterial(body: BodyRepresentation) {
  return new THREE.MeshPhongMaterial({
    color: body.color,
    shininess: 38,
    specular: '#667487',
    // STEP tessellators can preserve the exact closed B-rep while emitting
    // individual face triangles with mixed winding. A front-side-only
    // material then drops those faces even though the independent topology
    // edge overlay remains, making a valid imported solid look like broken
    // wireframe. Render imported STEP faces from both sides; Three.js flips
    // the lighting normal for back-facing fragments so the result stays
    // shaded instead of merely bypassing the cull.
    side: body.source === 'imported-step' ? THREE.DoubleSide : THREE.FrontSide
  });
}

/**
 * Builds the render object for one body: a studio-shaded mesh plus a subtle
 * feature-edge overlay for the classic CAD look. Body vertices are already
 * in world space (the kernel bakes transforms), so no placement is applied.
 */
export function createObjectForBody(body: BodyRepresentation): THREE.Object3D {
  const geometry = geometryFromMesh(body.mesh, body.topology);
  const material = createBodyMaterial(body);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = body.name;
  mesh.castShadow = true;
  // CAD solids cast onto the ground plane but do not receive the shadow map.
  // Self-shadowing on long tessellation triangles creates false triangular
  // bands across otherwise planar analytic faces.
  mesh.receiveShadow = false;

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 24),
    new THREE.LineBasicMaterial({
      color: '#0a0f16',
      transparent: true,
      opacity: 0.78
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

/**
 * Z-up studio fill. The cool ground colour acts as bounced floor light so
 * downward-facing surfaces stay legible without flattening the key light.
 */
export function createStudioHemisphereLight(): THREE.HemisphereLight {
  const light = new THREE.HemisphereLight('#d7e6f7', '#e2e8f0', 0.45);
  light.position.set(0, 0, 1);
  return light;
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
export function tuneShadowFrustum(
  light: THREE.DirectionalLight,
  radius: number
) {
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
