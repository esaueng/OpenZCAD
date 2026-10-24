/** Limits apply before normalization, cloning, or recursive history traversal. */
export const MAX_DOCUMENT_DEPTH = 64;
export const MAX_DOCUMENT_VALUES = 500_000;
/** Bounds extreme offline edit counters while preserving ordinary batched edits. */
export const MAX_DOCUMENT_VERSION_ADVANCE = 1_000_000;
/**
 * The refusal for a document over MAX_DOCUMENT_VALUES. The save edge answers
 * it as a 400, and continuous sync has to tell it apart from a transient
 * failure: no retry can ever store the same document.
 */
export const DOCUMENT_VALUES_REFUSAL = `Project document holds more than ${MAX_DOCUMENT_VALUES} values.`;

export function documentStructureError(value: unknown): string | null {
  const pending = [{ value, depth: 1 }];
  let visited = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.depth > MAX_DOCUMENT_DEPTH) {
      return `Project document nests deeper than ${MAX_DOCUMENT_DEPTH} levels.`;
    }
    visited += 1;
    if (visited > MAX_DOCUMENT_VALUES) {
      return DOCUMENT_VALUES_REFUSAL;
    }
    const children = Array.isArray(entry.value)
      ? entry.value
      : isDocumentRecord(entry.value)
        ? Object.values(entry.value)
        : [];
    if (visited + pending.length + children.length > MAX_DOCUMENT_VALUES) {
      return DOCUMENT_VALUES_REFUSAL;
    }
    for (const child of children)
      pending.push({ value: child, depth: entry.depth + 1 });
  }
  return null;
}

/** Lexical guard for streamed JSON, before JSON.parse allocates its object graph. */
export class JsonComplexityGuard {
  private depth = 0;
  private separators = 0;
  private inString = false;
  private escaped = false;
  constructor(
    private readonly maxDepth = MAX_DOCUMENT_DEPTH + 4,
    private readonly maxSeparators = MAX_DOCUMENT_VALUES * 2
  ) {}
  consume(text: string): void {
    for (const char of text) {
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') this.inString = true;
      else if (char === '{' || char === '[') {
        this.depth += 1;
        this.separators += 1;
      } else if (char === '}' || char === ']') this.depth -= 1;
      else if (char === ',' || char === ':') this.separators += 1;
      if (this.depth > this.maxDepth || this.separators > this.maxSeparators) {
        throw new Error('JSON exceeds the document structural limit.');
      }
    }
  }
}

/** Reuses the streamed request guard, including the surrounding save envelope. */
export function documentRequestWithinComplexity(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return false;
    new JsonComplexityGuard().consume(text);
    return true;
  } catch {
    return false;
  }
}

export function isDocumentRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The envelope read by all persistence and collaboration entry points. */
export function documentEnvelopeError(value: unknown): string | null {
  if (
    !isDocumentRecord(value) ||
    typeof value.projectId !== 'string' ||
    !value.projectId.trim() ||
    typeof value.ownerUserId !== 'string' ||
    !value.ownerUserId.trim() ||
    typeof value.name !== 'string' ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    (value.version as number) >=
      Number.MAX_SAFE_INTEGER - MAX_DOCUMENT_VERSION_ADVANCE ||
    !isDocumentRecord(value.nodes) ||
    !Object.values(value.nodes).every(isDocumentRecord) ||
    !Array.isArray(value.commandLog) ||
    !Array.isArray(value.revisions)
  ) {
    return 'Project document is missing required collections or a valid identity/version.';
  }
  return null;
}

/**
 * The derived block the account keeps when it strips derived geometry
 * (`withoutDerivedProjection`): its warnings and update time. Browsers always
 * send it; the account refuses a document without it rather than failing on
 * it (ADR-024 Phase 1: the account no longer normalizes what it stores).
 */
export function derivedEnvelopeError(value: unknown): string | null {
  const derived = isDocumentRecord(value) ? value.derived : undefined;
  if (
    !isDocumentRecord(derived) ||
    !Array.isArray(derived.warnings) ||
    !derived.warnings.every((warning) => typeof warning === 'string') ||
    typeof derived.updatedAt !== 'string'
  ) {
    return 'Project document is missing its derived state.';
  }
  return null;
}

export const MAX_NODE_NAME_LENGTH = 200;
export const MAX_EXPRESSION_LENGTH = 4_096;
export function boundedName(value: string): string {
  const end = value.charCodeAt(MAX_NODE_NAME_LENGTH - 1);
  return value.slice(
    0,
    end >= 0xd800 && end <= 0xdbff
      ? MAX_NODE_NAME_LENGTH - 1
      : MAX_NODE_NAME_LENGTH
  );
}

export function documentVersionCanAdvance(
  incoming: number,
  trusted: number
): boolean {
  return (
    Number.isSafeInteger(incoming) &&
    Number.isSafeInteger(trusted) &&
    incoming >= 0 &&
    trusted >= 0 &&
    incoming < Number.MAX_SAFE_INTEGER - MAX_DOCUMENT_VERSION_ADVANCE &&
    incoming <= trusted + MAX_DOCUMENT_VERSION_ADVANCE
  );
}
