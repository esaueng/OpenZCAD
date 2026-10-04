import { describe, expect, it } from 'vitest';
import { unconfiguredAssistantMessage } from './unconfigured';

describe('unconfiguredAssistantMessage', () => {
  it('tells a signed-out user how to enable the assistant', () => {
    expect(
      unconfiguredAssistantMessage({
        provider: 'openrouter',
        signedIn: false,
        dev: false
      })
    ).toBe(
      'Sign in and add a personal token in Settings → AI Assistant to use the assistant.'
    );
  });

  it('tells a signed-in user the deployment has no provider', () => {
    expect(
      unconfiguredAssistantMessage({
        provider: 'anthropic',
        signedIn: true,
        dev: false
      })
    ).toBe(
      'The assistant is not configured for this deployment. Add a token in Settings → AI Assistant.'
    );
  });

  it('never names environment variables or files outside the dev server', () => {
    for (const provider of ['openrouter', 'anthropic']) {
      for (const signedIn of [false, true]) {
        expect(
          unconfiguredAssistantMessage({ provider, signedIn, dev: false })
        ).not.toMatch(/API_KEY|\.dev\.vars|restart/);
      }
    }
  });

  it('keeps the developer instruction on the dev server', () => {
    expect(
      unconfiguredAssistantMessage({
        provider: 'openrouter',
        signedIn: false,
        dev: true
      })
    ).toContain('OPENROUTER_API_KEY');
    expect(
      unconfiguredAssistantMessage({
        provider: 'anthropic',
        signedIn: true,
        dev: true
      })
    ).toContain('AI_API_KEY');
  });
});
