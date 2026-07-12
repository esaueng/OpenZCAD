import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AI_MODEL,
  streamAssistantProposal
} from '../apps/web/worker/assistant';

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
  it('requests a strict streamed response from the configured model', async () => {
    const fetchMock = vi.fn(
      async () =>
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
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
