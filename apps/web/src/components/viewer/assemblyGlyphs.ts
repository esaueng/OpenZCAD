import * as THREE from 'three';
import {
  createFatLine,
  createFatLineSegments,
  disposeObject,
  projectToScreen,
  SELECTION_SEMANTICS,
  type FatLineResolution
} from '@openzcad/viewport';
import {
  frameToTransform,
  type AssemblyDofLimit,
  type AssemblyFrame,
  type AssemblyFrameSourceKind,
  type AssemblyJointKind
} from '@openzcad/shared';
import type { AssemblyJointGlyph } from '../../lib/assembly/assemblyView';

/**
 * Joint glyphs and the frame-pick snap marker for the Assemble workspace
 * (AS02). Each glyph sits on its joint's world frame and is drawn in unit
 * coordinates, scaled every frame to a constant size on screen like the
 * other gizmos: a revolute is a ring about its axis (with dashed limit
 * spokes and a filled wedge to the current angle when it has limits), a
 * slider an arrow along Z, a cylindrical joint both, and the rest a triad.
 *
 * Glyph groups are kept per joint and rebuilt only when what they show
 * changes shape (kind, state, limits); playback frames only move them and
 * redraw the wedge, so 60 fps motion allocates almost nothing.
 */

/** On-screen radius of a glyph's ring, CSS pixels. */
const GLYPH_RADIUS_PX = 26;
/** Snap marker size, CSS pixels. */
const MARKER_RADIUS_PX = 18;
/** Draw over the parts, under the move gizmo and drag handles. */
const GLYPH_RENDER_ORDER = 25;

export const ASSEMBLY_GLYPH_COLORS = {
  idle: 0xdbe4f3,
  selected: SELECTION_SEMANTICS.selected.face,
  unsolved: SELECTION_SEMANTICS.handle.invalid,
  axisX: 0xef6a6a,
  axisY: 0x6fd66f,
  axisZ: 0x5f8fef
} as const;

interface GlyphEntry {
  group: THREE.Group;
  signature: string;
  wedge: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
  wedgeValue: number | null;
  origin: THREE.Vector3;
}

const DEG = Math.PI / 180;

function glyphColor(glyph: Pick<AssemblyJointGlyph, 'selected' | 'unsolved'>) {
  if (glyph.unsolved) return ASSEMBLY_GLYPH_COLORS.unsolved;
  return glyph.selected
    ? ASSEMBLY_GLYPH_COLORS.selected
    : ASSEMBLY_GLYPH_COLORS.idle;
}

function overlay<T extends THREE.Object3D>(object: T): T {
  object.renderOrder = GLYPH_RENDER_ORDER;
  object.raycast = () => undefined;
  object.traverse((child) => {
    child.renderOrder = GLYPH_RENDER_ORDER;
    child.raycast = () => undefined;
    const material = (child as THREE.Mesh).material as
      THREE.Material | undefined;
    if (material) {
      material.depthTest = false;
      material.depthWrite = false;
      material.transparent = true;
    }
  });
  return object;
}

function ring(
  radius: number,
  fromDeg: number,
  toDeg: number,
  segments: number
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let k = 0; k <= segments; k += 1) {
    const a = (fromDeg + ((toDeg - fromDeg) * k) / segments) * DEG;
    points.push(
      new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0)
    );
  }
  return points;
}

function line(
  points: THREE.Vector3[],
  color: number,
  resolution: FatLineResolution,
  width = 2,
  opacity = 0.95
) {
  return createFatLine(points, {
    color,
    linewidth: width,
    opacity,
    depthTest: false,
    resolution
  });
}

/** A dashed spoke as disjoint segments (no dashed shader variant needed). */
function dashedSpoke(
  angleDeg: number,
  length: number,
  color: number,
  resolution: FatLineResolution
) {
  const dx = Math.cos(angleDeg * DEG);
  const dy = Math.sin(angleDeg * DEG);
  const positions: number[] = [];
  const dash = 0.12;
  const gap = 0.09;
  for (let s = 0; s < length; s += dash + gap) {
    const e = Math.min(length, s + dash);
    positions.push(dx * s, dy * s, 0, dx * e, dy * e, 0);
  }
  return createFatLineSegments(positions, {
    color,
    linewidth: 1.6,
    opacity: 0.9,
    depthTest: false,
    resolution
  });
}

function arrowHead(color: number, at: number, direction: 1 | -1) {
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.11, 0.3, 16),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
  );
  // Cones point along +Y; turn onto ±Z.
  head.rotation.x = direction > 0 ? Math.PI / 2 : -Math.PI / 2;
  head.position.set(0, 0, at);
  return head;
}

function triad(resolution: FatLineResolution, color: number | null) {
  const group = new THREE.Group();
  const axes: [THREE.Vector3, number][] = [
    [new THREE.Vector3(1, 0, 0), ASSEMBLY_GLYPH_COLORS.axisX],
    [new THREE.Vector3(0, 1, 0), ASSEMBLY_GLYPH_COLORS.axisY],
    [new THREE.Vector3(0, 0, 1), ASSEMBLY_GLYPH_COLORS.axisZ]
  ];
  for (const [axis, axisColor] of axes)
    group.add(
      line(
        [new THREE.Vector3(), axis.clone().multiplyScalar(0.9)],
        color ?? axisColor,
        resolution,
        2.2
      )
    );
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 12, 8),
    new THREE.MeshBasicMaterial({
      color: color ?? ASSEMBLY_GLYPH_COLORS.idle,
      transparent: true,
      opacity: 0.95
    })
  );
  group.add(dot);
  return group;
}

/** A filled fan from 0° to `valueDeg` in the XY plane, radius `radius`. */
function wedgeGeometry(valueDeg: number, radius: number): THREE.BufferGeometry {
  const segments = Math.max(2, Math.ceil(Math.abs(valueDeg) / 4));
  const positions: number[] = [];
  for (let k = 0; k < segments; k += 1) {
    const a0 = ((valueDeg * k) / segments) * DEG;
    const a1 = ((valueDeg * (k + 1)) / segments) * DEG;
    positions.push(
      0,
      0,
      0,
      Math.cos(a0) * radius,
      Math.sin(a0) * radius,
      0,
      Math.cos(a1) * radius,
      Math.sin(a1) * radius,
      0
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3)
  );
  return geometry;
}

function limitsSignature(limits: readonly (AssemblyDofLimit | null)[]) {
  return limits.map((l) => (l ? `${l.min}:${l.max}` : '-')).join(',');
}

function buildGlyph(
  glyph: AssemblyJointGlyph,
  resolution: FatLineResolution
): { group: THREE.Group; wedge: GlyphEntry['wedge'] } {
  const group = new THREE.Group();
  group.name = 'assembly-joint-glyph';
  group.userData.jointId = glyph.jointId;
  const color = glyphColor(glyph);
  const highlighted = glyph.selected || glyph.unsolved !== null;
  let wedge: GlyphEntry['wedge'] = null;
  const kind: AssemblyJointKind = glyph.kind;
  if (kind === 'revolute' || kind === 'cylindrical') {
    group.add(
      line(ring(1, 0, 360, 64), color, resolution, highlighted ? 2.6 : 2)
    );
    group.add(
      line(
        [new THREE.Vector3(0, 0, -0.6), new THREE.Vector3(0, 0, 1.2)],
        color,
        resolution,
        2
      )
    );
    group.add(arrowHead(color, 1.25, 1));
    // Where zero degrees points, so the wedge reads as an angle from it.
    group.add(
      line(
        [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)],
        color,
        resolution,
        1.2,
        0.6
      )
    );
    const limit = glyph.limits[0] ?? null;
    if (limit) {
      group.add(dashedSpoke(limit.min, 1.3, color, resolution));
      group.add(dashedSpoke(limit.max, 1.3, color, resolution));
    }
    wedge = new THREE.Mesh(
      wedgeGeometry(0, 0.85),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.32,
        side: THREE.DoubleSide
      })
    );
    wedge.name = 'assembly-joint-wedge';
    group.add(wedge);
  }
  if (kind === 'slider' || kind === 'cylindrical') {
    const reach = kind === 'slider' ? 1.4 : 1.7;
    group.add(
      line(
        [new THREE.Vector3(0, 0, -reach), new THREE.Vector3(0, 0, reach)],
        color,
        resolution,
        2.4
      )
    );
    group.add(arrowHead(color, reach + 0.05, 1));
    group.add(arrowHead(color, -reach - 0.05, -1));
  }
  if (kind === 'rigid' || kind === 'ball' || kind === 'planar') {
    group.add(triad(resolution, highlighted ? color : null));
    if (kind === 'ball')
      group.add(line(ring(0.55, 0, 360, 48), color, resolution, 1.6, 0.8));
    if (kind === 'planar')
      group.add(
        line(
          [
            new THREE.Vector3(-0.7, -0.7, 0),
            new THREE.Vector3(0.7, -0.7, 0),
            new THREE.Vector3(0.7, 0.7, 0),
            new THREE.Vector3(-0.7, 0.7, 0)
          ],
          color,
          resolution,
          1.4,
          0.7
        )
      );
  }
  overlay(group);
  return { group, wedge };
}

function placeOnFrame(object: THREE.Object3D, frame: AssemblyFrame) {
  const { t, q } = frameToTransform(frame);
  object.position.set(t.x, t.y, t.z);
  object.quaternion.set(q.x, q.y, q.z, q.w);
}

/** Every joint glyph, plus the snap marker the joint tool hovers. */
export class AssemblyGlyphLayer {
  readonly group = new THREE.Group();
  private entries = new Map<string, GlyphEntry>();
  private marker: THREE.Group | null = null;
  private markerKey = '';
  private resolution: () => FatLineResolution;

  constructor(resolution: () => FatLineResolution) {
    this.resolution = resolution;
    this.group.name = 'assembly-glyphs';
  }

  /** Brings the drawn glyphs in line with the view model's. */
  setGlyphs(glyphs: readonly AssemblyJointGlyph[]): void {
    const seen = new Set<string>();
    for (const glyph of glyphs) {
      seen.add(glyph.jointId);
      const signature = [
        glyph.kind,
        glyph.selected ? 's' : '',
        glyph.unsolved ?? '',
        limitsSignature(glyph.limits)
      ].join('|');
      let entry = this.entries.get(glyph.jointId);
      if (entry && entry.signature !== signature) {
        this.group.remove(entry.group);
        disposeObject(entry.group);
        entry = undefined;
      }
      if (!entry) {
        const built = buildGlyph(glyph, this.resolution());
        entry = {
          group: built.group,
          signature,
          wedge: built.wedge,
          wedgeValue: null,
          origin: new THREE.Vector3()
        };
        this.entries.set(glyph.jointId, entry);
        this.group.add(entry.group);
      }
      placeOnFrame(entry.group, glyph.frame);
      entry.origin.copy(entry.group.position);
      const value = glyph.values[0] ?? 0;
      if (entry.wedge && entry.wedgeValue !== value) {
        entry.wedge.geometry.dispose();
        entry.wedge.geometry = wedgeGeometry(value, 0.85);
        entry.wedgeValue = value;
      }
    }
    for (const [jointId, entry] of this.entries) {
      if (seen.has(jointId)) continue;
      this.group.remove(entry.group);
      disposeObject(entry.group);
      this.entries.delete(jointId);
    }
  }

  /**
   * The snap marker at a world frame, or none. `key` names what it marks so
   * an unchanged hover does not rebuild it.
   */
  setMarker(
    frame: AssemblyFrame | null,
    kind: AssemblyFrameSourceKind | null = null
  ): void {
    const key = frame
      ? `${kind}|${frame.origin.x},${frame.origin.y},${frame.origin.z}|${frame.zAxis.x},${frame.zAxis.y},${frame.zAxis.z}|${frame.xAxis.x},${frame.xAxis.y},${frame.xAxis.z}`
      : '';
    if (key === this.markerKey) return;
    this.markerKey = key;
    if (this.marker) {
      this.group.remove(this.marker);
      disposeObject(this.marker);
      this.marker = null;
    }
    if (!frame) return;
    const resolution = this.resolution();
    const marker = new THREE.Group();
    marker.name = 'assembly-frame-marker';
    marker.add(triad(resolution, null));
    if (kind === 'circle' || kind === 'cylinder')
      marker.add(
        line(
          ring(0.6, 0, 360, 48),
          ASSEMBLY_GLYPH_COLORS.selected,
          resolution,
          2.4
        )
      );
    overlay(marker);
    placeOnFrame(marker, frame);
    this.marker = marker;
    this.group.add(marker);
  }

  /** Screen-constant size: call every drawn frame before rendering. */
  scaleToScreen(worldPerPixelAt: (point: THREE.Vector3) => number): void {
    for (const entry of this.entries.values()) {
      const s = worldPerPixelAt(entry.origin) * GLYPH_RADIUS_PX;
      entry.group.scale.setScalar(Number.isFinite(s) && s > 0 ? s : 1);
    }
    if (this.marker) {
      const s = worldPerPixelAt(this.marker.position) * MARKER_RADIUS_PX;
      this.marker.scale.setScalar(Number.isFinite(s) && s > 0 ? s : 1);
    }
  }

  /** The joint whose glyph centre is within `tolerancePx` of a canvas point. */
  pick(
    canvasX: number,
    canvasY: number,
    camera: THREE.Camera,
    width: number,
    height: number,
    tolerancePx = 16
  ): string | null {
    let best: { jointId: string; gap: number } | null = null;
    for (const [jointId, entry] of this.entries) {
      const screen = projectToScreen(entry.origin, camera, width, height);
      if (!screen) continue;
      const gap = Math.hypot(screen.x - canvasX, screen.y - canvasY);
      if (gap <= tolerancePx && (!best || gap < best.gap))
        best = { jointId, gap };
    }
    return best?.jointId ?? null;
  }

  get empty(): boolean {
    return this.entries.size === 0 && !this.marker;
  }

  dispose(): void {
    for (const entry of this.entries.values()) disposeObject(entry.group);
    this.entries.clear();
    if (this.marker) disposeObject(this.marker);
    this.marker = null;
    this.markerKey = '';
    this.group.clear();
  }
}
