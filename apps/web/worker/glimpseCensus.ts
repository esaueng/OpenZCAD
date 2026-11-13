import {
  cachedSchemaProbe,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import type { GlimpseEnv } from './glimpse';
import {
  ACCOUNT_STATISTICS_VERSION,
  ACTIVITY_FIELDS,
  census,
  withheld,
  type Activity,
  type Census
} from './glimpseContract';
type CensusEnv = GlimpseEnv & Pick<CloudflareEnv, 'DB'>;
/**
 * Whether migration 0047's `glimpse_account_consent.version` exists. Until it
 * does, the permission keeps working without naming the column: grants are
 * stored as version 2 (its default once the column arrives) and snapshots
 * carry no activity counts.
 */
export const isConsentVersionReady = cachedSchemaProbe(
  `SELECT COUNT(*) AS ready FROM pragma_table_info('glimpse_account_consent')
   WHERE name = 'version'`,
  (row) => row?.ready === 1
);
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const enrolled = (activity: boolean) => `WITH enrolled AS (
 SELECT u.id${activity ? ',u.created_at,c.version' : ''} FROM users u JOIN glimpse_account_consent c ON c.user_id=u.id
 WHERE c.expires_at > ${NOW}
 AND NOT EXISTS (SELECT 1 FROM account_erasure_requests e WHERE e.user_id=u.id)
)`;
const TOTALS = `, owned AS (SELECT p.id,p.document_bytes,p.document_object_id FROM projects p JOIN enrolled e ON p.user_id=e.id),
 rev AS (SELECT r.document_bytes,r.document_object_id FROM revisions r JOIN owned p ON r.project_id=p.id),
 objects AS (SELECT o.stored_bytes FROM project_document_objects o JOIN owned p ON o.project_id=p.id),
 assets AS (SELECT a.stored_bytes,a.logical_bytes FROM project_storage_assets a JOIN owned p ON a.project_id=p.id),
 artifacts_owned AS (SELECT a.bytes AS bytes FROM artifacts a JOIN owned p ON a.project_id=p.id)`;
const SELECT_TOTALS = ` SELECT (SELECT generation FROM glimpse_census_clock WHERE singleton=1) AS generation,
 (SELECT COUNT(*) FROM enrolled) AS accounts, (SELECT COUNT(*) FROM owned) AS projects,
 (SELECT COUNT(*) FROM rev) AS revisions,
 COALESCE((SELECT SUM(stored_bytes) FROM objects),0)+COALESCE((SELECT SUM(stored_bytes) FROM assets),0)+COALESCE((SELECT SUM(bytes) FROM artifacts_owned),0)+COALESCE((SELECT SUM(document_bytes) FROM owned WHERE document_object_id IS NULL),0)+COALESCE((SELECT SUM(document_bytes) FROM rev WHERE document_object_id IS NULL),0) AS storedBytes,
 COALESCE((SELECT SUM(document_bytes) FROM owned),0)+COALESCE((SELECT SUM(document_bytes) FROM rev),0)+COALESCE((SELECT SUM(logical_bytes) FROM assets),0)+COALESCE((SELECT SUM(bytes) FROM artifacts_owned),0) AS logicalBytes,
 (SELECT COUNT(*) FROM artifacts_owned WHERE bytes IS NULL) AS unknownArtifacts,
 (SELECT COUNT(*) FROM owned WHERE document_bytes<1048576) AS lt1mib,
 (SELECT COUNT(*) FROM owned WHERE document_bytes>=1048576 AND document_bytes<10485760) AS mib1to10,
 (SELECT COUNT(*) FROM owned WHERE document_bytes>=10485760 AND document_bytes<104857600) AS mib10to100,
 (SELECT COUNT(*) FROM owned WHERE document_bytes>=104857600) AS gte100mib`;
// Only numeric storage metadata is read. No document_json, names, emails,
// object keys, project identifiers or account identifiers are exported.
export const CENSUS_SQL = `${enrolled(false)}${TOTALS}
${SELECT_TOTALS}`;
/**
 * The census plus raw save-activity counts, aggregated in SQL. Activity covers
 * only grants of version {@link ACCOUNT_STATISTICS_VERSION} or later, whose
 * text names save activity; `activityAccounts` is that population's size and
 * never leaves this Worker. An account's last save is the latest of its own
 * projects' document saves (including Trash, and edits by collaborators) and
 * the revisions it saved on any project, shared ones included. An account
 * that has never saved counts as idle from its creation.
 */
export const ACTIVITY_CENSUS_SQL = `${enrolled(true)}${TOTALS},
 consenting AS (SELECT id,created_at FROM enrolled WHERE version>=${ACCOUNT_STATISTICS_VERSION}),
 authored AS (SELECT r.author_user_id AS id,MAX(r.created_at) AS at FROM revisions r
  WHERE r.author_user_id IN (SELECT id FROM consenting) GROUP BY r.author_user_id),
 activity AS (SELECT c.created_at,NULLIF(MAX(
  COALESCE((SELECT MAX(p.updated_at) FROM projects p WHERE p.user_id=c.id),''),
  COALESCE(a.at,'')),'') AS last_save
  FROM consenting c LEFT JOIN authored a ON a.id=c.id)
${SELECT_TOTALS},
 (SELECT COUNT(*) FROM activity) AS activityAccounts,
 (SELECT COUNT(*) FROM activity WHERE last_save > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')) AS active7d,
 (SELECT COUNT(*) FROM activity WHERE last_save > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')) AS active30d,
 (SELECT COUNT(*) FROM activity WHERE COALESCE(last_save,created_at) <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')) AS idle90d`;
const NO_ACTIVITY: Activity = {
  active7d: null,
  active30d: null,
  idle90d: null
};
/**
 * Applies the k-threshold before anything leaves OpenZCAD: a count is sent as
 * null when it is below 5, or leaves fewer than 5 accounts outside it, judged
 * against both the activity population and the census `accounts` (the
 * stricter of the two decides). Raw counts that break an invariant, which SQL
 * cannot produce, are all withheld rather than sent.
 */
export function activityCounts(
  raw: Record<string, unknown>,
  accounts: number
): Activity {
  const population = raw.activityAccounts;
  const isCount = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!isCount(population) || population > accounts) return NO_ACTIVITY;
  const counts = {} as Record<(typeof ACTIVITY_FIELDS)[number], number>;
  for (const field of ACTIVITY_FIELDS) {
    const n = raw[field];
    if (!isCount(n) || n > population) return NO_ACTIVITY;
    counts[field] = n;
  }
  if (
    counts.active7d > counts.active30d ||
    counts.active30d + counts.idle90d > population
  )
    return NO_ACTIVITY;
  const result = {} as Activity;
  for (const field of ACTIVITY_FIELDS) {
    const n = counts[field];
    result[field] = withheld(n, population) || withheld(n, accounts) ? null : n;
  }
  return result;
}
/** The snapshot to send: the validated totals plus the thresholded counts. */
export function censusSnapshot(row: unknown, activity: boolean): Census | null {
  if (!row || typeof row !== 'object') return null;
  const raw = row as Record<string, unknown>;
  const totals = Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) =>
        key !== 'activityAccounts' &&
        !(ACTIVITY_FIELDS as readonly string[]).includes(key)
    )
  );
  const base = census(totals, 'openzcad');
  if (!base) return null;
  if (!activity) return base;
  return census({ ...base, ...activityCounts(raw, base.accounts) }, 'openzcad');
}
/** A Glimpse version without the activity fields rejects the snapshot. */
function withoutActivity(value: Census): Census {
  const copy = { ...value };
  for (const field of ACTIVITY_FIELDS) delete copy[field];
  return copy;
}
export async function publishCensus(env: CensusEnv): Promise<boolean> {
  if (
    !env.DB ||
    env.GLIMPSE_USAGE_ENABLED !== 'true' ||
    !env.GLIMPSE ||
    (typeof env.GLIMPSE !== 'object' && typeof env.GLIMPSE !== 'function')
  )
    return false;
  const binding = env.GLIMPSE as {
    // Glimpse resolves { accepted: false } when it already holds a newer
    // generation; versions before esaueng/glimpse#32 resolve undefined.
    snapshot?: (value: Census) => Promise<{ accepted?: unknown } | void>;
  };
  if (typeof binding.snapshot !== 'function') return false;
  try {
    const activity = await isConsentVersionReady(env.DB);
    // Generation and values come from one D1 transaction. Out-of-order RPC
    // deliveries cannot replace a newer snapshot in Glimpse.
    const results = await env.DB.batch([
      env.DB.prepare(
        'UPDATE glimpse_census_clock SET generation=generation+1 WHERE singleton=1'
      ),
      env.DB.prepare(activity ? ACTIVITY_CENSUS_SQL : CENSUS_SQL)
    ]);
    const second = results[1];
    if (!second || !('results' in second) || !Array.isArray(second.results))
      return false;
    const value = censusSnapshot(second.results[0], activity);
    if (!value) return false;
    let reply: { accepted?: unknown } | void;
    try {
      reply = await binding.snapshot(value);
    } catch (error) {
      // A Glimpse deployment older than the activity fields rejects the whole
      // snapshot as invalid. Retry exactly once without them, so the agreed
      // totals keep flowing; any other failure waits for the next hour.
      if (
        !ACTIVITY_FIELDS.some((field) => field in value) ||
        !/invalid census/i.test(String(error))
      )
        throw error;
      reply = await binding.snapshot(withoutActivity(value));
    }
    // An older Glimpse returns nothing: treat delivery as acceptance.
    return !(reply && typeof reply === 'object' && reply.accepted === false);
  } catch {
    return false;
  } // Collection can never interrupt a project operation. Nothing is logged.
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
    const versioned = await isConsentVersionReady(env.DB);
    const row = await env.DB.prepare(
      `SELECT expires_at${versioned ? ',version' : ''} FROM glimpse_account_consent WHERE user_id=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    )
      .bind(userId)
      .first<{ expires_at: string; version?: number }>();
    // `version` says which permission text the grant accepted: below the
    // current one it covers totals only, never save activity.
    return reply({
      enabled: Boolean(row),
      expiresAt: row?.expires_at ?? null,
      version: row ? (row.version ?? 2) : null,
      currentVersion: ACCOUNT_STATISTICS_VERSION
    });
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
    // A grant must accept the current text. Withdrawal is accepted from a
    // page still showing the previous text (version 2), so it always works.
    if (
      !v ||
      Object.keys(v).sort().join(',') !== 'enabled,version' ||
      typeof v.enabled !== 'boolean' ||
      !(
        v.version === ACCOUNT_STATISTICS_VERSION ||
        (v.enabled === false && v.version === 2)
      )
    )
      return reply({ error: 'Invalid consent' }, 400);
    if (v.enabled && env.GLIMPSE_USAGE_ENABLED !== 'true')
      return reply(
        { error: 'Account statistics are not enabled on this deployment.' },
        503
      );
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    if (v.enabled && (await isConsentVersionReady(env.DB)))
      await env.DB.prepare(
        'INSERT INTO glimpse_account_consent(user_id,expires_at,version) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET expires_at=excluded.expires_at,version=excluded.version'
      )
        .bind(userId, expiresAt, ACCOUNT_STATISTICS_VERSION)
        .run();
    // Before migration 0047 the grant is stored without a version and is
    // read as version 2 (totals only) once the column exists.
    else if (v.enabled)
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
      version: v.enabled
        ? (await isConsentVersionReady(env.DB))
          ? ACCOUNT_STATISTICS_VERSION
          : 2
        : null,
      currentVersion: ACCOUNT_STATISTICS_VERSION,
      publication: published ? 'updated' : 'pending'
    });
  } catch {
    return reply(
      { error: 'Could not update account statistics permission.' },
      503
    );
  }
}
