const PROJECT_INVITATION_SESSION_KEY = 'openzcad:pending-project-invitation:v1';
const PROJECT_INVITATION_TOKEN = /^[A-Za-z0-9_-]{40,128}$/;

function validToken(value: string | null): value is string {
  return value !== null && PROJECT_INVITATION_TOKEN.test(value);
}

export function projectInvitationTokenFromHash(hash: string): string | null {
  if (!hash.startsWith('#invite=')) {
    return null;
  }
  const parameters = new URLSearchParams(hash.slice(1));
  const invitationValues = parameters.getAll('invite');
  if (
    invitationValues.length !== 1 ||
    Array.from(parameters.keys()).some((key) => key !== 'invite')
  ) {
    return null;
  }
  const token = invitationValues[0] ?? null;
  return validToken(token) ? token : null;
}

/**
 * Captures an invitation before startup restores a remembered project. The
 * fragment is scrubbed immediately and the token remains tab-scoped while an
 * email-code sign-in reloads the app state.
 */
export function captureProjectInvitationLink(
  location: Pick<
    Location,
    'hash' | 'pathname' | 'search'
  > = globalThis.location,
  history: Pick<History, 'replaceState' | 'state'> = globalThis.history,
  storage: Pick<Storage, 'getItem' | 'setItem'> = globalThis.sessionStorage
): string | null {
  const hashWasInvitation = location.hash.startsWith('#invite=');
  const fromHash = projectInvitationTokenFromHash(location.hash);
  if (hashWasInvitation) {
    history.replaceState(
      history.state,
      '',
      `${location.pathname}${location.search}`
    );
  }
  try {
    if (fromHash) {
      storage.setItem(PROJECT_INVITATION_SESSION_KEY, fromHash);
      return fromHash;
    }
    const stored = storage.getItem(PROJECT_INVITATION_SESSION_KEY);
    return validToken(stored) ? stored : null;
  } catch {
    return fromHash;
  }
}

export function clearPendingProjectInvitation(
  storage: Pick<Storage, 'removeItem'> = globalThis.sessionStorage
): void {
  try {
    storage.removeItem(PROJECT_INVITATION_SESSION_KEY);
  } catch {
    // A blocked storage API must not prevent an accepted link from clearing.
  }
}

export { PROJECT_INVITATION_SESSION_KEY };
