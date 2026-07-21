import { describe, expect, it, vi } from 'vitest';

import {
  authenticateRequest,
  identifyAssistantRequest
} from '../apps/web/worker/auth';

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

describe('assistant request identity', () => {
  it('uses a stable opaque identity for public Cloudflare requests', async () => {
    const env = { AUTH_MODE: 'cloudflare-access' as const };
    const request = new Request('https://example.com/api/assistant/proposals', {
      headers: { 'cf-connecting-ip': '203.0.113.42' }
    });

    const first = await identifyAssistantRequest(request, env);
    const second = await identifyAssistantRequest(request, env);

    expect(first).toBe(second);
    expect(first).toMatch(/^user_anon_[a-f0-9]{24}$/);
    expect(first).not.toContain('203.0.113.42');
  });

  it('does not downgrade an invalid Access assertion to public identity', async () => {
    const request = new Request('https://example.com/api/assistant/proposals', {
      headers: {
        'cf-access-jwt-assertion': 'invalid',
        'cf-connecting-ip': '203.0.113.42'
      }
    });

    await expect(
      identifyAssistantRequest(request, {
        AUTH_MODE: 'cloudflare-access'
      })
    ).rejects.toThrow('Authentication required.');
  });
});
