import { parseAllEdgesFilletRequest } from '@openzcad/ai-contracts';
import type { UnitSystem } from '@openzcad/shared';
import type { AssistantEntry } from './conversation';
import { blendRefusalText, smallerSizeIn } from '../inPlace/sizeRefusal';

/**
 * The preamble a proposal that failed exact preview opens with. It names the
 * gate, not the problem: the reason the kernel gave follows it.
 */
const PREFLIGHT_PREAMBLE = /did not pass exact geometry preflight/;

export interface FailureParts {
  /** One line naming what went wrong. */
  headline: string;
  /** Everything else, read under the headline. */
  detail: string | null;
}

/** The first sentence, ending at a stop followed by space or the end. */
function firstSentence(text: string): [string, string] {
  const match = /^([\s\S]+?[.!?])(?=\s|$)/.exec(text);
  if (!match) return [text, ''];
  return [match[1]!, text.slice(match[1]!.length).trim()];
}

export function isPreflightFailure(text: string): boolean {
  return PREFLIGHT_PREAMBLE.test(text);
}

/**
 * A failure's headline and the rest. A preflight failure leads with the
 * kernel's own first sentence ("Fillet could not be created on 126 edges
 * with radius 2 mm."), which says what failed, without the feature name it
 * opens with, and keeps the preamble ("Nothing was changed.") with the rest
 * of the reason. The kernel's sizes are unit-free; `unit` writes the
 * document's after them. Any other failure leads with its first paragraph.
 */
export function failureParts(
  text: string,
  unit: string | null = null
): FailureParts {
  const trimmed = text.trim();
  const [first = '', ...rest] = trimmed.split(/\n{2,}/);
  const remainder = rest.join('\n\n').trim();
  if (remainder && isPreflightFailure(first)) {
    const [headline, after] = firstSentence(blendRefusalText(remainder, unit));
    const detail = [after, first.trim()].filter(Boolean).join('\n\n');
    return { headline, detail: detail || null };
  }
  return { headline: first.trim(), detail: remainder || null };
}

const UNIT_LABEL: Record<UnitSystem, string> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  inch: 'in'
};

/** The document unit as the failure text writes it after a size. */
export function unitLabel(units: UnitSystem): string {
  return UNIT_LABEL[units];
}

/** The fillet default the recipe uses when the ask names no radius. */
const DEFAULT_FILLET_RADIUS = 2;

/**
 * For an all-edge fillet that failed exact preview, the same ask at a
 * smaller radius: the one the kernel proved builds, when its refusal names
 * one ("radius 8.75 builds here", in document units), else half the radius
 * asked for. The result is a new ask, previewed exactly like the first, so a
 * radius that still fails says so again. Null for any other ask.
 */
export function smallerFilletRetry(
  ask: string,
  units: UnitSystem,
  failure: string | null = null
): { label: string; text: string } | null {
  const request = parseAllEdgesFilletRequest(ask);
  if (!request) return null;
  const target = request.target ? ` of ${request.target}` : '';
  const proved = failure ? smallerSizeIn(failure) : null;
  if (proved?.dimension === 'radius') {
    const unit = UNIT_LABEL[units];
    return {
      label: `Try ${proved.size} ${unit}`,
      text: `Fillet all edges${target} at ${proved.size} ${unit}`
    };
  }
  const radius = request.radius ?? DEFAULT_FILLET_RADIUS;
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const half = Number((radius / 2).toPrecision(3));
  if (!(half > 0)) return null;
  const unit = UNIT_LABEL[request.unit ?? units] ?? UNIT_LABEL[units];
  return {
    label: `Try ${half} ${unit}`,
    text: `Fillet all edges${target} at ${half} ${unit}`
  };
}

export type AssistantLatestTone = 'error' | 'proposal' | 'questions' | 'reply';

/** The newest reply, in the few words the closed prompt line has room for. */
export interface AssistantLatest {
  tone: AssistantLatestTone;
  text: string;
}

export function latestReplySummary(
  entries: readonly AssistantEntry[],
  unit: string | null = null
): AssistantLatest | null {
  const entry = entries.at(-1);
  if (!entry || entry.kind === 'user') return null;
  if (entry.kind === 'proposal') {
    if (entry.status === 'applied') return { tone: 'reply', text: 'Applied' };
    if (entry.status === 'rejected') return null;
    return { tone: 'proposal', text: 'Change ready to review' };
  }
  if (entry.kind === 'questions') {
    return { tone: 'questions', text: 'Question for you' };
  }
  if (entry.tone === 'error') {
    return { tone: 'error', text: failureParts(entry.text, unit).headline };
  }
  return { tone: 'reply', text: 'New reply' };
}
