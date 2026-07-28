import { toUserId, type AuthSession } from '@openzcad/shared';
import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';

const DEVELOPMENT_USER_ID = 'user_beta_dev';
const SESSION_COOKIE_NAME = '__Host-openzcad_session';
const LOGIN_CODE_TTL_SECONDS = 10 * 60;
const LOGIN_CODE_MAX_ATTEMPTS = 5;
const LOGIN_RATE_WINDOW_SECONDS = 15 * 60;
const LOGIN_EMAIL_RATE_LIMIT = 3;
const LOGIN_IP_RATE_LIMIT = 10;
const DEFAULT_SESSION_DAYS = 30;
const TURNSTILE_ACTION = 'email-code';
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
    (env.ENVIRONMENT === 'beta' && result.hostname !== expectedHostname)
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
  if (!constantTimeEqual(challenge.code_hash, expectedHash)) {
    await env.DB.prepare(
      `UPDATE auth_email_challenges
       SET attempts = attempts + 1
       WHERE id = ? AND consumed_at IS NULL`
    )
      .bind(challengeId)
      .run();
    throw new AuthFlowError(
      400,
      'AUTH_CODE_INVALID',
      'The login code is invalid or expired.'
    );
  }

  const consumed = await env.DB.prepare(
    `UPDATE auth_email_challenges
     SET consumed_at = ?
     WHERE id = ? AND consumed_at IS NULL AND attempts < ? AND expires_at >= ?`
  )
    .bind(timestamp, challengeId, LOGIN_CODE_MAX_ATTEMPTS, timestamp)
    .run();
  if (consumed.meta?.changes !== 1) {
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
 * users retain their account-scoped quota and personal provider selection;
 * public users receive a one-way, IP-derived identifier so D1 and providers
 * never receive the raw address as the user identifier.
 */
export async function identifyAssistantRequest(
  request: Request,
  env: CloudflareEnv
): Promise<AuthSession['userId']> {
  if (env.AUTH_MODE !== 'email-code') {
    return (await authenticateRequest(request, env)).userId;
  }
  if (readCookie(request, SESSION_COOKIE_NAME)) {
    return (await authenticateRequest(request, env)).userId;
  }
  const connectingIp = request.headers.get('cf-connecting-ip')?.trim();
  if (!connectingIp) {
    throw new AuthenticationError();
  }
  return hashedUserId('user_anon', connectingIp);
}
