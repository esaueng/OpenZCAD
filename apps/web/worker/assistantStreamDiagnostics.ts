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

type FailureClassification =
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
  if (
    (value.type === 'response.output_text.delta' ||
      value.type === 'response.content_part.delta') &&
    typeof value.delta === 'string'
  ) {
    appendOutput(state, value.delta);
    return;
  }
  if (
    value.type === 'response.output_text.done' &&
    typeof value.text === 'string'
  ) {
    replaceOutput(state, value.text);
    return;
  }
  if (
    value.type === 'response.output_item.done' &&
    value.item &&
    typeof value.item === 'object' &&
    !Array.isArray(value.item)
  ) {
    const item = value.item as Record<string, unknown>;
    const text = Array.isArray(item.content)
      ? item.content
          .flatMap((part) =>
            part &&
            typeof part === 'object' &&
            !Array.isArray(part) &&
            (part as Record<string, unknown>).type === 'output_text' &&
            typeof (part as Record<string, unknown>).text === 'string'
              ? [(part as Record<string, unknown>).text as string]
              : []
          )
          .join('')
      : '';
    if (text) {
      replaceOutput(state, text);
    }
    return;
  }
  if (
    value.type === 'response.completed' ||
    value.type === 'response.done' ||
    value.type === 'response.error' ||
    value.type === 'response.failed' ||
    value.type === 'response.incomplete' ||
    value.type === 'error'
  ) {
    state.terminalEvent = value.type;
    const response =
      value.response &&
      typeof value.response === 'object' &&
      !Array.isArray(value.response)
        ? (value.response as Record<string, unknown>)
        : undefined;
    state.terminalStatus =
      typeof response?.status === 'string'
        ? safeLabel(response.status)
        : undefined;
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

function classifyFailure(state: DiagnosticState): FailureClassification | null {
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
  classification: FailureClassification
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
  const state: DiagnosticState = {
    buffer: '',
    framingAbandoned: false,
    captureComplete: true,
    malformedEvent: false,
    output: '',
    outputBytes: 0
  };

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
        if (state.buffer.trim()) {
          consumeBlock(state, state.buffer);
          state.buffer = '';
        }
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
