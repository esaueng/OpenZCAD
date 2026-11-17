import {
  createModelPmiId,
  DRAWING_CHARACTERISTIC_LABELS,
  drawingFaceRefError,
  type GeometryBodyRepresentation,
  DRAWING_DATUM_REQUIRED_CHARACTERISTICS,
  type BodyId,
  type DrawingFaceRef,
  type FaceTopology,
  type ModelPmiAnnotation,
  type ModelPmiId,
  type ModelPmiSet,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import { resolveFace, topologyResolutionMessage } from '../topologyResolution';

import type {
  datumFeatureLayout,
  featureControlFrameLayout,
  FrameCells,
  FrameLayout
} from '../drawing/toleranceFrames';

/**
 * The drawing's frame and datum geometry, handed in by the caller (it loads
 * them with the drawing workspace's chunk), so this module shares no chunk
 * with the drawing code.
 */
export interface PmiFrameLayouts {
  datumFeatureLayout: typeof datumFeatureLayout;
  featureControlFrameLayout: typeof featureControlFrameLayout;
}

/**
 * D07 slice C: the model's PMI as the workspace shows it — each entry
 * resolved against the current bodies (its face by lineage, then hash,
 * never a nearby face), named for lists, and drawn for the viewport with
 * the same frame and symbol geometry a drawing prints. Loaded on demand, so
 * none of it weighs on the entry chunk.
 */

export type ModelPmiResolution =
  | { ok: true; face: FaceTopology }
  | {
      ok: false;
      reason: 'body-missing' | 'not-found' | 'ambiguous' | 'datum-undefined';
      message: string;
    };

type Bodies = Readonly<Record<string, GeometryBodyRepresentation | undefined>>;

/** Fixed decimals with trailing zeros trimmed; never "-0". */
function formatAmount(value: number): string {
  const trimmed = value.toFixed(6).replace(/\.?0+$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

/** The first datum letter not taken: A, B, … (no I, O, Q), then AA, …. */
function nextDatumLetter(used: Iterable<string>): string {
  const taken = new Set(used);
  const singles = [...'ABCDEFGHJKLMNPRSTUVWXYZ'];
  for (const letter of singles) if (!taken.has(letter)) return letter;
  for (const first of singles)
    for (const second of singles)
      if (!taken.has(first + second)) return first + second;
  return 'A';
}

/** Each entry's face now, or why it has none. */
export function resolveModelPmi(
  pmi: ModelPmiSet | undefined,
  bodies: Bodies
): Map<ModelPmiId, ModelPmiResolution> {
  const annotations = pmi?.annotations ?? [];
  const letters = new Set(
    annotations.flatMap((entry) =>
      entry.kind === 'datum-feature' ? [entry.letter] : []
    )
  );
  const out = new Map<ModelPmiId, ModelPmiResolution>();
  for (const annotation of annotations) {
    const found = resolveFace(bodies[annotation.face.bodyId], annotation.face);
    if (!found.ok) {
      out.set(annotation.pmiId, {
        ok: false,
        reason: found.reason,
        message: topologyResolutionMessage(found.reason).replace(
          'this measured',
          'this tolerances'
        )
      });
      continue;
    }
    if (
      annotation.kind === 'feature-control-frame' &&
      (annotation.datums ?? []).some((datum) => !letters.has(datum.letter))
    ) {
      out.set(annotation.pmiId, {
        ok: false,
        reason: 'datum-undefined',
        message:
          'This frame names a datum no datum feature on the model declares.'
      });
      continue;
    }
    out.set(annotation.pmiId, { ok: true, face: found.entry });
  }
  return out;
}

/** A frame's cells, its amount written in the document's units. */
export function modelFrameCells(
  annotation: Extract<ModelPmiAnnotation, { kind: 'feature-control-frame' }>
): FrameCells {
  return {
    characteristic: annotation.characteristic,
    tolerance: formatAmount(annotation.amount),
    diameterZone: annotation.diameterZone === true,
    ...(annotation.material ? { material: annotation.material } : {}),
    datums: (annotation.datums ?? []).map((datum) => ({ ...datum }))
  };
}

/** What lists and the viewport call an entry. */
export function modelPmiName(annotation: ModelPmiAnnotation): string {
  if (annotation.kind === 'datum-feature') return `Datum ${annotation.letter}`;
  const cells = modelFrameCells(annotation);
  const modifier = (material?: string) =>
    material === 'mmc' ? ' (M)' : material === 'lmc' ? ' (L)' : '';
  return [
    DRAWING_CHARACTERISTIC_LABELS[annotation.characteristic],
    `${cells.diameterZone ? 'Ø' : ''}${cells.tolerance}${modifier(cells.material)}`,
    ...cells.datums.map((datum) => `${datum.letter}${modifier(datum.material)}`)
  ].join(' | ');
}

/** A new frame's tolerance: about 0.1 mm, a round number in each unit. */
const DEFAULT_AMOUNT: Readonly<Record<UnitSystem, number>> = {
  mm: 0.1,
  cm: 0.01,
  m: 0.0001,
  inch: 0.004
};

/**
 * The stored face of a picked face, as a drawing stores one: its lineage
 * when it is trusted and names this face alone, else its hash; null when
 * neither picks out this face alone.
 */
export function pmiFaceRef(
  bodies: Bodies,
  bodyId: BodyId,
  hash: number
): DrawingFaceRef | null {
  const body = bodies[bodyId];
  const face = body?.topology?.faces.find(
    (candidate) => candidate.hash === hash
  );
  if (!face) return null;
  // The lineage name when it is this face's current one and storable;
  // either way the reference must resolve back to this face alone.
  const full: DrawingFaceRef = {
    bodyId,
    hash: face.hash,
    ...(face.reference ? { reference: face.reference } : {})
  };
  const ref =
    face.reference &&
    face.reference.currentHash === face.hash &&
    drawingFaceRefError(full) === null
      ? full
      : { bodyId, hash: face.hash };
  const found = resolveFace(body, ref);
  return found.ok && found.entry === face ? ref : null;
}

/**
 * A new datum feature (the next free letter) or frame (flatness, which
 * needs no datum) on `face`, its leader landing on `anchor`.
 */
export function draftModelPmi(
  kind: ModelPmiAnnotation['kind'],
  face: DrawingFaceRef,
  anchor: Vector3,
  pmi: ModelPmiSet | undefined,
  units: UnitSystem
): ModelPmiAnnotation {
  const base = {
    pmiId: createModelPmiId(),
    face,
    anchor: { x: anchor.x, y: anchor.y, z: anchor.z }
  };
  if (kind === 'datum-feature')
    return {
      ...base,
      kind,
      letter: nextDatumLetter(
        (pmi?.annotations ?? []).flatMap((entry) =>
          entry.kind === 'datum-feature' ? [entry.letter] : []
        )
      )
    };
  return {
    ...base,
    kind,
    characteristic: 'flatness',
    amount: DEFAULT_AMOUNT[units]
  };
}

/** Where a face's label anchors when no pick point is known: its centre. */
export function faceAnchor(face: FaceTopology): Vector3 | null {
  const geometry = face.geometry;
  const point = geometry?.centroid ?? geometry?.center;
  return point ? { x: point.x, y: point.y, z: point.z } : null;
}

/** Whether a characteristic needs a datum (for the editor). */
export function needsDatum(
  annotation: Extract<ModelPmiAnnotation, { kind: 'feature-control-frame' }>
): boolean {
  return DRAWING_DATUM_REQUIRED_CHARACTERISTICS.includes(
    annotation.characteristic
  );
}

const PX_PER_MM = 4;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A frame layout as standalone SVG markup, in CSS pixels. */
function layoutSvg(layout: FrameLayout): string {
  const pad = 0.5;
  const { x, y, width, height } = layout.box;
  const w = (width + 2 * pad) * PX_PER_MM;
  const h = (height + 2 * pad) * PX_PER_MM;
  // Paper y is up; SVG y is down.
  const px = (u: number) => ((u - x + pad) * PX_PER_MM).toFixed(2);
  const py = (v: number) => ((y + height + pad - v) * PX_PER_MM).toFixed(2);
  const paths = layout.strokes.map((stroke) => {
    const points: string[] = [];
    for (let i = 0; i + 1 < stroke.points.length; i += 2)
      points.push(`${px(stroke.points[i]!)},${py(stroke.points[i + 1]!)}`);
    const d = `M${points.join('L')}${stroke.closed || stroke.filled ? 'Z' : ''}`;
    return stroke.filled
      ? `<path d="${d}" class="pmi-fill"/>`
      : `<path d="${d}" class="pmi-stroke"/>`;
  });
  const texts = layout.texts.map(
    (text) =>
      `<text x="${px(text.x)}" y="${py(text.y)}" font-size="${(
        (text.sizeMm / 0.718) *
        PX_PER_MM
      ).toFixed(
        2
      )}"${text.align === 'middle' ? ' text-anchor="middle"' : ''}>${escapeXml(text.text)}</text>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}" height="${h.toFixed(1)}" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" aria-hidden="true">${paths.join('')}${texts.join('')}</svg>`;
}

/** An entry's frame or datum symbol, drawn as on a drawing. */
export function modelPmiSvg(
  annotation: ModelPmiAnnotation,
  layouts: PmiFrameLayouts
): string {
  return layoutSvg(
    annotation.kind === 'datum-feature'
      ? layouts.datumFeatureLayout(annotation.letter, [0, 0], null)
      : layouts.featureControlFrameLayout(modelFrameCells(annotation), [0, 0])
  );
}

/** One viewport label: where it anchors, what it draws, and its state. */
export interface PmiViewportLabel {
  pmiId: string;
  anchor: Vector3;
  svg: string;
  name: string;
  broken: boolean;
  selected: boolean;
}

type V3 = { x: number; y: number; z: number };

/** The point of triangle (a, b, c) nearest `p` (Ericson, RTCD 5.1.5). */
function nearestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const sub = (u: V3, v: V3) => ({ x: u.x - v.x, y: u.y - v.y, z: u.z - v.z });
  const dot = (u: V3, v: V3) => u.x * v.x + u.y * v.y + u.z * v.z;
  const at = (u: V3, v: V3, t: number) => ({
    x: u.x + v.x * t,
    y: u.y + v.y * t,
    z: u.z + v.z * t
  });
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return at(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return {
    x: a.x + ab.x * v + ac.x * w,
    y: a.y + ab.y * v + ac.y * w,
    z: a.z + ab.z * v + ac.z * w
  };
}

/**
 * Where an entry's leader lands now: the point of its face, as the model
 * has it now, nearest the stored anchor. A face that moved or changed size
 * carries its label with it, and a label never sits on another face. The
 * stored anchor when the face's triangles are not at hand.
 */
export function pmiAnchorOnFace(
  body: GeometryBodyRepresentation | undefined,
  face: FaceTopology,
  anchor: V3
): V3 {
  const mesh = body?.mesh;
  if (!mesh || face.triangleCount <= 0) return anchor;
  const vertex = (index: number): V3 => {
    const at = mesh.indices[index]! * 3;
    return {
      x: mesh.vertices[at]!,
      y: mesh.vertices[at + 1]!,
      z: mesh.vertices[at + 2]!
    };
  };
  let best: V3 | null = null;
  let bestDistance = Infinity;
  const end = (face.triangleStart + face.triangleCount) * 3;
  for (let index = face.triangleStart * 3; index + 2 < end; index += 3) {
    const point = nearestOnTriangle(
      anchor,
      vertex(index),
      vertex(index + 1),
      vertex(index + 2)
    );
    const distance =
      (point.x - anchor.x) ** 2 +
      (point.y - anchor.y) ** 2 +
      (point.z - anchor.z) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best ?? anchor;
}

export function pmiViewportLabels(
  pmi: ModelPmiSet | undefined,
  bodies: Bodies,
  selectedPmiId: string | null,
  layouts: PmiFrameLayouts
): PmiViewportLabel[] {
  const resolutions = resolveModelPmi(pmi, bodies);
  return (pmi?.annotations ?? []).map((annotation) => {
    const resolution = resolutions.get(annotation.pmiId);
    return {
      pmiId: annotation.pmiId,
      anchor: resolution?.ok
        ? pmiAnchorOnFace(
            bodies[annotation.face.bodyId],
            resolution.face,
            annotation.anchor
          )
        : annotation.anchor,
      svg: modelPmiSvg(annotation, layouts),
      name: modelPmiName(annotation),
      broken: !resolution?.ok,
      selected: annotation.pmiId === selectedPmiId
    };
  });
}
