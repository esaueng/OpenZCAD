import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  getAssistantStatus,
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

  it('uses one centralized frontier-model default', () => {
    expect(DEFAULT_AI_PROVIDER).toBe('openai');
    expect(DEFAULT_AI_MODEL).toBe('gpt-5.6-sol');
  });

  it('reports configuration state without returning the API key', () => {
    const status = getAssistantStatus({
      ENVIRONMENT: 'beta',
      AI_API_KEY: 'never-return-this',
      AI_MODEL: 'configured-model'
    });
    expect(status).toEqual({
      configured: true,
      provider: 'openai',
      model: 'configured-model',
      reasoningEffort: 'high'
    });
    expect(JSON.stringify(status)).not.toContain('never-return-this');
  });
});
