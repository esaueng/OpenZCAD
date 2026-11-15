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
