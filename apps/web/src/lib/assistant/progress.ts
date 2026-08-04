/**
 * What the assistant is doing, read off the reply while it is still arriving.
 *
 * The provider streams one JSON object, so there is nothing prose-shaped to
 * show until it closes — which is exactly the stretch where a spinner tells the
 * user nothing. Reading the fields that are already on the wire turns that wait
 * into "asking about two dimensions" or the first half of the summary it is
 * writing, without inventing anything the model did not say.
 *
 * Everything here works on a truncated document by design: this is a reader for
 * half-written JSON, not a parser, and it never throws.
 */

export type AssistantProgressStage =
  'reading' | 'drafting' | 'asking' | 'answering';

export interface AssistantProgress {
  stage: AssistantProgressStage;
  /** The partial sentence the model is writing, or '' before one exists. */
  text: string;
}

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t'
};

/**
 * The string literal starting at `from`, decoded as far as it goes.
 *
 * A trailing half-escape (`"12 \u00d`) contributes nothing rather than a
 * replacement character that would flicker as the rest arrives.
 */
function readPartialString(raw: string, from: number): string {
  let out = '';
  let index = from;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === '"') {
      return out;
    }
    if (char !== '\\') {
      out += char;
      index += 1;
      continue;
    }
    const next = raw[index + 1];
    if (next === undefined) {
      return out;
    }
    if (next === 'u') {
      const hex = raw.slice(index + 2, index + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
        return out;
      }
      out += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    const decoded = ESCAPES[next];
    if (decoded === undefined) {
      return out;
    }
    out += decoded;
    index += 2;
  }
  return out;
}

function fieldValue(raw: string, field: string): string | null {
  const opening = new RegExp(`"${field}"\\s*:\\s*"`).exec(raw);
  if (!opening) {
    return null;
  }
  return readPartialString(raw, opening.index + opening[0].length);
}

function stageOf(raw: string): AssistantProgressStage {
  const kind = /"replyKind"\s*:\s*"(patch|questions|message)"/.exec(raw)?.[1];
  if (kind === 'patch') {
    return 'drafting';
  }
  if (kind === 'questions') {
    return 'asking';
  }
  if (kind === 'message') {
    return 'answering';
  }
  return 'reading';
}

export function readAssistantProgress(raw: string): AssistantProgress {
  const stage = stageOf(raw);
  // `summary` belongs to a patch and `message` to the other two branches, so
  // whichever is present is the sentence being written this turn.
  const text = (fieldValue(raw, 'summary') ?? fieldValue(raw, 'message') ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return { stage, text };
}

const STAGE_LABEL: Record<AssistantProgressStage, string> = {
  reading: 'Reading the model',
  drafting: 'Drafting a change',
  asking: 'Working out what it needs to know',
  answering: 'Writing a reply'
};

/** The stage as a line of copy, with the selection folded in when there is one. */
export function describeProgress(
  progress: AssistantProgress,
  selectionSummary: string | null
): string {
  if (progress.stage === 'reading' && selectionSummary) {
    return `Reading ${selectionSummary} and the feature history`;
  }
  return STAGE_LABEL[progress.stage];
}
