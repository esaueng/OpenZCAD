export const SESSION_COOKIE_NAME = '__Host-openzcad_session';

/**
 * Native apps admitted to the PKCE device authorization (`/api/auth/desktop/*`)
 * and to the bearer tokens it issues: the macOS app and, under ADR-026, the
 * iPhone and iPad app. Every layer that checks a native client reads this one
 * list (the request parser, the access-token validator, the refresh path and
 * the E2EE write guard), so a client admitted at one is admitted at all.
 */
export const NATIVE_CLIENT_IDS = ['openzcad-macos', 'openzcad-ios'] as const;

export type NativeClientId = (typeof NATIVE_CLIENT_IDS)[number];

export function isNativeClientId(value: unknown): value is NativeClientId {
  return (NATIVE_CLIENT_IDS as readonly unknown[]).includes(value);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export function readCookie(request: Request, name: string): string | null {
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

export function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization) {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  return match?.[1] ?? null;
}

/** Private write authority; never attach credential hashes to public AuthSession. */
export async function sessionWriteCredential(request: Request): Promise<{
  table: 'auth_sessions' | 'desktop_access_tokens';
  tokenHash: string;
} | null> {
  const bearer = readBearerToken(request);
  const cookie = readCookie(request, SESSION_COOKIE_NAME);
  const token = bearer ?? cookie;
  return token
    ? {
        table: bearer ? 'desktop_access_tokens' : 'auth_sessions',
        tokenHash: await sha256(token)
      }
    : null;
}
