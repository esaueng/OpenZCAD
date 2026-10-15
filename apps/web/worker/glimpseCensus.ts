import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import type { GlimpseEnv } from './glimpse';
import { census, type Census } from './glimpseContract';
type CensusEnv = GlimpseEnv & Pick<CloudflareEnv, 'DB'>;
// Only numeric storage metadata is read. No document_json, names, emails,
// object keys, project identifiers or account identifiers are exported.
export const CENSUS_SQL = `WITH enrolled AS (
 SELECT u.id FROM users u JOIN glimpse_account_consent c ON c.user_id=u.id
 WHERE c.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
 AND NOT EXISTS (SELECT 1 FROM account_erasure_requests e WHERE e.user_id=u.id)
), owned AS (SELECT p.id,p.document_bytes,p.document_object_id FROM projects p JOIN enrolled e ON p.user_id=e.id),
 rev AS (SELECT r.document_bytes,r.document_object_id FROM revisions r JOIN owned p ON r.project_id=p.id),
 objects AS (SELECT o.stored_bytes FROM project_document_objects o JOIN owned p ON o.project_id=p.id),
 assets AS (SELECT a.stored_bytes,a.logical_bytes FROM project_storage_assets a JOIN owned p ON a.project_id=p.id),
 artifacts_owned AS (SELECT a.bytes AS bytes FROM artifacts a JOIN owned p ON a.project_id=p.id)
 SELECT (SELECT generation FROM glimpse_census_clock WHERE singleton=1) AS generation,
 (SELECT COUNT(*) FROM enrolled) AS accounts, (SELECT COUNT(*) FROM owned) AS projects,
 (SELECT COUNT(*) FROM rev) AS revisions,
 COALESCE((SELECT SUM(stored_bytes) FROM objects),0)+COALESCE((SELECT SUM(stored_bytes) FROM assets),0)+COALESCE((SELECT SUM(bytes) FROM artifacts_owned),0)+COALESCE((SELECT SUM(document_bytes) FROM owned WHERE document_object_id IS NULL),0)+COALESCE((SELECT SUM(document_bytes) FROM rev WHERE document_object_id IS NULL),0) AS storedBytes,
 COALESCE((SELECT SUM(document_bytes) FROM owned),0)+COALESCE((SELECT SUM(document_bytes) FROM rev),0)+COALESCE((SELECT SUM(logical_bytes) FROM assets),0)+COALESCE((SELECT SUM(bytes) FROM artifacts_owned),0) AS logicalBytes,
 (SELECT COUNT(*) FROM artifacts_owned WHERE bytes IS NULL) AS unknownArtifacts,
 (SELECT COUNT(*) FROM owned WHERE document_bytes<1048576) AS lt1mib,
 (SELECT COUNT(*) FROM owned WHERE document_bytes>=1048576 AND document_bytes<10485760) AS mib1to10,
 (SELECT COUNT(*) FROM owned WHERE document_bytes>=10485760 AND document_bytes<104857600) AS mib10to100,
 (SELECT COUNT(*) FROM owned WHERE document_bytes>=104857600) AS gte100mib`;
export async function publishCensus(env: CensusEnv): Promise<boolean> {
  if (
    !env.DB ||
    env.GLIMPSE_USAGE_ENABLED !== 'true' ||
    !env.GLIMPSE ||
    (typeof env.GLIMPSE !== 'object' && typeof env.GLIMPSE !== 'function')
  )
    return false;
  const binding = env.GLIMPSE as {
    snapshot?: (value: Census) => Promise<void>;
  };
  if (typeof binding.snapshot !== 'function') return false;
  try {
    // Generation and values come from one D1 transaction. Out-of-order RPC
    // deliveries cannot replace a newer snapshot in Glimpse.
    const results = await env.DB.batch([
      env.DB.prepare(
        'UPDATE glimpse_census_clock SET generation=generation+1 WHERE singleton=1'
      ),
      env.DB.prepare(CENSUS_SQL)
    ]);
    const second = results[1];
    if (!second || !('results' in second) || !Array.isArray(second.results))
      return false;
    const value = census(second.results[0], 'openzcad');
    if (!value) return false;
    await binding.snapshot(value);
    return true;
  } catch {
    return false;
  } // Collection can never interrupt a project operation.
}
export async function accountConsent(
  request: Request,
  env: CensusEnv,
  userId: string
): Promise<Response> {
  const reply = (body: Record<string, unknown>, status = 200) =>
    Response.json(body, {
      status,
      headers: { 'Cache-Control': 'private, no-store' }
    });
  if (!env.DB)
    return reply({ error: 'Cloud account statistics are unavailable.' }, 503);
  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      "SELECT expires_at FROM glimpse_account_consent WHERE user_id=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    )
      .bind(userId)
      .first<{ expires_at: string }>();
    return reply({ enabled: Boolean(row), expiresAt: row?.expires_at ?? null });
  }
  if (request.method !== 'POST')
    return reply({ error: 'Method not allowed' }, 405);
  if (request.headers.get('Content-Type') !== 'application/json')
    return reply({ error: 'Expected JSON' }, 415);
  if (Number(request.headers.get('Content-Length')) > 64)
    return reply({ error: 'Invalid consent' }, 413);
  const reader = request.body?.getReader();
  if (!reader) return reply({ error: 'Invalid consent' }, 400);
  let text = '';
  const decoder = new TextDecoder();
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 64) {
        await reader.cancel();
        return reply({ error: 'Invalid consent' }, 413);
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const v = JSON.parse(text) as Record<string, unknown>;
    if (
      !v ||
      Object.keys(v).sort().join(',') !== 'enabled,version' ||
      typeof v.enabled !== 'boolean' ||
      v.version !== 2
    )
      return reply({ error: 'Invalid consent' }, 400);
    if (v.enabled && env.GLIMPSE_USAGE_ENABLED !== 'true')
      return reply(
        { error: 'Account statistics are not enabled on this deployment.' },
        503
      );
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    if (v.enabled)
      await env.DB.prepare(
        'INSERT INTO glimpse_account_consent(user_id,expires_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at'
      )
        .bind(userId, expiresAt)
        .run();
    else
      await env.DB.prepare(
        'DELETE FROM glimpse_account_consent WHERE user_id=?'
      )
        .bind(userId)
        .run();
    const published = await publishCensus(env);
    return reply({
      enabled: v.enabled,
      expiresAt: v.enabled ? expiresAt : null,
      publication: published ? 'updated' : 'pending'
    });
  } catch {
    return reply(
      { error: 'Could not update account statistics permission.' },
      503
    );
  }
}
