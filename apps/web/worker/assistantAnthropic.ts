import type { AssistantReasoningEffort } from '@openzcad/shared';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Anthropic's grammar omits these constraints; the CAD reply parser still enforces them. */
export function anthropicReplySchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(anthropicReplySchema);
  const schema = record(value);
  if (!schema) return value;
  const result: Record<string, unknown> = {};
  const constraints: string[] = [];
  for (const [key, child] of Object.entries(schema)) {
    if (
      [
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'multipleOf',
        'minLength',
        'maxLength',
        'minItems',
        'maxItems',
        'pattern'
      ].includes(key)
    ) {
      constraints.push(`${key}: ${JSON.stringify(child)}`);
    } else if (
      key === 'properties' ||
      key === '$defs' ||
      key === 'definitions'
    ) {
      result[key] = Object.fromEntries(
        Object.entries(record(child) ?? {}).map(([name, property]) => [
          name,
          anthropicReplySchema(property)
        ])
      );
    } else {
      result[key] = anthropicReplySchema(child);
    }
  }
  if (constraints.length) {
    result.description = [schema.description, ...constraints]
      .filter(Boolean)
      .join('; ');
  }
  return result;
}

export function anthropicOutputOptions(
  schema: unknown,
  effort: AssistantReasoningEffort,
  model: string
) {
  return {
    output_config: {
      format: { type: 'json_schema', schema: anthropicReplySchema(schema) },
      ...(effort === 'off'
        ? { effort: 'low' }
        : effort !== 'provider-default'
          ? { effort }
          : {})
    },
    ...(effort === 'off'
      ? {
          thinking: {
            type: model.startsWith('claude-sonnet-5-5')
              ? 'between_tools'
              : 'disabled'
          }
        }
      : effort !== 'provider-default'
        ? { thinking: { type: 'adaptive' } }
        : {})
  };
}

/** Translate native Messages events to the existing, validated Responses stream. */
export function translateAnthropicStream(response: Response): Response {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let stopReason: string | undefined;
  let responseId: string | undefined;
  let stopped = false;
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
        emit(controller, {
          type: 'response.output_text.delta',
          delta: delta.text
        });
      }
    } else if (event?.type === 'message_delta') {
      const reason = record(event.delta)?.stop_reason;
      if (typeof reason === 'string') stopReason = reason;
    } else if (event?.type === 'message_stop') {
      stopped = true;
      emit(controller, {
        type: 'response.done',
        response: {
          id: responseId,
          status:
            stopReason === 'end_turn'
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
