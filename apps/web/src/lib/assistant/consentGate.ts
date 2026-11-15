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
 * copy and provider route, at or above this device's pin, permits it, and
 * only once an Allow clicked on this device granted that very record
 * (`e2ee/assistantConsentGrants.ts`). `confirm` hands the panel that grant
 * as the request's consent, which the send gate checks again at the send;
 * a Stop, in any tab, removes the grant before it awaits anything, so it
 * wins over an Allow still in flight.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ASSISTANT_CONSENT_COPY_VERSION,
  PROJECT_STORAGE_FORMAT_PLAINTEXT,
  type ProjectSummary
} from '@openzcad/shared';
import type * as ConsentModule from '../e2ee/assistantConsent';
import type { AssistantConsentState } from '../e2ee/assistantConsent';
import {
  assistantGrant,
  beginAssistantAllow,
  completeAssistantAllow,
  isAssistantGrantKey,
  stopAssistantGrant,
  withdrawAssistantAllow,
  type AssistantGrant
} from '../e2ee/assistantConsentGrants';
import type { AssistantSendConsent } from '../projectWriteGate';
import { ENCRYPTED_PROJECT_ASSISTANT_NOTICE } from './encryptedProject';

export type { AssistantConsentState };

export const ASSISTANT_CONSENT_LOCKED_NOTICE =
  'Unlock encryption on this device (Settings › Encryption) to use the assistant on this encrypted project. Nothing is sent until then.';
export const ASSISTANT_CONSENT_UNCHECKED_NOTICE =
  'Your assistant choice for this encrypted project could not be checked, so nothing was sent. Try again.';
export const ASSISTANT_CONSENT_UNRECORDED_NOTICE =
  'This device could not record your assistant choice for this project, so nothing was sent. Once this browser’s storage works again, choose Allow again.';
export const ASSISTANT_CONSENT_STOPPED_NOTICE =
  'The assistant was stopped for this project while it was being allowed, so it stays stopped and nothing was sent.';

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
  /** Send, carrying `consent`: the send gate checks it again. */
  | { readonly kind: 'permitted'; readonly consent: AssistantSendConsent }
  | { readonly kind: 'ask' }
  | { readonly kind: 'blocked'; readonly message: string };

export interface AssistantConsentGate {
  readonly projectId: string;
  readonly status: AssistantConsentGateStatus;
  /** The last write or check failure, for the panel's notice. */
  readonly error: string | null;
  /**
   * True when the verified record permits exactly this provider route and
   * this device granted that record (an Allow clicked here, not stopped).
   */
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

function isStale(error: unknown): boolean {
  return errorCode(error).code === 'E2EE_ASSISTANT_CONSENT_STALE';
}

/** Whether `grant` is this device's grant of exactly `state` for `route`. */
function grantMatches(
  grant: AssistantGrant | null,
  state: AssistantConsentState,
  route: string
): grant is AssistantGrant {
  return (
    grant !== null &&
    state.kind === 'verified' &&
    state.allowed &&
    state.route === route &&
    state.copyVersion === ASSISTANT_CONSENT_COPY_VERSION &&
    grant.sequence === state.sequence &&
    grant.route === route &&
    grant.copyVersion === ASSISTANT_CONSENT_COPY_VERSION
  );
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
  // Moves when this device's grants change (a Stop or Allow, here or in
  // another tab), so `permits` is asked again and a request it let through
  // is ended once it no longer holds.
  const [grantVersion, setGrantVersion] = useState(0);
  useEffect(() => {
    if (!projectId || typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent) => {
      if (isAssistantGrantKey(event.key)) setGrantVersion((n) => n + 1);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [projectId]);

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

  const permits = useCallback(
    (route: string) => {
      const current = statusRef.current;
      if (current.kind !== 'ready' || stoppedRef.current) return false;
      if (!projectId || !userId) return false;
      return grantMatches(
        assistantGrant(userId, projectId),
        current.state,
        route
      );
    },
    // grantVersion: a changed grant makes this a new function, so the
    // panel asks it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, userId, grantVersion]
  );

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
      // After the last await: this device's grant, read now, must be of
      // exactly the record just verified.
      const grant =
        projectId && userId && !stoppedRef.current
          ? assistantGrant(userId, projectId)
          : null;
      if (projectId && userId && grantMatches(grant, next.state, route)) {
        return {
          kind: 'permitted',
          consent: {
            userId,
            projectId,
            sequence: grant.sequence,
            route: grant.route,
            copyVersion: grant.copyVersion,
            grant: grant.id
          }
        };
      }
      return { kind: 'ask' };
    },
    [projectId, read, userId]
  );

  const show = useCallback((current: number, state: AssistantConsentState) => {
    if (generation.current !== current) return;
    const next = { kind: 'ready', state } as const;
    setStatus(next);
    statusRef.current = next;
  }, []);

  /** What a new record must exceed: what this page and the account know. */
  const floorOf = useCallback(
    (module: Module, latest: AssistantConsentState) => {
      const known = statusRef.current;
      return Math.max(
        known.kind === 'ready' ? module.consentFloor(known.state) : 0,
        module.consentFloor(latest)
      );
    },
    []
  );

  const allow = useCallback(
    async (route: string): Promise<boolean> => {
      if (!projectId || !userId) return false;
      const current = generation.current;
      setError(null);
      // Registered before anything is awaited: a Stop from now on, in any
      // tab, keeps this Allow from granting anything.
      const ticket = beginAssistantAllow(userId, projectId);
      if (!ticket) {
        setError(ASSISTANT_CONSENT_UNRECORDED_NOTICE);
        return false;
      }
      try {
        const module = await loadRef.current();
        const ctx = contextRef.current(module, userId);
        if (!ctx) {
          withdrawAssistantAllow(ticket);
          setStatus({ kind: 'locked' });
          setError(ASSISTANT_CONSENT_LOCKED_NOTICE);
          return false;
        }
        const latest = await module.loadAssistantConsent(ctx, projectId);
        // The account already holds this account's verified Allow for this
        // route and copy (made on another device): this click grants that
        // record here rather than writing another.
        const adopted = module.consentPermits(latest, route);
        const state = adopted
          ? latest
          : await module.saveAssistantConsent(
              ctx,
              projectId,
              { allowed: true, route },
              floorOf(module, latest)
            );
        if (state.kind !== 'verified' || !module.consentPermits(state, route)) {
          withdrawAssistantAllow(ticket);
          show(current, state);
          return false;
        }
        // After the last await, synchronously: granted only if no Stop (or
        // later Allow) came since the click.
        const grant = completeAssistantAllow(ticket, {
          sequence: state.sequence,
          route,
          copyVersion: state.copyVersion
        });
        if (!grant) {
          withdrawAssistantAllow(ticket);
          if (generation.current === current) {
            setError(ASSISTANT_CONSENT_STOPPED_NOTICE);
          }
          if (!adopted) {
            // The Stop wins on the account too: revoke the record this
            // Allow just stored, past it. Best effort: nothing here sends
            // on that record either way, since no grant was made.
            void module
              .saveAssistantConsent(
                ctx,
                projectId,
                { allowed: false, route: '' },
                state.sequence
              )
              .then((revoked) => show(current, revoked))
              .catch(() => undefined);
          }
          return false;
        }
        stoppedRef.current = false;
        show(current, state);
        setGrantVersion((n) => n + 1);
        return true;
      } catch (caught) {
        withdrawAssistantAllow(ticket);
        if (generation.current === current) {
          setError(
            message(
              caught,
              'The assistant could not be allowed for this project. Nothing was sent.'
            )
          );
        }
        return false;
      }
    },
    [floorOf, projectId, show, userId]
  );

  const stop = useCallback(async (): Promise<boolean> => {
    if (!projectId || !userId) return false;
    const current = generation.current;
    // Before anything is awaited: this device's grant and any Allow in
    // flight go now, in every tab, whatever the account answers.
    stopAssistantGrant(userId, projectId);
    stoppedRef.current = true;
    setGrantVersion((n) => n + 1);
    setError(null);
    try {
      const module = await loadRef.current();
      const ctx = contextRef.current(module, userId);
      if (!ctx) {
        setStatus({ kind: 'locked' });
        setError(ASSISTANT_CONSENT_LOCKED_NOTICE);
        return false;
      }
      const save = async () =>
        module.saveAssistantConsent(
          ctx,
          projectId,
          { allowed: false, route: '' },
          // A record the account holds that this device has not read yet.
          floorOf(module, await module.loadAssistantConsent(ctx, projectId))
        );
      let state: AssistantConsentState;
      try {
        state = await save();
      } catch (caught) {
        // An Allow stored meanwhile took this sequence: stop past it.
        if (!isStale(caught)) throw caught;
        state = await save();
      }
      show(current, state);
      return true;
    } catch (caught) {
      if (generation.current === current) {
        setError(
          message(
            caught,
            'Stopping the assistant for this project could not be saved. Try again.'
          )
        );
        // Whatever the account still holds, this page sends nothing more
        // until the user allows it again here: its grant is gone.
        const blocked = {
          kind: 'ready',
          state: { kind: 'none', floor: 0 }
        } as const;
        setStatus(blocked);
        statusRef.current = blocked;
      }
      return false;
    }
  }, [floorOf, projectId, show, userId]);

  return useMemo(
    () =>
      projectId
        ? { projectId, status, error, permits, confirm, allow, stop }
        : null,
    [allow, confirm, error, permits, projectId, status, stop]
  );
}
