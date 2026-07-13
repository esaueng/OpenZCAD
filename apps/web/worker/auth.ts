import { toUserId, type AuthSession } from '@openzcad/shared';
import type { CloudflareEnv } from '@openzcad/cloudflare-adapters';

const DEVELOPMENT_USER_ID = 'user_beta_dev';

export class AuthenticationError extends Error {
  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'AuthenticationError';
  }
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
  env: CloudflareEnv
): Promise<AuthSession> {
  const mode = env.AUTH_MODE ?? 'development';
  if (mode === 'development') {
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

  const accessAssertion = request.headers.get('cf-access-jwt-assertion');
  const email = request.headers
    .get('cf-access-authenticated-user-email')
    ?.trim()
    .toLowerCase();
  if (!accessAssertion || !email) {
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
