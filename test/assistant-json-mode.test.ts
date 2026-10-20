import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assistantReplySchemaFor,
  assistantSafetyIdentifier,
  DEFAULT_OPENROUTER_MODEL,
  streamAssistantProposal,
  testAssistantConnection
} from '../apps/web/worker/assistant';
import {
  ASSISTANT_SCHEMA_KEYWORDS,
  matchesAssistantSchema
} from '../apps/web/worker/assistantJsonSchema';
import { streamAssistantReply } from '../apps/web/src/lib/assistantStream';
import { parseAssistantProposalRequest } from '../apps/web/worker/validation';

function requestUrl(url: RequestInfo | URL): string {
  return typeof url === 'string'
    ? url
    : url instanceof URL
      ? url.href
      : url.url;
}

const input = {
  prompt: 'Make a parameter',
  digest: {
    schemaVersion: 3,
    projectId: 'proj_json',
    name: 'JSON mode',
    units: 'mm' as const,
    version: 1,
    parameters: [],
    features: [],
    bodies: [],
    warnings: []
  }
};
const reply = {
  replyKind: 'message',
  proposal: null,
  questions: null,
  message: 'Ready.',
  readings: null
};
const env = { OPENROUTER_API_KEY: 'test-key' };
const chat = (content: unknown) =>
  Response.json({
    choices: [
      { finish_reason: 'stop', message: { content: JSON.stringify(content) } }
    ]
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('prompted CAD JSON schema', () => {
  it('covers every keyword in the complete CAD reply schema', () => {
    const keywords = new Set<string>();
    function visit(value: unknown) {
      if (!value || typeof value !== 'object') return;
      const schema = value as Record<string, unknown>;
      Object.keys(schema).forEach((key) => keywords.add(key));
      if (Array.isArray(schema.anyOf)) schema.anyOf.forEach(visit);
      if (schema.properties && typeof schema.properties === 'object')
        Object.values(schema.properties).forEach(visit);
      if (schema.items) visit(schema.items);
    }
    visit(
      assistantReplySchemaFor({
        AI_PATCH_DIRECT_EDIT_ENABLED: 'true',
        AI_PATCH_GROWING_HOLDER_ENABLED: 'true',
        AI_PATCH_HOLE_CONTROL_ENABLED: 'true',
        AI_PATCH_FACE_SKETCH_ENABLED: 'true',
        AI_PATCH_MULTI_PROFILE_EXTRUDE_ENABLED: 'true',
        AI_PATCH_MIRROR_ENABLED: 'true',
        AI_PATCH_SHELL_ENABLED: 'true',
        AI_PATCH_SOLID_OFFSET_ENABLED: 'true',
        AI_PATCH_DATUM_PLANE_ENABLED: 'true',
        AI_PATCH_PARTIAL_REVOLVE_ENABLED: 'true'
      })
    );
    expect(
      [...keywords].filter((key) => !ASSISTANT_SCHEMA_KEYWORDS.has(key))
    ).toEqual([]);
    expect(matchesAssistantSchema(2, { type: 'number', multipleOf: 2 })).toBe(
      false
    );
  });

  it('requires all envelope and nested operation fields and rejects extra keys', () => {
    const schema = assistantReplySchemaFor({});
    expect(matchesAssistantSchema(reply, schema)).toBe(true);
    for (const key of Object.keys(reply)) {
      const missing: Record<string, unknown> = { ...reply };
      delete missing[key];
      expect(matchesAssistantSchema(missing, schema)).toBe(false);
    }
    expect(matchesAssistantSchema({ ...reply, extra: true }, schema)).toBe(
      false
    );
    expect(
      matchesAssistantSchema({ ...reply, replyKind: 'unknown' }, schema)
    ).toBe(false);
    const patch = {
      ...reply,
      replyKind: 'patch',
      message: null,
      proposal: {
        proposalId: 'proposal_json',
        summary: 'Set width',
        assumptions: [],
        preserveGeometry: false,
        operations: [{ kind: 'set_parameter', name: 'width', expression: '12' }]
      }
    };
    expect(matchesAssistantSchema(patch, schema)).toBe(true);
    delete (
      patch.proposal.operations[0] as Partial<
        (typeof patch.proposal.operations)[0]
      >
    ).expression;
    expect(matchesAssistantSchema(patch, schema)).toBe(false);
  });

  it('enforces the same capability-pruned operation properties sent in the prompt', () => {
    const patch = {
      ...reply,
      replyKind: 'patch',
      message: null,
      proposal: {
        proposalId: 'proposal_json',
        summary: 'Revolve',
        assumptions: [],
        preserveGeometry: false,
        operations: [
          {
            kind: 'add_revolve',
            name: 'Revolve',
            localId: null,
            sketchId: 'sketch_test',
            axis: 'vertical',
            angleDeg: 90
          }
        ]
      }
    };
    expect(
      matchesAssistantSchema(
        patch,
        assistantReplySchemaFor({ AI_PATCH_PARTIAL_REVOLVE_ENABLED: 'true' })
      )
    ).toBe(true);
    expect(matchesAssistantSchema(patch, assistantReplySchemaFor({}))).toBe(
      false
    );
  });

  it.each([
    [1, { type: 'integer', minimum: 1 }, true],
    [0, { type: 'integer', minimum: 1 }, false],
    [1.5, { type: 'integer' }, false],
    [2, { type: 'number', maximum: 1 }, false],
    [1, { type: 'number', exclusiveMinimum: 1 }, false],
    [1, { type: 'number', exclusiveMaximum: 1 }, false],
    ['unsafe id', { type: 'string', pattern: '^[a-z]+$' }, false],
    [[], { type: 'array', minItems: 1 }, false],
    [[1, 2], { type: 'array', maxItems: 1 }, false],
    [['x'], { type: 'array', items: { type: 'number' } }, false],
    [true, { anyOf: [{ type: 'null' }, { type: 'string' }] }, false]
  ])(
    'checks schema constraints for %j against %j',
    (value, schema, expected) => {
      expect(matchesAssistantSchema(value, schema)).toBe(expected);
    }
  );
});

describe('MiniMax JSON mode dispatch', () => {
  it('rejects schema-conforming but semantically invalid replies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chat({ ...reply, message: '' }))
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await streamAssistantProposal(input, env);
    const stream = await response.text();
    expect(stream).toContain('response.failed');
    expect(stream).not.toContain('response.output_text.done');
  });
  it('validates a real patch envelope before returning it to the client', async () => {
    const patch = {
      ...reply,
      replyKind: 'patch',
      message: null,
      proposal: {
        proposalId: 'proposal_json',
        summary: 'Set width',
        assumptions: [],
        preserveGeometry: false,
        operations: [{ kind: 'set_parameter', name: 'width', expression: '12' }]
      }
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => chat(patch))
    );
    const response = await streamAssistantProposal(input, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('set_parameter');
  });

  it('withholds invalid output, retries once with the exact schema, and returns a valid reply', async () => {
    const requests: Record<string, unknown>[] = [];
    let attempts = 0;
    const deltas = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (
          url: RequestInfo | URL,
          init?: RequestInit
        ): Promise<Response> => {
          const raw: unknown = JSON.parse(init?.body as string);
          if (requestUrl(url).endsWith('/api/assistant/proposals')) {
            attempts += 1;
            const body = parseAssistantProposalRequest(raw);
            return streamAssistantProposal(
              body,
              env,
              assistantSafetyIdentifier('user_test', body.retryAttempt)
            );
          }
          expect(requestUrl(url)).toBe(
            'https://openrouter.ai/api/v1/chat/completions'
          );
          requests.push(raw as Record<string, unknown>);
          return chat(
            attempts === 1
              ? { replyKind: 'message', message: 'invalid-private-output' }
              : reply
          );
        }
      )
    );
    await expect(
      streamAssistantReply(input, { onDelta: deltas })
    ).resolves.toMatchObject({ kind: 'message', message: 'Ready.' });
    expect(attempts).toBe(2);
    expect(requests).toHaveLength(2);
    for (const body of requests) {
      expect(body).toMatchObject({
        model: DEFAULT_OPENROUTER_MODEL,
        response_format: { type: 'json_object' },
        provider: { max_price: { prompt: 0, completion: 0, request: 0 } }
      });
      expect(JSON.stringify(body.messages)).toContain('Required JSON reply');
    }
    expect(JSON.stringify(requests[1]?.messages)).toContain(
      'previous reply failed validation'
    );
    expect(JSON.stringify(deltas.mock.calls)).not.toContain(
      'invalid-private-output'
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'invalid-private-output'
    );
  });

  it('fails closed after the existing one retry when replies keep violating the schema', async () => {
    let attempts = 0;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (
          url: RequestInfo | URL,
          init?: RequestInit
        ): Promise<Response> => {
          if (requestUrl(url).endsWith('/api/assistant/proposals')) {
            attempts += 1;
            const body = parseAssistantProposalRequest(
              JSON.parse(init?.body as string) as unknown
            );
            return streamAssistantProposal(
              body,
              env,
              assistantSafetyIdentifier('user_test', body.retryAttempt)
            );
          }
          return chat({ ...reply, extra: 'invalid-private-output' });
        }
      )
    );
    await expect(streamAssistantReply(input)).rejects.toMatchObject({
      code: 'AI_PROVIDER_STREAM_ERROR'
    });
    expect(attempts).toBe(2);
  });

  it.each([true, false])(
    'validates MiniMax connection-test output (valid=%s)',
    async (valid) => {
      const fetchMock = vi.fn(
        async (_url: RequestInfo | URL, _init?: RequestInit) =>
          chat(valid ? reply : { replyKind: 'message', message: 'Ready.' })
      );
      vi.stubGlobal('fetch', fetchMock);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const result = testAssistantConnection(
        {
          provider: 'openrouter',
          model: DEFAULT_OPENROUTER_MODEL,
          apiKey: 'test-key',
          reasoningEffort: 'high',
          maxOutputTokens: 32000,
          timeoutMs: 90000,
          customInstructions: ''
        },
        {}
      );
      if (valid) await expect(result).resolves.toMatchObject({ ok: true });
      else
        await expect(result).rejects.toMatchObject({
          code: 'AI_PROVIDER_FAILED'
        });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
        response_format: unknown;
      };
      expect(body.response_format).toEqual({ type: 'json_object' });
    }
  );
});
