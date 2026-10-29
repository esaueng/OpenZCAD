import {
  anthropicThinkingOffType,
  type AssistantReasoningEffort
} from '@openzcad/shared';

export class AnthropicModelConfigurationError extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function anthropicOutputOptions(
  effort: AssistantReasoningEffort,
  model: string
) {
  const offType = anthropicThinkingOffType(model);
  if (effort === 'off' && !offType) {
    throw new AnthropicModelConfigurationError(
      'Reasoning Off is unavailable for this Anthropic model. Choose Provider default or a reasoning level.'
    );
  }
  return {
    output_config: {
      ...(effort === 'off'
        ? { effort: 'low' }
        : effort !== 'provider-default'
          ? { effort }
          : {})
    },
    ...(effort === 'off'
      ? {
          thinking: {
            type: offType
          }
        }
      : effort !== 'provider-default'
        ? { thinking: { type: 'adaptive' } }
        : {})
  };
}

/**
 * Translate Messages events, checking the full CAD contract before forwarding.
 * Anthropic's grammar compiler permits only 16 union parameters; the CAD schema
 * exceeds that, so requests use prompted JSON with server-side enforcement.
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs#schema-complexity-limits
 */
export function translateAnthropicStream(
  response: Response,
  validateText: (text: string) => boolean
): Response {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let stopReason: string | undefined;
  let responseId: string | undefined;
  let stopped = false;
  let output = '';
  let outputBytes = 0;
  const emit = (
    controller: TransformStreamDefaultController<Uint8Array>,
    event: unknown
  ) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const consume = (
    block: string,
    controller: TransformStreamDefaultController<Uint8Array>
  ) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || stopped) return;
    const event = record(JSON.parse(data));
    if (event?.type === 'message_start') {
      const id = record(event.message)?.id;
      if (typeof id === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(id))
        responseId = id;
    } else if (event?.type === 'content_block_delta') {
      const delta = record(event.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        outputBytes += encoder.encode(delta.text).byteLength;
        if (outputBytes > 2 * 1024 * 1024)
          throw new Error('AI output exceeds the 2 MB limit.');
        output += delta.text;
      }
    } else if (event?.type === 'message_delta') {
      const reason = record(event.delta)?.stop_reason;
      if (typeof reason === 'string') stopReason = reason;
    } else if (event?.type === 'message_stop') {
      stopped = true;
      const valid = stopReason === 'end_turn' && validateText(output);
      // Validate the entire CAD reply before exposing any generated output.
      // Small delta frames also stay within the existing SSE parser's bounds.
      if (valid) {
        for (let offset = 0; offset < output.length; offset += 4096) {
          emit(controller, {
            type: 'response.output_text.delta',
            delta: output.slice(offset, offset + 4096)
          });
        }
      }
      output = '';
      emit(controller, {
        type: 'response.done',
        response: {
          id: responseId,
          status: valid
            ? 'completed'
            : stopReason === 'max_tokens'
              ? 'incomplete'
              : 'failed',
          ...(stopReason === 'max_tokens'
            ? { incomplete_details: { reason: 'max_output_tokens' } }
            : {})
        }
      });
    } else if (event?.type === 'error') {
      stopped = true;
      // Do not forward provider error text, which may echo sensitive input.
      emit(controller, {
        type: 'response.failed',
        response: { status: 'failed' }
      });
    }
  };
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          if (encoder.encode(block).byteLength > 64 * 1024)
            throw new Error('AI event exceeds framing limit.');
          consume(block, controller);
        }
        if (encoder.encode(buffer).byteLength > 64 * 1024)
          throw new Error('AI event exceeds framing limit.');
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer, controller);
        // Missing message_stop stays truncated; it must never become a successful reply.
      }
    })
  );
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' }
  });
}
