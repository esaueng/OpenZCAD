import { describe, expect, it, vi } from 'vitest';
import {
  captureProjectInvitationLink,
  clearPendingProjectInvitation,
  PROJECT_INVITATION_SESSION_KEY,
  projectInvitationTokenFromHash
} from './projectInvitationLink';

const token = 'a'.repeat(43);

describe('project invitation links', () => {
  it('accepts one opaque fragment token and rejects malformed fragments', () => {
    expect(projectInvitationTokenFromHash(`#invite=${token}`)).toBe(token);
    expect(projectInvitationTokenFromHash('#invite=short')).toBeNull();
    expect(
      projectInvitationTokenFromHash(
        `#invite=${token}&invite=${'b'.repeat(43)}`
      )
    ).toBeNull();
    expect(
      projectInvitationTokenFromHash(`#invite=${token}&next=/settings`)
    ).toBeNull();
    expect(projectInvitationTokenFromHash(`#other=${token}`)).toBeNull();
  });

  it('scrubs the fragment immediately and keeps the token in session storage', () => {
    const values = new Map<string, string>();
    const replaceState = vi.fn();
    const captured = captureProjectInvitationLink(
      { hash: `#invite=${token}`, pathname: '/cad', search: '?mode=beta' },
      { state: { preserved: true }, replaceState },
      {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
      }
    );

    expect(captured).toBe(token);
    expect(values.get(PROJECT_INVITATION_SESSION_KEY)).toBe(token);
    expect(replaceState).toHaveBeenCalledWith(
      { preserved: true },
      '',
      '/cad?mode=beta'
    );
  });

  it('resumes a stored invitation and clears it after completion', () => {
    const values = new Map([[PROJECT_INVITATION_SESSION_KEY, token]]);
    expect(
      captureProjectInvitationLink(
        { hash: '', pathname: '/', search: '' },
        { state: null, replaceState: vi.fn() },
        {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, value)
        }
      )
    ).toBe(token);

    clearPendingProjectInvitation({
      removeItem: (key) => values.delete(key)
    });
    expect(values.has(PROJECT_INVITATION_SESSION_KEY)).toBe(false);
  });

  it('scrubs malformed invite fragments without storing them', () => {
    const replaceState = vi.fn();
    expect(
      captureProjectInvitationLink(
        { hash: '#invite=not-a-token', pathname: '/', search: '' },
        { state: null, replaceState },
        { getItem: () => null, setItem: vi.fn() }
      )
    ).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });
});
