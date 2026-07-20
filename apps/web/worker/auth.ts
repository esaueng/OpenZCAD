import { createRemoteJWKSet, jwtVerify } from 'jose';
import { toUserId, type AuthSession } from '@openzcad/shared';
import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';

const DEVELOPMENT_USER_ID = 'user_beta_dev';

export class AuthenticationError extends Error {
  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

type AccessTokenVerifier = (
  assertion: string,
  issuer: string,
  audience: string
) => Promise<string>;

function accessIssuer(teamDomain: string): string {
  let url: URL;
  try {
    url = new URL(teamDomain);
  } catch {
    throw new AuthenticationError('Cloudflare Access is not configured.');
  }
  if (url.protocol !== 'https:' || url.pathname !== '/') {
    throw new AuthenticationError('Cloudflare Access is not configured.');
  }
  return url.origin;
}

function accessKeySet(issuer: string) {
  let keySet = accessKeySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    accessKeySets.set(issuer, keySet);
  }
  return keySet;
}

async function verifyAccessToken(
  assertion: string,
  issuer: string,
  audience: string
): Promise<string> {
  const { payload } = await jwtVerify(assertion, accessKeySet(issuer), {
    issuer,
    audience
  });
  if (typeof payload.email !== 'string' || payload.email.trim().length === 0) {
    throw new Error('Access token does not contain an email claim.');
  }
  return payload.email;
}

async function stableUserId(email: string): Promise<AuthSession['userId']> {
  const bytes = new TextEncoder().encode(email.toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const suffix = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return toUserId(`user_${suffix}`);
}

export async function authenticateRequest(
  request: Request,
  env: CloudflareEnv,
  verify: AccessTokenVerifier = verifyAccessToken
): Promise<AuthSession> {
  const mode = env.AUTH_MODE;
  if (mode === 'development') {
    if (env.ENVIRONMENT !== 'development') {
      throw new AuthenticationError(
        'Development authentication is disabled in this environment.'
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

  if (mode !== 'cloudflare-access') {
    throw new AuthenticationError('Authentication mode is not configured.');
  }

  const accessAssertion = request.headers.get('cf-access-jwt-assertion');
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.CF_ACCESS_AUD?.trim();
  if (!accessAssertion || !teamDomain || !audience) {
    throw new AuthenticationError();
  }

  let email: string;
  try {
    const issuer = accessIssuer(teamDomain);
    email = (await verify(accessAssertion, issuer, audience))
      .trim()
      .toLowerCase();
    if (email.length === 0) {
      throw new Error('Access token does not contain an email claim.');
    }
  } catch {
    throw new AuthenticationError();
  }

  const legacyOwnerEmail = env.AUTH_LEGACY_OWNER_EMAIL?.trim().toLowerCase();
  const userId =
    legacyOwnerEmail && email === legacyOwnerEmail
      ? toUserId(DEVELOPMENT_USER_ID)
      : await stableUserId(email);
  return {
    userId,
    displayName: email.split('@')[0] || email,
    email,
    mode
  };
}
