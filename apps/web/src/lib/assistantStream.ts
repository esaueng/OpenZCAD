import {
  groundCadPatchProposalToSelection,
  parseAssistantReply,
  type AssistantAttachment,
  type AssistantHistoryTurn,
  type AssistantReply,
  type CadDocumentDigest
} from '@openzcad/ai-contracts';

interface AssistantStreamOptions {
  signal?: AbortSignal;
  onDelta?(text: string): void;
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

export async function loadAssistantStatus(
  signal?: AbortSignal
): Promise<AssistantStatus> {
  const response = await fetch('/api/assistant/status', { signal });
  if (!response.ok) {
    throw new Error(`Assistant status check failed (${response.status}).`);
  }
  return (await response.json()) as AssistantStatus;
}

export function readAssistantEvent(
  event: unknown,
  currentText: string
): { text: string; done: boolean } {
  if (!event || typeof event !== 'object') {
    return { text: currentText, done: false };
  }
  const value = event as Record<string, unknown>;
  if (
    value.type === 'response.output_text.delta' &&
    typeof value.delta === 'string'
  ) {
    return { text: currentText + value.delta, done: false };
  }
  if (
    value.type === 'response.output_text.done' &&
    typeof value.text === 'string'
  ) {
    return { text: value.text, done: true };
  }
  if (
    value.type === 'response.failed' ||
    value.type === 'response.incomplete' ||
    value.type === 'error'
  ) {
    const response =
      value.response && typeof value.response === 'object'
        ? (value.response as Record<string, unknown>)
        : value;
    const detail =
      response.error && typeof response.error === 'object'
        ? (response.error as Record<string, unknown>).message
        : undefined;
    // A truncated response arrives as a normal `response.incomplete` event, not
    // an upstream error, so name the cause instead of reporting it as a generic
    // failure the user cannot act on.
    const incompleteReason =
      response.incomplete_details &&
      typeof response.incomplete_details === 'object'
        ? (response.incomplete_details as Record<string, unknown>).reason
        : undefined;
    if (incompleteReason === 'max_output_tokens') {
      throw new Error(
        'The modeling assistant ran out of output budget before finishing the patch. Try a simpler request, or raise AI_MAX_OUTPUT_TOKENS.'
      );
    }
    throw new Error(
      typeof detail === 'string'
        ? detail
        : typeof incompleteReason === 'string'
          ? `The modeling assistant could not complete the proposal (${incompleteReason}).`
          : 'The modeling assistant could not complete the proposal.'
    );
  }
  return { text: currentText, done: value.type === 'response.completed' };
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

function retryDelay(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export async function streamAssistantReply(
  request: AssistantTurnRequest,
  options: AssistantStreamOptions = {}
): Promise<AssistantReply> {
  const response = await fetch('/api/assistant/proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: request.prompt,
      digest: request.digest,
      history: request.history ?? [],
      attachments: request.attachments ?? []
    }),
    signal: options.signal
  });
  if (!response.ok || !response.body) {
    const error = (await response.json().catch(() => null)) as {
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
    } | null;
    const message =
      error?.error ?? `Assistant request failed (${response.status}).`;
    const retrySeconds = error?.retryAfterSeconds;
    const retryAfterSeconds =
      error?.code === 'AI_RATE_LIMITED' &&
      typeof retrySeconds === 'number' &&
      Number.isFinite(retrySeconds) &&
      retrySeconds > 0
        ? Math.ceil(retrySeconds)
        : null;
    throw new Error(
      retryAfterSeconds === null
        ? message
        : `${message} Try again in ${retryDelay(retryAfterSeconds)}.`
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
      return;
    }
    const next = readAssistantEvent(parsed.event, output);
    output = next.text;
    completed ||= next.done;
    options.onDelta?.(output);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
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
  } catch {
    throw new Error(
      'The modeling assistant connection ended before the proposal was complete.'
    );
  }

  if (!completed) {
    throw new Error(
      'The modeling assistant stream ended before the proposal was complete.'
    );
  }
  if (!output.trim()) {
    throw new Error('The modeling assistant returned an empty proposal.');
  }
  const reply = parseAssistantReply(JSON.parse(output));
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
