/**
 * Schema v53 thread features: a screw thread modeled on a body's cylindrical
 * face by the kernel's thread generator. Schema v57 adds runouts and the
 * tapered NPT and BSPT pipe threads.
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
  PIPE_THREAD_TAPER,
  millimetresPerUnit,
  isoMetricThreadForBore,
  nearestIsoMetricThread,
  pipeThreadOnFace,
  threadSpanOnFace,
  type FeatureId,
  type FeatureNode,
  type ParamValue,
  type PipeThreadSpec,
  type PipeThreadStandard,
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
import {
  createRemusSemanticLineage,
  deriveRemusBooleanCarrierLineage,
  mergeRemusLineageStates,
  type RemusLineageState,
  type RemusSemanticAssignment
} from './remus-lineage';
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
    'A hole, slot or other feature crosses the band the thread would occupy.',
  'thread:ends-overlap':
    'The finishes at the two ends overlap: the thread is too short for both. Lengthen it, finish one end only, or use a larger end angle.',
  'thread:taper-out-of-range':
    'The taper is out of range: it must change the diameter by 1 in 1000 to 1 in 4.'
};

/** Where a tapered thread's copy differs: each is decided at one end. */
const TAPERED_THREAD_REFUSALS: Readonly<Record<string, string>> = {
  'thread:cylinder-too-small':
    'The tapered thread grows larger than the boss before its large end. Shorten it or use a smaller size.',
  'thread:bore-too-large':
    'The bore is wider than the tapered thread at its small end. Shorten the thread, use a smaller bore, or use a larger size.',
  'thread:too-deep':
    'The tapered thread is too deep for this diameter at its small end.'
};

/** What a successful cut reports, as far as the feature reads it. */
export interface ThreadOkDetails {
  readonly geometry?: {
    readonly taperAngle?: number;
    readonly start?: { readonly kind?: string };
    readonly end?: { readonly kind?: string };
  };
  readonly faceRoles?: readonly {
    readonly face: number;
    readonly role: string;
  }[];
}

/** The success envelope's solid and details, or the refusal as a throw. */
function unwrap(
  envelope: SolidOperationDetailedResult,
  tapered: boolean
): { solid: number; details: ThreadOkDetails } {
  if (envelope.status === 'ok') {
    return {
      solid: envelope.value,
      details: envelope.details ?? {}
    };
  }
  const kernelMessage =
    typeof envelope.details?.message === 'string'
      ? envelope.details.message
      : envelope.code;
  const reason =
    (tapered ? TAPERED_THREAD_REFUSALS[envelope.code] : undefined) ??
    THREAD_REFUSALS[envelope.code] ??
    kernelMessage;
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
  /** The chamfer cone's angle from the axis at each chamfered end. */
  chamfer: { start?: number; end?: number };
  /** Schema v57: the runout cone's angle from the axis at each such end. */
  runout?: { start?: number; end?: number };
  /** How much the face truncated the crest, radially; 0 when it did not. */
  truncation: number;
  /**
   * Schema v57 pipe threads: the kernel's taper, its small end and the
   * gauge plane's distance from it. `majorDiameter` is on the gauge plane.
   */
  taper?: { ratio: number; smallEnd: 'start' | 'end'; gaugeOffset: number };
  /** The pipe size a pipe thread was cut to, in millimetres. */
  pipe?: PipeThreadSpec;
  /**
   * A pipe thread that ends where its crest meets the cylinder, short of
   * the standard's thread: where it stops and where the standard's ends,
   * both from the fitting face.
   */
  shortOfStandard?: { stopsAt: number; standard: number };
}

/** A profile's depth, crest flat and flank angles for a pitch. */
export function threadProfileForm(
  profile: Exclude<ThreadProfile, 'custom' | PipeThreadStandard>,
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
  if (data.profile === 'npt' || data.profile === 'bspt') {
    return resolvePipeThread(data, data.profile, values, face, mm);
  }
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
    // Placed by the rule the Thread panel shares (`threadSpanOnFace`).
    offset: threadSpanOnFace({
      offset,
      length,
      anchor: data.anchor ?? 'start',
      faceLength,
      radius
    }).start,
    length,
    phaseDeg: values.optional(data.phaseDeg, 'phase') ?? 0,
    chamfer: threadChamfers(data, values),
    ...threadRunouts(data, values),
    truncation
  };
}

/**
 * Schema v57: a tapered pipe thread, NPT or BSPT. The pipe size sets the
 * pitch, the form and the major diameter on the gauge plane; the thread's
 * fitting end is the end it starts at (`anchor`). A boss tapers small toward
 * it and is gauged its gauge length in; a bore opens large at it and is
 * gauged on it (NPT) or half a pitch behind it (Rc). A taper is not
 * truncated by its face: where the crest would cross the cylinder the
 * kernel refuses, so a length left to the standard stops short of that.
 */
function resolvePipeThread(
  data: FeatureDataOf<'thread'>,
  standard: PipeThreadStandard,
  values: {
    optional(value: ParamValue | undefined, label: string): number | undefined;
  },
  face: { kind: 'external' | 'internal'; radius: number; faceLength: number },
  mm: number
): ResolvedThread {
  const { kind, radius, faceLength } = face;
  // The resolution the Thread panel shares (`pipeThreadOnFace`).
  const {
    spec: pipe,
    pitch,
    form,
    majorAtGauge,
    gaugeFromFittingEnd,
    standardLength,
    reach,
    end
  } = pipeThreadOnFace({
    standard,
    size: data.pipeSize,
    kind,
    radius,
    faceLength,
    clearance: values.optional(data.clearance, 'clearance') ?? 0,
    mm
  });
  const offset = values.optional(data.offset, 'offset') ?? 0;
  const typedLength = values.optional(data.length, 'length');
  // Every distance here is from the fitting face (the end of the face the
  // thread is anchored at), as the standards measure the gauge plane and
  // the thread's length from the pipe's end or the fitting's face: an
  // offset moves the band, never the gauge plane. Left to the standard,
  // the band ends where the standard's thread ends, within the face, and
  // where its crest meets the cylinder. One that does not fit at all keeps
  // the standard's end, and the kernel names why.
  const slack = (size: number) => 1e-9 * Math.max(size, 1);
  if (typedLength === undefined && end - offset <= slack(end)) {
    throw new Error(
      `The offset leaves this pipe thread no length: it would end ${formatted(end)} from the fitting end, and the offset is ${formatted(offset)}. Reduce the offset or set the length.`
    );
  }
  const length = typedLength ?? end - offset;
  const fittingEnd = data.anchor ?? 'start';
  const farEnd = fittingEnd === 'start' ? 'end' : 'start';
  // Derived from where the band ends, so a length the panel stored from
  // this same rule warns as one left to it does.
  const stopsAtCrest =
    reach > 0 &&
    reach < Math.min(standardLength, faceLength) - slack(standardLength) &&
    Math.abs(offset + length - reach) <= 1e-6 * Math.max(standardLength, 1);
  return {
    kind,
    majorDiameter: majorAtGauge,
    pitch,
    depth: form.depth,
    crestWidth: form.crestWidth,
    upperFlankAngleDeg: form.flankAngleDeg,
    lowerFlankAngleDeg: form.flankAngleDeg,
    starts: Math.round(values.optional(data.starts, 'starts') ?? 1),
    hand: data.hand ?? 'right',
    offset: threadSpanOnFace({
      offset,
      length,
      anchor: fittingEnd,
      faceLength,
      radius
    }).start,
    length,
    phaseDeg: values.optional(data.phaseDeg, 'phase') ?? 0,
    chamfer: threadChamfers(data, values),
    ...threadRunouts(data, values),
    truncation: 0,
    // The kernel's gauge offset runs from the band's small end toward its
    // large end, and may fall outside the band. A boss's small end is the
    // band's fitting side, `offset` from the fitting face; a bore's is its
    // far side, `offset + length` from it.
    taper:
      kind === 'external'
        ? {
            ratio: PIPE_THREAD_TAPER,
            smallEnd: fittingEnd,
            gaugeOffset: gaugeFromFittingEnd - offset
          }
        : {
            ratio: PIPE_THREAD_TAPER,
            smallEnd: farEnd,
            gaugeOffset: offset + length - gaugeFromFittingEnd
          },
    pipe,
    ...(stopsAtCrest
      ? {
          shortOfStandard: {
            stopsAt: offset + length,
            standard: standardLength
          }
        }
      : {})
  };
}

/** Schema v57: the run-out ends' cone angles; absent when there are none. */
function threadRunouts(
  data: FeatureDataOf<'thread'>,
  values: {
    optional(value: ParamValue | undefined, label: string): number | undefined;
  }
): { runout?: { start?: number; end?: number } } {
  if (!data.runoutStart && !data.runoutEnd) return {};
  const angle = values.optional(data.chamferAngleDeg, 'runout angle') ?? 45;
  return {
    runout: {
      ...(data.runoutStart ? { start: angle } : {}),
      ...(data.runoutEnd ? { end: angle } : {})
    }
  };
}

/** The chamfered ends' cone angles, in degrees; absent ends are plain. */
function threadChamfers(
  data: FeatureDataOf<'thread'>,
  values: {
    optional(value: ParamValue | undefined, label: string): number | undefined;
  }
): { start?: number; end?: number } {
  const angle = values.optional(data.chamferAngleDeg, 'chamfer angle') ?? 45;
  return {
    ...(data.chamferStart ? { start: angle } : {}),
    ...(data.chamferEnd ? { end: angle } : {})
  };
}

interface ThreadEndKind {
  kind: 'chamfer' | 'runout';
  angle: number;
}

/**
 * The kernel spec's end fields: present only for a finished end, a chamfer
 * or (schema v57) a runout. An end asked for both is refused.
 */
export function threadEndSpec(
  thread: Pick<ResolvedThread, 'chamfer' | 'runout'>
): { start?: ThreadEndKind; end?: ThreadEndKind } {
  const spec: { start?: ThreadEndKind; end?: ThreadEndKind } = {};
  for (const end of ['start', 'end'] as const) {
    const chamfer = thread.chamfer[end];
    const runout = thread.runout?.[end];
    if (chamfer !== undefined && runout !== undefined) {
      throw new Error(
        `The thread's ${end} takes a chamfer or a runout, not both.`
      );
    }
    if (chamfer !== undefined) spec[end] = { kind: 'chamfer', angle: chamfer };
    if (runout !== undefined) spec[end] = { kind: 'runout', angle: runout };
  }
  return spec;
}

/**
 * The chamfered ends that stop short of their end of the face. A chamfer's
 * cone is built into an end standing on the face's end plane; the kernel has
 * no chamfer for an end that stops against a collar of the face. The slack
 * is the kernel's own, within which a span snaps to the face's end. A span
 * past the face has none: the kernel refuses that with its own code.
 */
export function threadChamfersShortOfFace(
  thread: Pick<ResolvedThread, 'offset' | 'length' | 'chamfer'>,
  face: { radius: number; faceLength: number }
): ('start' | 'end')[] {
  // The rule the Thread panel shares, so it never asks for a chamfer here.
  const span = threadSpanOnFace({
    offset: thread.offset,
    length: thread.length,
    faceLength: face.faceLength,
    radius: face.radius
  });
  if (span.outside) return [];
  const short: ('start' | 'end')[] = [];
  if (thread.chamfer.start !== undefined && !span.reachesStart) {
    short.push('start');
  }
  if (thread.chamfer.end !== undefined && !span.reachesEnd) {
    short.push('end');
  }
  return short;
}

/**
 * Refuse, by code, a chamfer on an end that stops short of the face: the
 * kernel answers that case with its general `thread:invalid-parameter`.
 */
function refuseChamferShortOfFace(
  thread: ResolvedThread,
  face: { radius: number; faceLength: number },
  unitLabel: string
): void {
  const short = threadChamfersShortOfFace(thread, face);
  if (short.length === 0) return;
  const stop = thread.offset + thread.length;
  const kernelMessage = `the thread spans ${formatted(thread.offset)}..${formatted(stop)} ${unitLabel} along a face ${formatted(face.faceLength)} ${unitLabel} long, chamfered at its ${short.join(' and ')}`;
  const reason =
    short.length === 2
      ? 'A chamfered end must reach the end of the face, and this thread stops short of both. Run it to an end, or run the thread out there instead.'
      : `A chamfered end must reach the end of the face, and this thread stops short of the face's ${short[0]}. Run it to that end, or run the thread out there instead.`;
  throw new KernelRefusal({
    family: 'thread',
    category: 'unsupported',
    kernelCode: 'thread:chamfer-short-of-face',
    kernelMessage,
    reason,
    message: `Thread: ${reason}\n${kernelMessage}`
  });
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
  if (thread.shortOfStandard !== undefined) {
    advisories.push(
      `The pipe thread stops ${formatted(thread.shortOfStandard.stopsAt)} ${unitLabel} from its fitting end, where its crest meets the ${thread.kind === 'external' ? 'boss' : 'bore'}, short of the standard's ${formatted(thread.shortOfStandard.standard)} ${unitLabel}.`
    );
  }
  if (thread.pipe?.standard === 'bspt') {
    advisories.push(
      'The BSPT profile is approximate: its rounded crests and roots are modelled as flats.'
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
  const mm = millimetresPerUnit(document.units);
  const thread = resolveThread(
    data,
    values,
    { kind, radius: geometry.radius, faceLength: geometry.axialLength },
    mm
  );
  refuseChamferShortOfFace(
    thread,
    { radius: geometry.radius, faceLength: geometry.axialLength },
    document.units
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
    phase: thread.phaseDeg,
    // Sent only for a finished end, so a plain thread builds on a kernel
    // from before chamfers.
    ...threadEndSpec(thread),
    // Schema v57: only a pipe thread tapers.
    ...(thread.taper ? { taper: thread.taper } : {})
  };
  const { solid, details } = unwrap(
    threadKernel(kernel).cutThreadDetailed(
      targetSolid,
      face,
      JSON.stringify(spec)
    ),
    thread.taper !== undefined
  );
  requireBuiltAsAsked(thread, details);
  validateGeneratedSolid(kernel, solid, 'Thread');
  for (const advisory of threadPrintAdvisories(thread, mm, document.units)) {
    raiseFeatureWarning(result, feature, advisory, 'advisory');
  }
  result.consumed.add(data.targetBodyId);
  // The body's other faces keep their names through a unique analytic
  // carrier, as across a boolean; the thread's own faces take their roles
  // where a role names one face.
  const carried = deriveRemusBooleanCarrierLineage({
    producingFeatureId: feature.featureId,
    operands: [
      {
        lineage: shape.lineage,
        candidates: topologyCandidatesForSolid(kernel, targetSolid),
        role: 'target'
      }
    ],
    resultCandidates: topologyCandidatesForSolid(kernel, solid)
  });
  result.shapes.set(feature.bodyId, {
    solids: [solid],
    lineage: mergeRemusLineageStates([
      threadRoleLineage(kernel, solid, feature.featureId, details, carried),
      carried
    ])
  });
  inheritMeshOrigin(result, data.targetBodyId, feature.bodyId);
}

/**
 * The kernel reports what it built at each end and the taper it cut. A
 * runout or a taper it did not report was not built, so the feature refuses
 * rather than show a thread other than the one it stores.
 */
export function requireBuiltAsAsked(
  thread: Pick<ResolvedThread, 'runout' | 'taper'>,
  details: ThreadOkDetails
): void {
  for (const end of ['start', 'end'] as const) {
    if (
      thread.runout?.[end] !== undefined &&
      details.geometry?.[end]?.kind !== 'runout'
    ) {
      throw new Error('This kernel build has no thread runouts.');
    }
  }
  if (thread.taper && !(Number(details.geometry?.taperAngle) > 0)) {
    throw new Error('This kernel build has no tapered threads.');
  }
}

/**
 * Names for the thread's own faces from the kernel's face roles, e.g.
 * `thread.face.runout.end`. A thread is a stack of half-turn segments, so
 * most roles (crest, root, flanks) are held by many faces: only a role held
 * by exactly one face names it, and never a face the body's own names
 * already carry. The rest stay unnamed rather than be told apart by
 * guesswork (ADR-013).
 */
export function threadRoleLineage(
  kernel: RemusKernel,
  solid: number,
  featureId: FeatureId,
  details: ThreadOkDetails,
  carried: Pick<RemusLineageState, 'faceReferences'>
): RemusLineageState {
  const roles = details.faceRoles ?? [];
  const held = new Map<string, number>();
  for (const { role } of roles) held.set(role, (held.get(role) ?? 0) + 1);
  const candidates = new Map(
    topologyCandidatesForSolid(kernel, solid)
      .filter((candidate) => candidate.kind === 'face')
      .map((candidate) => [candidate.handle, candidate] as const)
  );
  const assignments: RemusSemanticAssignment[] = [];
  for (const { face, role } of roles) {
    const candidate = candidates.get(face);
    if (
      candidate &&
      held.get(role) === 1 &&
      !carried.faceReferences.has(face)
    ) {
      assignments.push({ ...candidate, lineageName: `thread.face.${role}` });
    }
  }
  return createRemusSemanticLineage(featureId, 'primitive', assignments);
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
