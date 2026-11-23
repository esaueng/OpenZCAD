import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import type { EncryptedProjectAssistantSettings } from '@openzcad/shared';

const MODEL = '@cf/qwen/qwen3.8-27b';
const API = 'https://api.cloudflare.com/client/v4/accounts';
export const QWEN_MAX_OUTPUT_TOKENS = 4096;

export interface EncryptedQwenConfig {
  accountId: string;
  apiToken: string;
  status: EncryptedProjectAssistantSettings;
}

export function encryptedQwenConfig(
  env: CloudflareEnv
): EncryptedQwenConfig | null {
  const accountId = env.AI_QWEN_FREE_ACCOUNT_ID?.trim();
  const apiToken = env.AI_QWEN_FREE_API_TOKEN?.trim();
  if (!accountId || !/^[0-9a-f]{32}$/.test(accountId) || !apiToken) return null;
  return {
    accountId,
    apiToken,
    status: {
      configured: true,
      source: 'deployment',
      provider: 'workers-ai',
      model: MODEL,
      reasoningEffort: 'off',
      endpoint: `${API}/${accountId}/ai/run/${MODEL}`
    }
  };
}

/**
 * The account is dedicated to Workers Free, which rejects inference beyond its
 * daily allowance. Require an affirmative, empty subscription list on each turn.
 * An upgrade, a permissions error or an unexpected API response shuts off Qwen.
 */
export async function verifyQwenFreeAccount(
  config: EncryptedQwenConfig
): Promise<boolean> {
  try {
    const response = await fetch(`${API}/${config.accountId}/subscriptions`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return false;
    const billing = (await response.json()) as {
      success?: unknown;
      result?: unknown;
    } | null;
    return (
      billing?.success === true &&
      Array.isArray(billing.result) &&
      billing.result.length === 0
    );
  } catch {
    return false;
  }
}
