import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { keepProgram, type HandleVec3 } from './DragRig';
import { SELECTION_SEMANTICS } from '../render/semantics';

const CHANGE = SELECTION_SEMANTICS.change;

/** A loop vertex turning by more than this is a corner the cut ghost stands a
 *  vertical on; a tessellated arc bends by far less at each vertex. */
const CORNER_TURN_RADIANS = (20 * Math.PI) / 180;

const BAND_VERTEX = /* glsl */ `
attribute float level;
varying float vLevel;
void main() {
  vLevel = level;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Screen-space diagonal hatching, so the stripes keep one pitch however the
// band is foreshortened, and a crisp seam where the band meets the old level.
const BAND_FRAGMENT = /* glsl */ `
uniform vec3 stripe;
uniform vec3 seam;
uniform float opacity;
uniform float pixelRatio;
varying float vLevel;
void main() {
  float pitch = 7.0 * pixelRatio;
  float along = mod(gl_FragCoord.x + gl_FragCoord.y, pitch);
  float hatch = step(along, 3.0 * pixelRatio);
  float edge = max(fwidth(vLevel), 1e-5);
  float seamLine = 1.0 - smoothstep(edge, edge * 2.0, vLevel);
  float alpha = max(hatch, seamLine);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(mix(stripe, seam, seamLine), opacity * alpha);
}
`;

export interface ChangeBand {
  /** World-space parts: the hatched walls and, for a cut, the ghost outline. */
  readonly object: THREE.Group;
  /** Moves the band's far edge to the face's new level. */
  update(value: number): void;
  dispose(): void;
}

/**
 * The walls a face offset adds or removes, swept from the face's boundary
 * loops (its old level) along the normal by the current value.
 *
 * Adding, they are a green hatched band with a crisp seam at the old level:
 * the new side walls, and only those, coloured. Cutting, the same walls are
 * the removed slab's sides — hatched coral, which is also exactly the wall a
 * push exposes where the face met a taller neighbour — and the slab itself is
 * outlined in dashed coral: both levels and the verticals at its corners.
 */
export function createChangeBand(
  loops: readonly HandleVec3[][],
  direction: THREE.Vector3,
  pixelRatio = 1
): ChangeBand {
  const object = new THREE.Group();
  object.name = 'offset-change-band';

  const base: number[] = [];
  const levels: number[] = [];
  const indices: number[] = [];
  const outlineBase: number[] = [];
  const outlineLevel: number[] = [];
  const pushOutline = (point: HandleVec3, level: number) => {
    outlineBase.push(point.x, point.y, point.z);
    outlineLevel.push(level);
  };
  let cursor = 0;
  for (const loop of loops) {
    const count = loop.length;
    if (count < 2) {
      continue;
    }
    for (const level of [0, 1]) {
      for (const point of loop) {
        base.push(point.x, point.y, point.z);
        levels.push(level);
      }
    }
    for (let k = 0; k < count; k += 1) {
      const a = cursor + k;
      const b = cursor + ((k + 1) % count);
      const c = cursor + count + k;
      const d = cursor + count + ((k + 1) % count);
      indices.push(a, b, d, a, d, c);
      // Both levels of the slab's outline.
      const from = loop[k]!;
      const to = loop[(k + 1) % count]!;
      for (const level of [0, 1]) {
        pushOutline(from, level);
        pushOutline(to, level);
      }
      // The verticals only at corners: every vertex of a tessellated arc
      // would hatch the outline into a fence.
      const previous = loop[(k - 1 + count) % count]!;
      const inward = new THREE.Vector3(
        from.x - previous.x,
        from.y - previous.y,
        from.z - previous.z
      );
      const outward = new THREE.Vector3(
        to.x - from.x,
        to.y - from.y,
        to.z - from.z
      );
      if (
        count <= 8 ||
        (inward.lengthSq() > 0 &&
          outward.lengthSq() > 0 &&
          inward.angleTo(outward) > CORNER_TURN_RADIANS)
      ) {
        pushOutline(from, 0);
        pushOutline(from, 1);
      }
    }
    cursor += count * 2;
  }

  const positions = new Float32Array(base);
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute(
    'level',
    new THREE.BufferAttribute(new Float32Array(levels), 1)
  );
  geometry.setIndex(indices);
  const material = keepProgram(
    new THREE.ShaderMaterial({
      vertexShader: BAND_VERTEX,
      fragmentShader: BAND_FRAGMENT,
      uniforms: {
        stripe: { value: new THREE.Color(CHANGE.addStripe) },
        seam: { value: new THREE.Color(CHANGE.addSeam) },
        opacity: { value: CHANGE.bandOpacity },
        pixelRatio: { value: pixelRatio }
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // The band lies on the preview body's own walls; it wins that tie but
      // still hides behind anything genuinely in front of it.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    })
  );
  const walls = new THREE.Mesh(geometry, material);
  walls.name = 'offset-change-walls';
  // The band moves every frame of a drag; recomputing its bounds that often
  // buys nothing for something this small and short-lived.
  walls.frustumCulled = false;
  walls.renderOrder = 27;
  walls.visible = false;
  object.add(walls);

  const outlinePositions = new Float32Array(outlineBase);
  const outlineGeometry = new THREE.BufferGeometry();
  const outlineAttribute = new THREE.BufferAttribute(outlinePositions, 3);
  outlineGeometry.setAttribute('position', outlineAttribute);
  const outline = new THREE.LineSegments(
    outlineGeometry,
    keepProgram(
      new THREE.LineDashedMaterial({
        color: CHANGE.cut,
        dashSize: 1.2,
        gapSize: 0.8,
        transparent: true,
        opacity: 0.95,
        // The removed slab is gone from the preview: its outline is a ghost
        // and reads through whatever now stands in front of it.
        depthTest: false
      })
    )
  );
  outline.name = 'offset-change-cut-outline';
  outline.frustumCulled = false;
  outline.renderOrder = 28;
  outline.visible = false;
  object.add(outline);

  const uniforms = material.uniforms as {
    stripe: { value: THREE.Color };
    seam: { value: THREE.Color };
  };

  return {
    object,
    update(value: number) {
      const engaged = Math.abs(value) > 1e-9;
      const cutting = value < 0;
      walls.visible = engaged;
      outline.visible = engaged && cutting;
      if (!engaged) {
        return;
      }
      uniforms.stripe.value.setHex(
        cutting ? CHANGE.cutStripe : CHANGE.addStripe
      );
      uniforms.seam.value.setHex(cutting ? CHANGE.cutSeam : CHANGE.addSeam);
      for (let vertex = 0; vertex < levels.length; vertex += 1) {
        const lift = (levels[vertex] ?? 0) * value;
        positions[vertex * 3] = base[vertex * 3]! + direction.x * lift;
        positions[vertex * 3 + 1] = base[vertex * 3 + 1]! + direction.y * lift;
        positions[vertex * 3 + 2] = base[vertex * 3 + 2]! + direction.z * lift;
      }
      positionAttribute.needsUpdate = true;
      if (cutting) {
        for (let vertex = 0; vertex < outlineLevel.length; vertex += 1) {
          const lift = (outlineLevel[vertex] ?? 0) * value;
          outlinePositions[vertex * 3] =
            outlineBase[vertex * 3]! + direction.x * lift;
          outlinePositions[vertex * 3 + 1] =
            outlineBase[vertex * 3 + 1]! + direction.y * lift;
          outlinePositions[vertex * 3 + 2] =
            outlineBase[vertex * 3 + 2]! + direction.z * lift;
        }
        outlineAttribute.needsUpdate = true;
        outline.computeLineDistances();
      }
    },
    dispose() {
      // Geometries only: the materials keep their programs (keepProgram).
      geometry.dispose();
      outlineGeometry.dispose();
      object.removeFromParent();
    }
  };
}

const LEVEL_RING_RADIUS = 0.22;
const LEVEL_RING_SEGMENTS = 40;

export interface LevelRing {
  /** Screen-scaled like the pin: position, orient and scale it as a unit. */
  readonly object: THREE.Group;
  setColor(color: THREE.ColorRepresentation): void;
}

/**
 * The dashed ring that marks a face's old level on the drag axis: where the
 * change arrow starts, the reference the offset is measured from. It lies in
 * the face plane (the group's local XZ plane, its +Y on the normal).
 */
export function createLevelRing(): LevelRing {
  const object = new THREE.Group();
  object.name = 'offset-old-level';
  const points: number[] = [];
  for (let k = 0; k <= LEVEL_RING_SEGMENTS; k += 1) {
    const angle = (k / LEVEL_RING_SEGMENTS) * Math.PI * 2;
    points.push(
      Math.cos(angle) * LEVEL_RING_RADIUS,
      0,
      Math.sin(angle) * LEVEL_RING_RADIUS
    );
  }
  const geometry = new LineGeometry();
  geometry.setPositions(points);
  const material = keepProgram(
    new LineMaterial({
      color: CHANGE.oldLevel,
      linewidth: 1.4,
      dashed: true,
      dashSize: 0.06,
      gapSize: 0.06,
      transparent: true,
      opacity: 0.85,
      depthTest: false
    })
  );
  const ring = new Line2(geometry, material);
  ring.computeLineDistances();
  ring.renderOrder = 29;
  object.add(ring);
  object.visible = false;
  return {
    object,
    setColor(color) {
      material.color.set(color);
    }
  };
}
