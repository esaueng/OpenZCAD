import { findSketch, resolveParamValue } from '@openzcad/document-core';
import {
  computeSketchProfileAnalysis,
  type PlaneBasis
} from '@openzcad/geometry';
import type { ProjectDocument, SketchObjectData } from '@openzcad/shared';
import type { FeatureDataOf } from './exact-build-loop';
import type { RemusKernel } from './remus-runtime';
import { makeRegionFace } from './exact-profile-builders';

/**
 * M06 (schema v101): the exact rib. The rib's material is the region its open
 * profile and the body close off, built with exact booleans only:
 *
 * - `parallel`: the profile, extended along its end tangents, bounds a slab
 *   in the sketch plane on the chosen side, `thickness` across the plane.
 * - `normal`: the profile thickened within the plane is run along the
 *   sketch normal, far past the body.
 *
 * Either tool is cut by the body into regions (`booleanRegions`); the rib is
 * the region beside the profile, and it must close against the body: one
 * that runs on past the body (the profile does not reach it) is refused by
 * name, never trimmed to a guess. The caller unites it with the body.
 */

type V2 = { x: number; y: number };

interface Element2 {
  data: SketchObjectData;
  start: V2;
  end: V2;
  /** Unit tangents at the start and end, in traversal direction. */
  t0: V2;
  t1: V2;
  /** Arcs: centre, radius and whether traversal runs counter-clockwise. */
  arc?: { center: V2; radius: number; ccw: boolean };
}

const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: V2, k: number): V2 => ({ x: a.x * k, y: a.y * k });
const length = (a: V2) => Math.hypot(a.x, a.y);
const left = (a: V2): V2 => ({ x: -a.y, y: a.x });
const unit = (a: V2): V2 => scale(a, 1 / (length(a) || 1));

function lineObject(a: V2, b: V2): SketchObjectData {
  return { objectKind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** An arc object spanning the same points as `from`→`to` about `center`. */
function arcObject(
  center: V2,
  radius: number,
  from: V2,
  to: V2,
  ccw: boolean
): SketchObjectData {
  const angle = (p: V2) =>
    (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI;
  const [a, b] = ccw ? [from, to] : [to, from];
  return {
    objectKind: 'arc',
    centerX: center.x,
    centerY: center.y,
    radius,
    startAngleDeg: angle(a),
    endAngleDeg: angle(b)
  };
}

/** The profile's curves, read at the rib's history position. */
function profileElements(
  document: ProjectDocument,
  data: FeatureDataOf<'rib'>,
  scope: Record<string, number>
): Element2[] {
  const sketch = findSketch(document, data.profile.sketchId);
  if (!sketch) throw new Error('The rib profile sketch no longer exists.');
  const value = (v: unknown, name: string) =>
    resolveParamValue(
      v as never,
      scope,
      `rib profile ${name}`,
      document.units
    );
  return data.profile.entityIds.map((id) => {
    const node = document.nodes[id];
    if (node?.kind !== 'sketch-object' || !sketch.objectIds.includes(id)) {
      throw new Error('The rib profile names a curve its sketch no longer holds.');
    }
    const object = node.data;
    if (object.objectKind === 'line') {
      const start = { x: value(object.x1, 'X'), y: value(object.y1, 'Y') };
      const end = { x: value(object.x2, 'X'), y: value(object.y2, 'Y') };
      const t = unit(sub(end, start));
      return { data: object, start, end, t0: t, t1: t };
    }
    if (object.objectKind === 'arc') {
      const center = {
        x: value(object.centerX, 'centre X'),
        y: value(object.centerY, 'centre Y')
      };
      const radius = value(object.radius, 'radius');
      const a0 = (value(object.startAngleDeg, 'start angle') * Math.PI) / 180;
      const a1 = (value(object.endAngleDeg, 'end angle') * Math.PI) / 180;
      const at = (a: number) => ({
        x: center.x + radius * Math.cos(a),
        y: center.y + radius * Math.sin(a)
      });
      const tangent = (a: number) => ({ x: -Math.sin(a), y: Math.cos(a) });
      return {
        data: object,
        start: at(a0),
        end: at(a1),
        t0: tangent(a0),
        t1: tangent(a1),
        arc: { center, radius, ccw: true }
      };
    }
    throw new Error(
      'A rib profile is made of lines and arcs; this one holds another curve.'
    );
  });
}

function reversed(element: Element2): Element2 {
  return {
    ...element,
    start: element.end,
    end: element.start,
    t0: scale(element.t1, -1),
    t1: scale(element.t0, -1),
    ...(element.arc ? { arc: { ...element.arc, ccw: !element.arc.ccw } } : {})
  };
}

/**
 * The profile as one open chain, start to end, starting at the free end
 * that sorts first by x then y, so a replay always reads it the same way.
 */
function orderedChain(elements: Element2[], tolerance: number): Element2[] {
  const meets = (a: V2, b: V2) => length(sub(a, b)) <= tolerance;
  const endsAt = (p: V2) =>
    elements.reduce(
      (count, e) => count + Number(meets(e.start, p)) + Number(meets(e.end, p)),
      0
    );
  const free: { element: Element2; at: V2 }[] = [];
  for (const element of elements) {
    for (const at of [element.start, element.end]) {
      const count = endsAt(at);
      if (count > 2)
        throw new Error('The rib profile branches; it must be one open chain.');
      if (count === 1) free.push({ element, at });
    }
  }
  if (free.length !== 2) {
    throw new Error(
      free.length === 0
        ? 'The rib profile is closed; a rib needs an open profile.'
        : 'The rib profile is not one connected chain.'
    );
  }
  free.sort((a, b) => a.at.x - b.at.x || a.at.y - b.at.y);
  const first = free[0]!;
  const chain = [
    meets(first.element.start, first.at)
      ? first.element
      : reversed(first.element)
  ];
  const used = new Set([first.element]);
  while (chain.length < elements.length) {
    const tail = chain[chain.length - 1]!.end;
    const next = elements.find(
      (e) => !used.has(e) && (meets(e.start, tail) || meets(e.end, tail))
    );
    if (!next) throw new Error('The rib profile is not one connected chain.');
    used.add(next);
    chain.push(meets(next.start, tail) ? next : reversed(next));
  }
  return chain;
}

/** The chain offset to its left by `d` (negative: right), joints mitred. */
function offsetChain(
  chain: Element2[],
  d: number
): { objects: SketchObjectData[]; start: V2; end: V2 } {
  if (d === 0)
    return {
      objects: chain.map((e) => e.data),
      start: chain[0]!.start,
      end: chain[chain.length - 1]!.end
    };
  const out: SketchObjectData[] = [];
  const points: V2[] = [];
  // Each element's offset ends, before joints are reconciled.
  const ends = chain.map((e) => {
    if (!e.arc) {
      const n = scale(left(e.t0), d);
      return { start: add(e.start, n), end: add(e.end, n) };
    }
    const radius = e.arc.radius + (e.arc.ccw ? -d : d);
    if (!(radius > 0)) {
      throw new Error(
        'The rib is thicker than an arc in its profile is tight; use a thinner rib or a wider arc.'
      );
    }
    const at = (p: V2) =>
      add(e.arc!.center, scale(unit(sub(p, e.arc!.center)), radius));
    return { start: at(e.start), end: at(e.end), radius };
  });
  points.push(ends[0]!.start);
  for (let i = 1; i < chain.length; i++) {
    const before = chain[i - 1]!;
    const after = chain[i]!;
    const turn = Math.abs(
      before.t1.x * after.t0.y - before.t1.y * after.t0.x
    );
    const along = before.t1.x * after.t0.x + before.t1.y * after.t0.y;
    if (turn < 1e-9 && along > 0) {
      points.push(ends[i]!.start);
      continue;
    }
    if (before.arc || after.arc) {
      throw new Error(
        'A normal rib profile turns a corner next to an arc; join the arc tangentially.'
      );
    }
    // Mitre: where the two offset lines meet.
    const p = ends[i - 1]!.start;
    const r = before.t1;
    const q = ends[i]!.start;
    const s = after.t0;
    const cross = r.x * s.y - r.y * s.x;
    const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / cross;
    points.push(add(p, scale(r, t)));
  }
  points.push(ends[ends.length - 1]!.end);
  chain.forEach((e, i) => {
    const from = points[i]!;
    const to = points[i + 1]!;
    out.push(
      e.arc
        ? arcObject(e.arc.center, ends[i]!.radius!, from, to, e.arc.ccw)
        : lineObject(from, to)
    );
  });
  return { objects: out, start: points[0]!, end: points[points.length - 1]! };
}

/** The one region `objects` enclose, as a face on `basis`. */
function regionFace(
  kernel: RemusKernel,
  objects: SketchObjectData[],
  basis: PlaneBasis,
  warn: (message: string) => void,
  what: string
): number {
  const analysis = computeSketchProfileAnalysis(
    objects.map((data, index) => ({ id: `rib-${index}`, data })),
    (value) => Number(value)
  );
  if (analysis.profiles.length !== 1) {
    throw new Error(
      `The ${what} does not close one region (it crosses itself); simplify the rib profile.`
    );
  }
  return makeRegionFace(kernel, analysis.profiles[0]!, basis, warn);
}

type V3 = { x: number; y: number; z: number };

function shifted(basis: PlaneBasis, along: number): PlaneBasis {
  return {
    ...basis,
    origin: {
      x: basis.origin.x + basis.normal.x * along,
      y: basis.origin.y + basis.normal.y * along,
      z: basis.origin.z + basis.normal.z * along
    }
  };
}

function point3(basis: PlaneBasis, p: V2, h = 0): V3 {
  return {
    x: basis.origin.x + basis.u.x * p.x + basis.v.x * p.y + basis.normal.x * h,
    y: basis.origin.y + basis.u.y * p.x + basis.v.y * p.y + basis.normal.y * h,
    z: basis.origin.z + basis.u.z * p.x + basis.v.z * p.y + basis.normal.z * h
  };
}

/** The middle of the chain and the left normal there. */
function chainMiddle(chain: Element2[]): { at: V2; normal: V2 } {
  const e = chain[Math.floor(chain.length / 2)]!;
  if (!e.arc) {
    return {
      at: scale(add(e.start, e.end), 0.5),
      normal: left(e.t0)
    };
  }
  const { center, radius, ccw } = e.arc;
  const a0 = Math.atan2(e.start.y - center.y, e.start.x - center.x);
  let a1 = Math.atan2(e.end.y - center.y, e.end.x - center.x);
  if (ccw && a1 < a0) a1 += 2 * Math.PI;
  if (!ccw && a1 > a0) a1 -= 2 * Math.PI;
  const mid = (a0 + a1) / 2;
  const radial = { x: Math.cos(mid), y: Math.sin(mid) };
  return {
    at: add(center, scale(radial, radius)),
    // Left of travel: toward the centre counter-clockwise.
    normal: ccw ? scale(radial, -1) : radial
  };
}

function bounds(kernel: RemusKernel, solid: number) {
  const b = kernel.boundingBox(solid);
  return {
    min: { x: b[0]!, y: b[1]!, z: b[2]! },
    max: { x: b[3]!, y: b[4]!, z: b[5]! }
  };
}

/**
 * The rib's material as one exact solid, to be united with `body`. Scratch
 * tools are released; the regions `booleanRegions` returns belong to its
 * compound and stay in the build's arena.
 */
export function buildRibSolid(
  kernel: RemusKernel,
  document: ProjectDocument,
  data: FeatureDataOf<'rib'>,
  body: number,
  basis: PlaneBasis,
  scope: Record<string, number>,
  warn: (message: string) => void
): number {
  const thickness = resolveParamValue(
    data.thickness,
    scope,
    'rib thickness',
    document.units
  );
  if (!(thickness > 0)) throw new Error('A rib needs a positive thickness.');
  const elements = profileElements(document, data, scope);
  const extent = Math.max(
    ...elements.flatMap((e) => [length(e.start), length(e.end)]),
    thickness
  );
  const box = bounds(kernel, body);
  const diagonal = Math.hypot(
    box.max.x - box.min.x,
    box.max.y - box.min.y,
    box.max.z - box.min.z
  );
  const reach = Math.hypot(
    (box.max.x + box.min.x) / 2 - basis.origin.x,
    (box.max.y + box.min.y) / 2 - basis.origin.y,
    (box.max.z + box.min.z) / 2 - basis.origin.z
  );
  const far = 4 * (diagonal + extent + reach + thickness);
  const tolerance = 1e-7 * Math.max(1, extent);
  const chain = orderedChain(elements, tolerance * 100);
  const first = chain[0]!;
  const last = chain[chain.length - 1]!;
  const middle = chainMiddle(chain);
  const nudge = 1e-3 * Math.min(thickness, Math.max(extent, 1));

  /**
   * The rib on one side (`parallel`) or growing one way (`normal`): its
   * material solid, or a refusal saying why that way has none.
   */
  const build = (sign: 1 | -1): number => {
    let tool: number;
    let witness: V3;
    let bounded: (lump: number) => boolean;
    const slack = 1e-6 * far;
    if (data.direction === 'parallel') {
      const chord = sub(last.end, first.start);
      if (length(chord) <= tolerance) {
        throw new Error('The rib profile is closed; a rib needs an open profile.');
      }
      const side = scale(left(unit(chord)), sign);
      const s = sub(first.start, scale(first.t0, far));
      const t = add(last.end, scale(last.t1, far));
      const away = scale(side, 2 * far);
      const objects = [
        lineObject(s, first.start),
        ...chain.map((e) => e.data),
        lineObject(last.end, t),
        lineObject(t, add(t, away)),
        lineObject(add(t, away), add(s, away)),
        lineObject(add(s, away), s)
      ];
      const [low, height] =
        data.thicknessSide === 'symmetric'
          ? [-thickness / 2, thickness]
          : data.thicknessSide === 'first'
            ? [0, thickness]
            : [-thickness, thickness];
      const face = regionFace(
        kernel,
        objects,
        shifted(basis, low),
        warn,
        'rib side'
      );
      tool = kernel.extrude(
        face,
        basis.normal.x,
        basis.normal.y,
        basis.normal.z,
        height
      );
      const localSide =
        middle.normal.x * side.x + middle.normal.y * side.y >= 0
          ? middle.normal
          : scale(middle.normal, -1);
      witness = point3(
        basis,
        add(middle.at, scale(localSide, nudge)),
        low + height / 2
      );
      // Closed off by the body: within the bounds of the body and profile.
      const ends = chain.flatMap((e) => [e.start, e.end]).map((p) =>
        point3(basis, p, low)
      );
      const limit = {
        min: {
          x: Math.min(box.min.x, ...ends.map((p) => p.x)) - thickness,
          y: Math.min(box.min.y, ...ends.map((p) => p.y)) - thickness,
          z: Math.min(box.min.z, ...ends.map((p) => p.z)) - thickness
        },
        max: {
          x: Math.max(box.max.x, ...ends.map((p) => p.x)) + thickness,
          y: Math.max(box.max.y, ...ends.map((p) => p.y)) + thickness,
          z: Math.max(box.max.z, ...ends.map((p) => p.z)) + thickness
        }
      };
      bounded = (lump) => {
        const b = bounds(kernel, lump);
        return (['x', 'y', 'z'] as const).every(
          (k) =>
            b.min[k] >= limit.min[k] - slack && b.max[k] <= limit.max[k] + slack
        );
      };
    } else {
      const [leftOffset, rightOffset] =
        data.thicknessSide === 'symmetric'
          ? [thickness / 2, -thickness / 2]
          : data.thicknessSide === 'first'
            ? [thickness, 0]
            : [0, -thickness];
      const leftSide = offsetChain(chain, leftOffset);
      const rightSide = offsetChain(chain, rightOffset);
      const objects = [
        ...leftSide.objects,
        lineObject(leftSide.end, rightSide.end),
        lineObject(rightSide.start, leftSide.start),
        ...rightSide.objects
      ];
      const face = regionFace(kernel, objects, basis, warn, 'thickened rib');
      const dir = sign;
      tool = kernel.extrude(
        face,
        basis.normal.x * dir,
        basis.normal.y * dir,
        basis.normal.z * dir,
        far
      );
      // The middle of the thickened band, just off the sketch plane.
      witness = point3(
        basis,
        add(middle.at, scale(middle.normal, (leftOffset + rightOffset) / 2)),
        dir * nudge
      );
      bounded = (lump) => {
        const b = bounds(kernel, lump);
        const corners = [b.min, b.max].flatMap((lo) =>
          [b.min, b.max].flatMap((mid) =>
            [b.min, b.max].map((hi) => ({ x: lo.x, y: mid.y, z: hi.z }))
          )
        );
        return corners.every(
          (c) =>
            ((c.x - basis.origin.x) * basis.normal.x +
              (c.y - basis.origin.y) * basis.normal.y +
              (c.z - basis.origin.z) * basis.normal.z) *
              dir <
            far / 2
        );
      };
    }

    const inBody =
      kernel.classifyPoint(body, witness.x, witness.y, witness.z, nudge * 1e-3) ===
      'inside';
    if (inBody) {
      kernel.deleteSolid(tool);
      throw new Error(
        'The rib profile lies inside the body; draw it in the open space the rib should fill.'
      );
    }
    let lumps: number[];
    try {
      lumps = Array.from(
        kernel.getCompoundSolids(kernel.booleanRegions('cut', tool, body))
      );
    } finally {
      kernel.deleteSolid(tool);
    }
    const chosen = lumps.filter(
      (lump) =>
        kernel.classifyPoint(lump, witness.x, witness.y, witness.z, nudge * 1e-3) ===
        'inside'
    );
    // The regions stay owned by the kernel's region compound, which has no
    // release call: they are left to the build's arena, never deleted.
    if (chosen.length !== 1) {
      throw new Error(
        'The rib has no material beside its profile on that side.'
      );
    }
    const rib = chosen[0]!;
    if (!bounded(rib)) {
      throw new Error(
        data.direction === 'parallel'
          ? 'The rib does not close against the body: extend its profile until it meets the body.'
          : 'The rib does not reach the body along the sketch normal; move its sketch so the body lies across it.'
      );
    }
    return rib;
  };
  // The default is the way that closes against the body (the profile's
  // left, or along the normal, when both do); Flip takes the other. The
  // choice is read from the geometry each rebuild, so it replays alike.
  let preferred: number;
  try {
    preferred = build(1);
  } catch (first) {
    if (data.flip) throw first;
    try {
      return build(-1);
    } catch {
      throw first;
    }
  }
  if (!data.flip) return preferred;
  return build(-1);
}
