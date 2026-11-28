import type { BodyClashVerdict, UnitSystem, Vector3 } from '@openzcad/shared';
import { formatMeasuredQuantity, formatNumber } from '../model';
import { unitLabel } from '../measurements';

export type InterferenceTone = 'interference' | 'unknown' | 'contact' | 'clear';

export interface InterferenceVerdictText {
  tone: InterferenceTone;
  /** Short value beside the pair: "125 mm³", "Touching", "Clear". */
  value: string;
  /** The witness, in words, shown under a picked pair. */
  detail: string;
}

function point(p: Vector3, unit: string): string {
  return `(${formatNumber(p.x)}, ${formatNumber(p.y)}, ${formatNumber(p.z)}) ${unit}`;
}

/**
 * AS04 wording for one pair's exact verdict. Every figure says where it came
 * from: an exact intersection, an exact difference, or a certified distance,
 * and an unmeasured value is never shown as zero.
 */
export function describeInterference(
  verdict: BodyClashVerdict,
  units: UnitSystem
): InterferenceVerdictText {
  const length = unitLabel('length', units);
  const volume = unitLabel('volume', units);
  if (verdict.kind === 'interference') {
    const measured =
      verdict.volume === null
        ? null
        : `${formatMeasuredQuantity(verdict.volume)} ${volume}`;
    const value =
      measured === null
        ? 'Overlap'
        : verdict.complete
          ? measured
          : `≥ ${measured}`;
    const parts: string[] = [];
    if (measured !== null) {
      parts.push(
        `${verdict.complete ? '' : 'At least '}${measured} shared, measured by an exact ${
          verdict.proof === 'intersect' ? 'intersection' : 'difference'
        }.`
      );
    } else {
      parts.push(
        'The kernel could not measure the shared volume; a point inside both parts proves they overlap.'
      );
    }
    if (verdict.bounds) {
      const { min, max } = verdict.bounds;
      parts.push(
        `Overlap region ${formatNumber(max.x - min.x)} × ${formatNumber(
          max.y - min.y
        )} × ${formatNumber(max.z - min.z)} ${length}.`
      );
    }
    if (verdict.point) {
      parts.push(`Inside both at ${point(verdict.point, length)}.`);
    }
    return { tone: 'interference', value, detail: parts.join(' ') };
  }
  if (verdict.kind === 'unknown') {
    return {
      tone: 'unknown',
      value: 'Unknown',
      detail: `Not checked exactly: ${verdict.message.replace(/[.\s]+$/, '')}. This pair is not reported as clear.`
    };
  }
  if (verdict.touching === true) {
    return {
      tone: 'contact',
      value: 'Touching',
      detail: verdict.closest
        ? `The parts meet without overlapping, at ${point(verdict.closest[0], length)}.`
        : 'The parts meet without overlapping.'
    };
  }
  if (verdict.distance !== null) {
    const gap = `${formatNumber(verdict.distance)} ${length}`;
    return {
      tone: 'clear',
      value: `${gap} gap`,
      detail: verdict.closest
        ? `Certified minimum distance ${gap}, between ${point(
            verdict.closest[0],
            length
          )} and ${point(verdict.closest[1], length)}.`
        : `Certified minimum distance ${gap}.`
    };
  }
  return {
    tone: 'clear',
    value: 'Clear',
    detail:
      verdict.atLeast !== null
        ? `No shared volume; at least ${formatNumber(verdict.atLeast)} ${length} apart.`
        : verdict.touching === null
          ? 'No shared volume. Whether the parts touch is not certified on these surfaces.'
          : 'No shared volume.'
  };
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "1 pair overlaps", "3 pairs of parts overlap". */
function overlapping(count: number, ofParts = false) {
  const noun = `${count === 1 ? 'pair' : 'pairs'}${ofParts ? ' of parts' : ''}`;
  return `${count} ${noun} ${count === 1 ? 'overlaps' : 'overlap'}`;
}

export interface InterferenceSummaryText {
  /** The section's own line, above the pairs. */
  headline: string;
  /** The workspace status message when the check finishes. */
  status: string;
}

/**
 * AS04 one-line summary of the static check. It checks the saved joint
 * values, the rest position, and says so: a study, a scrub or a sweep's
 * "Show" can pose the view somewhere else, where the parts may well clash
 * (#2154). "No parts overlap" is a claim about every pair, so it is made only
 * when every pair was decided: an undecided pair or a part with no geometry
 * leaves it "no overlap found, but …".
 */
export function describeInterferenceSummary(summary: {
  interfering: number;
  unknown: number;
  missing: number;
}): InterferenceSummaryText {
  const unchecked = [
    summary.unknown > 0
      ? `${plural(summary.unknown, 'pair')} could not be checked exactly`
      : '',
    summary.missing > 0
      ? `${plural(summary.missing, 'part')} had no geometry to check`
      : ''
  ]
    .filter(Boolean)
    .join(' and ');
  if (summary.interfering > 0) {
    const rest = unchecked ? `; ${unchecked}` : '';
    return {
      headline: `${overlapping(summary.interfering)} at the rest position${rest}.`,
      status: `Interference: ${overlapping(summary.interfering, true)} at the rest position${rest}.`
    };
  }
  if (unchecked)
    return {
      headline: `No overlap found at the rest position, but ${unchecked}.`,
      status: `Interference: no overlap found at the rest position, but ${unchecked}.`
    };
  return {
    headline: 'No parts overlap at the rest position.',
    status: 'Interference: no parts overlap at the rest position.'
  };
}

/** Said beside a static result while the view is posed somewhere else. */
export const INTERFERENCE_OTHER_POSITION =
  'The view shows another position, which this check does not cover.';

/**
 * AS04 one-line summary of a sweep. "No overlap at the positions checked"
 * is a claim about every moving pair at every one of them, so it is made
 * only when each was decided: a pair unknown somewhere (at every position,
 * for a pair the kernel cannot intersect) or a part with no geometry is
 * counted in the same line, never left to the rows below it (#2183).
 */
export function describeSweepSummary(
  counts: {
    overlapping: number;
    unknown: number;
    unknownEverywhere: number;
    onlyUnknown: { positions: number; checked: number } | null;
    missing: number;
  },
  /** Positions checked, refinements included. */
  checked: number,
  /** The motion, as the picker names it. */
  motion: string
): InterferenceSummaryText {
  const undecided =
    counts.unknown === 0
      ? ''
      : counts.onlyUnknown
        ? counts.onlyUnknown.positions >= counts.onlyUnknown.checked
          ? `1 pair could not be checked exactly at any of its ${plural(counts.onlyUnknown.checked, 'position')}`
          : `1 pair could not be checked exactly at ${counts.onlyUnknown.positions} of its ${plural(counts.onlyUnknown.checked, 'position')}`
        : `${counts.unknown} pairs could not be checked exactly at ${
            counts.unknownEverywhere === counts.unknown
              ? 'any position'
              : 'some positions'
          }`;
  const unchecked = [
    undecided,
    counts.missing > 0
      ? `${plural(counts.missing, 'part')} had no geometry to check`
      : ''
  ]
    .filter(Boolean)
    .join(' and ');
  if (counts.overlapping > 0) {
    const rest = unchecked ? `; ${unchecked}` : '';
    return {
      headline: `${overlapping(counts.overlapping)} along the motion${rest}.`,
      status: `Interference through motion: ${overlapping(counts.overlapping, true)} along ${motion}${rest}.`
    };
  }
  if (unchecked)
    return {
      headline: `No overlap found at the ${plural(checked, 'position')} checked, but ${unchecked}.`,
      status: `Interference through motion: no overlap found at ${plural(checked, 'position')} checked along ${motion}, but ${unchecked}.`
    };
  return {
    headline: `No overlap at the ${plural(checked, 'position')} checked.`,
    status: `Interference through motion: no overlap at ${plural(checked, 'position')} checked along ${motion}.`
  };
}

/**
 * A part's name in a result, with the configuration row it was checked in
 * when that is not the model's own: "Plate (Wide)" (#2388).
 */
export function checkedPartName(
  name: string,
  configuration: { rowName: string } | undefined
): string {
  return configuration ? `${name} (${configuration.rowName})` : name;
}
