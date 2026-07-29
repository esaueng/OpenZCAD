import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
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

/** Viewport size in CSS pixels; fat-line widths are expressed in the same unit. */
export interface FatLineResolution {
  width: number;
  height: number;
}

export interface FatLineOptions {
  color: THREE.ColorRepresentation;
  /** Width in CSS pixels. Screen-space, so it survives camera zoom. */
  linewidth: number;
  opacity?: number;
  depthTest?: boolean;
  /**
   * Overlay lines normally test the solid depth buffer without modifying it.
   * Opt in only for geometry that must occlude later transparent passes.
   */
  depthWrite?: boolean;
  /** Viewport size the shader rasterizes against; keep it in sync on resize. */
  resolution?: FatLineResolution;
}

/**
 * Stable CAD viewport hierarchy for coincident display geometry.
 *
 * Model geometry stays untouched: solid faces populate the depth buffer, then
 * depth-aware line overlays resolve same-location representations by policy.
 */
export const VIEWPORT_RENDER_ORDER = {
  BODY_FACE: 0,
  BODY_EDGE: 8,
  SKETCH_FILL: 9,
  SKETCH_CURVE: 10,
  HOVER_HIGHLIGHT: 15,
  SELECTED_GEOMETRY: 16,
  ACTIVE_SKETCH: 20
} as const;

/**
 * Shared material for every screen-space polyline in the viewport.
 *
 * WebGL's native line primitive is locked to a single device pixel and picks
 * up almost nothing from the framebuffer's MSAA, so it staircases badly on
 * curves — a sketch circle came out as one hard pixel with no falloff at all.
 * Line2 draws the line as a quad instead, whose long edges MSAA does resolve,
 * which is where the antialiasing actually comes from.
 *
 * `alphaToCoverage` only reaches the shader's rounded endcaps; measured across
 * a body edge it leaves the line body byte-for-byte identical. It is on because
 * the caps are otherwise hard-clipped, not because it smooths the length.
 */
export function createFatLineMaterial(options: FatLineOptions): LineMaterial {
  const material = new LineMaterial({
    color: options.color,
    linewidth: options.linewidth,
    transparent: true,
    alphaToCoverage: true,
    opacity: options.opacity ?? 1,
    depthTest: options.depthTest ?? true,
    // Body edges, sketches, and highlights can be coincident. Let the opaque
    // face depth buffer preserve occlusion, but never let one overlay's
    // independently tessellated quad mask another overlay drawn later.
    depthWrite: options.depthWrite ?? false
  });
  material.resolution.set(
    Math.max(options.resolution?.width ?? 1, 1),
    Math.max(options.resolution?.height ?? 1, 1)
  );
  return material;
}

/**
 * Antialiased polyline through `points`. Closed profiles repeat their first
 * point rather than using LineLoop, which has no fat-line equivalent.
 */
export function createFatLine(
  points: THREE.Vector3[],
  options: FatLineOptions & { closed?: boolean }
): Line2 {
  const vertices =
    options.closed && points.length > 2 ? [...points, points[0]!] : points;
  const geometry = new LineGeometry();
  geometry.setPositions(
    vertices.flatMap((point) => [point.x, point.y, point.z])
  );
  const line = new Line2(geometry, createFatLineMaterial(options));
  line.computeLineDistances();
  return line;
}

/** Antialiased disjoint segments from flat xyz pairs (two points per segment). */
export function createFatLineSegments(
  positions: ArrayLike<number>,
  options: FatLineOptions
): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(Array.from(positions));
  const segments = new LineSegments2(geometry, createFatLineMaterial(options));
  segments.computeLineDistances();
  return segments;
}

/**
 * Refreshes every fat line under `root` after a resize. Fat-line widths are in
 * CSS pixels, so the shader needs the viewport size; a registry of materials
 * would have to be kept in sync by hand at each creation site, and the body
 * rebuild used to clear one out from under the handle rigs.
 */
export function syncFatLineResolution(
  root: THREE.Object3D,
  width: number,
  height: number
) {
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);
  root.traverse((child: THREE.Object3D) => {
    if (child instanceof LineSegments2) {
      child.material.resolution.set(safeWidth, safeHeight);
    }
  });
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
    // Push only the disposable face rasterization back by the smallest
    // practical depth-buffer bias. GL line materials ignore polygonOffset;
    // keeping the bias on the faces lets depth-tested edge/sketch overlays sit
    // stably on their exact model plane without moving authoritative geometry.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    // Exact kernels emit consistently oriented closed faces. Keep culling on
    // so an orientation regression remains visible instead of being hidden by
    // a double-sided material.
    side: THREE.FrontSide
  });
}

/**
 * Builds the render object for one body: a studio-shaded mesh plus a subtle
 * feature-edge overlay for the classic CAD look. Body vertices are already
 * in world space (the kernel bakes transforms), so no placement is applied.
 *
 * The overlay is a fallback only. Bodies that carry B-rep topology get their
 * edges from the exact curves instead (the viewer draws one fat line per
 * topology edge), and drawing both put two lines along nearly — but not
 * exactly — the same path. Bodies from the compat kernel, which the AI preview
 * uses, have no topology at all, so tessellated feature edges remain their
 * only outline.
 */
export function createObjectForBody(
  body: BodyRepresentation,
  resolution?: FatLineResolution
): THREE.Object3D {
  const geometry = geometryFromMesh(body.mesh, body.topology);
  const material = createBodyMaterial(body);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = body.name;
  mesh.renderOrder = VIEWPORT_RENDER_ORDER.BODY_FACE;
  mesh.castShadow = true;
  // CAD solids cast onto the ground plane but do not receive the shadow map.
  // Self-shadowing on long tessellation triangles creates false triangular
  // bands across otherwise planar analytic faces.
  mesh.receiveShadow = false;

  if (!body.topology?.edges.length) {
    const featureEdges = new THREE.EdgesGeometry(geometry, 24);
    const edges = createFatLineSegments(
      featureEdges.getAttribute('position').array,
      {
        color: '#0a0f16',
        linewidth: 1.4,
        opacity: 0.78,
        resolution
      }
    );
    featureEdges.dispose();
    edges.raycast = () => undefined; // selection picks faces, not edge lines
    edges.name = 'body-edge';
    edges.renderOrder = VIEWPORT_RENDER_ORDER.BODY_EDGE;
    mesh.add(edges);
  }
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

/**
 * Origin axis triad. THREE.AxesHelper draws native GL lines, which are stuck
 * at one hard device pixel; these are fat lines for the same reason every
 * other viewport polyline is. Picking stays off — the triad is decoration, and
 * Line2 raycasts against a screen-space radius that would make it an easy
 * accidental hit where the thin native lines were practically unhittable.
 */
export function createAxesGizmo(
  size: number,
  resolution?: FatLineResolution
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'axes';
  const axes = [
    { direction: new THREE.Vector3(size, 0, 0), color: '#ff0000' },
    { direction: new THREE.Vector3(0, size, 0), color: '#00ff00' },
    { direction: new THREE.Vector3(0, 0, size), color: '#0000ff' }
  ];
  for (const axis of axes) {
    const line = createFatLine([new THREE.Vector3(), axis.direction], {
      color: axis.color,
      linewidth: 1.6,
      opacity: 0.55,
      resolution
    });
    line.raycast = () => undefined;
    group.add(line);
  }
  return group;
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

/**
 * The horizontal shadow catcher grounds oblique views, but looking almost
 * straight down turns it into a large dark duplicate behind the model.
 */
export function shouldShowGroundShadow(
  camera: THREE.Camera,
  showGrid: boolean
): boolean {
  if (!showGrid) {
    return false;
  }
  const direction = camera.getWorldDirection(new THREE.Vector3());
  return Math.abs(direction.z) < 0.92;
}

/**
 * Configures the key light's shadow frustum for a model of `radius` size.
 *
 * Blockiness in the penumbra is a texel-density problem. three's PCF sampler
 * takes only five Vogel-disk taps and rotates the pattern per pixel with
 * interleaved gradient noise, so a wide `radius` spreads those few taps thin
 * and the dither reads as chunky squares once the camera is close enough to
 * magnify shadow texels. The fix is more texels over less world space and a
 * tighter disk, not a wider blur.
 */
export function tuneShadowFrustum(
  light: THREE.DirectionalLight,
  radius: number
) {
  // 1.6 still clears the cast shadow of a model lit from above and to the side,
  // and covers 1.9x less area than 2.2 did — every texel gets that much finer.
  const extent = Math.max(radius * 1.6, 40);
  const { camera } = light.shadow;
  camera.left = -extent;
  camera.right = extent;
  camera.top = extent;
  camera.bottom = -extent;
  camera.near = 1;
  camera.far = extent * 6;
  camera.updateProjectionMatrix();
  // 3072 rather than 4096: with the tighter frustum this still lands about 2x
  // finer than the old 2048, at roughly half the shadow-texture memory of a
  // 4096 map.
  light.shadow.mapSize.set(3072, 3072);
  light.shadow.bias = -0.0002;
  light.shadow.normalBias = 0.02;
  light.shadow.radius = 3;
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
