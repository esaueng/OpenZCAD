/**
 * What the assistant says when no model provider is configured.
 *
 * A production user can neither set a shell variable nor restart the Worker,
 * so the developer instruction is a dev-server message only; everyone else is
 * told the step they can take themselves — a personal token in Settings.
 */
export function unconfiguredAssistantMessage({
  provider,
  signedIn,
  dev
}: {
  provider: string;
  signedIn: boolean;
  dev: boolean;
}): string {
  if (dev) {
    return provider === 'openrouter'
      ? 'Set OPENROUTER_API_KEY in your shell or apps/web/.dev.vars (or as a beta Worker secret), then restart the app.'
      : 'Add AI_API_KEY to apps/web/.dev.vars (or a beta Worker secret), then restart the app.';
  }
  return signedIn
    ? 'The assistant is not configured for this deployment. Add a token in Settings → AI Assistant.'
    : 'Sign in and add a personal token in Settings → AI Assistant to use the assistant.';
}
