import {
  groundCadPatchProposalToSelection,
  parseAssistantReply,
  type AssistantAttachment,
  type AssistantHistoryTurn,
  type AssistantReply,
  type CadDocumentDigest
} from '@openzcad/ai-contracts';
import { desktopFetch } from './desktopBridge';

interface AssistantStreamOptions {
  signal?: AbortSignal;
  onDelta?(text: string): void;
}

export type AssistantStreamErrorCode =
  | 'AI_EMPTY_REPLY'
  | 'AI_INVALID_JSON'
  | 'AI_INVALID_REPLY'
  | 'AI_OUTPUT_INCOMPLETE'
  | 'AI_PROVIDER_STREAM_ERROR'
  | 'AI_STREAM_CONNECTION'
  | 'AI_STREAM_PROTOCOL'
  | 'AI_STREAM_TRUNCATED';

export const INVALID_STRUCTURED_OUTPUT_MESSAGE =
  'The provider returned invalid structured output.';

function safeRequestId(response: Response): string | undefined {
  const value = response.headers.get('x-openzcad-request-id')?.trim();
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
    ? value
    : undefined;
}

function messageWithReference(
  message: string,
  requestId: string | undefined
): string {
  return requestId ? `${message} Reference: ${requestId}.` : message;
}

export class AssistantStreamError extends Error {
  readonly code: AssistantStreamErrorCode;
  readonly requestId?: string;

  constructor(
    code: AssistantStreamErrorCode,
    message: string,
    requestId?: string
  ) {
    super(messageWithReference(message, requestId));
    this.name = 'AssistantStreamError';
    this.code = code;
    this.requestId = requestId;
  }
}

export interface AssistantTurnRequest {
  /** The current turn's text. */
  prompt: string;
  /** Freshly captured for this turn; never a replay of an older snapshot. */
  digest: CadDocumentDigest;
  history?: readonly AssistantHistoryTurn[];
  attachments?: readonly AssistantAttachment[];
}

export interface AssistantStatus {
  configured: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
}

function outputTextFromPart(part: unknown): string | undefined {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return undefined;
  }
  const value = part as Record<string, unknown>;
  return value.type === 'output_text' && typeof value.text === 'string'
    ? value.text
    : undefined;
}

function outputTextFromItem(item: unknown): string | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return undefined;
  }
  const content = (item as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content.flatMap((part) => {
    const value = outputTextFromPart(part);
    return value === undefined ? [] : [value];
  });
  return text.length > 0 ? text.join('') : undefined;
}

function outputTextFromResponse(response: unknown): string | undefined {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return undefined;
  }
  const value = response as Record<string, unknown>;
  if (typeof value.output_text === 'string') {
    return value.output_text;
  }
  if (!Array.isArray(value.output)) {
    return undefined;
  }
  const text = value.output.flatMap((item) => {
    const itemText = outputTextFromItem(item);
    return itemText === undefined ? [] : [itemText];
  });
  return text.length > 0 ? text.join('') : undefined;
}

function eventTextDelta(event: Record<string, unknown>): string | undefined {
  if (
    event.type !== 'response.output_text.delta' &&
    event.type !== 'response.content_part.delta'
  ) {
    return undefined;
  }
  const part =
    event.part && typeof event.part === 'object' && !Array.isArray(event.part)
      ? (event.part as Record<string, unknown>)
      : undefined;
  if (typeof part?.type === 'string' && part.type !== 'output_text') {
    return undefined;
  }
  if (typeof event.delta === 'string') {
    return event.delta || outputTextFromPart(part);
  }
  const delta =
    event.delta &&
    typeof event.delta === 'object' &&
    !Array.isArray(event.delta)
      ? (event.delta as Record<string, unknown>)
      : undefined;
  if (typeof delta?.type === 'string' && delta.type !== 'output_text') {
    return undefined;
  }
  return typeof delta?.text === 'string'
    ? delta.text
    : outputTextFromPart(part);
}

export async function loadAssistantStatus(
  signal?: AbortSignal
): Promise<AssistantStatus> {
  const response = await desktopFetch('/api/assistant/status', { signal });
  if (!response.ok) {
    throw new Error(`Assistant status check failed (${response.status}).`);
  }
  return (await response.json()) as AssistantStatus;
}

export function readAssistantEvent(
  event: unknown,
  currentText: string,
  requestId?: string
): { text: string; done: boolean } {
  if (!event || typeof event !== 'object') {
    return { text: currentText, done: false };
  }
  const value = event as Record<string, unknown>;
  const delta = eventTextDelta(value);
  if (delta !== undefined) {
    return { text: currentText + delta, done: false };
  }
  if (
    value.type === 'response.output_text.done' &&
    typeof value.text === 'string'
  ) {
    return { text: value.text, done: false };
  }
  if (value.type === 'response.content_part.done') {
    const text = outputTextFromPart(value.part);
    if (text !== undefined) {
      return { text, done: false };
    }
  }
  if (
    value.type === 'response.output_item.done' &&
    value.item &&
    typeof value.item === 'object' &&
    !Array.isArray(value.item)
  ) {
    const text = outputTextFromItem(value.item);
    if (text !== undefined) {
      return { text, done: false };
    }
  }
  const response =
    value.response &&
    typeof value.response === 'object' &&
    !Array.isArray(value.response)
      ? (value.response as Record<string, unknown>)
      : undefined;
  const responseDoneFailure =
    value.type === 'response.done' &&
    (response?.status === 'failed' || response?.status === 'incomplete');
  if (
    value.type === 'response.failed' ||
    value.type === 'response.incomplete' ||
    value.type === 'response.error' ||
    responseDoneFailure ||
    value.type === 'error'
  ) {
    const failure = response ?? value;
    // A truncated response arrives as a normal `response.incomplete` event, not
    // an upstream error, so name the cause instead of reporting it as a generic
    // failure the user cannot act on.
    const incompleteReason =
      failure.incomplete_details &&
      typeof failure.incomplete_details === 'object'
        ? (failure.incomplete_details as Record<string, unknown>).reason
        : undefined;
    if (incompleteReason === 'max_output_tokens') {
      throw new AssistantStreamError(
        'AI_OUTPUT_INCOMPLETE',
        'The modeling assistant ran out of output budget before finishing the patch. Try a simpler request, or raise AI_MAX_OUTPUT_TOKENS.',
        requestId
      );
    }
    throw new AssistantStreamError(
      value.type === 'response.incomplete' || response?.status === 'incomplete'
        ? 'AI_OUTPUT_INCOMPLETE'
        : 'AI_PROVIDER_STREAM_ERROR',
      'The modeling assistant could not complete the proposal.',
      requestId
    );
  }
  const responseText = outputTextFromResponse(response);
  return {
    text: responseText ?? currentText,
    done:
      value.type === 'response.completed' ||
      (value.type === 'response.done' && response?.status === 'completed')
  };
}

export function parseAssistantEventData(
  data: string
): { event: unknown } | null {
  try {
    return { event: JSON.parse(data) as unknown };
  } catch {
    return null;
  }
}

/**
 * Failures produced by the provider rather than by this request: garbage or
 * empty structured output, and a stream that died mid-proposal. One automatic
 * retry absorbs most of them. Deterministic failures — a refused request, an
 * output-budget overrun — are excluded so a retry never doubles their cost.
 */
const RETRYABLE_STREAM_CODES: ReadonlySet<AssistantStreamErrorCode> = new Set([
  'AI_EMPTY_REPLY',
  'AI_INVALID_JSON',
  'AI_INVALID_REPLY',
  'AI_PROVIDER_STREAM_ERROR',
  'AI_STREAM_CONNECTION',
  'AI_STREAM_TRUNCATED'
]);

export async function streamAssistantReply(
  request: AssistantTurnRequest,
  options: AssistantStreamOptions = {}
): Promise<AssistantReply> {
  try {
    return await streamAssistantReplyAttempt(request, options, 0);
  } catch (error) {
    if (
      !(error instanceof AssistantStreamError) ||
      !RETRYABLE_STREAM_CODES.has(error.code) ||
      options.signal?.aborted
    ) {
      throw error;
    }
    // The retry marker makes the worker vary the provider routing key, so
    // this attempt can reach a different provider than the one that failed.
    return streamAssistantReplyAttempt(request, options, 1);
  }
}

async function streamAssistantReplyAttempt(
  request: AssistantTurnRequest,
  options: AssistantStreamOptions,
  retryAttempt: 0 | 1
): Promise<AssistantReply> {
  const response = await desktopFetch('/api/assistant/proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: request.prompt,
      digest: request.digest,
      history: request.history ?? [],
      attachments: request.attachments ?? [],
      retryAttempt
    }),
    signal: options.signal
  });
  const requestId = safeRequestId(response);
  if (!response.ok || !response.body) {
    const error = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      messageWithReference(
        error?.error ?? `Assistant request failed (${response.status}).`,
        requestId
      )
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let output = '';
  let completed = false;

  const consumeBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') {
      return;
    }
    const parsed = parseAssistantEventData(data);
    if (parsed === null) {
      throw new AssistantStreamError(
        'AI_STREAM_PROTOCOL',
        'The modeling assistant returned an invalid stream event.',
        requestId
      );
    }
    const next = readAssistantEvent(parsed.event, output, requestId);
    output = next.text;
    completed ||= next.done;
    options.onDelta?.(output);
  };

  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      throw new AssistantStreamError(
        'AI_STREAM_CONNECTION',
        'The modeling assistant connection ended before the proposal was complete.',
        requestId
      );
    }
    const { value, done } = result;
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      consumeBlock(block);
    }
    if (done) {
      if (buffer.trim()) {
        consumeBlock(buffer);
      }
      break;
    }
  }

  if (!completed) {
    throw new AssistantStreamError(
      'AI_STREAM_TRUNCATED',
      'The modeling assistant stream ended before the proposal was complete.',
      requestId
    );
  }
  if (!output.trim()) {
    throw new AssistantStreamError(
      'AI_EMPTY_REPLY',
      'The modeling assistant returned an empty proposal.',
      requestId
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new AssistantStreamError(
      'AI_INVALID_JSON',
      INVALID_STRUCTURED_OUTPUT_MESSAGE,
      requestId
    );
  }
  let reply: AssistantReply;
  try {
    // The digest the model was given, so the witness-binding checks in
    // `parseCadPatchProposal` actually run. Without it they were dead outside
    // the test suite: `validateCadPatchProposalAgainstDigest` is called only
    // when a digest is present, so a proposal quoting a stale or invented
    // topology witness reached the user's review card unchallenged.
    reply = parseAssistantReply(decoded, request.digest);
  } catch {
    throw new AssistantStreamError(
      'AI_INVALID_REPLY',
      INVALID_STRUCTURED_OUTPUT_MESSAGE,
      requestId
    );
  }
  // Grounding replaces the model's guesses at which entities words like
  // "these edges" mean with the actual UI selection, so it applies to the one
  // branch that names entities.
  return reply.kind === 'patch'
    ? {
        ...reply,
        proposal: groundCadPatchProposalToSelection(
          request.prompt,
          request.digest,
          reply.proposal
        )
      }
    : reply;
}
