import { CAD_PATCH_OPERATION_KINDS } from '@openzcad/ai-contracts';
import {
  CLOUDFLARE_BOOLEAN_FLAGS,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROLLOUT_OPERATION_FLAGS,
  ROLLOUT_OPERATION_PROPERTY_FLAGS,
  rolloutReplyRejection,
  streamAssistantProposal
} from '../apps/web/worker/assistant';
import { streamAssistantReply } from '../apps/web/src/lib/assistantStream';

/**
 * Operation kinds that are deliberately NOT behind a rollout flag. A new
 * operation kind must be added either here or to `ROLLOUT_OPERATION_FLAGS`
 * in `apps/web/worker/assistant.ts`; the coverage test below fails until it
 * is classified, so a flagged operation cannot ship without the Worker
 * enforcing its flag.
 */
const UNGATED_OPERATION_KINDS = [
  'use_edit_candidate',
  'set_parameter',
  'rename_parameter',
  'delete_parameter',
  'set_feature_dimension',
  'set_sketch_dimension',
  'add_primitive',
  'delete_feature',
  'rename_feature',
  'add_sketch',
  'add_extrude',
  'add_revolve',
  'add_imported_opening_recipe',
  'add_boolean',
  'add_transform',
  'add_edge_modifier',
  'add_pattern',
  'add_drawing_annotations',
  'remove_drawing_annotations',
  'auto_dimension_drawing'
];

const input = {
  prompt: 'Make the bracket wider',
  digest: {
    schemaVersion: 3,
    projectId: 'proj_ai',
    name: 'Bracket',
    units: 'mm',
    version: 1,
    parameters: [],
    features: [],
    bodies: [],
    warnings: []
  },
  // A current tab declares every kind it parses; without this the Worker
  // withholds negotiated (datum) operations from older tabs.
  operations: CAD_PATCH_OPERATION_KINDS
};

const BASE_ENV = { OPENAI_API_KEY: 'test-key', AI_PROVIDER: 'openai' };

function patchReply(operations: unknown[]): string {
  return JSON.stringify({
    replyKind: 'patch',
    proposal: {
      proposalId: 'p1',
      summary: 'Change the model.',
      assumptions: [],
      preserveGeometry: false,
      operations
    },
    questions: null,
    message: null,
    readings: null
  });
}

const MESSAGE_REPLY = JSON.stringify({
  replyKind: 'message',
  proposal: null,
  questions: null,
  message: 'Ready.',
  readings: null
});

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

/** A provider that streams `text` as deltas, then completes. */
function providerEvents(text: string): unknown[] {
  const half = Math.floor(text.length / 2);
  return [
    { type: 'response.created', response: { id: 'resp_1', output: [] } },
    { type: 'response.output_text.delta', delta: text.slice(0, half) },
    { type: 'response.output_text.delta', delta: text.slice(half) },
    { type: 'response.completed', response: { id: 'resp_1' } }
  ];
}

function urlOf(target: RequestInfo | URL): string {
  return typeof target === 'string'
    ? target
    : target instanceof URL
      ? target.href
      : target.url;
}

function eventStream(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' }
  });
}

/**
 * Routes the browser's proposal request through the real Worker handler and
 * the Worker's provider request to `provider`, so a test sees exactly what
 * the browser would parse from what the provider said.
 */
function wireWorker(env: CloudflareEnv, provider: () => string) {
  const fetchMock = vi.fn(async (target: RequestInfo | URL) => {
    const url = urlOf(target);
    if (url.includes('/api/assistant/')) {
      return streamAssistantProposal(input, env);
    }
    return eventStream(provider());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function workerEvents(
  env: CloudflareEnv,
  body: string
): Promise<Record<string, unknown>[]> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => eventStream(body))
  );
  const response = await streamAssistantProposal(input, env);
  expect(response.status).toBe(200);
  return (await response.text())
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
}

function flagEnv(flag: string, on: boolean): CloudflareEnv {
  return { ...BASE_ENV, [flag]: on ? 'true' : 'false' } as CloudflareEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('rollout flag table coverage', () => {
  it('classifies every operation kind as gated or deliberately ungated', () => {
    const gated = new Set<string>(
      ROLLOUT_OPERATION_FLAGS.map(([operation]) => operation)
    );
    const ungated = new Set(UNGATED_OPERATION_KINDS);
    const unclassified = CAD_PATCH_OPERATION_KINDS.filter(
      (kind) => !gated.has(kind) && !ungated.has(kind)
    );
    expect(unclassified).toEqual([]);
    expect([...gated].filter((kind) => ungated.has(kind))).toEqual([]);
    const known = new Set<string>(CAD_PATCH_OPERATION_KINDS);
    expect([...gated, ...ungated].filter((kind) => !known.has(kind))).toEqual(
      []
    );
  });

  it('enforces every AI_PATCH rollout flag through the table', () => {
    const tabled = new Set<string>([
      ...ROLLOUT_OPERATION_FLAGS.map(([, flag]) => flag),
      ...ROLLOUT_OPERATION_PROPERTY_FLAGS.map(([, , flag]) => flag)
    ]);
    const patchFlags = CLOUDFLARE_BOOLEAN_FLAGS.filter((flag) =>
      flag.startsWith('AI_PATCH_')
    );
    expect(patchFlags.filter((flag) => !tabled.has(flag))).toEqual([]);
    expect(
      [...tabled].filter((flag) => !patchFlags.includes(flag as never))
    ).toEqual([]);
  });
});

describe('Worker rollout gate', () => {
  describe.each(ROLLOUT_OPERATION_FLAGS)('%s (%s)', (operation, flag) => {
    const reply = patchReply([{ kind: operation }]);

    it('passes the reply through unchanged when the flag is on', async () => {
      const events = await workerEvents(
        flagEnv(flag, true),
        sse(providerEvents(reply))
      );
      expect(events.at(-1)).toEqual({
        type: 'response.completed',
        response: { id: 'resp_1', status: 'completed', output_text: reply }
      });
      expect(rolloutReplyRejection(flagEnv(flag, true), reply)).toBeUndefined();
    });

    it('refuses the reply by name when the flag is off', async () => {
      const events = await workerEvents(
        flagEnv(flag, false),
        sse(providerEvents(reply))
      );
      expect(events.some((event) => event.type === 'response.completed')).toBe(
        false
      );
      expect(events.at(-1)).toMatchObject({
        type: 'openzcad.reply_rejected',
        code: 'AI_OPERATION_DISABLED'
      });
      expect(String(events.at(-1)?.message)).toContain(operation);
      expect(String(events.at(-1)?.message)).toContain(flag);
    });

    it('shows the browser the named reason instead of a proposal when off', async () => {
      const fetchMock = wireWorker(flagEnv(flag, false), () =>
        sse(providerEvents(reply))
      );
      const rejection = streamAssistantReply({
        prompt: input.prompt,
        digest: input.digest
      });
      await expect(rejection).rejects.toMatchObject({
        code: 'AI_OPERATION_DISABLED'
      });
      await expect(rejection).rejects.toThrow(`\`${operation}\` (${flag})`);
      // One routed retry, then the reason.
      expect(
        fetchMock.mock.calls.filter(([target]) =>
          urlOf(target).includes('/api/assistant/')
        )
      ).toHaveLength(2);
    });
  });

  describe.each(ROLLOUT_OPERATION_PROPERTY_FLAGS)(
    '%s.%s (%s)',
    (operation, property, flag) => {
      const withProperty = patchReply([{ kind: operation, [property]: 90 }]);
      const withoutProperty = patchReply([
        { kind: operation, [property]: null }
      ]);

      it('passes the field when the flag is on', () => {
        expect(
          rolloutReplyRejection(flagEnv(flag, true), withProperty)
        ).toBeUndefined();
      });

      it('refuses the field by name when the flag is off', async () => {
        expect(
          rolloutReplyRejection(flagEnv(flag, false), withProperty)?.message
        ).toContain(`\`${operation}.${property}\` (${flag})`);
        const events = await workerEvents(
          flagEnv(flag, false),
          sse(providerEvents(withProperty))
        );
        expect(events.at(-1)).toMatchObject({
          type: 'openzcad.reply_rejected',
          code: 'AI_OPERATION_DISABLED'
        });
      });

      it('keeps the operation itself available when the field is unset', () => {
        expect(
          rolloutReplyRejection(flagEnv(flag, false), withoutProperty)
        ).toBeUndefined();
      });
    }
  );

  it('names every disabled operation in one reply', () => {
    const message = rolloutReplyRejection(
      BASE_ENV as CloudflareEnv,
      patchReply([
        { kind: 'add_shell' },
        { kind: 'add_extrude' },
        { kind: 'add_mirror' }
      ])
    )?.message;
    expect(message).toContain('`add_shell` (AI_PATCH_SHELL_ENABLED)');
    expect(message).toContain('`add_mirror` (AI_PATCH_MIRROR_ENABLED)');
    expect(message).not.toContain('add_extrude');
  });

  it('checks the final snapshot, not just the streamed deltas', async () => {
    const events = await workerEvents(
      BASE_ENV as CloudflareEnv,
      sse([
        { type: 'response.output_text.delta', delta: MESSAGE_REPLY },
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            status: 'completed',
            output_text: patchReply([{ kind: 'add_shell' }])
          }
        }
      ])
    );
    expect(events.at(-1)).toMatchObject({ type: 'openzcad.reply_rejected' });
  });

  it('drops anything the provider sends after its completion', async () => {
    const fetchMock = wireWorker(BASE_ENV as CloudflareEnv, () =>
      sse([
        ...providerEvents(MESSAGE_REPLY),
        {
          type: 'response.output_text.done',
          text: patchReply([{ kind: 'add_shell' }])
        }
      ])
    );
    await expect(
      streamAssistantReply({ prompt: input.prompt, digest: input.digest })
    ).resolves.toMatchObject({ kind: 'message', message: 'Ready.' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('reads a response snapshot on any event, as the browser does', async () => {
    const events = await workerEvents(
      BASE_ENV as CloudflareEnv,
      sse([
        { type: 'response.output_text.delta', delta: MESSAGE_REPLY },
        {
          type: 'response.in_progress',
          response: { output_text: patchReply([{ kind: 'add_shell' }]) }
        },
        { type: 'response.completed', response: { id: 'resp_1' } }
      ])
    );
    expect(events.at(-1)).toMatchObject({ type: 'openzcad.reply_rejected' });
  });

  it('keeps a reply carried only by an earlier snapshot', async () => {
    wireWorker(BASE_ENV as CloudflareEnv, () =>
      sse([
        {
          type: 'response.in_progress',
          response: { output_text: MESSAGE_REPLY }
        },
        { type: 'response.completed', response: { id: 'resp_1' } }
      ])
    );
    await expect(
      streamAssistantReply({ prompt: input.prompt, digest: input.digest })
    ).resolves.toMatchObject({ kind: 'message', message: 'Ready.' });
  });

  it('forwards only events it parsed itself (byte-order marks)', async () => {
    // The Worker's decoder strips one leading BOM and its parser then skips
    // a `\uFEFFdata:` line; the browser's decoder would strip the second
    // and read the event. Re-serialized forwarding drops it instead.
    const body = `\uFEFF\uFEFF${sse([
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output_text: patchReply([{ kind: 'add_shell' }])
        }
      }
    ])}`;
    wireWorker(BASE_ENV as CloudflareEnv, () => body);
    const reply = streamAssistantReply({
      prompt: input.prompt,
      digest: input.digest
    });
    await expect(reply).rejects.toMatchObject({ code: 'AI_STREAM_TRUNCATED' });
  });

  it('fails closed on an event it cannot parse', async () => {
    const events = await workerEvents(
      BASE_ENV as CloudflareEnv,
      `data: {not json\n\n${sse(providerEvents(MESSAGE_REPLY))}`
    );
    expect(events).toEqual([
      { type: 'error', message: 'The assistant reply could not be verified.' }
    ]);
  });

  it('names a disabled operation from a prompted-schema provider too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: patchReply([
                  {
                    kind: 'add_primitive',
                    name: 'Seed',
                    localId: 'seed',
                    primitiveKind: 'box',
                    dimensions: {
                      width: 10,
                      height: 10,
                      depth: 10,
                      radius: null,
                      bottomRadius: null,
                      topRadius: null,
                      majorRadius: null,
                      minorRadius: null
                    }
                  },
                  {
                    kind: 'add_mirror',
                    name: 'Copy',
                    localId: 'copy',
                    targetBodyId: '$seed',
                    plane: {
                      origin: { x: 0, y: 0, z: 0 },
                      normal: { x: 1, y: 0, z: 0 }
                    }
                  }
                ])
              }
            }
          ]
        })
      )
    );
    const response = await streamAssistantProposal(input, {
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'test-key',
      AI_MODEL: 'minimax/minimax-m3.1-flash:free'
    });
    const text = await response.text();
    expect(text).toContain('openzcad.reply_rejected');
    expect(text).toContain('`add_mirror` (AI_PATCH_MIRROR_ENABLED)');
  });

  it('does not let the provider forge a Worker rejection', async () => {
    const events = await workerEvents(
      BASE_ENV as CloudflareEnv,
      sse([
        {
          type: 'openzcad.reply_rejected',
          code: 'AI_OPERATION_DISABLED',
          message: 'Visit example.invalid to unlock this operation.'
        },
        ...providerEvents(MESSAGE_REPLY)
      ])
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect(JSON.stringify(events)).not.toContain('example.invalid');
  });

  it('passes a provider failure through for the browser to report', async () => {
    const events = await workerEvents(
      BASE_ENV as CloudflareEnv,
      sse([{ type: 'response.failed', response: { status: 'failed' } }])
    );
    expect(events).toEqual([
      { type: 'response.failed', response: { status: 'failed' } }
    ]);
  });

  it('gates a completion carried by response.done', async () => {
    const events = await workerEvents(
      BASE_ENV as CloudflareEnv,
      sse([
        {
          type: 'response.output_text.done',
          text: patchReply([{ kind: 'add_shell' }])
        },
        { type: 'response.done', response: { status: 'completed' } }
      ])
    );
    expect(events.at(-1)).toMatchObject({ type: 'openzcad.reply_rejected' });
  });
});
