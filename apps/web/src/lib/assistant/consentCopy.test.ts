import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCadDocumentDigest,
  type CadDocumentDigest
} from '@openzcad/ai-contracts';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { streamAssistantReply } from '../assistantStream';
import {
  ASSISTANT_CONSENT_COPY_VERSION,
  ASSISTANT_CONSENT_DIGEST_FIELDS,
  ASSISTANT_CONSENT_FIELDS_BY_COPY_VERSION,
  ASSISTANT_CONSENT_ITEMS,
  ASSISTANT_CONSENT_REQUEST_FIELDS,
  assistantConsentRoute,
  describeAssistantRoute
} from './consentCopy';

/**
 * Compile-time inventory: a field added to the digest type fails the
 * typecheck here until it is listed (and the copy version bumped).
 */
const DIGEST_TYPE_FIELDS: Record<keyof CadDocumentDigest, true> = {
  bodies: true,
  editCatalog: true,
  features: true,
  name: true,
  parameters: true,
  projectId: true,
  schemaVersion: true,
  selection: true,
  units: true,
  version: true,
  warnings: true
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what the assistant consent copy lists (ADR-024 6-1)', () => {
  it('pins this copy version to the exact request and digest fields', () => {
    // Changing either list needs a new copy version (which asks every user
    // again): never edit a published version's entry.
    expect(ASSISTANT_CONSENT_COPY_VERSION).toBe(1);
    expect(ASSISTANT_CONSENT_FIELDS_BY_COPY_VERSION[1]).toEqual({
      request: [
        'attachments',
        'digest',
        'history',
        'operations',
        'prompt',
        'retryAttempt'
      ],
      digest: [
        'bodies',
        'editCatalog',
        'features',
        'name',
        'parameters',
        'projectId',
        'schemaVersion',
        'selection',
        'units',
        'version',
        'warnings'
      ]
    });
    expect(
      ASSISTANT_CONSENT_FIELDS_BY_COPY_VERSION[ASSISTANT_CONSENT_COPY_VERSION]
    ).toEqual({
      request: ASSISTANT_CONSENT_REQUEST_FIELDS,
      digest: ASSISTANT_CONSENT_DIGEST_FIELDS
    });
    expect(Object.keys(DIGEST_TYPE_FIELDS).sort()).toEqual([
      ...ASSISTANT_CONSENT_DIGEST_FIELDS
    ]);
  });

  it('names every field in the words the dialog shows', () => {
    const listed = new Set(
      ASSISTANT_CONSENT_ITEMS.flatMap((item) => item.fields)
    );
    for (const field of ASSISTANT_CONSENT_REQUEST_FIELDS) {
      if (field === 'digest') continue;
      expect(listed.has(field), field).toBe(true);
    }
    for (const field of ASSISTANT_CONSENT_DIGEST_FIELDS) {
      expect(listed.has(`digest.${field}`), field).toBe(true);
    }
    for (const field of listed) {
      const [head, tail] = field.split('.');
      if (tail) {
        expect(head).toBe('digest');
        expect(ASSISTANT_CONSENT_DIGEST_FIELDS).toContain(tail);
      } else {
        expect(ASSISTANT_CONSENT_REQUEST_FIELDS).toContain(head);
      }
    }
  });

  it('matches what a digest and a request actually carry', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Bracket', toUserId('user_a')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const digest = createCadDocumentDigest(document, {
      featureIds: [],
      bodyIds: [document.bodyOrder[0]!],
      topologies: []
    });
    for (const key of Object.keys(digest)) {
      expect(ASSISTANT_CONSENT_DIGEST_FIELDS, key).toContain(key);
    }
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(
          JSON.parse(init?.body as string) as Record<string, unknown>
        );
        return new Response('{}', { status: 503 });
      })
    );
    await expect(
      streamAssistantReply({
        prompt: 'Make it thicker',
        selectionPrompt: 'stays on this device',
        digest,
        history: [{ role: 'user', text: 'Hi' }],
        attachments: []
      })
    ).rejects.toThrow();
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0]!).sort()).toEqual([
      ...ASSISTANT_CONSENT_REQUEST_FIELDS
    ]);
    expect(JSON.stringify(bodies[0])).not.toContain('stays on this device');
  });

  it('names the provider route', () => {
    expect(
      describeAssistantRoute({
        source: 'deployment',
        provider: 'openrouter',
        model: 'openai/gpt-5.6-sol'
      })
    ).toBe('OpenZCAD’s AI provider, OpenRouter, model openai/gpt-5.6-sol');
    expect(
      describeAssistantRoute({
        source: 'personal',
        provider: 'openai',
        model: 'gpt-5'
      })
    ).toBe('your own key with OpenAI, model gpt-5');
    // A known endpoint is named by its host.
    expect(
      describeAssistantRoute({
        source: 'personal',
        provider: 'responses-compatible',
        model: 'm',
        endpoint: 'https://llm.example.com/v1/responses'
      })
    ).toBe(
      'your own key with a Responses-compatible endpoint, model m, at llm.example.com'
    );
    // Key source, provider, model and endpoint each make a different route.
    const routes = new Set(
      [
        { source: 'deployment', provider: 'openai', model: 'm' },
        { source: 'personal', provider: 'openai', model: 'm' },
        { source: 'personal', provider: 'openrouter', model: 'm' },
        { source: 'personal', provider: 'openrouter', model: 'n' },
        {
          source: 'personal',
          provider: 'openrouter',
          model: 'n',
          endpoint: 'https://a.example/v1'
        },
        {
          source: 'personal',
          provider: 'openrouter',
          model: 'n',
          endpoint: 'https://b.example/v1'
        },
        { provider: 'openai', model: 'm' }
      ].map((input) => assistantConsentRoute(input as never))
    );
    expect(routes.size).toBe(6);
  });

  it('never lets two models share a route, however they are written', () => {
    const route = (model: string) =>
      assistantConsentRoute({ source: 'personal', provider: 'openai', model });
    // Characters the readable part replaces, and models longer than it keeps.
    const long = 'x'.repeat(150);
    const models = ['a|b', 'a/b', 'a?b', 'aéb', 'a€b', long, `${long}y`];
    expect(new Set(models.map(route)).size).toBe(models.length);
    // Readable, bounded, and well inside a record's 256-character route.
    expect(route(`${long}y`)).toMatch(
      /^v2\|personal\|openai\|x{60}\|[0-9a-f]{64}$/
    );
    expect(route('a|b').split('|')).toHaveLength(5);
  });
});
