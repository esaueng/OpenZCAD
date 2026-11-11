import * as THREE from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { sectionCapGeometry } from '../scene/sectionCaps';
import {
  createFatLineSegments,
  drawFatLineOncePerPixel,
  fatLineDepthBiasForExtent,
  TRANSLUCENT_LINE_STENCIL,
  type FatLineResolution
} from '../render/scene';

// The original shape is a quiet reference behind the live solid, not another
// selected body. In particular, an inward offset must not leave a bright
// cyan copy of the face floating over its new position. On the graphite
// stage it still has to read as a shape: a light, lit, frosted fill with a
// clean outline, not a dark smudge.
const GHOST_COLOR = 0xc3c9d4;
const GHOST_OPACITY = 0.32;
const GHOST_FACE_OPACITY = 0.14;
// Pulled material sits over the solid's old end and the ground beneath it,
// not open stage: a little more body keeps it frosted rather than smoked.
const VEIL_OPACITY = 0.5;
const GHOST_EDGE_COLOR = 0xe2e6ee;
const GHOST_EDGE_OPACITY = 0.62;
const GHOST_EDGE_WIDTH = 1.6;
// Where the part used to end. On a pull the old face lies inside the new
// solid and its rim on the solid's surface: this is the one ghost line meant
// to draw over the live part, so the old extent stays readable.
const OLD_FACE_OUTLINE_OPACITY = 0.7;
const OLD_FACE_OUTLINE_WIDTH = 1.4;

// Every ghost surface is pushed this far behind coincident solid surfaces.
const SURFACE_OFFSET = { factor: 2, units: 8 } as const;
// Edges sit between the two: behind the live solid, in front of the ghost's
// own depth, so they survive the ghost's hidden-surface pass.
const EDGE_OFFSET = { factor: 1, units: 4 } as const;

// Stencil bit set wherever the ghost's own surface is the nearest thing
// drawn. Bit 1 is the opaque bodies', bit 2 the translucent lines' (see
// render/scene.ts); the stencil buffer is cleared each frame.
//
// Its edges draw only inside that mask. A fat line is a flat screen-facing
// quad, so on a face seen at a grazing angle half its width sits in front
// of the face whatever the polygon offset: an old edge lying on a surface
// the live solid keeps would draw a bright line across the part, and every
// unchanged silhouette would get a light halo. Inside the mask that cannot
// happen. At the ghost's own silhouette only the inner half of a line
// shows, which the width allows for.
export const GHOST_SURFACE_STENCIL = 4;

// The veil's depth pass draws before the live body's edges (8), so the
// edges on its far side hide behind the added material like the ghost's own.
const VEIL_DEPTH_ORDER = 6;
// Its fill draws before them too, so the proposed shape keeps the body's
// own crisp ink on its rim instead of seeing it washed out by the frost.
const VEIL_FILL_ORDER = 7;
const DEPTH_ORDER = 25;
const SHELL_ORDER = 26;
const FACE_ORDER = 27;
const EDGE_ORDER = 28;

export interface BodyGhost {
  /** Add beside the body it was taken from. */
  readonly object: THREE.Group;
  /** Follows the section view when it moves or closes under a kept ghost. */
  setClippingPlane(plane: THREE.Plane | null): void;
  /**
   * While a body is given, the material it has gained beyond the dragged
   * face's old plane draws as ghost, not solid: the change is still only a
   * proposal. The part up to the old face stays solid, capped by the live
   * cross-section. Call it each frame with the body as currently displayed
   * (an exact preview replaces the object); `null` makes the whole part solid again.
   * Does nothing for a dragged face that is not planar.
   */
  veilAddedMaterial(live: THREE.Mesh | null): void;
  dispose(): void;
}

/**
 * A translucent copy of a body as it is now, kept while a drag reshapes the
 * body itself: the solid shows the part as it will be, the ghost the part as
 * it was. The ghost sits a little behind the solid in depth, so wherever the
 * two surfaces coincide the solid wins, and the ghost shows only material
 * the change removes. Material the change adds covers the ghost.
 *
 * Before its fill, the ghost lays down its own depth, invisibly, after the
 * live body and its edges have drawn. Only the ghost's nearest surface then
 * fills, once, and its far-side edges and seams stay hidden behind it, so it
 * reads as one frosted shape instead of a stack of see-through layers and a
 * wireframe. Its feature edges draw as a solid light outline. Smooth seams
 * are left out: the lit fill already shows a fillet, and seam arcs seen
 * through it read as stray dotted marks. `faceRange` marks the dragged
 * face's original position in the same neutral reference colour, and rims
 * it with an outline that stays visible on the live solid after a pull, so
 * the part's old extent still reads.
 *
 * Take it before the body is deformed: it copies the body's positions.
 */
export function createBodyGhost(
  body: THREE.Mesh,
  options: {
    faceRange?: { triangleStart: number; triangleCount: number };
    resolution?: FatLineResolution;
    /** The active section's cut, so the ghost is cut like the body. */
    clippingPlane?: THREE.Plane | null;
  } = {}
): BodyGhost {
  const clippingPlanes = options.clippingPlane ? [options.clippingPlane] : null;
  const object = new THREE.Group();
  object.name = 'offset-body-ghost';
  object.matrixAutoUpdate = false;
  body.updateMatrixWorld(true);
  object.matrix.copy(body.matrixWorld);
  const geometry = body.geometry.clone();

  // Transparent so it sorts after the live body's edges, which then keep
  // their ink where removed material stands in front of them.
  const depthMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: SURFACE_OFFSET.factor,
    polygonOffsetUnits: SURFACE_OFFSET.units,
    stencilWrite: true,
    stencilRef: GHOST_SURFACE_STENCIL,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilWriteMask: GHOST_SURFACE_STENCIL,
    stencilZPass: THREE.ReplaceStencilOp,
    clippingPlanes
  });
  const depth = new THREE.Mesh(geometry, depthMaterial);
  depth.name = 'offset-body-ghost-depth';
  depth.renderOrder = DEPTH_ORDER;
  object.add(depth);

  const material = new THREE.MeshStandardMaterial({
    color: GHOST_COLOR,
    roughness: 0.7,
    metalness: 0,
    transparent: true,
    opacity: GHOST_OPACITY,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: SURFACE_OFFSET.factor,
    polygonOffsetUnits: SURFACE_OFFSET.units,
    clippingPlanes
  });
  const shell = new THREE.Mesh(geometry, material);
  shell.name = 'offset-body-ghost-shell';
  shell.renderOrder = SHELL_ORDER;
  object.add(shell);

  let face: THREE.Mesh | null = null;
  const index = geometry.index;
  const range = options.faceRange;
  if (index && range && range.triangleCount > 0) {
    const start = range.triangleStart * 3;
    const end = Math.min(index.count, start + range.triangleCount * 3);
    const faceIndices: number[] = [];
    for (let i = start; i < end; i++) faceIndices.push(index.getX(i));
    const faceGeometry = new THREE.BufferGeometry();
    faceGeometry.setAttribute('position', geometry.getAttribute('position'));
    const normal = geometry.getAttribute('normal');
    if (normal) faceGeometry.setAttribute('normal', normal);
    faceGeometry.setIndex(faceIndices);
    face = new THREE.Mesh(
      faceGeometry,
      new THREE.MeshBasicMaterial({
        color: GHOST_COLOR,
        transparent: true,
        opacity: GHOST_FACE_OPACITY,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: EDGE_OFFSET.factor,
        polygonOffsetUnits: EDGE_OFFSET.units,
        clippingPlanes
      })
    );
    face.name = 'offset-body-ghost-face';
    face.renderOrder = FACE_ORDER;
    object.add(face);
  }

  // The dragged face's rim, depth-tested like the body's own edges (pulled
  // forward past the tessellation's chord error) and outside the stencil
  // mask, so it shows on the live surface it lies on and hides only where
  // the part really stands in front of it.
  let outline: LineSegments2 | null = null;
  const rim = index && range ? faceRim(geometry, range) : null;
  if (rim) {
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    outline = createFatLineSegments(rim, {
      color: GHOST_EDGE_COLOR,
      linewidth: OLD_FACE_OUTLINE_WIDTH,
      opacity: OLD_FACE_OUTLINE_OPACITY,
      depthBias: fatLineDepthBiasForExtent(
        2 * (geometry.boundingSphere?.radius ?? 0)
      ),
      ...(options.resolution ? { resolution: options.resolution } : {})
    });
    outline.material.clippingPlanes = clippingPlanes;
    // Translucent: blend each pixel once, without the coverage dither that
    // drew it dotted.
    drawFatLineOncePerPixel(outline.material);
    outline.name = 'offset-body-ghost-face-outline';
    outline.renderOrder = EDGE_ORDER + 1;
    object.add(outline);
  }

  let edges: LineSegments2 | null = null;
  const points: number[] = [];
  body.traverse((child) => {
    if (child.name !== 'body-edge') return;
    const lines = child as THREE.Mesh;
    const start = lines.geometry?.getAttribute('instanceStart');
    const finish = lines.geometry?.getAttribute('instanceEnd');
    if (!start || !finish) return;
    for (let i = 0; i < start.count; i++)
      points.push(
        start.getX(i),
        start.getY(i),
        start.getZ(i),
        finish.getX(i),
        finish.getY(i),
        finish.getZ(i)
      );
  });
  if (points.length) {
    edges = createFatLineSegments(Float32Array.from(points), {
      color: GHOST_EDGE_COLOR,
      linewidth: GHOST_EDGE_WIDTH,
      opacity: GHOST_EDGE_OPACITY,
      ...(options.resolution ? { resolution: options.resolution } : {})
    });
    // Fat lines are triangles too. A smaller bias than the surfaces keeps an
    // old edge that coincides with the new solid behind it, so a pull covers
    // the ghost's outline as well as its surface, while the ghost's own
    // depth still hides only its far-side edges. The stencil mask covers
    // what a flat line's offset cannot.
    edges.material.depthWrite = false;
    edges.material.polygonOffset = true;
    edges.material.polygonOffsetFactor = EDGE_OFFSET.factor;
    edges.material.polygonOffsetUnits = EDGE_OFFSET.units;
    edges.material.clippingPlanes = clippingPlanes;
    // Inside the ghost's mask, and once per pixel like every translucent
    // line: neighbouring segments' round caps overlap, and blended twice at
    // this opacity the outline reads as a string of beads. The first
    // fragment flips the translucent-line bit and later ones see it set.
    // Alpha to coverage goes off with it; at partial opacity its dither
    // breaks a line into dots.
    edges.material.alphaToCoverage = false;
    edges.material.stencilWrite = true;
    edges.material.stencilRef = GHOST_SURFACE_STENCIL;
    edges.material.stencilFunc = THREE.EqualStencilFunc;
    edges.material.stencilFuncMask =
      GHOST_SURFACE_STENCIL | TRANSLUCENT_LINE_STENCIL;
    edges.material.stencilWriteMask = TRANSLUCENT_LINE_STENCIL;
    edges.material.stencilZPass = THREE.InvertStencilOp;
    edges.name = 'offset-body-ghost-edges';
    edges.renderOrder = EDGE_ORDER;
    object.add(edges);
  }

  object.traverse((child) => {
    child.raycast = () => undefined;
    child.castShadow = false;
    child.receiveShadow = false;
  });
  // ---- The added-material veil ------------------------------------------
  let section = options.clippingPlane ?? null;
  const oldPlane = range && face ? planarFacePlane(geometry, range) : null;
  let veil: {
    live: THREE.Mesh;
    /** Every material the keep plane was added to, to take it off again. */
    clipped: Set<THREE.Material>;
    keep: THREE.Plane;
    beyond: THREE.Plane;
    depth: THREE.Mesh;
    fill: THREE.Mesh;
    cap: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    /** The old part beyond the old plane that is not the dragged face. */
    rest: THREE.Mesh | null;
  } | null = null;
  const veilDepthMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: SURFACE_OFFSET.factor,
    polygonOffsetUnits: SURFACE_OFFSET.units
  });
  const veilFillMaterial = material.clone();
  veilFillMaterial.opacity = VEIL_OPACITY;
  const veilMaterials: THREE.Material[] = [veilDepthMaterial, veilFillMaterial];
  const veilPlanes = (beyond: THREE.Plane) =>
    section ? [section, beyond] : [beyond];
  function unveil() {
    if (!veil) return;
    for (const part of [veil.depth, veil.fill, veil.cap, veil.rest])
      part?.removeFromParent();
    veil.cap.material.dispose();
    if (veil.rest) (veil.rest.material as THREE.Material).dispose();
    const keep = veil.keep;
    for (const target of veil.clipped) {
      const planes = (target.clippingPlanes ?? []).filter(
        (plane) => plane !== keep
      );
      target.clippingPlanes = planes.length ? planes : null;
      target.needsUpdate = true;
    }
    veil = null;
  }
  // The old face's plane in world space, and how far past it counts.
  let frame: { plane: THREE.Plane; margin: number } | null = null;
  function veilFrame(plane: THREE.Plane) {
    if (!frame) {
      geometry.computeBoundingBox();
      const size = geometry.boundingBox!.getSize(new THREE.Vector3()).length();
      frame = {
        plane: plane.clone().applyMatrix4(object.matrix),
        margin: Math.max(size, 1e-6) * 1e-4
      };
    }
    return frame;
  }
  // Whether the body as displayed reaches past the old face, cached on its
  // buffer and placement: a drag frame only rescans after a reshape.
  let reach: {
    position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    version: number;
    matrix: THREE.Matrix4;
    beyond: boolean;
  } | null = null;
  function reachesBeyond(live: THREE.Mesh, plane: THREE.Plane, margin: number) {
    const position = live.geometry.getAttribute('position');
    if (!position) return false;
    live.updateMatrixWorld();
    const version =
      position instanceof THREE.BufferAttribute
        ? position.version
        : position.data.version;
    if (
      reach &&
      reach.position === position &&
      reach.version === version &&
      reach.matrix.equals(live.matrixWorld)
    )
      return reach.beyond;
    const point = new THREE.Vector3();
    let beyond = false;
    // A push scans every vertex on each reshape (nothing lies beyond), so
    // read a plain buffer directly; the transform is `applyMatrix4`'s.
    const direct =
      position instanceof THREE.BufferAttribute &&
      !position.normalized &&
      position.itemSize === 3
        ? position.array
        : null;
    const e = live.matrixWorld.elements;
    for (let i = 0; i < position.count && !beyond; i++) {
      if (direct) {
        const x = direct[i * 3]!;
        const y = direct[i * 3 + 1]!;
        const z = direct[i * 3 + 2]!;
        const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
        point.set(
          (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
          (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
          (e[2] * x + e[6] * y + e[10] * z + e[14]) * w
        );
      } else {
        point.fromBufferAttribute(position, i).applyMatrix4(live.matrixWorld);
      }
      beyond = plane.distanceToPoint(point) > 2 * margin;
    }
    reach = { position, version, matrix: live.matrixWorld.clone(), beyond };
    return beyond;
  }
  // Section the live shape only after a reshape or placement change, not
  // every animation frame. Cache failures too: an open preview must stay
  // solid rather than retrying a failed section on every frame.
  let capSection: {
    geometry: THREE.BufferGeometry;
    position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    version: number;
    index: THREE.BufferAttribute | null;
    indexVersion: number;
    matrix: THREE.Matrix4;
    cap: THREE.BufferGeometry | null;
  } | null = null;
  function liveCap(live: THREE.Mesh, keep: THREE.Plane) {
    const position = live.geometry.getAttribute('position');
    const version =
      position instanceof THREE.BufferAttribute
        ? position.version
        : position.data.version;
    const index = live.geometry.index;
    if (
      capSection &&
      capSection.geometry === live.geometry &&
      capSection.position === position &&
      capSection.version === version &&
      capSection.index === index &&
      capSection.indexVersion === (index?.version ?? 0) &&
      capSection.matrix.equals(live.matrixWorld)
    )
      return capSection.cap;
    capSection?.cap?.dispose();
    let cap: THREE.BufferGeometry | null = null;
    try {
      const localPlane = keep
        .clone()
        .applyMatrix4(live.matrixWorld.clone().invert());
      cap = sectionCapGeometry(live.geometry, localPlane);
      // Veil parts live beside the original body, in its captured frame.
      cap?.applyMatrix4(
        object.matrix.clone().invert().multiply(live.matrixWorld)
      );
    } catch {
      cap?.dispose();
      cap = null;
    }
    capSection = {
      geometry: live.geometry,
      position,
      version,
      index,
      indexVersion: index?.version ?? 0,
      matrix: live.matrixWorld.clone(),
      cap
    };
    return cap;
  }
  function veilAddedMaterial(live: THREE.Mesh | null) {
    const liveMaterial = live?.material;
    if (
      !live ||
      !oldPlane ||
      !face ||
      !(liveMaterial instanceof THREE.Material) ||
      liveMaterial.transparent
    ) {
      unveil();
      return;
    }
    // Where the solid stops and the veil starts: a hair past the old face,
    // leaving the old face as a quiet reference on the solid side.
    const { plane, margin } = veilFrame(oldPlane);
    // Only a pull adds material to veil. Pushed in, nothing lies past the
    // old face, and a cap there would close empty air with a solid face.
    if (!reachesBeyond(live, plane, margin)) {
      unveil();
      return;
    }
    if (veil && veil.live !== live) unveil();
    // three.js keeps what lies on a plane's positive side.
    const keep =
      veil?.keep ??
      new THREE.Plane(plane.normal.clone().negate(), -plane.constant + margin);
    const cap = liveCap(live, keep);
    if (!cap) {
      unveil();
      return;
    }
    if (!veil) {
      const beyond = new THREE.Plane(
        plane.normal.clone(),
        plane.constant - margin
      );
      const part = <T extends THREE.Mesh>(
        name: string,
        mesh: T,
        renderOrder: number
      ): T => {
        mesh.name = name;
        mesh.renderOrder = renderOrder;
        mesh.raycast = () => undefined;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        object.add(mesh);
        return mesh;
      };
      for (const target of veilMaterials) {
        target.clippingPlanes = veilPlanes(beyond);
        target.needsUpdate = true;
      }
      // Old material past the old plane that the drag did not make (a boss
      // standing above a pulled top face, say) stays solid: the old part
      // there, drawn with the body's own finish.
      let rest: THREE.Mesh | null = null;
      const position = geometry.getAttribute('position');
      const point = new THREE.Vector3();
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i);
        if (oldPlane.distanceToPoint(point) <= 2 * margin) continue;
        const restMaterial = liveMaterial.clone();
        restMaterial.clippingPlanes = veilPlanes(beyond);
        rest = part(
          'offset-body-ghost-veil-rest',
          new THREE.Mesh(geometry, restMaterial),
          0
        );
        break;
      }
      veil = {
        live,
        clipped: new Set(),
        keep,
        beyond,
        depth: part(
          'offset-body-ghost-veil-depth',
          new THREE.Mesh(live.geometry, veilDepthMaterial),
          VEIL_DEPTH_ORDER
        ),
        fill: part(
          'offset-body-ghost-veil-fill',
          new THREE.Mesh(live.geometry, veilFillMaterial),
          VEIL_FILL_ORDER
        ),
        // The live section closes the whole solid, including the band
        // around an inset face whose bounding fillets moved with it.
        cap: part(
          'offset-body-ghost-veil-cap',
          new THREE.Mesh(cap, liveMaterial.clone()),
          0
        ),
        rest
      };
    }
    // A proxy may swap the body's geometry, and the section pass rewrites
    // the body's planes; keep both current.
    if (veil.depth.geometry !== live.geometry) {
      veil.depth.geometry = live.geometry;
      veil.fill.geometry = live.geometry;
    }
    veil.cap.geometry = cap;
    veil.cap.material.copy(liveMaterial);
    // The cap lies on the keep plane; clipping it by that same plane can
    // discard it through rounding. Only the user's section cuts the cap.
    veil.cap.material.clippingPlanes = section ? [section] : null;
    veil.cap.material.side = THREE.DoubleSide;
    // The body, and what selection draws on it: the dragged face's own
    // highlight would otherwise paint the new end solid. Its edges stay, so
    // the proposed shape keeps its outline.
    const current = veil;
    const clip = (target: THREE.Material) => {
      current.clipped.add(target);
      if (target.clippingPlanes?.includes(current.keep)) return;
      target.clippingPlanes = [...(target.clippingPlanes ?? []), current.keep];
      target.needsUpdate = true;
    };
    clip(liveMaterial);
    const visit = (node: THREE.Object3D) => {
      for (const child of node.children) {
        if (child.name.startsWith('body-edge')) continue;
        const own = (child as THREE.Mesh).material;
        for (const target of Array.isArray(own) ? own : own ? [own] : [])
          clip(target);
        visit(child);
      }
    };
    visit(live);
  }

  return {
    object,
    setClippingPlane(plane) {
      section = plane;
      const planes = plane ? [plane] : null;
      object.traverse((child) => {
        // The veil's parts carry their own cut.
        if (child.name.startsWith('offset-body-ghost-veil')) return;
        const material = (child as THREE.Mesh).material as
          THREE.Material | undefined;
        if (!material) return;
        material.clippingPlanes = planes;
        material.needsUpdate = true;
      });
      if (veil) {
        veil.cap.material.clippingPlanes = planes;
        veil.cap.material.needsUpdate = true;
        const parts = [...veilMaterials];
        if (veil.rest) parts.push(veil.rest.material as THREE.Material);
        for (const target of parts) {
          target.clippingPlanes = veilPlanes(veil.beyond);
          target.needsUpdate = true;
        }
      }
    },
    veilAddedMaterial,
    dispose() {
      unveil();
      capSection?.cap?.dispose();
      veilDepthMaterial.dispose();
      veilFillMaterial.dispose();
      object.removeFromParent();
      geometry.dispose();
      depthMaterial.dispose();
      material.dispose();
      if (face) {
        face.geometry.dispose();
        (face.material as THREE.Material).dispose();
      }
      for (const lines of [edges, outline]) {
        if (!lines) continue;
        lines.geometry.dispose();
        lines.material.dispose();
      }
    }
  };
}

/**
 * The plane of a run of triangles, its normal facing the way they wind
 * (out of the body), or null when they do not lie in one plane.
 */
function planarFacePlane(
  geometry: THREE.BufferGeometry,
  range: { triangleStart: number; triangleCount: number }
): THREE.Plane | null {
  const index = geometry.index;
  const position = geometry.getAttribute('position');
  if (!index || !position || range.triangleCount <= 0) return null;
  const start = range.triangleStart * 3;
  const end = Math.min(index.count, start + range.triangleCount * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  let area = 0;
  for (let i = start; i + 2 < end; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    const cross = ab.subVectors(b, a).cross(ac.subVectors(c, a));
    const twiceArea = cross.length();
    normal.add(cross);
    centroid.addScaledVector(a.add(b).add(c), twiceArea / 3);
    area += twiceArea;
  }
  if (area <= 0 || normal.lengthSq() === 0) return null;
  centroid.divideScalar(area);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    normal.normalize(),
    centroid
  );
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3()).length();
  const tolerance = Math.max(size, 1e-6) * 1e-4;
  for (let i = start; i < end; i++) {
    a.fromBufferAttribute(position, index.getX(i));
    if (Math.abs(plane.distanceToPoint(a)) > tolerance) return null;
  }
  return plane;
}

/**
 * The outline of a run of triangles: every triangle side not shared with
 * another triangle of the run, as xyz/xyz segment pairs. Sides are matched
 * by position, not index, so a face whose tessellation repeats vertices
 * still has only its rim. Null when the run has no rim.
 */
function faceRim(
  geometry: THREE.BufferGeometry,
  range: { triangleStart: number; triangleCount: number }
): Float32Array | null {
  const index = geometry.index;
  const position = geometry.getAttribute('position');
  if (!index || !position || range.triangleCount <= 0) return null;
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3()).length();
  // Positions within a millionth of the body's size are one vertex.
  const step = Math.max(size, 1e-9) * 1e-6;
  const key = (vertex: number) =>
    `${Math.round(position.getX(vertex) / step)},${Math.round(
      position.getY(vertex) / step
    )},${Math.round(position.getZ(vertex) / step)}`;
  const sides = new Map<string, { a: number; b: number; uses: number }>();
  const start = range.triangleStart * 3;
  const end = Math.min(index.count, start + range.triangleCount * 3);
  for (let i = start; i + 2 < end; i += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const a = index.getX(i + corner);
      const b = index.getX(i + ((corner + 1) % 3));
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) continue;
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const side = sides.get(id);
      if (side) side.uses += 1;
      else sides.set(id, { a, b, uses: 1 });
    }
  }
  const points: number[] = [];
  for (const { a, b, uses } of sides.values()) {
    if (uses !== 1) continue;
    points.push(
      position.getX(a),
      position.getY(a),
      position.getZ(a),
      position.getX(b),
      position.getY(b),
      position.getZ(b)
    );
  }
  return points.length ? Float32Array.from(points) : null;
}
