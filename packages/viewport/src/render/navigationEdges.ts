import * as THREE from 'three';
import type { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { EDGE_IDLE_COLOR, EDGE_IDLE_WIDTH } from '../pick/edges';
import type { BodyEdgeOverlay } from './edgeOverlay';
import { nativeEdgeMaterial } from './scene';

const SEVERE_RATIO = 0.75;
const MAX_GPU_BYTES = 4 * 1024 * 1024;
const MAX_BATCHES = 32;
const MIN_SEGMENTS = 256;

interface CachedLines {
  sourceMaterial: LineMaterial;
  sourceVersion: number;
  sourceVertex: string;
  buffer: THREE.InterleavedBuffer;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  drawing: boolean;
  release: () => void;
}
const cache = new Map<LineSegmentsGeometry, CachedLines>();
let allocated = 0;

function batchFor(
  overlay: BodyEdgeOverlay,
  camera: THREE.Camera
): CachedLines | undefined {
  const line = overlay.idleEdges;
  const { geometry, material } = line;
  if (
    geometry.instanceCount < MIN_SEGMENTS ||
    geometry.instanceCount !== overlay.ownershipBySegment.length ||
    !line.layers.test(camera.layers) ||
    !material.visible ||
    material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile ||
    material.onBeforeRender !== THREE.Material.prototype.onBeforeRender ||
    material.clippingPlanes?.length ||
    material.worldUnits ||
    material.dashed ||
    material.vertexColors ||
    material.depthWrite ||
    !material.depthTest ||
    material.depthFunc !== THREE.LessEqualDepth ||
    material.stencilWrite ||
    material.blending !== THREE.NormalBlending ||
    material.linewidth !== EDGE_IDLE_WIDTH ||
    material.color.getHex() !== EDGE_IDLE_COLOR ||
    material.opacity !== 1 ||
    !material.transparent ||
    material.premultipliedAlpha ||
    geometry.drawRange.start !== 0 ||
    geometry.drawRange.count !== Infinity
  )
    return;
  for (
    let object: THREE.Object3D | null = line;
    object;
    object = object.parent
  ) {
    if (!object.visible) return;
  }
  const starts = geometry.getAttribute('instanceStart'),
    ends = geometry.getAttribute('instanceEnd');
  if (
    !(starts instanceof THREE.InterleavedBufferAttribute) ||
    !(ends instanceof THREE.InterleavedBufferAttribute) ||
    starts.data !== ends.data ||
    starts.offset !== 0 ||
    ends.offset !== 3 ||
    starts.data.stride !== 6 ||
    !(starts.data.array instanceof Float32Array) ||
    starts.data.array.length !== geometry.instanceCount * 6 ||
    starts.data.version !== 0 ||
    !geometry.boundingBox
  )
    return;
  // LineMaterial trims segments near the eye before expansion. Retain that
  // path if any biased endpoint could meet the camera's near plane.
  if (!(
    camera instanceof THREE.PerspectiveCamera ||
    camera instanceof THREE.OrthographicCamera
  ))
    return;
  const bias = material.uniforms.depthBias?.value;
  if (!(bias >= 0 && Number.isFinite(bias))) return;
  line.updateWorldMatrix(true, false);
  const view = new THREE.Matrix4().multiplyMatrices(
    camera.matrixWorldInverse,
    line.matrixWorld
  ).elements;
  const { min, max } = geometry.boundingBox;
  const nearestZ =
    view[14] +
    Math.max(view[2] * min.x, view[2] * max.x) +
    Math.max(view[6] * min.y, view[6] * max.y) +
    Math.max(view[10] * min.z, view[10] * max.z);
  if (!(nearestZ + bias < -camera.near)) return;
  const old = cache.get(geometry);
  if (old?.drawing) return;
  if (
    old?.buffer === starts.data &&
    old.sourceMaterial === material &&
    old.sourceVersion === material.version &&
    old.sourceVertex === material.vertexShader &&
    old.material.fragmentShader === material.fragmentShader &&
    old.material.uniforms === material.uniforms &&
    old.material.fog === material.fog &&
    old.material.toneMapped === material.toneMapped
  ) {
    return old;
  }
  old?.release();
  // Keep admissions stable until their source is replaced or disposed. When
  // a near-plane crossing hides one of 33 bodies, its buffer remains ready
  // when it reappears, without evicting the next 31 bodies in draw order.
  const bytes = starts.data.array.byteLength;
  if (cache.size >= MAX_BATCHES || allocated + bytes > MAX_GPU_BYTES) return;
  const ink = nativeEdgeMaterial(material);
  if (!ink) return;
  ink.linewidth = 1 / SEVERE_RATIO; // WebGLRenderer multiplies by canvas DPR.
  const native = new THREE.BufferGeometry();
  native.setAttribute(
    'position',
    new THREE.BufferAttribute(starts.data.array, 3)
  );
  native.boundingBox = geometry.boundingBox;
  native.boundingSphere = geometry.boundingSphere;
  const entry: CachedLines = {
    buffer: starts.data,
    sourceMaterial: material,
    sourceVersion: material.version,
    sourceVertex: material.vertexShader,
    geometry: native,
    material: ink,
    drawing: false,
    release() {
      geometry.removeEventListener('dispose', entry.release);
      cache.delete(geometry);
      allocated -= bytes;
      native.dispose();
      ink.dispose();
    }
  };
  allocated += bytes;
  cache.set(geometry, entry);
  geometry.addEventListener('dispose', entry.release);
  return entry;
}

// WebGLRenderer selects TRIANGLES for a Mesh and LINES for a LineSegments
// using these flags. Keep the same scene object: its id breaks transparent
// sort ties, and its matrix, layer mask, culling volume and render order stay
// authoritative even for coincident edges from different bodies.
interface DrawObject {
  isMesh: boolean;
  isLine?: boolean;
  isLineSegments?: boolean;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/** One physical pixel during severe navigation. Use the normal round stroke
 * for every other draw and restore the complete pickable object on return. */
export function withNavigationEdges(
  overlays: Iterable<BodyEdgeOverlay>,
  camera: THREE.Camera,
  pixelRatio: number,
  draw: () => void
): void {
  if (pixelRatio !== SEVERE_RATIO) {
    draw();
    return;
  }
  camera.updateWorldMatrix(true, false);
  const restore: (() => void)[] = [];
  try {
    for (const overlay of overlays) {
      const entry = batchFor(overlay, camera);
      if (!entry) continue;
      const object: DrawObject = overlay.idleEdges;
      const { geometry, material } = object;
      restore.push(() => {
        object.isMesh = true;
        delete object.isLine;
        delete object.isLineSegments;
        object.geometry = geometry;
        object.material = material;
        entry.drawing = false;
      });
      entry.drawing = true;
      object.geometry = entry.geometry;
      object.material = entry.material;
      object.isMesh = false;
      object.isLine = true;
      object.isLineSegments = true;
    }
    draw();
  } finally {
    for (const reset of restore) reset();
  }
}
