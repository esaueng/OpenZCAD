import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import type { GlimpseEnv } from './glimpse';

type AdoptionSnapshot = {
  generation: number;
  accounts: number;
  signedInAccounts: number;
  signInSessions: number;
};

// Only existing sign-in records are used. Account identifiers and session
// tokens never leave D1, and no activity history is written to the app DB.
const ADOPTION_SQL = `WITH accounts AS (
  SELECT id FROM users u WHERE email IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM account_erasure_requests e
    WHERE e.user_id=u.id AND e.scope IN ('profile','all')
  )
), sessions AS (
  SELECT s.user_id FROM auth_sessions s JOIN accounts a ON a.id=s.user_id
  WHERE s.expires_at >= unixepoch() AND s.token_hash NOT GLOB 'e2ee-write:*'
)
SELECT (SELECT generation FROM glimpse_census_clock WHERE singleton=1) AS generation,
  (SELECT COUNT(*) FROM accounts) AS accounts,
  (SELECT COUNT(DISTINCT user_id) FROM sessions) AS signedInAccounts,
  (SELECT COUNT(*) FROM sessions) AS signInSessions`;

export async function publishAdoption(
  env: GlimpseEnv & Pick<CloudflareEnv, 'DB'>
): Promise<void> {
  const collector = env.GLIMPSE as
    | {
        adoptionSnapshot?: (value: AdoptionSnapshot) => Promise<unknown>;
      }
    | undefined;
  if (
    !env.DB ||
    env.GLIMPSE_BASIC_ENABLED !== 'true' ||
    typeof collector?.adoptionSnapshot !== 'function'
  )
    return;
  try {
    const [, result] = await env.DB.batch([
      env.DB.prepare(
        'UPDATE glimpse_census_clock SET generation=generation+1 WHERE singleton=1'
      ),
      env.DB.prepare(ADOPTION_SQL)
    ]);
    const row = result?.results?.[0] as AdoptionSnapshot | undefined;
    if (!row?.generation) return;
    const { generation, accounts, signedInAccounts, signInSessions } = row;
    await collector.adoptionSnapshot({
      generation,
      accounts,
      signedInAccounts,
      signInSessions
    });
  } catch {
    // An unavailable collector or an older deployment can miss a snapshot.
  }
}
