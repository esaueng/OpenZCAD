import { toUserId, type AuthSession } from '@openzcad/shared';
import {
  isCloudflareFeatureEnabled,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import { isDesktopAuthReady } from './readiness';

const DEVELOPMENT_USER_ID = 'user_beta_dev';
const SESSION_COOKIE_NAME = '__Host-openzcad_session';
const LOGIN_CODE_TTL_SECONDS = 10 * 60;
const LOGIN_CODE_MAX_ATTEMPTS = 5;
const LOGIN_RATE_WINDOW_SECONDS = 15 * 60;
const LOGIN_EMAIL_RATE_LIMIT = 3;
const LOGIN_IP_RATE_LIMIT = 10;
const DEFAULT_SESSION_DAYS = 30;
const TURNSTILE_ACTION = 'email-code';
const DESKTOP_CLIENT_ID = 'openzcad-macos';
const DESKTOP_AUTH_ATTEMPT_TTL_SECONDS = 10 * 60;
const DESKTOP_AUTH_USER_CODE_LENGTH = 8;
const DESKTOP_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const DESKTOP_AUTH_IP_RATE_LIMIT = 20;
const encoder = new TextEncoder();

type AuthenticationFailure = 'missing' | 'invalid' | 'configuration';

export class AuthenticationError extends Error {
  constructor(
    message = 'Authentication required.',
    readonly failure: AuthenticationFailure = 'missing'
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthFlowError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AuthFlowError';
  }
}

interface LoginChallengeRow {
  id: string;
  email: string;
  code_hash: string;
  attempts: number;
  expires_at: number;
  consumed_at: number | null;
}

interface SessionRow {
  user_id: string;
  email: string | null;
  expires_at: number;
}

interface DesktopAuthAttemptRow {
  id: string;
  state_hash: string;
  code_challenge: string;
  client_id: string;
  user_id: string | null;
  email: string | null;
  expires_at: number;
  approved_at: number | null;
  exchanged_at: number | null;
}

interface DesktopTokenRow extends SessionRow {
  session_id: string;
  client_id: string;
  revoked_at: number | null;
  rotated_at?: number | null;
}

export interface DesktopAuthTokenResponse {
  status: 'authorized';
  session: AuthSession;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

interface TurnstileResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest('SHA-256', encoder.encode(value))
  );
}

async function sha256Base64Url(value: string): Promise<string> {
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  );
}

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return bytesToHex(
    await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthFlowError(400, 'AUTH_EMAIL_INVALID', 'Enter a valid email.');
  }
  const email = value.trim().toLowerCase();
  if (
    email.length === 0 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new AuthFlowError(400, 'AUTH_EMAIL_INVALID', 'Enter a valid email.');
  }
  return email;
}

export function generateLoginCode(): string {
  const range = 1_000_000;
  const maximum = 0x1_0000_0000;
  const unbiasedLimit = maximum - (maximum % range);
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0]! >= unbiasedLimit);
  return String(random[0]! % range).padStart(6, '0');
}

export async function hashLoginCode(
  challengeId: string,
  email: string,
  code: string,
  secret: string
): Promise<string> {
  return hmac(`openzcad-login-v1:${challengeId}:${email}:${code}`, secret);
}

async function stableUserId(email: string): Promise<AuthSession['userId']> {
  return hashedUserId('user', email);
}

async function hashedUserId(
  prefix: 'user' | 'user_anon',
  identity: string
): Promise<AuthSession['userId']> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(identity)
  );
  const suffix = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return toUserId(`${prefix}_${suffix}`);
}

async function hmacUserId(
  prefix: 'user_anon',
  identity: string,
  secret: string
): Promise<AuthSession['userId']> {
  const digest = await hmac(identity, secret);
  return toUserId(`${prefix}_${digest.slice(0, 24)}`);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const [candidate, ...value] = part.trim().split('=');
    if (candidate === name) {
      return value.join('=') || null;
    }
  }
  return null;
}

function configuredSessionDays(env: CloudflareEnv): number {
  const requested = Number(env.AUTH_SESSION_DAYS ?? DEFAULT_SESSION_DAYS);
  return Number.isFinite(requested)
    ? Math.min(90, Math.max(1, Math.floor(requested)))
    : DEFAULT_SESSION_DAYS;
}

export function createSessionCookie(
  token: string,
  maxAgeSeconds: number
): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function emailAuthConfigured(env: CloudflareEnv): boolean {
  return Boolean(
    env.AUTH_MODE === 'email-code' &&
    env.DB &&
    env.EMAIL &&
    env.AUTH_OTP_PEPPER?.trim() &&
    env.AUTH_EMAIL_FROM?.trim() &&
    env.TURNSTILE_SITE_KEY?.trim() &&
    env.TURNSTILE_SECRET_KEY?.trim()
  );
}

function desktopAuthFlagEnabled(env: CloudflareEnv): boolean {
  return (
    emailAuthConfigured(env) &&
    isCloudflareFeatureEnabled(env, 'DESKTOP_AUTH_ENABLED')
  );
}

export function getAuthConfig(env: CloudflareEnv): {
  mode: 'development' | 'email-code' | 'unconfigured';
  emailCodeEnabled: boolean;
  turnstileSiteKey?: string;
} {
  const mode =
    env.AUTH_MODE === 'development' || env.AUTH_MODE === 'email-code'
      ? env.AUTH_MODE
      : 'unconfigured';
  return {
    mode,
    emailCodeEnabled: emailAuthConfigured(env),
    ...(env.TURNSTILE_SITE_KEY?.trim()
      ? { turnstileSiteKey: env.TURNSTILE_SITE_KEY.trim() }
      : {})
  };
}

export async function getDesktopAuthConfig(
  env: CloudflareEnv
): Promise<ReturnType<typeof getAuthConfig> & { desktopAuthEnabled: boolean }> {
  return {
    ...getAuthConfig(env),
    desktopAuthEnabled:
      desktopAuthFlagEnabled(env) && (await isDesktopAuthReady(env.DB))
  };
}

async function requireDesktopAuth(env: CloudflareEnv): Promise<D1Database> {
  if (
    !desktopAuthFlagEnabled(env) ||
    !env.DB ||
    !(await isDesktopAuthReady(env.DB))
  ) {
    throw new AuthFlowError(
      503,
      'DESKTOP_AUTH_UNAVAILABLE',
      'Desktop sign-in is not configured.'
    );
  }
  return env.DB;
}

function requireEmailAuth(env: CloudflareEnv): asserts env is CloudflareEnv & {
  DB: D1Database;
  EMAIL: SendEmail;
  AUTH_OTP_PEPPER: string;
  AUTH_EMAIL_FROM: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
} {
  if (!emailAuthConfigured(env)) {
    throw new AuthFlowError(
      503,
      'AUTH_UNAVAILABLE',
      'Email sign-in is not configured.'
    );
  }
}

async function verifyTurnstile(
  request: Request,
  token: string,
  challengeId: string,
  env: CloudflareEnv & { TURNSTILE_SECRET_KEY: string }
): Promise<void> {
  if (!token || token.length > 2048) {
    throw new AuthFlowError(
      400,
      'AUTH_CHALLENGE_REQUIRED',
      'Complete the security check.'
    );
  }
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
    idempotency_key: challengeId
  });
  const connectingIp = request.headers.get('cf-connecting-ip')?.trim();
  if (connectingIp) {
    body.set('remoteip', connectingIp);
  }

  let response: Response;
  try {
    response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(10_000)
      }
    );
  } catch {
    throw new AuthFlowError(
      503,
      'AUTH_CHALLENGE_UNAVAILABLE',
      'The security check is temporarily unavailable.'
    );
  }
  let result: TurnstileResponse;
  try {
    result = (await response.json()) as TurnstileResponse;
  } catch {
    throw new AuthFlowError(
      503,
      'AUTH_CHALLENGE_UNAVAILABLE',
      'The security check is temporarily unavailable.'
    );
  }
  const expectedHostname = new URL(request.url).hostname;
  if (
    !response.ok ||
    result.success !== true ||
    result.action !== TURNSTILE_ACTION ||
    (env.ENVIRONMENT !== 'development' && result.hostname !== expectedHostname)
  ) {
    throw new AuthFlowError(
      400,
      'AUTH_CHALLENGE_INVALID',
      'The security check expired. Try again.'
    );
  }
}

async function consumeRateLimit(
  db: D1Database,
  bucket: string,
  limit: number,
  timestamp: number
): Promise<void> {
  const windowStart =
    Math.floor(timestamp / LOGIN_RATE_WINDOW_SECONDS) *
    LOGIN_RATE_WINDOW_SECONDS;
  await db
    .prepare(
      `INSERT INTO auth_rate_limits (bucket, window_start, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET
         window_start = CASE
           WHEN auth_rate_limits.window_start = excluded.window_start
             THEN auth_rate_limits.window_start
           ELSE excluded.window_start
         END,
         request_count = CASE
           WHEN auth_rate_limits.window_start = excluded.window_start
             THEN auth_rate_limits.request_count + 1
           ELSE 1
         END`
    )
    .bind(bucket, windowStart)
    .run();
  const current = await db
    .prepare(
      `SELECT request_count
       FROM auth_rate_limits
       WHERE bucket = ? AND window_start = ?`
    )
    .bind(bucket, windowStart)
    .first<{ request_count: number }>();
  if ((current?.request_count ?? limit + 1) > limit) {
    throw new AuthFlowError(
      429,
      'AUTH_RATE_LIMITED',
      'Too many login attempts. Try again later.'
    );
  }
}

async function cleanExpiredAuthRows(
  db: D1Database,
  timestamp: number
): Promise<void> {
  const staleWindow = timestamp - LOGIN_RATE_WINDOW_SECONDS * 2;
  await db.batch([
    db
      .prepare(
        `DELETE FROM auth_email_challenges
         WHERE id IN (
           SELECT id FROM auth_email_challenges
           WHERE expires_at < ?
           LIMIT 100
         )`
      )
      .bind(timestamp),
    db
      .prepare(
        `DELETE FROM auth_sessions
         WHERE token_hash IN (
           SELECT token_hash FROM auth_sessions
           WHERE expires_at < ?
           LIMIT 100
         )`
      )
      .bind(timestamp),
    db
      .prepare(
        `DELETE FROM auth_rate_limits
         WHERE bucket IN (
           SELECT bucket FROM auth_rate_limits
           WHERE window_start < ?
           LIMIT 100
         )`
      )
      .bind(staleWindow)
  ]);
}

function loginEmail(code: string): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `${code} is your OpenZCAD sign-in code`;
  const text = [
    'Sign in to your OpenZCAD cloud profile',
    '',
    `Your code is: ${code}`,
    '',
    'This code expires in 10 minutes and can be used once.',
    'If you did not request it, you can ignore this email.'
  ].join('\n');
  const html = [
    '<h1>Sign in to OpenZCAD</h1>',
    '<p>Enter this code to open your cloud profile:</p>',
    `<p style="font:700 32px/1.2 monospace;letter-spacing:0.18em">${code}</p>`,
    '<p>This code expires in 10 minutes and can be used once.</p>',
    '<p>If you did not request it, you can ignore this email.</p>'
  ].join('');
  return { subject, text, html };
}

export async function startEmailLogin(
  request: Request,
  input: { email: unknown; turnstileToken: unknown },
  env: CloudflareEnv
): Promise<{ challengeId: string; expiresInSeconds: number }> {
  requireEmailAuth(env);
  const email = normalizeEmail(input.email);
  const turnstileToken =
    typeof input.turnstileToken === 'string' ? input.turnstileToken : '';
  const challengeId = crypto.randomUUID();
  await verifyTurnstile(request, turnstileToken, challengeId, env);

  const timestamp = nowSeconds();
  const connectingIp =
    request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  const [emailBucket, ipBucket] = await Promise.all([
    hmac(`email:${email}`, env.AUTH_OTP_PEPPER),
    hmac(`ip:${connectingIp}`, env.AUTH_OTP_PEPPER)
  ]);
  await cleanExpiredAuthRows(env.DB, timestamp);
  await Promise.all([
    consumeRateLimit(
      env.DB,
      `email:${emailBucket}`,
      LOGIN_EMAIL_RATE_LIMIT,
      timestamp
    ),
    consumeRateLimit(env.DB, `ip:${ipBucket}`, LOGIN_IP_RATE_LIMIT, timestamp)
  ]);

  const code = generateLoginCode();
  const codeHash = await hashLoginCode(
    challengeId,
    email,
    code,
    env.AUTH_OTP_PEPPER
  );
  const expiresAt = timestamp + LOGIN_CODE_TTL_SECONDS;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE auth_email_challenges
         SET consumed_at = ?
         WHERE email = ? AND consumed_at IS NULL`
    ).bind(timestamp, email),
    env.DB.prepare(
      `INSERT INTO auth_email_challenges
           (id, email, code_hash, attempts, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, 0, ?, ?, NULL)`
    ).bind(challengeId, email, codeHash, timestamp, expiresAt)
  ]);

  try {
    await env.EMAIL.send({
      to: email,
      from: { email: env.AUTH_EMAIL_FROM, name: 'OpenZCAD' },
      subject: loginEmail(code).subject,
      text: loginEmail(code).text,
      html: loginEmail(code).html
    });
  } catch (error) {
    await env.DB.prepare(`DELETE FROM auth_email_challenges WHERE id = ?`)
      .bind(challengeId)
      .run();
    console.error(
      'Email code delivery failed.',
      error instanceof Error ? error.name : 'UnknownError'
    );
    throw new AuthFlowError(
      503,
      'AUTH_EMAIL_UNAVAILABLE',
      'The sign-in email could not be sent. Try again later.'
    );
  }

  return {
    challengeId,
    expiresInSeconds: LOGIN_CODE_TTL_SECONDS
  };
}

function parseLoginCode(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value.trim())) {
    throw new AuthFlowError(
      400,
      'AUTH_CODE_INVALID',
      'Enter the six-digit code from your email.'
    );
  }
  return value.trim();
}

function parseChallengeId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 64) {
    throw new AuthFlowError(
      400,
      'AUTH_CODE_INVALID',
      'The login code is invalid or expired.'
    );
  }
  return value;
}

export async function verifyEmailLogin(
  input: { challengeId: unknown; code: unknown },
  env: CloudflareEnv
): Promise<{ session: AuthSession; cookie: string }> {
  requireEmailAuth(env);
  const challengeId = parseChallengeId(input.challengeId);
  const code = parseLoginCode(input.code);
  const timestamp = nowSeconds();
  const challenge = await env.DB.prepare(
    `SELECT id, email, code_hash, attempts, expires_at, consumed_at
     FROM auth_email_challenges
     WHERE id = ?`
  )
    .bind(challengeId)
    .first<LoginChallengeRow>();
  if (!challenge || challenge.consumed_at !== null) {
    throw new AuthFlowError(
      400,
      'AUTH_CODE_INVALID',
      'The login code is invalid or expired.'
    );
  }
  if (challenge.expires_at < timestamp) {
    await env.DB.prepare(
      `UPDATE auth_email_challenges SET consumed_at = ? WHERE id = ?`
    )
      .bind(timestamp, challengeId)
      .run();
    throw new AuthFlowError(
      400,
      'AUTH_CODE_EXPIRED',
      'The login code expired. Request a new one.'
    );
  }
  if (challenge.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
    throw new AuthFlowError(
      429,
      'AUTH_CODE_LOCKED',
      'Too many incorrect codes. Request a new one.'
    );
  }

  const expectedHash = await hashLoginCode(
    challenge.id,
    challenge.email,
    code,
    env.AUTH_OTP_PEPPER
  );
  const codeMatches = constantTimeEqual(challenge.code_hash, expectedHash);
  const decision = await env.DB.prepare(
    `UPDATE auth_email_challenges
     SET attempts = CASE WHEN ? = 1 THEN attempts ELSE attempts + 1 END,
         consumed_at = CASE WHEN ? = 1 THEN ? ELSE consumed_at END
     WHERE id = ?
       AND consumed_at IS NULL
       AND attempts < ?
       AND expires_at >= ?`
  )
    .bind(
      codeMatches ? 1 : 0,
      codeMatches ? 1 : 0,
      timestamp,
      challengeId,
      LOGIN_CODE_MAX_ATTEMPTS,
      timestamp
    )
    .run();
  if (!codeMatches) {
    throw new AuthFlowError(
      400,
      'AUTH_CODE_INVALID',
      'The login code is invalid or expired.'
    );
  }
  if (decision.meta?.changes !== 1) {
    throw new AuthFlowError(
      400,
      'AUTH_CODE_INVALID',
      'The login code is invalid or expired.'
    );
  }

  const legacyOwnerEmail = env.AUTH_LEGACY_OWNER_EMAIL?.trim().toLowerCase();
  const userId =
    legacyOwnerEmail && challenge.email === legacyOwnerEmail
      ? toUserId(DEVELOPMENT_USER_ID)
      : await stableUserId(challenge.email);
  const sessionTokenBytes = new Uint8Array(32);
  crypto.getRandomValues(sessionTokenBytes);
  const sessionToken = bytesToBase64Url(sessionTokenBytes);
  const tokenHash = await sha256(sessionToken);
  const maxAgeSeconds = configuredSessionDays(env) * 24 * 60 * 60;
  const expiresAt = timestamp + maxAgeSeconds;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email`
    ).bind(userId, challenge.email, new Date().toISOString()),
    env.DB.prepare(
      `INSERT INTO auth_sessions
           (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
    ).bind(tokenHash, userId, timestamp, expiresAt)
  ]);
  const session: AuthSession = {
    userId,
    displayName: challenge.email.split('@')[0] || challenge.email,
    email: challenge.email,
    mode: 'email-code'
  };
  return {
    session,
    cookie: createSessionCookie(sessionToken, maxAgeSeconds)
  };
}

function parseDesktopClientId(value: unknown): typeof DESKTOP_CLIENT_ID {
  if (value !== DESKTOP_CLIENT_ID) {
    throw new AuthFlowError(
      400,
      'DESKTOP_AUTH_CLIENT_INVALID',
      'The desktop client is not supported.'
    );
  }
  return value;
}

function parseBase64Url(
  value: unknown,
  label: string,
  minimum: number,
  maximum = minimum
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new AuthFlowError(
      400,
      'DESKTOP_AUTH_INVALID',
      `The desktop ${label} is invalid.`
    );
  }
  return value;
}

function parseDesktopAttemptId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 64 ||
    !/^[A-Za-z0-9-]+$/.test(value)
  ) {
    throw new AuthFlowError(
      400,
      'DESKTOP_AUTH_INVALID',
      'The desktop sign-in attempt is invalid.'
    );
  }
  return value;
}

function normalizeDesktopUserCode(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthFlowError(
      400,
      'DESKTOP_AUTH_INVALID_CODE',
      'Enter the code shown in OpenZCAD for macOS.'
    );
  }
  const normalized = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(normalized)) {
    throw new AuthFlowError(
      400,
      'DESKTOP_AUTH_INVALID_CODE',
      'Enter the 8-character code shown in OpenZCAD for macOS.'
    );
  }
  return normalized;
}

function desktopUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(DESKTOP_AUTH_USER_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const byte of bytes) {
    code += alphabet[byte % alphabet.length];
  }
  return code;
}

function desktopSession(row: { user_id: string; email: string }): AuthSession {
  return {
    userId: toUserId(row.user_id),
    displayName: row.email.split('@')[0] || row.email,
    email: row.email,
    mode: 'email-code'
  };
}

async function cleanExpiredDesktopAuthRows(
  db: D1Database,
  timestamp: number
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM desktop_auth_attempts
         WHERE id IN (
           SELECT id FROM desktop_auth_attempts
           WHERE expires_at < ?
           LIMIT 100
         )`
      )
      .bind(timestamp),
    db
      .prepare(
        `DELETE FROM desktop_access_tokens
         WHERE token_hash IN (
           SELECT token_hash FROM desktop_access_tokens
           WHERE expires_at < ?
           LIMIT 100
         )`
      )
      .bind(timestamp),
    db
      .prepare(
        `DELETE FROM desktop_refresh_tokens
         WHERE token_hash IN (
           SELECT token_hash FROM desktop_refresh_tokens
           WHERE expires_at < ?
           LIMIT 100
         )`
      )
      .bind(timestamp)
  ]);
}

export async function startDesktopAuthorization(
  request: Request,
  input: {
    clientId: unknown;
    state: unknown;
    codeChallenge: unknown;
  },
  env: CloudflareEnv
): Promise<{
  attemptId: string;
  browserUrl: string;
  expiresInSeconds: number;
  userCode: string;
}> {
  const db = await requireDesktopAuth(env);
  const clientId = parseDesktopClientId(input.clientId);
  const state = parseBase64Url(input.state, 'state', 43);
  const codeChallenge = parseBase64Url(
    input.codeChallenge,
    'PKCE challenge',
    43
  );
  const timestamp = nowSeconds();
  const connectingIp =
    request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  const ipBucket = await hmac(
    `desktop-ip:${connectingIp}`,
    env.AUTH_OTP_PEPPER!
  );
  await cleanExpiredAuthRows(db, timestamp);
  await consumeRateLimit(
    db,
    `desktop-ip:${ipBucket}`,
    DESKTOP_AUTH_IP_RATE_LIMIT,
    timestamp
  );
  await cleanExpiredDesktopAuthRows(db, timestamp);
  const attemptId = crypto.randomUUID();
  const userCode = desktopUserCode();
  await db
    .prepare(
      `INSERT INTO desktop_auth_attempts
         (id, state_hash, code_challenge, client_id, user_id, user_code_hash,
          created_at, expires_at, approved_at, exchanged_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)`
    )
    .bind(
      attemptId,
      await sha256(state),
      codeChallenge,
      clientId,
      await sha256(userCode),
      timestamp,
      timestamp + DESKTOP_AUTH_ATTEMPT_TTL_SECONDS
    )
    .run();

  const browserUrl = new URL('/', request.url);
  browserUrl.searchParams.set('desktopAuth', attemptId);
  return {
    attemptId,
    browserUrl: browserUrl.toString(),
    expiresInSeconds: DESKTOP_AUTH_ATTEMPT_TTL_SECONDS,
    userCode
  };
}

export async function approveDesktopAuthorization(
  input: { attemptId: unknown; userCode: unknown },
  session: AuthSession,
  env: CloudflareEnv
): Promise<{ ok: true }> {
  const db = await requireDesktopAuth(env);
  const attemptId = parseDesktopAttemptId(input.attemptId);
  const userCode = normalizeDesktopUserCode(input.userCode);
  const timestamp = nowSeconds();
  const result = await db
    .prepare(
      `UPDATE desktop_auth_attempts
       SET user_id = ?, approved_at = ?
       WHERE id = ?
         AND user_code_hash = ?
         AND expires_at >= ?
         AND exchanged_at IS NULL
         AND (user_id IS NULL OR user_id = ?)`
    )
    .bind(
      session.userId,
      timestamp,
      attemptId,
      await sha256(userCode),
      timestamp,
      session.userId
    )
    .run();
  if (result.meta?.changes !== 1) {
    throw new AuthFlowError(
      400,
      'DESKTOP_AUTH_INVALID',
      'The desktop sign-in attempt is invalid or expired.'
    );
  }
  return { ok: true };
}

function issueDesktopTokens(
  row: { user_id: string; email: string },
  env: CloudflareEnv,
  timestamp: number
): DesktopAuthTokenResponse & { sessionId: string } {
  const maxAgeSeconds = configuredSessionDays(env) * 24 * 60 * 60;
  return {
    status: 'authorized',
    session: desktopSession(row),
    sessionId: crypto.randomUUID(),
    accessToken: randomToken(),
    accessExpiresAt: timestamp + DESKTOP_ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: randomToken(),
    refreshExpiresAt: timestamp + maxAgeSeconds
  };
}

export async function exchangeDesktopAuthorization(
  input: {
    attemptId: unknown;
    clientId: unknown;
    state: unknown;
    verifier: unknown;
  },
  env: CloudflareEnv
): Promise<{ status: 'pending' } | DesktopAuthTokenResponse> {
  const db = await requireDesktopAuth(env);
  const attemptId = parseDesktopAttemptId(input.attemptId);
  const clientId = parseDesktopClientId(input.clientId);
  const state = parseBase64Url(input.state, 'state', 43);
  const verifier = parseBase64Url(input.verifier, 'PKCE verifier', 43, 128);
  const timestamp = nowSeconds();
  const row = await db
    .prepare(
      `SELECT a.id, a.state_hash, a.code_challenge, a.client_id, a.user_id,
              u.email, a.expires_at, a.approved_at, a.exchanged_at
       FROM desktop_auth_attempts a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.id = ?`
    )
    .bind(attemptId)
    .first<DesktopAuthAttemptRow>();
  if (
    !row ||
    row.client_id !== clientId ||
    !constantTimeEqual(row.state_hash, await sha256(state)) ||
    !constantTimeEqual(row.code_challenge, await sha256Base64Url(verifier))
  ) {
    throw new AuthFlowError(
      400,
      'DESKTOP_AUTH_INVALID',
      'The desktop sign-in attempt is invalid.'
    );
  }
  if (row.expires_at < timestamp) {
    throw new AuthFlowError(
      410,
      'DESKTOP_AUTH_EXPIRED',
      'The desktop sign-in attempt expired. Start again.'
    );
  }
  if (!row.approved_at || !row.user_id || !row.email) {
    return { status: 'pending' };
  }
  if (row.exchanged_at !== null) {
    throw new AuthFlowError(
      400,
      'DESKTOP_AUTH_CONSUMED',
      'The desktop sign-in attempt was already used.'
    );
  }

  const issued = issueDesktopTokens(
    { user_id: row.user_id, email: row.email },
    env,
    timestamp
  );
  const accessHash = await sha256(issued.accessToken);
  const refreshHash = await sha256(issued.refreshToken);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE desktop_auth_attempts
         SET exchanged_at = ?
         WHERE id = ? AND exchanged_at IS NULL AND approved_at IS NOT NULL`
      )
      .bind(timestamp, attemptId),
    db
      .prepare(
        `INSERT INTO desktop_access_tokens
           (token_hash, session_id, user_id, client_id,
            created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .bind(
        accessHash,
        issued.sessionId,
        row.user_id,
        clientId,
        timestamp,
        issued.accessExpiresAt
      ),
    db
      .prepare(
        `INSERT INTO desktop_refresh_tokens
           (token_hash, session_id, user_id, client_id,
            created_at, expires_at, rotated_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .bind(
        refreshHash,
        issued.sessionId,
        row.user_id,
        clientId,
        timestamp,
        issued.refreshExpiresAt
      )
  ]);
  if (results[0]?.meta?.changes !== 1) {
    throw new AuthFlowError(
      400,
      'DESKTOP_AUTH_CONSUMED',
      'The desktop sign-in attempt was already used.'
    );
  }
  const { sessionId: _, ...response } = issued;
  return response;
}

async function revokeDesktopSession(
  db: D1Database,
  sessionId: string,
  timestamp: number
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE desktop_access_tokens
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE session_id = ?`
      )
      .bind(timestamp, sessionId),
    db
      .prepare(
        `UPDATE desktop_refresh_tokens
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE session_id = ?`
      )
      .bind(timestamp, sessionId)
  ]);
}

export async function refreshDesktopAuthorization(
  input: { clientId: unknown; refreshToken: unknown },
  env: CloudflareEnv
): Promise<DesktopAuthTokenResponse> {
  const db = await requireDesktopAuth(env);
  const clientId = parseDesktopClientId(input.clientId);
  const refreshToken = parseBase64Url(
    input.refreshToken,
    'refresh credential',
    43
  );
  const timestamp = nowSeconds();
  const tokenHash = await sha256(refreshToken);
  const row = await db
    .prepare(
      `SELECT t.session_id, t.user_id, t.client_id, t.expires_at,
              t.revoked_at, t.rotated_at, u.email
       FROM desktop_refresh_tokens t
       INNER JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`
    )
    .bind(tokenHash)
    .first<DesktopTokenRow>();
  if (
    !row ||
    !row.email ||
    row.client_id !== clientId ||
    row.expires_at < timestamp ||
    row.revoked_at !== null ||
    row.rotated_at !== null
  ) {
    if (row?.session_id) {
      await revokeDesktopSession(db, row.session_id, timestamp);
    }
    throw new AuthenticationError(
      'Your desktop session expired. Sign in again.',
      'invalid'
    );
  }

  const issued = issueDesktopTokens(
    { user_id: row.user_id, email: row.email },
    env,
    timestamp
  );
  issued.sessionId = row.session_id;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE desktop_refresh_tokens
         SET rotated_at = ?, revoked_at = ?
         WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL`
      )
      .bind(timestamp, timestamp, tokenHash),
    db
      .prepare(
        `INSERT INTO desktop_access_tokens
           (token_hash, session_id, user_id, client_id,
            created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .bind(
        await sha256(issued.accessToken),
        row.session_id,
        row.user_id,
        clientId,
        timestamp,
        issued.accessExpiresAt
      ),
    db
      .prepare(
        `INSERT INTO desktop_refresh_tokens
           (token_hash, session_id, user_id, client_id,
            created_at, expires_at, rotated_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .bind(
        await sha256(issued.refreshToken),
        row.session_id,
        row.user_id,
        clientId,
        timestamp,
        issued.refreshExpiresAt
      )
  ]);
  if (results[0]?.meta?.changes !== 1) {
    await revokeDesktopSession(db, row.session_id, timestamp);
    throw new AuthenticationError(
      'Your desktop session expired. Sign in again.',
      'invalid'
    );
  }
  const { sessionId: _, ...response } = issued;
  return response;
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization) {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  return match?.[1] ?? null;
}

async function authenticateDesktopBearer(
  token: string,
  env: CloudflareEnv
): Promise<AuthSession> {
  const db = await requireDesktopAuth(env);
  const tokenHash = await sha256(token);
  const timestamp = nowSeconds();
  const row = await db
    .prepare(
      `SELECT t.session_id, t.user_id, t.client_id, t.expires_at,
              t.revoked_at, u.email
       FROM desktop_access_tokens t
       INNER JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`
    )
    .bind(tokenHash)
    .first<DesktopTokenRow>();
  if (
    !row ||
    !row.email ||
    row.client_id !== DESKTOP_CLIENT_ID ||
    row.expires_at < timestamp ||
    row.revoked_at !== null
  ) {
    if (row && row.expires_at < timestamp) {
      await db
        .prepare(`DELETE FROM desktop_access_tokens WHERE token_hash = ?`)
        .bind(tokenHash)
        .run();
    }
    throw new AuthenticationError(
      'Your desktop session expired. Sign in again.',
      'invalid'
    );
  }
  return desktopSession({ user_id: row.user_id, email: row.email });
}

export async function destroyDesktopAuthorization(
  request: Request,
  env: CloudflareEnv
): Promise<void> {
  const token = readBearerToken(request);
  if (!token) {
    throw new AuthenticationError();
  }
  const db = await requireDesktopAuth(env);
  const row = await db
    .prepare(
      `SELECT session_id FROM desktop_access_tokens WHERE token_hash = ?`
    )
    .bind(await sha256(token))
    .first<{ session_id: string }>();
  if (!row) {
    throw new AuthenticationError();
  }
  await revokeDesktopSession(db, row.session_id, nowSeconds());
}

export async function destroyEmailSession(
  request: Request,
  env: CloudflareEnv
): Promise<string> {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (token && env.DB) {
    await env.DB.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`)
      .bind(await sha256(token))
      .run();
  }
  return clearSessionCookie();
}

export async function authenticateRequest(
  request: Request,
  env: CloudflareEnv
): Promise<AuthSession> {
  const mode = env.AUTH_MODE;
  if (mode === 'development') {
    if (env.ENVIRONMENT !== 'development') {
      throw new AuthenticationError(
        'Development authentication is disabled in this environment.',
        'configuration'
      );
    }
    const requestedUser = request.headers.get('x-openzcad-development-user');
    const userId = toUserId(requestedUser?.trim() || DEVELOPMENT_USER_ID);
    return {
      userId,
      displayName:
        request.headers.get('x-openzcad-development-name')?.trim() ||
        'Beta developer',
      mode
    };
  }

  if (mode !== 'email-code' || !env.DB) {
    throw new AuthenticationError(
      'Authentication mode is not configured.',
      'configuration'
    );
  }
  const bearerToken = readBearerToken(request);
  if (bearerToken) {
    return authenticateDesktopBearer(bearerToken, env);
  }
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (!token) {
    throw new AuthenticationError();
  }
  const tokenHash = await sha256(token);
  const session = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email
     FROM auth_sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first<SessionRow>();
  const timestamp = nowSeconds();
  if (!session || session.expires_at < timestamp || !session.email) {
    if (session) {
      await env.DB.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`)
        .bind(tokenHash)
        .run();
    }
    throw new AuthenticationError(
      'Your session expired. Sign in again.',
      'invalid'
    );
  }
  return {
    userId: toUserId(session.user_id),
    displayName: session.email.split('@')[0] || session.email,
    email: session.email,
    mode
  };
}

/**
 * The modeling assistant remains available to local-first users. Signed-in
 * users retain their personal provider selection; public users receive a
 * secret-keyed, IP-derived identifier so D1 and providers never receive the
 * raw address as the user identifier.
 */
export interface AssistantRequestIdentity {
  userId: AuthSession['userId'];
  email?: string;
}

export async function identifyAssistantIdentity(
  request: Request,
  env: CloudflareEnv
): Promise<AssistantRequestIdentity> {
  if (env.AUTH_MODE !== 'email-code') {
    const session = await authenticateRequest(request, env);
    return {
      userId: session.userId,
      ...(session.email ? { email: session.email } : {})
    };
  }
  if (
    readCookie(request, SESSION_COOKIE_NAME) ||
    readBearerToken(request) !== null
  ) {
    const session = await authenticateRequest(request, env);
    return {
      userId: session.userId,
      ...(session.email ? { email: session.email } : {})
    };
  }
  const connectingIp = request.headers.get('cf-connecting-ip')?.trim();
  if (!connectingIp) {
    throw new AuthenticationError();
  }
  const pepper = env.AI_IDENTITY_PEPPER?.trim();
  if (!pepper) {
    throw new AuthFlowError(
      503,
      'AI_IDENTITY_UNAVAILABLE',
      'The modeling assistant identity service is unavailable.'
    );
  }
  return {
    userId: await hmacUserId(
      'user_anon',
      `openzcad-ai-user-v1:${connectingIp}`,
      pepper
    )
  };
}

export async function identifyAssistantRequest(
  request: Request,
  env: CloudflareEnv
): Promise<AuthSession['userId']> {
  return (await identifyAssistantIdentity(request, env)).userId;
}
