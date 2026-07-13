import {
  CAD_PATCH_JSON_SCHEMA,
  type CadDocumentDigest
} from '@openzcad/ai-contracts';
import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';

export const DEFAULT_AI_MODEL = 'gpt-5.6-sol';
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.6-terra';
export const DEFAULT_AI_REASONING_EFFORT = 'high';
export const DEFAULT_AI_PROVIDER = 'openrouter';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENROUTER_RESPONSES_URL = 'https://openrouter.ai/api/v1/responses';

const CAD_ASSISTANT_INSTRUCTIONS = `You are the planning engine for OpenZCAD, a browser-first parametric solid modeler.

Your only job is to translate the user's modeling intent into one small, deterministic CadPatchProposal against the supplied document digest. The application will validate, preview, and optionally apply the patch; you never apply it yourself.

Planning rules:
- Preserve the user's units and existing design intent. Prefer editing a named parameter when it already controls the requested dimension.
- Reference only featureId, sketchId, bodyId, parameter names, and topology hashes present in the digest. New primitives are the only operation that does not require an existing target.
- Treat feature order as history order. When several new operations are required, order them so later operations can reference only identifiers already present in the digest; newly generated result IDs are not available inside the same proposal.
- Use set_feature_dimension for existing primitive dimensions; extrude distance; fillet radius; chamfer distance; pattern count, spacing, or angleDeg; and transform fields translation.x/y/z or rotationDeg.x/y/z.
- Use add_edge_modifier only when the digest contains an explicitly selected edge with a numeric hash. Never guess an edge.
- For subtract and intersect, preserve targetBodyIds order: the first body is the target and later bodies are tools.
- Keep the patch minimal. Do not delete unrelated features, invent unsupported geometry, or silently substitute a different operation.
- Put any ambiguity or necessary interpretation in assumptions. If the request cannot be represented safely, explain the limitation in assumptions and choose the smallest non-destructive supported patch.
- Write a concise summary in future tense. Never claim the model or document has already changed.

Return only the strict structured output required by the response schema.`;

interface ProposalInput {
  prompt: string;
  digest: CadDocumentDigest;
}

export interface AssistantStatus {
  configured: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
}

function providerFor(env: CloudflareEnv) {
  const genericKey = env.AI_API_KEY?.trim();
  const openAiKey = env.OPENAI_API_KEY?.trim();
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  if (env.AI_PROVIDER === 'openai' && !genericKey && !openAiKey && openRouterKey) {
    return 'openrouter';
  }
  if (
    env.AI_PROVIDER === 'openrouter' &&
    !genericKey &&
    !openRouterKey &&
    openAiKey
  ) {
    return 'openai';
  }
  if (env.AI_PROVIDER) {
    return env.AI_PROVIDER;
  }
  if (openRouterKey) {
    return 'openrouter';
  }
  if (openAiKey) {
    return 'openai';
  }
  return DEFAULT_AI_PROVIDER;
}

function apiKeyFor(env: CloudflareEnv, provider: string) {
  const genericKey = env.AI_API_KEY?.trim();
  const providerKey =
    provider === 'openrouter'
      ? env.OPENROUTER_API_KEY?.trim()
      : env.OPENAI_API_KEY?.trim();
  return provider === 'openrouter'
    ? providerKey || genericKey || undefined
    : genericKey || providerKey || undefined;
}

function modelFor(env: CloudflareEnv, provider: string) {
  if (env.AI_PROVIDER && env.AI_PROVIDER !== provider) {
    return provider === 'openrouter'
      ? DEFAULT_OPENROUTER_MODEL
      : DEFAULT_AI_MODEL;
  }
  return (
    env.AI_MODEL ??
    (provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_AI_MODEL)
  );
}

function upstreamUrlFor(env: CloudflareEnv, provider: string) {
  if (env.AI_BASE_URL) {
    return env.AI_BASE_URL;
  }
  if (provider === 'openai') {
    return OPENAI_RESPONSES_URL;
  }
  if (provider === 'openrouter') {
    return OPENROUTER_RESPONSES_URL;
  }
  return undefined;
}

export function getAssistantStatus(env: CloudflareEnv): AssistantStatus {
  const provider = providerFor(env);
  return {
    configured: Boolean(apiKeyFor(env, provider)),
    provider,
    model: modelFor(env, provider),
    reasoningEffort:
      env.AI_REASONING_EFFORT ?? DEFAULT_AI_REASONING_EFFORT
  };
}

function jsonError(error: string, code: string, status: number): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

interface ProviderErrorDetails {
  code?: string;
  errorType?: string;
  message?: string;
  providerName?: string;
}

function boundedProviderErrorValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 500)
    : undefined;
}

async function readProviderErrorDetails(
  response: Response
): Promise<ProviderErrorDetails> {
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const error =
    payload?.error && typeof payload.error === 'object'
      ? (payload.error as Record<string, unknown>)
      : null;
  const metadata =
    error?.metadata && typeof error.metadata === 'object'
      ? (error.metadata as Record<string, unknown>)
      : null;
  const raw =
    typeof metadata?.raw === 'string' && metadata.raw.length <= 20_000
      ? metadata.raw
      : undefined;
  const rawPayload = raw
    ? ((() => {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return null;
        }
      })())
    : null;
  const rawError =
    rawPayload?.error && typeof rawPayload.error === 'object'
      ? (rawPayload.error as Record<string, unknown>)
      : rawPayload;
  return {
    code:
      boundedProviderErrorValue(rawError?.code) ??
      boundedProviderErrorValue(error?.code),
    errorType:
      boundedProviderErrorValue(rawError?.type) ??
      boundedProviderErrorValue(payload?.error_type),
    message:
      boundedProviderErrorValue(rawError?.message) ??
      boundedProviderErrorValue(error?.message),
    providerName: boundedProviderErrorValue(metadata?.provider_name)
  };
}

export async function streamAssistantProposal(
  input: ProposalInput,
  env: CloudflareEnv,
  safetyIdentifier?: string
): Promise<Response> {
  const provider = providerFor(env);
  const apiKey = apiKeyFor(env, provider);
  if (!apiKey) {
    return jsonError(
      'AI is not configured for this environment.',
      'AI_NOT_CONFIGURED',
      503
    );
  }

  const upstreamUrl = upstreamUrlFor(env, provider);
  if (!upstreamUrl) {
    return jsonError(
      'AI_BASE_URL is required for a Responses-compatible provider.',
      'AI_PROVIDER_NOT_CONFIGURED',
      503
    );
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json'
  };
  if (provider === 'openrouter') {
    headers['X-Title'] = env.AI_APP_NAME ?? 'OpenZCAD';
    if (env.AI_SITE_URL) {
      headers['HTTP-Referer'] = env.AI_SITE_URL;
    }
  }

  const upstream = await fetch(upstreamUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelFor(env, provider),
      instructions: CAD_ASSISTANT_INSTRUCTIONS,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `CAD request:\n${input.prompt}\n\nCurrent document digest:\n${JSON.stringify(input.digest)}`
            }
          ]
        }
      ],
      reasoning: {
        effort: env.AI_REASONING_EFFORT ?? DEFAULT_AI_REASONING_EFFORT
      },
      text: {
        format: {
          type: 'json_schema',
          name: 'openzcad_patch',
          strict: true,
          schema: CAD_PATCH_JSON_SCHEMA
        }
      },
      max_output_tokens: 3_000,
      store: false,
      stream: true,
      ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {})
    })
  });

  if (!upstream.ok || !upstream.body) {
    const details = await readProviderErrorDetails(upstream);
    console.error('AI Responses provider failed:', {
      provider,
      status: upstream.status,
      ...details
    });
    return jsonError(
      'The modeling assistant could not generate a patch.',
      'AI_UPSTREAM_ERROR',
      502
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-content-type-options': 'nosniff'
    }
  });
}
