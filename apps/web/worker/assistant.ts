import {
  CAD_PATCH_JSON_SCHEMA,
  type CadDocumentDigest
} from '@openzcad/ai-contracts';
import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';

export const DEFAULT_AI_MODEL = 'gpt-5.6-sol';
export const DEFAULT_AI_REASONING_EFFORT = 'high';
export const DEFAULT_AI_PROVIDER = 'openai';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const CAD_ASSISTANT_INSTRUCTIONS = `You are OpenZCAD's parametric modeling assistant.
Turn the user's request into the smallest safe patch against the supplied document digest.
Only reference feature and parameter identifiers that exist in the digest, except when adding a primitive.
Preserve design intent and units. Prefer changing named parameters over hard-coded feature dimensions.
Never claim a patch was applied. State uncertainty in assumptions.
Return only the structured patch requested by the response schema.`;

interface ProposalInput {
  prompt: string;
  digest: CadDocumentDigest;
}

function jsonError(error: string, code: string, status: number): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export async function streamAssistantProposal(
  input: ProposalInput,
  env: CloudflareEnv
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
      stream: true
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
