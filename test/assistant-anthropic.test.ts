import { describe, expect, it } from 'vitest';
import {
  anthropicOutputOptions,
  translateAnthropicStream
} from '../apps/web/worker/assistantAnthropic';
import { assistantReplySchemaFor } from '../apps/web/worker/assistant';
import { validateAssistantResponse } from '../apps/web/worker/assistantStreamDiagnostics';

describe('Anthropic protocol adapter', () => {
  it('avoids native grammar compilation for the CAD schema exceeding Anthropic’s 16-union limit', () => {
    function unionCount(value: unknown): number {
      if (!value || typeof value !== 'object') return 0;
      if (Array.isArray(value))
        return value.reduce<number>((sum, child) => sum + unionCount(child), 0);
      const schema = value as Record<string, unknown>;
      return (
        (Array.isArray(schema.anyOf) || Array.isArray(schema.type) ? 1 : 0) +
        Object.values(schema).reduce<number>(
          (sum, child) => sum + unionCount(child),
          0
        )
      );
    }
    expect(unionCount(assistantReplySchemaFor({}))).toBeGreaterThan(16);
    expect(
      anthropicOutputOptions('high', 'claude-sonnet-5-5')
    ).not.toHaveProperty('output_config.format');
  });

  it('lets the provider choose defaults and maps Off to Sonnet 5.5 without up-front thinking', () => {
    expect(
      anthropicOutputOptions('provider-default', 'claude-sonnet-5-5')
    ).toEqual({ output_config: {} });
    expect(anthropicOutputOptions('off', 'claude-sonnet-5-5')).toMatchObject({
      thinking: { type: 'between_tools' },
      output_config: { effort: 'low' }
    });
    expect(anthropicOutputOptions('off', 'claude-sonnet-4-6')).toMatchObject({
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' }
    });
  });

  it.each([
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
    'unknown-future-model'
  ])('refuses Off for %s before any request is sent', (model) => {
    expect(() => anthropicOutputOptions('off', model)).toThrow(
      'Off is unavailable'
    );
  });

  it('recognizes dated aliases of models supporting Off', () => {
    expect(
      anthropicOutputOptions('off', 'claude-sonnet-4-5-20250929')
    ).toMatchObject({ thinking: { type: 'disabled' } });
  });

  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'maps %s effort to adaptive thinking',
    (effort) => {
      expect(anthropicOutputOptions(effort, 'claude-sonnet-5-5')).toMatchObject(
        {
          thinking: { type: 'adaptive' },
          output_config: { effort }
        }
      );
    }
  );

  it.each(['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'])(
    'uses budgeted extended thinking on %s without unsupported effort fields',
    (model) => {
      expect(anthropicOutputOptions('high', model, 4096)).toEqual({
        thinking: { type: 'enabled', budget_tokens: 3072 }
      });
      expect(anthropicOutputOptions('off', model)).toEqual({
        thinking: { type: 'disabled' }
      });
      expect(anthropicOutputOptions('provider-default', model)).toEqual({});
    }
  );

  it.each([
    ['low', 1024],
    ['medium', 4096],
    ['high', 8192],
    ['xhigh', 16384]
  ] as const)(
    'maps legacy %s to a bounded %i-token thinking budget',
    (effort, budget) => {
      expect(
        anthropicOutputOptions(effort, 'claude-sonnet-4-5', 32000)
      ).toEqual({ thinking: { type: 'enabled', budget_tokens: budget } });
    }
  );

  it('rejects a legacy thinking budget that cannot leave room for a reply', () => {
    expect(() =>
      anthropicOutputOptions('high', 'claude-sonnet-4-5', 1024)
    ).toThrow('at least 2048');
    expect(anthropicOutputOptions('high', 'claude-sonnet-4-5', 2048)).toEqual({
      thinking: { type: 'enabled', budget_tokens: 1024 }
    });
  });

  it.each(['claude-opus-4-6', 'claude-sonnet-4-6'])(
    'maps Extra high to supported max effort on %s',
    (model) => {
      expect(anthropicOutputOptions('xhigh', model)).toMatchObject({
        output_config: { effort: 'max' },
        thinking: { type: 'adaptive' }
      });
    }
  );

  it('sanitizes provider stream errors', async () => {
    const response = translateAnthropicStream(
      new Response(
        'data: {"type":"error","error":{"message":"secret echoed input"}}\n\n'
      ),
      () => false
    );
    const text = await response.text();
    expect(text).toContain('response.failed');
    expect(text).not.toContain('secret echoed input');
  });

  it('never forwards text that fails the full CAD validator', async () => {
    const response = translateAnthropicStream(
      new Response(
        [
          {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'invalid CAD output' }
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' }
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')
      ),
      () => false
    );
    const wire = await response.text();
    expect(wire).toContain('failed');
    expect(wire).not.toContain('invalid CAD output');
  });

  it.each(['data: not-json\n\n', `data: ${'x'.repeat(65537)}`])(
    'fails closed on invalid framing',
    async (wire) => {
      const response = translateAnthropicStream(
        new Response(wire),
        () => false
      );
      await expect(
        validateAssistantResponse(response.body!)
      ).resolves.toMatchObject({ ok: false });
    }
  );

  it('bounds accumulated reply text before validation', async () => {
    const delta = `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(4096) } })}\n\n`;
    const response = translateAnthropicStream(
      new Response(delta.repeat(513)),
      () => true
    );
    await expect(response.text()).rejects.toThrow('2 MB limit');
  });

  it('leaves HTTP errors available for existing credential and rate-limit guidance', () => {
    const response = new Response('{}', { status: 429 });
    expect(translateAnthropicStream(response, () => false)).toBe(response);
  });
});
