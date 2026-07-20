import { describe, expect, it, vi } from 'vitest';

import { authenticateRequest } from '../apps/web/worker/auth';

describe('worker authentication', () => {
  it('allows explicit development authentication only in development', async () => {
    await expect(
      authenticateRequest(new Request('https://example.com'), {
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'development'
      })
    ).rejects.toThrow(/disabled/);

    await expect(
      authenticateRequest(new Request('https://example.com'), {
        ENVIRONMENT: 'development',
        AUTH_MODE: 'development'
      })
    ).resolves.toMatchObject({
      userId: 'user_beta_dev',
      mode: 'development'
    });
  });

  it('fails closed when the authentication mode is absent', async () => {
    await expect(
      authenticateRequest(new Request('https://example.com'), {
        ENVIRONMENT: 'beta'
      })
    ).rejects.toThrow(/not configured/);
  });

  it('derives identity only from a verified Access assertion', async () => {
    const verify = vi.fn(async () => 'Verified.User@Example.com');
    const session = await authenticateRequest(
      new Request('https://example.com', {
        headers: {
          'cf-access-jwt-assertion': 'signed-token',
          'cf-access-authenticated-user-email': 'forged@example.com'
        }
      }),
      {
        ENVIRONMENT: 'beta',
        AUTH_MODE: 'cloudflare-access',
        CF_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
        CF_ACCESS_AUD: 'application-audience'
      },
      verify
    );

    expect(verify).toHaveBeenCalledWith(
      'signed-token',
      'https://team.cloudflareaccess.com',
      'application-audience'
    );
    expect(session.email).toBe('verified.user@example.com');
    expect(session.displayName).toBe('verified.user');
  });

  it('rejects invalid Access assertions', async () => {
    const verify = vi.fn(async () => {
      throw new Error('bad signature');
    });
    await expect(
      authenticateRequest(
        new Request('https://example.com', {
          headers: { 'cf-access-jwt-assertion': 'forged-token' }
        }),
        {
          ENVIRONMENT: 'beta',
          AUTH_MODE: 'cloudflare-access',
          CF_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
          CF_ACCESS_AUD: 'application-audience'
        },
        verify
      )
    ).rejects.toThrow('Authentication required.');
  });
});
