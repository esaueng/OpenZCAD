import {
  CAD_PATCH_JSON_SCHEMA,
  type CadDocumentDigest
} from '@openzcad/ai-contracts';
import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';

export const DEFAULT_AI_MODEL = 'gpt-5.6-sol';
export const DEFAULT_AI_REASONING_EFFORT = 'high';
export const DEFAULT_AI_PROVIDER = 'openai';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

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

export function getAssistantStatus(env: CloudflareEnv): AssistantStatus {
  return {
    configured: Boolean(env.AI_API_KEY ?? env.OPENAI_API_KEY),
    provider: env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER,
    model: env.AI_MODEL ?? DEFAULT_AI_MODEL,
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

export async function streamAssistantProposal(
  input: ProposalInput,
  env: CloudflareEnv,
  safetyIdentifier?: string
): Promise<Response> {
  const apiKey = env.AI_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    return jsonError(
      'AI is not configured for this environment.',
      'AI_NOT_CONFIGURED',
      503
    );
  }

  const provider = env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER;
  const upstreamUrl =
    provider === 'openai'
      ? (env.AI_BASE_URL ?? OPENAI_RESPONSES_URL)
      : env.AI_BASE_URL;
  if (!upstreamUrl) {
    return jsonError(
      'AI_BASE_URL is required for a Responses-compatible provider.',
      'AI_PROVIDER_NOT_CONFIGURED',
      503
    );
  }

  const upstream = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: env.AI_MODEL ?? DEFAULT_AI_MODEL,
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
    console.error('AI Responses provider failed:', provider, upstream.status);
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
