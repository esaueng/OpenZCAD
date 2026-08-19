import {
  CLOUD_AUTOSAVE_DELAY_BOUNDS,
  DEFAULT_APP_SETTINGS,
  deepClone,
  nowIso,
  PANEL_WIDTH_LIMITS,
  type AppSettings,
  type PanelWidthLimits,
  type AppSettingsResponse,
  type AssistantCredentialMetadata,
  type AssistantProvider,
  type EffectiveAssistantSettings,
  type UpdateAppSettingsRequest,
  type UserId
} from '@openzcad/shared';
import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';
import { getAssistantStatus, type AssistantRuntimeConfig } from './assistant';
import { HttpError } from './validation';

interface SettingsRow {
  settings_json: string;
  revision: number;
}

interface CredentialRow {
  ciphertext: string;
  iv: string;
  key_version: number;
  token_hint: string;
  updated_at: string;
  last_validated_at: string | null;
}

const UNIT_SYSTEMS = ['mm', 'cm', 'm', 'inch'] as const;
const THEMES = ['system', 'dark'] as const;
const DENSITIES = ['compact', 'comfortable'] as const;
const PROJECTIONS = ['perspective', 'orthographic'] as const;
const DISPLAY_MODES = ['shaded-edges', 'shaded', 'wireframe'] as const;
const MIDDLE_DRAGS = ['pan', 'orbit', 'zoom'] as const;
const POINTER_NAVIGATIONS = ['auto', 'mouse', 'trackpad'] as const;
const PROVIDERS = ['openrouter', 'openai', 'responses-compatible'] as const;
const CREDENTIAL_SOURCES = ['deployment', 'personal'] as const;
const REASONING_EFFORTS = [
  'provider-default',
  'off',
  'low',
  'medium',
  'high',
  'xhigh'
] as const;
const MAX_CUSTOM_INSTRUCTIONS = 4_000;
const MAX_TOKEN_LENGTH = 8_192;
const CREDENTIAL_AAD_PREFIX = 'openzcad-ai-credential:v1:';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string
): boolean {
  if (typeof record[key] !== 'boolean') {
    throw new HttpError(400, `"${key}" must be a boolean.`);
  }
  return record[key];
}

function requiredMember<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T {
  const value = record[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new HttpError(400, `"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/**
 * A member that older clients may omit. Unlike `requiredMember`, a missing
 * value falls back instead of rejecting the whole save.
 */
function optionalMember<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = record[key];
  return typeof value === 'string' && allowed.includes(value as T)
    ? (value as T)
    : fallback;
}

/**
 * A panel width from a client that may predate the preference, or postdate this
 * Worker's limits. Chrome geometry is cosmetic, so an absent or out-of-range
 * width is clamped rather than made a reason to reject the whole save.
 */
function optionalPanelWidth(value: unknown, limits: PanelWidthLimits): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return limits.default;
  }
  return Math.round(Math.min(limits.max, Math.max(limits.min, value)));
}

/**
 * An optional bounded preference: unusable becomes the default, out of range
 * becomes the nearest bound. Clamping rather than rejecting keeps one bad
 * number from failing a whole settings save, and matches how panel widths and
 * the browser's own normalization treat the same shape of value.
 */
function optionalBoundedNumber(
  value: unknown,
  bounds: { min: number; max: number; default: number }
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return bounds.default;
  }
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));
}

function requiredNumber(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): number {
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new HttpError(
      400,
      `"${key}" must be between ${minimum} and ${maximum}.`
    );
  }
  return value;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
  allowBlank = false
): string {
  const value = record[key];
  if (
    typeof value !== 'string' ||
    (!allowBlank && !value.trim()) ||
    value.length > maximum
  ) {
    throw new HttpError(
      400,
      `"${key}" must be ${allowBlank ? '' : 'a non-empty string '}at most ${maximum} characters.`
    );
  }
  return value.trim();
}

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return true;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] === 0
  );
}

export function validateAssistantBaseUrl(
  value: string,
  environment: CloudflareEnv['ENVIRONMENT'],
  allowedBaseUrlHosts?: string
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'The AI endpoint must be a valid URL.');
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'The AI endpoint cannot contain credentials.');
  }
  const hostname = url.hostname.toLowerCase();
  const bareHostname =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  const localDevelopment =
    environment === 'development' &&
    url.protocol === 'http:' &&
    (hostname === 'localhost' || hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localDevelopment) {
    throw new HttpError(400, 'The AI endpoint must use HTTPS.');
  }
  if (
    hostname === 'localhost' ||
    bareHostname === '::' ||
    bareHostname === '::1' ||
    // IPv4-mapped and NAT64 forms tunnel private IPv4 targets through the
    // IPv6 grammar; no legitimate public provider uses them, so block all.
    bareHostname.startsWith('::ffff:') ||
    bareHostname.startsWith('64:ff9b::') ||
    /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(bareHostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    isPrivateIpv4(hostname)
  ) {
    if (!localDevelopment) {
      throw new HttpError(400, 'Private-network AI endpoints are not allowed.');
    }
  }
  if (environment !== 'development') {
    const allowedHosts = new Set(
      (allowedBaseUrlHosts ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    );
    if (!allowedHosts.has(hostname)) {
      throw new HttpError(
        400,
        'The AI endpoint hostname is not approved for this deployment.'
      );
    }
  }
  url.hash = '';
  return url.toString();
}

export function parseUpdateAppSettingsRequest(
  value: unknown,
  environment: CloudflareEnv['ENVIRONMENT'],
  allowedBaseUrlHosts?: string
): UpdateAppSettingsRequest {
  const root = asRecord(value, 'Request body');
  const expectedRevision = requiredNumber(
    root,
    'expectedRevision',
    0,
    1_000_000
  );
  const settings = asRecord(root.settings, '"settings"');
  const general = asRecord(settings.general, '"settings.general"');
  const appearance = asRecord(settings.appearance, '"settings.appearance"');
  // Layout widths are optional in the payload so older clients keep saving.
  const layout = asRecord(settings.layout ?? {}, '"settings.layout"');
  const viewport = asRecord(settings.viewport, '"settings.viewport"');
  const sketching = asRecord(settings.sketching, '"settings.sketching"');
  // Optional in the payload so a client from before cloud autosave was
  // configurable keeps saving instead of being rejected.
  const files = asRecord(settings.files ?? {}, '"settings.files"');
  // Optional so clients from before the user-facing sharing switch keep saving.
  const collaboration = asRecord(
    settings.collaboration ?? {},
    '"settings.collaboration"'
  );
  const assistant = asRecord(settings.assistant, '"settings.assistant"');
  // Experiments are optional in the payload so older clients keep saving.
  const experiments = asRecord(
    settings.experiments ?? {},
    '"settings.experiments"'
  );
  const provider = requiredMember(assistant, 'provider', PROVIDERS);
  const rawBaseUrl = requiredString(assistant, 'baseUrl', 2_048, true);
  const baseUrl =
    provider === 'responses-compatible'
      ? validateAssistantBaseUrl(rawBaseUrl, environment, allowedBaseUrlHosts)
      : '';
  return {
    expectedRevision,
    settings: {
      schemaVersion: 1,
      general: {
        reopenLastProject: requiredBoolean(general, 'reopenLastProject'),
        defaultUnits: requiredMember(general, 'defaultUnits', UNIT_SYSTEMS),
        confirmDestructiveActions: requiredBoolean(
          general,
          'confirmDestructiveActions'
        )
      },
      appearance: {
        theme: requiredMember(appearance, 'theme', THEMES),
        density: requiredMember(appearance, 'density', DENSITIES),
        reducedMotion: requiredBoolean(appearance, 'reducedMotion')
      },
      layout: {
        sidebarWidth: optionalPanelWidth(
          layout.sidebarWidth,
          PANEL_WIDTH_LIMITS.sidebar
        ),
        assistantWidth: optionalPanelWidth(
          layout.assistantWidth,
          PANEL_WIDTH_LIMITS.assistant
        )
      },
      viewport: {
        defaultProjection: requiredMember(
          viewport,
          'defaultProjection',
          PROJECTIONS
        ),
        showGrid: requiredBoolean(viewport, 'showGrid'),
        displayMode: requiredMember(viewport, 'displayMode', DISPLAY_MODES),
        // Optional in the payload so a client from before this preference
        // existed keeps saving instead of being rejected.
        zoomToCursor:
          typeof viewport.zoomToCursor === 'boolean'
            ? viewport.zoomToCursor
            : true,
        middleDrag: optionalMember(viewport, 'middleDrag', MIDDLE_DRAGS, 'pan'),
        // Optional, like middleDrag: a client that predates this setting
        // must still be able to save its settings.
        pointerNavigation: optionalMember(
          viewport,
          'pointerNavigation',
          POINTER_NAVIGATIONS,
          'auto'
        )
      },
      sketching: {
        gridVisible:
          typeof sketching.gridVisible === 'boolean'
            ? sketching.gridVisible
            : DEFAULT_APP_SETTINGS.sketching.gridVisible,
        snapEnabled: requiredBoolean(sketching, 'snapEnabled'),
        geometrySnapEnabled:
          typeof sketching.geometrySnapEnabled === 'boolean'
            ? sketching.geometrySnapEnabled
            : DEFAULT_APP_SETTINGS.sketching.geometrySnapEnabled,
        inferenceEnabled:
          typeof sketching.inferenceEnabled === 'boolean'
            ? sketching.inferenceEnabled
            : DEFAULT_APP_SETTINGS.sketching.inferenceEnabled,
        linearSnap: requiredNumber(sketching, 'linearSnap', 0.001, 10_000),
        angleSnap: requiredNumber(sketching, 'angleSnap', 1, 90),
        snapTolerancePx:
          typeof sketching.snapTolerancePx === 'number'
            ? requiredNumber(sketching, 'snapTolerancePx', 4, 24)
            : DEFAULT_APP_SETTINGS.sketching.snapTolerancePx
      },
      files: {
        cloudAutosave:
          typeof files.cloudAutosave === 'boolean' ? files.cloudAutosave : true,
        // Falls back to the default rather than clamping or rejecting, matching
        // how the browser normalizes the same field and how the other optional
        // preferences behave. A cosmetic number is never worth failing a save.
        cloudAutosaveDelaySeconds: optionalBoundedNumber(
          files.cloudAutosaveDelaySeconds,
          CLOUD_AUTOSAVE_DELAY_BOUNDS
        )
      },
      collaboration: {
        enabled:
          typeof collaboration.enabled === 'boolean'
            ? collaboration.enabled
            : DEFAULT_APP_SETTINGS.collaboration.enabled
      },
      assistant: {
        enabled: requiredBoolean(assistant, 'enabled'),
        credentialSource: requiredMember(
          assistant,
          'credentialSource',
          CREDENTIAL_SOURCES
        ),
        provider,
        baseUrl,
        model: requiredString(assistant, 'model', 200),
        reasoningEffort: requiredMember(
          assistant,
          'reasoningEffort',
          REASONING_EFFORTS
        ),
        maxOutputTokens: Math.round(
          requiredNumber(assistant, 'maxOutputTokens', 1_024, 128_000)
        ),
        timeoutMs: Math.round(
          requiredNumber(assistant, 'timeoutMs', 5_000, 300_000)
        ),
        customInstructions: requiredString(
          assistant,
          'customInstructions',
          MAX_CUSTOM_INSTRUCTIONS,
          true
        )
      },
      experiments: {
        directManipulation:
          typeof experiments.directManipulation === 'boolean'
            ? experiments.directManipulation
            : true
      }
    }
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(secret.trim());
  } catch {
    throw new HttpError(
      503,
      'Personal AI credential storage is misconfigured.'
    );
  }
  if (bytes.byteLength !== 32) {
    throw new HttpError(
      503,
      'Personal AI credential storage is misconfigured.'
    );
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt'
  ]);
}

export async function encryptAssistantCredential(
  token: string,
  userId: UserId,
  secret: string
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(token);
  const additionalData = new TextEncoder().encode(
    `${CREDENTIAL_AAD_PREFIX}${userId}`
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    await encryptionKey(secret),
    encoded
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv)
  };
}

export async function decryptAssistantCredential(
  row: Pick<CredentialRow, 'ciphertext' | 'iv'>,
  userId: UserId,
  secret: string
): Promise<string> {
  try {
    const additionalData = new TextEncoder().encode(
      `${CREDENTIAL_AAD_PREFIX}${userId}`
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(row.iv),
        additionalData
      },
      await encryptionKey(secret),
      base64ToBytes(row.ciphertext)
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(503, 'The saved AI credential could not be decrypted.');
  }
}

async function readSettings(
  userId: UserId,
  env: CloudflareEnv
): Promise<{ settings: AppSettings; revision: number; synced: boolean }> {
  if (!env.DB) {
    return {
      settings: deepClone(DEFAULT_APP_SETTINGS),
      revision: 0,
      synced: false
    };
  }
  const row = await env.DB.prepare(
    'SELECT settings_json, revision FROM user_settings WHERE user_id = ?'
  )
    .bind(userId)
    .first<SettingsRow>();
  if (!row) {
    return {
      settings: deepClone(DEFAULT_APP_SETTINGS),
      revision: 0,
      synced: true
    };
  }
  try {
    const parsedSettings: unknown = JSON.parse(row.settings_json);
    return {
      settings: parseUpdateAppSettingsRequest(
        {
          expectedRevision: row.revision,
          settings: parsedSettings
        },
        env.ENVIRONMENT,
        env.AI_ALLOWED_BASE_URL_HOSTS
      ).settings,
      revision: row.revision,
      synced: true
    };
  } catch {
    return {
      settings: deepClone(DEFAULT_APP_SETTINGS),
      revision: row.revision,
      synced: true
    };
  }
}

async function readCredential(
  userId: UserId,
  env: CloudflareEnv
): Promise<CredentialRow | null> {
  if (!env.DB) {
    return null;
  }
  return env.DB.prepare(
    `SELECT ciphertext, iv, key_version, token_hint, updated_at, last_validated_at
     FROM user_ai_credentials WHERE user_id = ?`
  )
    .bind(userId)
    .first<CredentialRow>();
}

function credentialMetadata(
  row: CredentialRow | null,
  env: CloudflareEnv
): AssistantCredentialMetadata {
  return {
    stored: Boolean(row),
    ...(row
      ? {
          hint: row.token_hint,
          updatedAt: row.updated_at,
          ...(row.last_validated_at
            ? { lastValidatedAt: row.last_validated_at }
            : {})
        }
      : {}),
    storageAvailable: Boolean(env.DB && env.SETTINGS_ENCRYPTION_KEY?.trim())
  };
}

function deploymentEffective(env: CloudflareEnv): EffectiveAssistantSettings {
  const status = getAssistantStatus(env);
  return {
    ...status,
    source: 'deployment',
    provider: status.provider as AssistantProvider
  };
}

export function deploymentAssistantAllowed(
  email: string | undefined,
  env: CloudflareEnv
): boolean {
  if (env.ENVIRONMENT === 'development') {
    return true;
  }
  if (!email) {
    return false;
  }
  const normalizedEmail = email.trim().toLowerCase();
  return (
    env.AI_DEPLOYMENT_ALLOWED_EMAILS?.split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .includes(normalizedEmail) ?? false
  );
}

function effectiveAssistantStatus(
  settings: AppSettings,
  credential: CredentialRow | null,
  env: CloudflareEnv,
  email?: string
): EffectiveAssistantSettings {
  if (!settings.assistant.enabled) {
    return {
      configured: false,
      source: settings.assistant.credentialSource,
      provider: settings.assistant.provider,
      model: settings.assistant.model,
      reasoningEffort: settings.assistant.reasoningEffort
    };
  }
  if (settings.assistant.credentialSource === 'deployment') {
    return deploymentAssistantAllowed(email, env)
      ? deploymentEffective(env)
      : {
          ...deploymentEffective(env),
          configured: false
        };
  }
  return {
    configured: Boolean(credential && env.SETTINGS_ENCRYPTION_KEY?.trim()),
    source: 'personal',
    provider: settings.assistant.provider,
    model: settings.assistant.model,
    reasoningEffort: settings.assistant.reasoningEffort
  };
}

export async function resolveUserAssistant(
  userId: UserId,
  env: CloudflareEnv,
  email?: string
): Promise<{
  effective: EffectiveAssistantSettings;
  runtime: AssistantRuntimeConfig | null;
}> {
  const { settings } = await readSettings(userId, env);
  if (!settings.assistant.enabled) {
    return {
      effective: {
        configured: false,
        source: settings.assistant.credentialSource,
        provider: settings.assistant.provider,
        model: settings.assistant.model,
        reasoningEffort: settings.assistant.reasoningEffort
      },
      runtime: null
    };
  }
  if (settings.assistant.credentialSource === 'deployment') {
    return {
      effective: deploymentAssistantAllowed(email, env)
        ? deploymentEffective(env)
        : {
            ...deploymentEffective(env),
            configured: false
          },
      runtime: null
    };
  }
  const row = await readCredential(userId, env);
  const secret = env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (!row || !secret) {
    return {
      effective: {
        configured: false,
        source: 'personal',
        provider: settings.assistant.provider,
        model: settings.assistant.model,
        reasoningEffort: settings.assistant.reasoningEffort
      },
      runtime: null
    };
  }
  const apiKey = await decryptAssistantCredential(row, userId, secret);
  const reasoningEffort = settings.assistant.reasoningEffort;
  const runtime: AssistantRuntimeConfig = {
    provider: settings.assistant.provider,
    apiKey,
    ...(settings.assistant.baseUrl
      ? { baseUrl: settings.assistant.baseUrl }
      : {}),
    model: settings.assistant.model,
    reasoningEffort,
    maxOutputTokens: settings.assistant.maxOutputTokens,
    timeoutMs: settings.assistant.timeoutMs,
    customInstructions: settings.assistant.customInstructions
  };
  return {
    effective: {
      configured: true,
      source: 'personal',
      provider: runtime.provider,
      model: runtime.model,
      reasoningEffort: runtime.reasoningEffort
    },
    runtime
  };
}

export async function getAppSettings(
  userId: UserId,
  env: CloudflareEnv,
  email?: string
): Promise<AppSettingsResponse> {
  const [stored, credential] = await Promise.all([
    readSettings(userId, env),
    readCredential(userId, env)
  ]);
  return {
    settings: stored.settings,
    revision: stored.revision,
    synced: stored.synced,
    credential: credentialMetadata(credential, env),
    effectiveAssistant: effectiveAssistantStatus(
      stored.settings,
      credential,
      env,
      email
    )
  };
}

/**
 * Server-side authorization must not rely on the browser honoring the sharing
 * preference. Keep this small helper beside settings parsing so missing and
 * legacy rows receive the same default as the settings API.
 *
 * Deliberately reads the stored flag directly instead of going through
 * `readSettings`: that path re-validates the whole settings document and
 * falls back to `DEFAULT_APP_SETTINGS` — where collaboration is enabled —
 * whenever the row fails validation for ANY reason (for example a saved AI
 * endpoint whose host later left `AI_ALLOWED_BASE_URL_HOSTS`). An owner's
 * explicit "off" must never silently flip back on because an unrelated
 * setting stopped parsing. This mirrors the D1 authorization query, which
 * `json_extract`s the same flag from the same row.
 */
export async function isProjectSharingPreferenceEnabled(
  userId: UserId,
  env: CloudflareEnv
): Promise<boolean> {
  if (!env.DB) {
    return DEFAULT_APP_SETTINGS.collaboration.enabled;
  }
  const row = await env.DB.prepare(
    'SELECT settings_json FROM user_settings WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ settings_json: string }>();
  if (row) {
    try {
      const parsed = JSON.parse(row.settings_json) as {
        collaboration?: { enabled?: unknown };
      } | null;
      const enabled = parsed?.collaboration?.enabled;
      if (typeof enabled === 'boolean') {
        return enabled;
      }
    } catch {
      // Unreadable row: fall through to the same default the SQL path uses.
    }
  }
  return DEFAULT_APP_SETTINGS.collaboration.enabled;
}

export async function updateAppSettings(
  userId: UserId,
  request: UpdateAppSettingsRequest,
  env: CloudflareEnv,
  email?: string
): Promise<AppSettingsResponse> {
  if (!env.DB) {
    throw new HttpError(503, 'Account settings storage is unavailable.');
  }
  const current = await readSettings(userId, env);
  if (current.revision !== request.expectedRevision) {
    throw new HttpError(
      409,
      'Settings changed elsewhere. Reload and try again.'
    );
  }
  const nextRevision = current.revision + 1;
  const serialized = JSON.stringify(request.settings);
  const timestamp = nowIso();
  const result =
    current.revision === 0
      ? await env.DB.prepare(
          `INSERT OR IGNORE INTO user_settings
             (user_id, settings_json, revision, updated_at)
           VALUES (?, ?, ?, ?)`
        )
          .bind(userId, serialized, nextRevision, timestamp)
          .run()
      : await env.DB.prepare(
          `UPDATE user_settings
           SET settings_json = ?, revision = ?, updated_at = ?
           WHERE user_id = ? AND revision = ?`
        )
          .bind(serialized, nextRevision, timestamp, userId, current.revision)
          .run();
  if (result.meta?.changes !== 1) {
    throw new HttpError(
      409,
      'Settings changed elsewhere. Reload and try again.'
    );
  }
  return getAppSettings(userId, env, email);
}

export function parseAssistantCredential(value: unknown): string {
  const root = asRecord(value, 'Request body');
  const token = requiredString(root, 'token', MAX_TOKEN_LENGTH);
  if (token.length < 8) {
    throw new HttpError(400, 'The API token is too short.');
  }
  return token;
}

export async function saveAssistantCredential(
  userId: UserId,
  token: string,
  env: CloudflareEnv,
  email?: string
): Promise<AppSettingsResponse> {
  const secret = env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (!env.DB || !secret) {
    throw new HttpError(503, 'Personal AI credential storage is unavailable.');
  }
  const encrypted = await encryptAssistantCredential(token, userId, secret);
  const timestamp = nowIso();
  const hint = `••••${token.slice(-4)}`;
  await env.DB.prepare(
    `INSERT INTO user_ai_credentials
       (user_id, ciphertext, iv, key_version, token_hint, updated_at, last_validated_at)
     VALUES (?, ?, ?, 1, ?, ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       iv = excluded.iv,
       key_version = excluded.key_version,
       token_hint = excluded.token_hint,
       updated_at = excluded.updated_at,
       last_validated_at = NULL`
  )
    .bind(userId, encrypted.ciphertext, encrypted.iv, hint, timestamp)
    .run();
  return getAppSettings(userId, env, email);
}

export async function deleteAssistantCredential(
  userId: UserId,
  env: CloudflareEnv,
  email?: string
): Promise<AppSettingsResponse> {
  if (!env.DB) {
    throw new HttpError(503, 'Personal AI credential storage is unavailable.');
  }
  await env.DB.prepare('DELETE FROM user_ai_credentials WHERE user_id = ?')
    .bind(userId)
    .run();
  return getAppSettings(userId, env, email);
}

export async function markAssistantCredentialValidated(
  userId: UserId,
  env: CloudflareEnv
): Promise<void> {
  if (!env.DB) {
    return;
  }
  await env.DB.prepare(
    'UPDATE user_ai_credentials SET last_validated_at = ? WHERE user_id = ?'
  )
    .bind(nowIso(), userId)
    .run();
}
