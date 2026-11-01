/**
 * Schema v53 thread features: a screw thread modeled on a body's cylindrical
 * face by the kernel's thread generator.
 *
 * The kernel owns the thread: its helical surfaces, their certified fit, the
 * proof that the band is solid and the boolean-free gluing onto the body.
 * This module resolves what the feature leaves to the face — boss or bore,
 * the ISO size and pitch, the profile's depth and flats — applies a printed
 * fit's clearance, truncates the crest where the face cuts into it, maps the
 * kernel's typed refusals onto {@link KernelRefusal}, and raises the
 * printability advisories a 3D-printed thread needs: flanks that overhang
 * past 45°, crests narrower than an extrusion line, a thread a layer deep.
 */
import {
  UNIT_TO_MM,
  isoMetricThreadForBore,
  nearestIsoMetricThread,
  type FeatureNode,
  type ParamValue,
  type ThreadProfile
} from '@openzcad/shared';
import { resolveParamValue } from '@openzcad/document-core';

import { collapseShape } from './exact-boolean-helpers';
import type { FeatureBuildContext, FeatureDataOf } from './exact-build-loop';
import { raiseFeatureWarning } from './exact-feature-warnings';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import { classifySolidPoint, measureFaceGeometry } from './exact-measure';
import { resolveFeatureFaces } from './exact-reference-resolution';
import { inheritMeshOrigin, validateGeneratedSolid } from './exact-shape-utils';
import type { ExactShape } from './exact-types';
import { KernelRefusal } from './kernel-refusal';
import { deriveRemusBooleanCarrierLineage } from './remus-lineage';
import type {
  RemusKernel,
  SolidOperationDetailedResult
} from './remus-runtime';

/**
 * The thread entry point, typed here until the pinned kernel's declarations
 * carry it; the runtime check refuses by name on a kernel without it.
 */
interface ThreadKernel {
  cutThreadDetailed(
    solid: number,
    face: number,
    spec: string
  ): SolidOperationDetailedResult;
}

function threadKernel(kernel: RemusKernel): ThreadKernel {
  const candidate = kernel as unknown as Partial<ThreadKernel>;
  if (typeof candidate.cutThreadDetailed !== 'function') {
    throw new Error('This kernel build has no thread generator.');
  }
  return candidate as ThreadKernel;
}

/** Product copy per kernel refusal code; the kernel's sentence follows it. */
const THREAD_REFUSALS: Readonly<Record<string, string>> = {
  'thread:invalid-parameter': 'A thread parameter is out of range.',
  'thread:root-closed':
    'The crest and flanks take more than the pitch, leaving no root.',
  'thread:not-a-cylinder': 'A thread needs a cylindrical face.',
  'thread:not-a-boss-or-bore':
    'The picked cylinder is neither a boss nor a bore.',
  'thread:span-outside-face':
    'The thread runs past an end of the cylindrical face. Shorten it or reduce the offset.',
  'thread:cylinder-too-small':
    'The thread is larger than the boss. Use a smaller size.',
  'thread:bore-too-large':
    'The bore is larger than the thread. Use a larger size.',
  'thread:too-deep': 'The thread is too deep for this diameter.',
  'thread:tolerance-too-tight':
    'The thread is too long for the generator to resolve. Shorten it.',
  'thread:features-in-thread-region':
    'A hole, slot or other feature crosses the band the thread would occupy.'
};

/** The success envelope's solid, or the refusal as a throw. */
function unwrap(envelope: SolidOperationDetailedResult): number {
  if (envelope.status === 'ok') {
    return envelope.value;
  }
  const kernelMessage =
    typeof envelope.details?.message === 'string'
      ? envelope.details.message
      : envelope.code;
  const reason = THREAD_REFUSALS[envelope.code] ?? kernelMessage;
  throw new KernelRefusal({
    family: 'thread',
    category: envelope.category,
    kernelCode: envelope.code,
    kernelMessage,
    reason,
    message: `Thread: ${reason}\n${kernelMessage}`
  });
}

/** Printability guidance, in millimetres. */
const PRINT = {
  /** A typical extrusion line: a crest flat narrower than this is an edge. */
  lineWidth: 0.4,
  /** A typical layer: a thread shallower than this is one layer deep. */
  layerHeight: 0.2,
  /** Steepest overhang printed upright without support, from vertical. */
  overhangDeg: 45
} as const;

/** How the kernel is asked to cut the thread, in document units. */
export interface ResolvedThread {
  kind: 'external' | 'internal';
  majorDiameter: number;
  pitch: number;
  depth: number;
  crestWidth: number;
  upperFlankAngleDeg: number;
  lowerFlankAngleDeg: number;
  starts: number;
  hand: 'right' | 'left';
  /** From the face's lower end along its axis. */
  offset: number;
  length: number;
  phaseDeg: number;
  /** How much the face truncated the crest, radially; 0 when it did not. */
  truncation: number;
}

/** A profile's depth, crest flat and flank angles for a pitch. */
export function threadProfileForm(
  profile: Exclude<ThreadProfile, 'custom'>,
  kind: 'external' | 'internal',
  pitch: number
): {
  depth: number;
  crestWidth: number;
  upperFlankAngleDeg: number;
  lowerFlankAngleDeg: number;
} {
  if (profile === 'printable') {
    // 45° flanks with equal crest and root flats of a quarter pitch: the
    // flanks take the other half, so the depth is a quarter pitch too. The
    // groove is the tooth's mirror, so a printed boss and bore mate.
    return {
      depth: pitch / 4,
      crestWidth: pitch / 4,
      upperFlankAngleDeg: 45,
      lowerFlankAngleDeg: 45
    };
  }
  // ISO 68-1 basic profile: H = √3/2·P, depth 5H/8, crest P/8 on a boss and
  // P/4 in a bore (the boss's root).
  return {
    depth: (5 / 8) * (Math.sqrt(3) / 2) * pitch,
    crestWidth: kind === 'external' ? pitch / 8 : pitch / 4,
    upperFlankAngleDeg: 30,
    lowerFlankAngleDeg: 30
  };
}

const DEG = Math.PI / 180;

/**
 * Resolve a thread's sizes against its face. `radius` and `faceLength` are
 * the face's, in document units; `mm` is millimetres per document unit.
 */
export function resolveThread(
  data: FeatureDataOf<'thread'>,
  values: {
    optional(value: ParamValue | undefined, label: string): number | undefined;
  },
  face: { kind: 'external' | 'internal'; radius: number; faceLength: number },
  mm: number
): ResolvedThread {
  const { kind, radius, faceLength } = face;
  const typedMajor = values.optional(data.majorDiameter, 'major diameter');
  const typedPitch = values.optional(data.pitch, 'pitch');
  // The face's ISO size, when the feature leaves the diameter to it.
  const fromFace =
    kind === 'external'
      ? nearestIsoMetricThread(2 * radius * mm)
      : isoMetricThreadForBore(2 * radius * mm);
  const nominal =
    typedMajor ?? (kind === 'external' ? 2 * radius : fromFace.nominal / mm);
  const pitch = typedPitch ?? nearestIsoMetricThread(nominal * mm).pitch / mm;
  const form =
    data.profile === 'custom'
      ? {
          depth: values.optional(data.depth, 'depth')!,
          crestWidth: values.optional(data.crestWidth, 'crest width')!,
          upperFlankAngleDeg: values.optional(
            data.upperFlankAngleDeg,
            'upper flank angle'
          )!,
          lowerFlankAngleDeg: values.optional(
            data.lowerFlankAngleDeg,
            'lower flank angle'
          )!
        }
      : threadProfileForm(data.profile, kind, pitch);
  const clearance = values.optional(data.clearance, 'clearance') ?? 0;
  // The thread's outer surface: an external crest, an internal root. The
  // clearance moves the whole profile away from the mating part.
  let outer = nominal / 2 + (kind === 'external' ? -clearance : clearance);
  let { depth, crestWidth } = form;
  const flankRun =
    Math.tan(form.upperFlankAngleDeg * DEG) +
    Math.tan(form.lowerFlankAngleDeg * DEG);
  // Where the face cuts into the crest, the crest is the face: truncated
  // flat, wider by the flanks it loses.
  const crest = kind === 'external' ? outer : outer - depth;
  const cut = kind === 'external' ? crest - radius : radius - crest;
  let truncation = 0;
  if (cut > 1e-9 * Math.max(radius, 1)) {
    if (cut >= 0.75 * depth) {
      throw new Error(
        kind === 'external'
          ? 'The boss is too small for this thread: it would cut away most of its depth. Use a smaller size.'
          : 'The bore is too large for this thread: it would cut away most of its depth. Use a larger size.'
      );
    }
    truncation = cut;
    depth -= cut;
    crestWidth += cut * flankRun;
    if (kind === 'external') outer = radius;
  }
  const length =
    values.optional(data.length, 'length') ??
    faceLength - (values.optional(data.offset, 'offset') ?? 0);
  const offset = values.optional(data.offset, 'offset') ?? 0;
  const starts = Math.round(values.optional(data.starts, 'starts') ?? 1);
  return {
    kind,
    majorDiameter: 2 * outer,
    pitch,
    depth,
    crestWidth,
    upperFlankAngleDeg: form.upperFlankAngleDeg,
    lowerFlankAngleDeg: form.lowerFlankAngleDeg,
    starts,
    hand: data.hand ?? 'right',
    offset:
      (data.anchor ?? 'start') === 'end'
        ? faceLength - offset - length
        : offset,
    length,
    phaseDeg: values.optional(data.phaseDeg, 'phase') ?? 0,
    truncation
  };
}

/** Six significant digits, without exponent noise for ordinary sizes. */
function formatted(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** The printability advisories for a resolved thread, in document units. */
export function threadPrintAdvisories(
  thread: ResolvedThread,
  mm: number,
  unitLabel: string
): string[] {
  const advisories: string[] = [];
  const steepest = Math.min(
    thread.upperFlankAngleDeg,
    thread.lowerFlankAngleDeg
  );
  // A flank `a` from the plane across the axis stands 90° − a from the axis:
  // printed upright, the downward flank overhangs that far from vertical.
  if (90 - steepest > PRINT.overhangDeg + 1e-9) {
    advisories.push(
      `Printed upright, a ${formatted(steepest)}° flank overhangs ${formatted(90 - steepest)}° from vertical, past ${PRINT.overhangDeg}°. The Printable profile keeps both flanks at 45°.`
    );
  }
  const line = PRINT.lineWidth / mm;
  if (thread.crestWidth < line) {
    advisories.push(
      `The crest flat is ${formatted(thread.crestWidth)} ${unitLabel} wide, under a ${formatted(line)} ${unitLabel} extrusion line, so it prints as a sharp edge.`
    );
  }
  const layer = PRINT.layerHeight / mm;
  if (thread.depth < 1.5 * layer) {
    advisories.push(
      `The thread is ${formatted(thread.depth)} ${unitLabel} deep, about one ${formatted(layer)} ${unitLabel} layer; it may not print.`
    );
  }
  return advisories;
}

export function buildThreadFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'thread'>
): void {
  const { kernel, result, scope, document } = ctx;
  if (!feature.bodyId) {
    throw new Error('Thread has no result body.');
  }
  const target = result.shapes.get(data.targetBodyId);
  if (!target) {
    throw new Error('Thread target is unavailable.');
  }
  // Face resolution works on a single solid; fuse a multi-solid body first,
  // exactly as a hole does.
  const shape: ExactShape =
    target.solids.length === 1
      ? target
      : { solids: [collapseShape(kernel, target)] };
  const targetSolid = shape.solids[0]!;
  const face = resolveFeatureFaces(
    kernel,
    shape,
    [data.faceReference?.currentHash ?? data.faceHash],
    data.faceReference ? [data.faceReference] : undefined,
    'Thread'
  )[0]!;
  const geometry = measureFaceGeometry(kernel, face);
  if (
    geometry?.surfaceType !== 'cylinder' ||
    geometry.radius === undefined ||
    geometry.axisStart === undefined ||
    geometry.axisEnd === undefined ||
    geometry.axialLength === undefined
  ) {
    throw new Error('A thread needs a cylindrical face.');
  }
  const kind = threadKind(kernel, targetSolid, geometry);
  const values = {
    optional: (value: ParamValue | undefined, label: string) =>
      value === undefined
        ? undefined
        : resolveParamValue(value, scope, `thread ${label}`, document.units)
  };
  const mm = UNIT_TO_MM[document.units];
  const thread = resolveThread(
    data,
    values,
    { kind, radius: geometry.radius, faceLength: geometry.axialLength },
    mm
  );
  const spec = {
    pitch: thread.pitch,
    depth: thread.depth,
    crestWidth: thread.crestWidth,
    upperFlankAngle: thread.upperFlankAngleDeg,
    lowerFlankAngle: thread.lowerFlankAngleDeg,
    starts: thread.starts,
    hand: thread.hand,
    majorDiameter: thread.majorDiameter,
    offset: thread.offset,
    length: thread.length,
    phase: thread.phaseDeg
  };
  const solid = unwrap(
    threadKernel(kernel).cutThreadDetailed(
      targetSolid,
      face,
      JSON.stringify(spec)
    )
  );
  validateGeneratedSolid(kernel, solid, 'Thread');
  for (const advisory of threadPrintAdvisories(thread, mm, document.units)) {
    raiseFeatureWarning(result, feature, advisory, 'advisory');
  }
  result.consumed.add(data.targetBodyId);
  // The body's other faces keep their names through a unique analytic
  // carrier, as across a boolean.
  result.shapes.set(feature.bodyId, {
    solids: [solid],
    lineage: deriveRemusBooleanCarrierLineage({
      producingFeatureId: feature.featureId,
      operands: [
        {
          lineage: shape.lineage,
          candidates: topologyCandidatesForSolid(kernel, targetSolid),
          role: 'target'
        }
      ],
      resultCandidates: topologyCandidatesForSolid(kernel, solid)
    })
  });
  inheritMeshOrigin(result, data.targetBodyId, feature.bodyId);
}

/**
 * Boss or bore: probe just inside and just outside the cylinder halfway
 * along it. The kernel makes the same probe and refuses a face with material
 * on neither or both sides; this one only picks the ISO defaults.
 */
function threadKind(
  kernel: RemusKernel,
  solid: number,
  geometry: {
    radius?: number;
    axisStart?: { x: number; y: number; z: number };
    axisEnd?: { x: number; y: number; z: number };
  }
): 'external' | 'internal' {
  const { radius, axisStart: a, axisEnd: b } = geometry;
  if (radius === undefined || !a || !b) return 'external';
  const axis = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const length = Math.hypot(axis.x, axis.y, axis.z);
  if (!(length > 0)) return 'external';
  const unit = { x: axis.x / length, y: axis.y / length, z: axis.z / length };
  // Any direction across the axis.
  const helper =
    Math.abs(unit.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const cross = {
    x: unit.y * helper.z - unit.z * helper.y,
    y: unit.z * helper.x - unit.x * helper.z,
    z: unit.x * helper.y - unit.y * helper.x
  };
  const size = Math.hypot(cross.x, cross.y, cross.z);
  const radial = { x: cross.x / size, y: cross.y / size, z: cross.z / size };
  const middle = {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2
  };
  const at = (r: number) => ({
    x: middle.x + radial.x * r,
    y: middle.y + radial.y * r,
    z: middle.z + radial.z * r
  });
  const step = 1e-3 * radius;
  const inside = classifySolidPoint(kernel, solid, at(radius - step));
  return inside === 'inside' ? 'external' : 'internal';
}
