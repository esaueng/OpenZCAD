import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AI_MODEL,
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

    const response = await streamAssistantProposal(input, {
      ENVIRONMENT: 'beta',
      OPENAI_API_KEY: 'test-key',
      AI_MODEL: 'configured-model',
      AI_REASONING_EFFORT: 'xhigh'
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(typeof init?.body).toBe('string');
    const request = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(request).toMatchObject({
      model: 'configured-model',
      stream: true,
      store: false,
      reasoning: { effort: 'xhigh' },
      text: {
        format: { type: 'json_schema', name: 'openzcad_patch', strict: true }
      }
    });
  });

  it('uses one centralized frontier-model default', () => {
    expect(DEFAULT_AI_MODEL).toBe('gpt-5.6-sol');
  });
});
