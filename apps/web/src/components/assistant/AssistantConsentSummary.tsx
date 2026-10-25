import { useEffect, useState } from 'react';
import { ASSISTANT_CONSENT_COPY_VERSION } from '@openzcad/shared';
import type * as ConsentModule from '../../lib/e2ee/assistantConsent';

type Module = typeof ConsentModule;

export interface AssistantConsentSummaryProps {
  projectId: string;
  /** Injected in tests; the app loads the consent module on demand. */
  loadModule?: () => Promise<Module>;
  /** Injected in tests: the API, pins and key the module's context uses. */
  context?: (
    module: Module,
    userId: string
  ) => ConsentModule.AssistantConsentContext | null;
  /** Injected in tests: the signed-in account. */
  userId?: () => Promise<string | null>;
}

const defaultLoader = () => import('../../lib/e2ee/assistantConsent');

/**
 * The project-properties row for an encrypted project's assistant consent
 * (ADR-024 Phase 6, slice 6-1): whether this account allowed it, verified
 * against its own key, and how many co-members allowed it (plan default
 * M6; their records only their own browsers can verify).
 */
export function AssistantConsentSummary({
  projectId,
  loadModule = defaultLoader,
  context,
  userId
}: AssistantConsentSummaryProps) {
  const [text, setText] = useState('Checking…');
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<string> => {
      const module = await loadModule();
      const id = await (userId ?? (() => module.sessionUserId()))();
      if (!id) return 'Sign in to check';
      const ctx = context
        ? context(module, id)
        : module.assistantConsentContext(id);
      if (!ctx) return 'Unlock encryption on this device to check';
      let mine: string;
      try {
        const state = await module.loadAssistantConsent(ctx, projectId);
        mine =
          state.kind === 'none'
            ? 'Not allowed; it asks before reading this project'
            : state.kind === 'refused'
              ? 'Unknown: the stored choice did not verify, so nothing is sent'
              : !state.allowed
                ? 'Stopped by you'
                : state.copyVersion !== ASSISTANT_CONSENT_COPY_VERSION
                  ? 'Allowed for an older notice; it asks again'
                  : 'Allowed by you';
      } catch (caught) {
        const status = (caught as { status?: unknown } | null)?.status;
        return status === 501 || status === 503 || status === 404
          ? 'Off for encrypted projects'
          : 'Could not be checked';
      }
      try {
        const { consents } = await ctx.api.members(projectId);
        const others = consents.filter(
          (consent) => consent.userId !== id && consent.allowed
        ).length;
        if (others > 0) {
          mine += ` · allowed by ${others} other member${others === 1 ? '' : 's'}`;
        }
      } catch {
        // Co-members are a detail; the account's own answer stands.
      }
      return mine;
    })()
      .catch(() => 'Could not be checked')
      .then((next) => {
        if (!cancelled) setText(next);
      });
    return () => {
      cancelled = true;
    };
  }, [context, loadModule, projectId, userId]);
  return <>{text}</>;
}
