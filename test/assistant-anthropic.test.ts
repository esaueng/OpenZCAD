import { describe, expect, it } from 'vitest';
import {
  anthropicOutputOptions,
  anthropicReplySchema,
  translateAnthropicStream
} from '../apps/web/worker/assistantAnthropic';
import { validateAssistantResponse } from '../apps/web/worker/assistantStreamDiagnostics';

describe('Anthropic protocol adapter', () => {
  it('moves unsupported constraints into descriptions without removing CAD property names', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: {
          type: 'string',
          minLength: 1,
          pattern: '^a',
          description: 'Name'
        },
        width: { type: 'number', minimum: 1, maximum: 100 },
        points: {
          type: 'array',
          minItems: 2,
          items: { type: 'number', minimum: 0 }
        }
      }
    };
    expect(anthropicReplySchema(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: {
          type: 'string',
          description: 'Name; minLength: 1; pattern: "^a"'
        },
        width: { type: 'number', description: 'minimum: 1; maximum: 100' },
        points: {
          type: 'array',
          description: 'minItems: 2',
          items: { type: 'number', description: 'minimum: 0' }
        }
      }
    });
    expect(schema.properties.width.minimum).toBe(1);
  });

  it('lets the provider choose defaults and maps Off to Sonnet 5.5 without up-front thinking', () => {
    expect(
      anthropicOutputOptions({}, 'provider-default', 'claude-sonnet-5-5')
    ).toEqual({
      output_config: { format: { type: 'json_schema', schema: {} } }
    });
    expect(
      anthropicOutputOptions({}, 'off', 'claude-sonnet-5-5')
    ).toMatchObject({
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' }
    });
    expect(
      anthropicOutputOptions({}, 'off', 'claude-sonnet-4-6')
    ).toMatchObject({
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' }
    });
  });

  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'maps %s effort to adaptive thinking',
    (effort) => {
      expect(
        anthropicOutputOptions({}, effort, 'claude-sonnet-5-5')
      ).toMatchObject({
        thinking: { type: 'adaptive' },
        output_config: { effort }
      });
    }
  );

  it('sanitizes provider stream errors', async () => {
    const response = translateAnthropicStream(
      new Response(
        'data: {"type":"error","error":{"message":"secret echoed input"}}\n\n'
      )
    );
    const text = await response.text();
    expect(text).toContain('response.failed');
    expect(text).not.toContain('secret echoed input');
  });

  it.each(['data: not-json\n\n', `data: ${'x'.repeat(65537)}`])(
    'fails closed on invalid framing',
    async (wire) => {
      const response = translateAnthropicStream(new Response(wire));
      await expect(
        validateAssistantResponse(response.body!)
      ).resolves.toMatchObject({ ok: false });
    }
  );

  it('leaves HTTP errors available for existing credential and rate-limit guidance', () => {
    const response = new Response('{}', { status: 429 });
    expect(translateAnthropicStream(response)).toBe(response);
  });
});
