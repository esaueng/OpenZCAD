import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  DEFAULT_OPENROUTER_MODEL,
  getAssistantStatus,
  maxOutputTokensFor,
  streamAssistantProposal
} from '../apps/web/worker/assistant';
import { readAssistantEvent } from '../apps/web/src/lib/assistantStream';

const input = {
  prompt: 'Make the bracket wider',
  digest: {
    schemaVersion: 2,
    projectId: 'proj_ai',
    name: 'Bracket',
    units: 'mm',
    version: 1,
    parameters: [],
    features: [],
    bodies: [],
    warnings: []
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assistant integration', () => {
  it('assembles streamed output text deltas', () => {
    const first = readAssistantEvent(
      { type: 'response.output_text.delta', delta: '{"summary":' },
      ''
    );
    const second = readAssistantEvent(
      { type: 'response.output_text.delta', delta: '"Wider"}' },
      first.text
    );
    expect(second.text).toBe('{"summary":"Wider"}');
  });

  it('requests a strict streamed response from the configured model', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await streamAssistantProposal(
      input,
      {
        ENVIRONMENT: 'beta',
        OPENAI_API_KEY: 'test-key',
        AI_PROVIDER: 'responses-compatible',
        AI_BASE_URL: 'https://models.example.test/v1/responses',
        AI_MODEL: 'configured-model',
        AI_REASONING_EFFORT: 'xhigh'
      },
      'user_test'
    );

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://models.example.test/v1/responses'
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(typeof init?.body).toBe('string');
    const request = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(request).toMatchObject({
      model: 'configured-model',
      stream: true,
      store: false,
      reasoning: { effort: 'xhigh' },
      safety_identifier: 'user_test',
      text: {
        format: { type: 'json_schema', name: 'openzcad_patch', strict: true }
      }
    });
  });

  it('budgets enough output for a multi-part patch and allows an override', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    await streamAssistantProposal(
      input,
      { AI_API_KEY: 'key', AI_BASE_URL: 'https://models.example.test/v1/responses' },
      'user_test'
    );
    const budgeted = JSON.parse(
      fetchMock.mock.calls[0]![1]?.body as string
    ) as { max_output_tokens: number; instructions: string };
    // Reasoning tokens share this budget; a box-and-lid patch is ~18 operations
    // and silently truncates under the old 3k ceiling.
    expect(budgeted.max_output_tokens).toBeGreaterThanOrEqual(16_000);
    // The instructions must actually teach the non-obvious kernel conventions.
    expect(budgeted.instructions).toContain('CORNER AT THE ORIGIN');
    expect(budgeted.instructions).toContain('localId');
    expect(budgeted.instructions).toContain(
      'copy every selected edge\'s numeric `hash`'
    );
    expect(budgeted.instructions).toContain(
      'ONE LIVE BODY for each physical part'
    );
    expect(budgeted.instructions).toContain(
      'default to one finished physical part'
    );

    const overridden = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
    );
    vi.stubGlobal('fetch', overridden);
    await streamAssistantProposal(
      input,
      {
        AI_API_KEY: 'key',
        AI_BASE_URL: 'https://models.example.test/v1/responses',
        AI_MAX_OUTPUT_TOKENS: '4096'
      },
      'user_test'
    );
    expect(
      (
        JSON.parse(overridden.mock.calls[0]![1]?.body as string) as {
          max_output_tokens: number;
        }
      ).max_output_tokens
    ).toBe(4096);
  });

  it('falls back to the default output budget for unusable overrides', () => {
    // A declared-but-blank Worker var reads as '', which Number() would turn
    // into 0 and make the provider reject every request.
    expect(maxOutputTokensFor({ AI_MAX_OUTPUT_TOKENS: '' })).toBe(
      DEFAULT_AI_MAX_OUTPUT_TOKENS
    );
    expect(maxOutputTokensFor({ AI_MAX_OUTPUT_TOKENS: 'lots' })).toBe(
      DEFAULT_AI_MAX_OUTPUT_TOKENS
    );
    expect(maxOutputTokensFor({ AI_MAX_OUTPUT_TOKENS: '0' })).toBe(
      DEFAULT_AI_MAX_OUTPUT_TOKENS
    );
    expect(maxOutputTokensFor({})).toBe(DEFAULT_AI_MAX_OUTPUT_TOKENS);
    expect(maxOutputTokensFor({ AI_MAX_OUTPUT_TOKENS: '8000' })).toBe(8000);
  });

  it('uses one centralized frontier-model default', () => {
    expect(DEFAULT_AI_PROVIDER).toBe('openrouter');
    expect(DEFAULT_OPENROUTER_MODEL).toBe('openai/gpt-5.6-terra');
    expect(DEFAULT_AI_MODEL).toBe('gpt-5.6-sol');
  });

  it('recovers from a stale direct-provider variable when only OpenRouter is configured', () => {
    expect(
      getAssistantStatus({
        AI_PROVIDER: 'openai',
        AI_MODEL: 'gpt-5.6-sol',
        OPENROUTER_API_KEY: 'openrouter-key'
      })
    ).toEqual({
      configured: true,
      provider: 'openrouter',
      model: 'openai/gpt-5.6-terra',
      reasoningEffort: 'high'
    });
  });

  it('reports configuration state without returning the API key', () => {
    const status = getAssistantStatus({
      ENVIRONMENT: 'beta',
      AI_API_KEY: 'never-return-this',
      AI_MODEL: 'configured-model'
    });
    expect(status).toEqual({
      configured: true,
      provider: 'openrouter',
      model: 'configured-model',
      reasoningEffort: 'high'
    });
    expect(JSON.stringify(status)).not.toContain('never-return-this');
  });

  it('uses an OpenRouter key, endpoint, headers, and balanced model default', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      ENVIRONMENT: 'beta' as const,
      AI_PROVIDER: 'openrouter' as const,
      AI_API_KEY: 'wrong-generic-key',
      OPENROUTER_API_KEY: 'openrouter-test-key',
      AI_SITE_URL: 'https://beta.openzcad.example',
      AI_APP_NAME: 'OpenZCAD Beta'
    };
    const status = getAssistantStatus(env);
    expect(status).toMatchObject({
      configured: true,
      provider: 'openrouter',
      model: DEFAULT_OPENROUTER_MODEL
    });

    const response = await streamAssistantProposal(input, env, 'user_test');
    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/responses');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer openrouter-test-key');
    expect(headers.get('x-title')).toBe('OpenZCAD Beta');
    expect(headers.get('http-referer')).toBe(
      'https://beta.openzcad.example'
    );
    const request = JSON.parse(init?.body as string) as {
      model: string;
      reasoning: { effort: string };
      stream: boolean;
    };
    expect(request).toMatchObject({
      model: 'openai/gpt-5.6-terra',
      reasoning: { effort: 'high' },
      stream: true
    });
  });

  it('logs bounded provider diagnostics without returning upstream details', async () => {
    const longMessage = `Invalid response schema: ${'x'.repeat(600)}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 'invalid_prompt',
              message: 'Provider returned error',
              metadata: {
                provider_name: 'OpenAI',
                raw: JSON.stringify({
                  error: {
                    code: 'invalid_json_schema',
                    type: 'invalid_request_error',
                    message: longMessage
                  }
                })
              }
            },
            error_type: 'invalid_request'
          },
          { status: 400 }
        )
      )
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const response = await streamAssistantProposal(input, {
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'secret-key'
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'The modeling assistant could not generate a patch.',
      code: 'AI_UPSTREAM_ERROR'
    });
    expect(consoleError).toHaveBeenCalledWith(
      'AI Responses provider failed:',
      {
        provider: 'openrouter',
        status: 400,
        code: 'invalid_json_schema',
        errorType: 'invalid_request_error',
        message: longMessage.slice(0, 500),
        providerName: 'OpenAI'
      }
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret-key');
  });
});
