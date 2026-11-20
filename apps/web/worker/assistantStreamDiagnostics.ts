import { parseAssistantReply } from '@openzcad/ai-contracts';

const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_FRAMING_BUFFER_BYTES = 64 * 1024;

type TerminalEvent =
  | 'response.completed'
  | 'response.done'
  | 'response.error'
  | 'response.failed'
  | 'response.incomplete'
  | 'error';

export type AssistantResponseFailureClassification =
  | 'connection_error'
  | 'empty_output'
  | 'invalid_contract'
  | 'invalid_json'
  | 'output_over_limit'
  | 'protocol_error'
  | 'provider_failed'
  | 'provider_incomplete'
  | 'stream_error'
  | 'truncated_stream';

interface DiagnosticContext {
  requestId: string;
  provider: string;
  model: string;
}

interface DiagnosticState {
  buffer: string;
  framingAbandoned: boolean;
  captureComplete: boolean;
  malformedEvent: boolean;
  output: string;
  outputBytes: number;
  terminalEvent?: TerminalEvent;
  terminalStatus?: string;
  upstreamResponseId?: string;
}

export type AssistantResponseValidation =
  | { ok: true; upstreamResponseId?: string }
  | {
      ok: false;
      classification: AssistantResponseFailureClassification;
      upstreamResponseId?: string;
    };

const encoder = new TextEncoder();

function safeLabel(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

function safeResponseId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
    ? value
    : undefined;
}

function eventResponseId(event: Record<string, unknown>): string | undefined {
  const response =
    event.response &&
    typeof event.response === 'object' &&
    !Array.isArray(event.response)
      ? (event.response as Record<string, unknown>)
      : undefined;
  return safeResponseId(event.response_id) ?? safeResponseId(response?.id);
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

function replaceOutput(state: DiagnosticState, text: string): void {
  state.outputBytes = encoder.encode(text).byteLength;
  state.captureComplete = state.outputBytes <= MAX_CAPTURED_OUTPUT_BYTES;
  state.output = state.captureComplete ? text : '';
}

function appendOutput(state: DiagnosticState, delta: string): void {
  state.outputBytes += encoder.encode(delta).byteLength;
  if (!state.captureComplete || state.outputBytes > MAX_CAPTURED_OUTPUT_BYTES) {
    state.captureComplete = false;
    state.output = '';
    return;
  }
  state.output += delta;
}

function consumeEvent(state: DiagnosticState, event: unknown): void {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    state.malformedEvent = true;
    return;
  }
  const value = event as Record<string, unknown>;
  state.upstreamResponseId ??= eventResponseId(value);
  const delta = eventTextDelta(value);
  if (delta !== undefined) {
    appendOutput(state, delta);
    return;
  }
  if (
    value.type === 'response.output_text.done' &&
    typeof value.text === 'string'
  ) {
    replaceOutput(state, value.text);
    return;
  }
  // From here the order mirrors the browser's `readAssistantEvent`: an event
  // without text of its own falls through to the response snapshot it may
  // carry, whatever its type, and the last text seen wins.
  if (value.type === 'response.content_part.done') {
    const text = outputTextFromPart(value.part);
    if (text !== undefined) {
      replaceOutput(state, text);
      return;
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
      replaceOutput(state, text);
      return;
    }
  }
  const response =
    value.response &&
    typeof value.response === 'object' &&
    !Array.isArray(value.response)
      ? (value.response as Record<string, unknown>)
      : undefined;
  if (
    value.type === 'response.completed' ||
    value.type === 'response.done' ||
    value.type === 'response.error' ||
    value.type === 'response.failed' ||
    value.type === 'response.incomplete' ||
    value.type === 'error'
  ) {
    state.terminalEvent = value.type;
    state.terminalStatus =
      typeof response?.status === 'string'
        ? safeLabel(response.status)
        : undefined;
  }
  const responseText = outputTextFromResponse(response);
  if (responseText !== undefined) {
    replaceOutput(state, responseText);
  }
}

function dataFromBlock(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

function consumeBlock(state: DiagnosticState, block: string): void {
  const data = dataFromBlock(block);
  if (!data || data === '[DONE]') {
    return;
  }
  try {
    consumeEvent(state, JSON.parse(data) as unknown);
  } catch {
    state.malformedEvent = true;
  }
}

function consumeText(state: DiagnosticState, text: string): void {
  if (state.framingAbandoned) {
    return;
  }
  state.buffer += text;
  const blocks = state.buffer.split(/\r?\n\r?\n/);
  state.buffer = blocks.pop() ?? '';
  for (const block of blocks) {
    consumeBlock(state, block);
  }
  if (encoder.encode(state.buffer).byteLength > MAX_FRAMING_BUFFER_BYTES) {
    state.buffer = '';
    state.framingAbandoned = true;
    state.malformedEvent = true;
  }
}

function createDiagnosticState(): DiagnosticState {
  return {
    buffer: '',
    framingAbandoned: false,
    captureComplete: true,
    malformedEvent: false,
    output: '',
    outputBytes: 0
  };
}

function finishDiagnosticState(state: DiagnosticState): void {
  if (state.buffer.trim()) {
    consumeBlock(state, state.buffer);
    state.buffer = '';
  }
}

function classifyFailure(
  state: DiagnosticState
): AssistantResponseFailureClassification | null {
  if (state.malformedEvent) {
    return 'protocol_error';
  }
  if (state.terminalEvent === 'response.failed') {
    return 'provider_failed';
  }
  if (state.terminalEvent === 'response.incomplete') {
    return 'provider_incomplete';
  }
  if (
    state.terminalEvent === 'response.error' ||
    state.terminalEvent === 'error'
  ) {
    return 'stream_error';
  }
  if (
    state.terminalEvent === 'response.done' &&
    state.terminalStatus === 'failed'
  ) {
    return 'provider_failed';
  }
  if (
    state.terminalEvent === 'response.done' &&
    state.terminalStatus === 'incomplete'
  ) {
    return 'provider_incomplete';
  }
  if (
    state.terminalEvent !== 'response.completed' &&
    !(
      state.terminalEvent === 'response.done' &&
      state.terminalStatus === 'completed'
    )
  ) {
    return 'truncated_stream';
  }
  if (state.outputBytes === 0) {
    return 'empty_output';
  }
  if (!state.captureComplete) {
    return 'output_over_limit';
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(state.output) as unknown;
  } catch {
    return 'invalid_json';
  }
  try {
    parseAssistantReply(decoded);
  } catch {
    return 'invalid_contract';
  }
  return null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

async function logFailure(
  state: DiagnosticState,
  context: DiagnosticContext,
  classification: AssistantResponseFailureClassification
): Promise<void> {
  const outputSha256 = state.captureComplete
    ? await sha256Hex(state.output)
    : null;
  console.error('AI Responses stream failed:', {
    requestId: context.requestId,
    provider: safeLabel(context.provider),
    model: safeLabel(context.model),
    upstreamResponseId: state.upstreamResponseId ?? null,
    classification,
    terminalEvent: state.terminalEvent ?? null,
    terminalStatus: state.terminalStatus ?? null,
    outputBytes: state.outputBytes,
    outputSha256,
    outputHashComplete: state.captureComplete
  });
}

/**
 * Passes the provider stream through byte-for-byte while collecting enough
 * terminal metadata to diagnose failures without logging prompts or output.
 */
export function observeAssistantResponse(
  source: ReadableStream<Uint8Array>,
  context: DiagnosticContext
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const state = createDiagnosticState();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (!result.done) {
          consumeText(state, decoder.decode(result.value, { stream: true }));
          controller.enqueue(result.value);
          return;
        }
        consumeText(state, decoder.decode());
        finishDiagnosticState(state);
        const classification = classifyFailure(state);
        if (classification) {
          await logFailure(state, context, classification);
        }
        controller.close();
      } catch (error) {
        await logFailure(state, context, 'connection_error');
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}

/**
 * Consumes a provider stream and proves it reached a terminal success with one
 * reply that satisfies the assistant contract. No prompt or output text leaves
 * this module; callers receive only an allowlisted failure classification and
 * provider response id.
 */
export async function validateAssistantResponse(
  source: ReadableStream<Uint8Array>
): Promise<AssistantResponseValidation> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const state = createDiagnosticState();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      consumeText(state, decoder.decode(result.value, { stream: true }));
    }
    consumeText(state, decoder.decode());
    finishDiagnosticState(state);
  } catch {
    return {
      ok: false,
      classification: 'connection_error',
      ...(state.upstreamResponseId
        ? { upstreamResponseId: state.upstreamResponseId }
        : {})
    };
  }

  const classification = classifyFailure(state);
  return classification
    ? {
        ok: false,
        classification,
        ...(state.upstreamResponseId
          ? { upstreamResponseId: state.upstreamResponseId }
          : {})
      }
    : {
        ok: true,
        ...(state.upstreamResponseId
          ? { upstreamResponseId: state.upstreamResponseId }
          : {})
      };
}

/**
 * Event type of a rejection the Worker itself writes into the stream. The
 * `openzcad.` namespace belongs to the Worker: the gate replaces any provider
 * event that claims it, so a provider cannot put its own text behind it.
 */
export const ASSISTANT_REJECTION_EVENT_TYPE = 'openzcad.reply_rejected';
export const ASSISTANT_REJECTION_EVENT_PREFIX = 'openzcad.';

export interface AssistantReplyRejection {
  code: 'AI_OPERATION_DISABLED';
  message: string;
}

/**
 * Generous enough for one event that repeats the whole capped output (a
 * `response.completed` snapshot), with room for JSON escaping. The
 * diagnostics observer's smaller framing limit only gives up on logging;
 * this one decides what the client receives, so it fails closed instead.
 */
const MAX_GATE_FRAMING_BUFFER_BYTES = 2 * MAX_CAPTURED_OUTPUT_BYTES + 64 * 1024;

function sseBlock(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Unverifiable output reads as a provider stream failure, never success. */
const UNVERIFIED_STREAM_EVENT = sseBlock({
  type: 'error',
  message: 'The assistant reply could not be verified.'
});

/**
 * Holds back the provider's terminal success until the assembled reply has
 * been checked, then ends the stream with exactly the text it checked.
 *
 * The provider stream is otherwise forwarded event by event, so the client
 * still renders live deltas. The client parses the last full text an event
 * carries, so the gate replaces the provider's success event with one whose
 * `output_text` is the checked text and stops there: nothing the provider
 * sends after it, and no earlier event's differing snapshot, can change what
 * the client parses. A rejected reply ends with a Worker rejection event the
 * client shows by name instead of building a proposal.
 */
export function gateAssistantResponse(
  source: ReadableStream<Uint8Array>,
  check: (replyText: string) => AssistantReplyRejection | undefined,
  context: Pick<DiagnosticContext, 'requestId'>
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const state = createDiagnosticState();
  let buffer = '';
  let finished = false;

  const finish = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    final: string
  ) => {
    finished = true;
    controller.enqueue(encoder.encode(final));
    controller.close();
    reader.cancel().catch(() => undefined);
  };

  const terminalSuccess = (event: Record<string, unknown>): boolean => {
    if (event.type === 'response.completed') return true;
    if (event.type !== 'response.done') return false;
    const response = event.response;
    return (
      !!response &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      (response as Record<string, unknown>).status === 'completed'
    );
  };

  /** What to forward for one block, or a final block that ends the stream. */
  const handleBlock = (
    block: string
  ): { forward: string } | { final: string } => {
    // Every forwarded event is re-serialized from what the gate parsed, so
    // the browser can never read an event the gate did not (a byte-order
    // mark, a comment line or odd framing the two parsers treat apart).
    if (block.length > MAX_GATE_FRAMING_BUFFER_BYTES) {
      return { final: UNVERIFIED_STREAM_EVENT };
    }
    const data = dataFromBlock(block);
    if (!data || data === '[DONE]') return { forward: '' };
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      return { final: UNVERIFIED_STREAM_EVENT };
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return { forward: sseBlock(event) };
    }
    const value = event as Record<string, unknown>;
    if (
      typeof value.type === 'string' &&
      value.type.startsWith(ASSISTANT_REJECTION_EVENT_PREFIX)
    ) {
      return { final: UNVERIFIED_STREAM_EVENT };
    }
    consumeEvent(state, value);
    if (!terminalSuccess(value)) return { forward: sseBlock(value) };
    if (!state.captureComplete) return { final: UNVERIFIED_STREAM_EVENT };
    const rejection = check(state.output);
    if (rejection) {
      console.warn('AI reply rejected by the Worker:', {
        requestId: context.requestId,
        upstreamResponseId: state.upstreamResponseId ?? null,
        code: rejection.code
      });
      return {
        final: sseBlock({
          type: ASSISTANT_REJECTION_EVENT_TYPE,
          code: rejection.code,
          message: rejection.message
        })
      };
    }
    return {
      final: sseBlock({
        type: 'response.completed',
        response: {
          ...(state.upstreamResponseId ? { id: state.upstreamResponseId } : {}),
          status: 'completed',
          output_text: state.output
        }
      })
    };
  };

  const drain = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    blocks: string[]
  ) => {
    let forward = '';
    for (const block of blocks) {
      const result = handleBlock(block);
      if ('final' in result) {
        if (forward) controller.enqueue(encoder.encode(forward));
        finish(controller, result.final);
        return;
      }
      forward += result.forward;
    }
    if (forward) controller.enqueue(encoder.encode(forward));
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!finished) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          controller.error(error);
          return;
        }
        if (result.done) {
          buffer += decoder.decode();
          if (buffer.trim()) drain(controller, [buffer]);
          if (!finished) {
            finished = true;
            controller.close();
          }
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        // UTF-16 length never exceeds the UTF-8 size, so this bound is cheap
        // and no stricter than the byte limit it stands in for.
        if (buffer.length > MAX_GATE_FRAMING_BUFFER_BYTES) {
          finish(controller, UNVERIFIED_STREAM_EVENT);
          return;
        }
        if (blocks.length > 0) {
          drain(controller, blocks);
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}
