import type { FeatureWarning } from '@openzcad/shared';
import { plainRefusal } from './refusalLanguage';

export interface DiagnosticRow {
  /** Stable enough for a React key: the raw warning text. */
  key: string;
  featureName: string | null;
  /** The plain sentence, never the kernel's own wording or an internal id. */
  message: string;
  /** The kernel text the sentence stands for, when it was translated. */
  detail?: string;
}

const FEATURE_PREFIX = /^Feature "([^"]+)":\s*/;
const INTERNAL_ID = /\s*\b(?:body|feat|feature|sketch|node)_[0-9a-f-]{8,}\b/gi;

const REWRITES: { pattern: RegExp; sentence: string }[] = [
  {
    pattern: /^Stored cut target .*is unavailable\.?$/i,
    sentence: 'The body this feature cuts into no longer exists.'
  },
  {
    pattern: /^Stored add target .*is unavailable\.?$/i,
    sentence: 'The body this feature adds to no longer exists.'
  }
];

/**
 * The Diagnostics list as a person should read it.
 *
 * `warnings` is the rebuild's channel to the commit gate and the tests, and
 * it carries three things that do not belong in front of a user: features
 * they paused on purpose ("Suppressed; skipped during exact rebuild"), the
 * kernel's own sentences, and internal ids such as `body_cd3e…`. Suppression
 * is a state the history row already shows, so it is dropped here rather than
 * counted; the rest keeps the feature name and gets the same plain sentence
 * the tool card would show, with the original text kept as detail.
 */
export function presentedDiagnostics(
  warnings: readonly string[],
  featureWarnings?: readonly FeatureWarning[]
): DiagnosticRow[] {
  const suppressed = new Set(
    (featureWarnings ?? [])
      .filter((entry) => entry.kind === 'suppressed')
      .map((entry) => entry.message)
  );
  const rows: DiagnosticRow[] = [];
  for (const warning of warnings) {
    if (suppressed.has(warning)) continue;
    const match = FEATURE_PREFIX.exec(warning);
    const featureName = match?.[1] ?? null;
    const body = (match ? warning.slice(match[0].length) : warning).trim();
    const rewrite = REWRITES.find(({ pattern }) => pattern.test(body));
    if (rewrite) {
      rows.push({
        key: warning,
        featureName,
        message: rewrite.sentence,
        detail: body
      });
      continue;
    }
    const plain = plainRefusal(body);
    const message = plain.message
      .replace(INTERNAL_ID, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    rows.push({
      key: warning,
      featureName,
      message,
      ...(plain.detail || message !== body
        ? { detail: plain.detail ?? body }
        : {})
    });
  }
  return rows;
}
