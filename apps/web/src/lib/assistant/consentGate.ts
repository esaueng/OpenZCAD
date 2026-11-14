/**
 * The assistant's consent gate on an encrypted project (ADR-024 Phase 6,
 * slice 6-1). A plaintext project has no gate: `useAssistantConsentGate`
 * answers null and the assistant behaves exactly as before. For an
 * encrypted project it loads the crypto-bearing consent module on demand,
 * reads and verifies this account's MAC'd consent for the project, and
 * gives the panel three actions: `confirm` (re-read and verify right before
 * a request: fails closed), `allow` (write the consent the dialog asked
 * for) and `stop` (write the revocation). The Worker cannot make this
 * browser send: only a record this account key verifies, for the current
 * copy and provider route, at or above this device's pin, permits it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ASSISTANT_CONSENT_COPY_VERSION,
  PROJECT_STORAGE_FORMAT_PLAINTEXT,
  type ProjectSummary
} from '@openzcad/shared';
import type * as ConsentModule from '../e2ee/assistantConsent';
import type { AssistantConsentState } from '../e2ee/assistantConsent';
import { ENCRYPTED_PROJECT_ASSISTANT_NOTICE } from './encryptedProject';

export type { AssistantConsentState };

export const ASSISTANT_CONSENT_LOCKED_NOTICE =
  'Unlock encryption on this device (Settings › Encryption) to use the assistant on this encrypted project. Nothing is sent until then.';
export const ASSISTANT_CONSENT_UNCHECKED_NOTICE =
  'Your assistant choice for this encrypted project could not be checked, so nothing was sent. Try again.';

export type AssistantConsentGateStatus =
  /** Reading and verifying the account's record. */
  | { readonly kind: 'checking' }
  /**
   * The assistant stays off on this project: the account cannot store
   * consent (flag off, migration 0041 missing, an older Worker) or this
   * device cannot read it. Nothing is ever sent.
   */
  | { readonly kind: 'unavailable'; readonly reason: string }
  /** Keys are not unlocked on this page; a send re-checks. */
  | { readonly kind: 'locked' }
  | { readonly kind: 'ready'; readonly state: AssistantConsentState };

/** What `confirm` decided, right before a request. */
export type AssistantConsentDecision =
  | { readonly kind: 'permitted' }
  | { readonly kind: 'ask' }
  | { readonly kind: 'blocked'; readonly message: string };

export interface AssistantConsentGate {
  readonly projectId: string;
  readonly status: AssistantConsentGateStatus;
  /** The last write or check failure, for the panel's notice. */
  readonly error: string | null;
  /** True when the verified record permits exactly this provider route. */
  permits(route: string): boolean;
  confirm(route: string): Promise<AssistantConsentDecision>;
  allow(route: string): Promise<boolean>;
  stop(): Promise<boolean>;
}

type Module = typeof ConsentModule;
export type ConsentModuleLoader = () => Promise<Module>;

let loadedModule: Promise<Module> | null = null;
const defaultLoader: ConsentModuleLoader = () =>
  (loadedModule ??= import('../e2ee/assistantConsent'));

function errorCode(error: unknown): { status?: number; code?: string } {
  if (!error || typeof error !== 'object') return {};
  const value = error as { status?: unknown; code?: unknown };
  return {
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
    ...(typeof value.code === 'string' ? { code: value.code } : {})
  };
}

/**
 * The Worker cannot store consent for this account: the flag is off (501),
 * migration 0041 is missing (503), a static host or an older Worker
 * (404/405), or the project is not one it lets this account consent for.
 */
function serverCannotConsent(error: unknown): boolean {
  const { status } = errorCode(error);
  return status === 501 || status === 503 || status === 404 || status === 405;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface AssistantConsentGateOptions {
  /** Injected in tests; the app loads the module on demand. */
  readonly loadModule?: ConsentModuleLoader;
  /** Injected in tests: the API and pins the module's context uses. */
  readonly context?: (
    module: Module,
    userId: string
  ) => ConsentModule.AssistantConsentContext | null;
}

/**
 * The gate for the open project, or null when the project is not stored
 * encrypted (no gate, no change).
 */
export function useAssistantConsentGate(
  userId: string | null,
  project: Pick<ProjectSummary, 'projectId' | 'storageFormat'> | undefined,
  options: AssistantConsentGateOptions = {}
): AssistantConsentGate | null {
  const encrypted =
    project !== undefined &&
    (project.storageFormat ?? PROJECT_STORAGE_FORMAT_PLAINTEXT) !==
      PROJECT_STORAGE_FORMAT_PLAINTEXT;
  const projectId = encrypted ? project.projectId : null;
  // Read through refs: an inline option must not restart the read.
  const loadRef = useRef(options.loadModule ?? defaultLoader);
  loadRef.current = options.loadModule ?? defaultLoader;
  const contextOf =
    options.context ??
    ((module: Module, id: string) => module.assistantConsentContext(id));
  const contextRef = useRef(contextOf);
  contextRef.current = contextOf;
  const [status, setStatus] = useState<AssistantConsentGateStatus>({
    kind: 'checking'
  });
  const [error, setError] = useState<string | null>(null);
  // Which project the status describes; a late answer for another is dropped.
  const generation = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;
  // Set by Stop until an Allow succeeds: a revocation that failed to save
  // still stops this page from sending on the account's older record.
  const stoppedRef = useRef(false);

  const read = useCallback(async (): Promise<AssistantConsentGateStatus> => {
    if (!projectId) return { kind: 'unavailable', reason: '' };
    if (!userId) {
      return {
        kind: 'unavailable',
        reason: ENCRYPTED_PROJECT_ASSISTANT_NOTICE
      };
    }
    const module = await loadRef.current();
    const ctx = contextRef.current(module, userId);
    if (!ctx) return { kind: 'locked' };
    try {
      return {
        kind: 'ready',
        state: await module.loadAssistantConsent(ctx, projectId)
      };
    } catch (caught) {
      if (serverCannotConsent(caught)) {
        return {
          kind: 'unavailable',
          reason: ENCRYPTED_PROJECT_ASSISTANT_NOTICE
        };
      }
      throw caught;
    }
  }, [projectId, userId]);

  useEffect(() => {
    if (!projectId) return;
    stoppedRef.current = false;
    const current = ++generation.current;
    setStatus({ kind: 'checking' });
    setError(null);
    void read()
      .then((next) => {
        if (generation.current === current) setStatus(next);
      })
      .catch((caught: unknown) => {
        if (generation.current !== current) return;
        // Fails closed: unknown is not allowed.
        setStatus({ kind: 'locked' });
        setError(message(caught, ASSISTANT_CONSENT_UNCHECKED_NOTICE));
      });
    return () => {
      generation.current += 1;
    };
  }, [projectId, read]);

  const permits = useCallback((route: string) => {
    const current = statusRef.current;
    if (current.kind !== 'ready') return false;
    const state = current.state;
    return (
      state.kind === 'verified' &&
      state.allowed &&
      state.route === route &&
      state.copyVersion === ASSISTANT_CONSENT_COPY_VERSION &&
      !stoppedRef.current
    );
  }, []);

  const confirm = useCallback(
    async (route: string): Promise<AssistantConsentDecision> => {
      const current = generation.current;
      let next: AssistantConsentGateStatus;
      try {
        next = await read();
      } catch (caught) {
        const text = message(caught, ASSISTANT_CONSENT_UNCHECKED_NOTICE);
        if (generation.current === current) setError(text);
        return { kind: 'blocked', message: ASSISTANT_CONSENT_UNCHECKED_NOTICE };
      }
      if (generation.current !== current) {
        return { kind: 'blocked', message: ASSISTANT_CONSENT_UNCHECKED_NOTICE };
      }
      setStatus(next);
      statusRef.current = next;
      if (next.kind === 'unavailable') {
        return { kind: 'blocked', message: next.reason };
      }
      if (next.kind === 'locked' || next.kind === 'checking') {
        return { kind: 'blocked', message: ASSISTANT_CONSENT_LOCKED_NOTICE };
      }
      if (permits(route)) return { kind: 'permitted' };
      return { kind: 'ask' };
    },
    [permits, read]
  );

  const write = useCallback(
    async (allowed: boolean, route: string): Promise<boolean> => {
      if (!projectId || !userId) return false;
      const current = generation.current;
      if (!allowed) stoppedRef.current = true;
      setError(null);
      try {
        const module = await loadRef.current();
        const ctx = contextRef.current(module, userId);
        if (!ctx) {
          setStatus({ kind: 'locked' });
          setError(ASSISTANT_CONSENT_LOCKED_NOTICE);
          return false;
        }
        const known = statusRef.current;
        const floor = Math.max(
          known.kind === 'ready' ? module.consentFloor(known.state) : 0,
          // A record the account holds that this device has not read yet.
          module.consentFloor(await module.loadAssistantConsent(ctx, projectId))
        );
        const state = await module.saveAssistantConsent(
          ctx,
          projectId,
          { allowed, route },
          floor
        );
        if (generation.current === current) {
          const next = { kind: 'ready', state } as const;
          setStatus(next);
          statusRef.current = next;
        }
        if (!allowed) return true;
        const permitted = module.consentPermits(state, route);
        if (permitted) stoppedRef.current = false;
        return permitted;
      } catch (caught) {
        if (generation.current === current) {
          setError(
            message(
              caught,
              allowed
                ? 'The assistant could not be allowed for this project. Nothing was sent.'
                : 'Stopping the assistant for this project could not be saved. Try again.'
            )
          );
          if (!allowed) {
            // Whatever the account still holds, this page sends nothing
            // more until the user allows it again (see stoppedRef).
            const blocked = {
              kind: 'ready',
              state: { kind: 'none', floor: 0 }
            } as const;
            setStatus(blocked);
            statusRef.current = blocked;
          }
        }
        return false;
      }
    },
    [projectId, userId]
  );

  const allow = useCallback((route: string) => write(true, route), [write]);
  const stop = useCallback(() => write(false, ''), [write]);

  return useMemo(
    () =>
      projectId
        ? { projectId, status, error, permits, confirm, allow, stop }
        : null,
    [allow, confirm, error, permits, projectId, status, stop]
  );
}
