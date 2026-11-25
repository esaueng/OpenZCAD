/**
 * The app-level invitation runner (L11 plan of 2026-11-25, §3.3 and §3.4).
 * One pass does everything a session does about invitations to encrypted
 * projects (`invitationPass.ts`): the invitee's KeyPackages and Welcome
 * joins, the owner's ready Adds, and renewing pending statements before
 * they lapse. Before this, a pass ran only while Settings › Encryption or
 * a project's sharing dialog was open; now it runs on any device whose
 * keys are unlocked:
 *
 * - at startup, on every encryption-state change of the account, when a
 *   key session becomes ready and when the browser comes back online;
 * - every `INVITATION_RUNNER_INTERVAL_MS` while the page is visible (and
 *   once on becoming visible after that long);
 * - when a panel asks (`syncInvitationsNow`): Settings › Encryption ›
 *   Invitations and the sharing dialog read the result instead of
 *   syncing on their own.
 *
 * Passes are single-flight: a request while one runs waits for one more
 * pass after it. A pass that fails backs the timer off (doubling up to
 * `INVITATION_RUNNER_MAX_BACKOFF_MS`); explicit requests and state changes
 * still run. Pending statements are renewed at most once per
 * `INVITATION_RENEWAL_CHECK_MS`.
 *
 * Free of any crypto import, like `automaticMigrationLoader.ts`, so the app
 * shell starts it from the entry chunk. Nothing loads until the server
 * opens the rollout gates (`/api/e2ee/config`: encryption and encrypted
 * projects); with either closed, an older Worker or the check unreachable,
 * no chunk is requested. The pass then checks the account itself, quietly:
 * without keys, or with this device locked, it does nothing until the
 * encryption state changes.
 */
import type { E2eeConfigResponse } from '@openzcad/shared';
import { desktopFetch } from '../desktopBridge';
import { subscribeEncryptionState } from './encryptionStateEvents';
import { isKeySessionActive, subscribeKeySession } from './keySession';
import type { InviteeInvitation, OwnerInvitation } from './invitations';

export const INVITATION_RUNNER_INTERVAL_MS = 60_000;
export const INVITATION_RUNNER_MAX_BACKOFF_MS = 15 * 60_000;
/** How often pending statements are checked for renewal (judgment). */
export const INVITATION_RENEWAL_CHECK_MS = 60 * 60_000;

/** What a pass did, for the panels and the app's notices. */
export interface InvitationPassResult {
  readonly incoming: readonly InviteeInvitation[];
  readonly outgoing: readonly OwnerInvitation[];
  /** Projects this device joined by their Welcome in this pass. */
  readonly joined: readonly string[];
  /** The owner's invitations this pass completed (the invitee was added). */
  readonly completed: readonly OwnerInvitation[];
  /** Ready invitations whose Add failed. */
  readonly failed: readonly {
    readonly invitation: OwnerInvitation;
    readonly error: unknown;
  }[];
  /** Pending statements renewed in this pass. */
  readonly renewed: readonly string[];
  readonly errors: readonly unknown[];
}

export type InvitationPassOutcome =
  /** The routes say the feature is closed for this account (501/503). */
  | { readonly kind: 'closed' }
  /** No keys, or this device's keys are locked. */
  | { readonly kind: 'ineligible' }
  | ({ readonly kind: 'ran' } & InvitationPassResult);

/** The lazily loaded pass (`invitationPass.ts`). */
export interface InvitationPassModule {
  /** Whether the account has keys and this device holds them unlocked. */
  eligible(userId: string): Promise<boolean>;
  runInvitationPass(
    userId: string,
    options: { readonly renew: boolean }
  ): Promise<InvitationPassOutcome>;
}

export type InvitationRunnerEvent =
  /** An owner's device of this account added someone it invited. */
  | {
      readonly kind: 'added';
      readonly projectId: string;
      readonly invitationId: string;
      /** The address this browser invited, or the one Contacts lists. */
      readonly email: string | null;
    }
  /** This device joined a project it was invited to. */
  | { readonly kind: 'joined'; readonly projectId: string }
  /**
   * Someone new to this account accepted an invitation it sent
   * (`confirm-new`): only the owner's signed Confirm adds them (ADR-024
   * amendment 2026-11-25). The runner never signs; this asks once per
   * invitation.
   */
  | {
      readonly kind: 'confirm';
      readonly projectId: string;
      readonly invitationId: string;
    };

type Trigger = 'tick' | 'visible' | 'event' | 'manual';

export interface InvitationRunnerDeps {
  gatesOpen(): Promise<boolean>;
  load(): Promise<InvitationPassModule>;
  now(): number;
  /** Whether the page is visible now. */
  visible(): boolean;
  /** Whether a key session is active (signed in, not being torn down). */
  keySessionActive(): boolean;
  /** Calls `tick` every `ms`; returns the stop. */
  every(ms: number, tick: () => void): () => void;
  /**
   * Registers the wake-ups: `changed` for an encryption-state change, a
   * key session becoming ready or the page coming back online; `shown`
   * when the page becomes visible. Returns the stop.
   */
  watch(changed: () => void, shown: () => void): () => void;
}

export interface InvitationRunner {
  /** Runs a pass now (after the one in flight), and resolves with it. */
  sync(): Promise<InvitationPassResult | null>;
  /** The newest pass's result; null before one ran. */
  latest(): InvitationPassResult | null;
  subscribe(listener: (event: InvitationRunnerEvent) => void): () => void;
  /** Called after every pass that ran, with its result. */
  onPass(listener: (result: InvitationPassResult) => void): () => void;
  dispose(): void;
}

/** The delay before the next timed pass after `failures` failed in a row. */
export function invitationRunnerBackoff(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(
    INVITATION_RUNNER_INTERVAL_MS * 2 ** (failures - 1),
    INVITATION_RUNNER_MAX_BACKOFF_MS
  );
}

const STRENGTH: Record<Trigger, number> = {
  tick: 0,
  visible: 0,
  event: 1,
  manual: 2
};

export function createInvitationRunner(
  userId: string,
  deps: InvitationRunnerDeps
): InvitationRunner {
  let disposed = false;
  /** Rollout gates and the account's standing: null until checked. */
  let gates: boolean | null = null;
  let eligible: boolean | null = null;
  let failures = 0;
  let nextAllowedAt = 0;
  let lastPassAt = Number.NEGATIVE_INFINITY;
  let lastRenewAt = Number.NEGATIVE_INFINITY;
  let latest: InvitationPassResult | null = null;
  let inFlight: Promise<InvitationPassResult | null> | null = null;
  let queued: Promise<InvitationPassResult | null> | null = null;
  let queuedTrigger: Trigger | null = null;
  const listeners = new Set<(event: InvitationRunnerEvent) => void>();
  /** Invitations whose Confirm was asked for already. */
  const asked = new Set<string>();
  const passListeners = new Set<(result: InvitationPassResult) => void>();

  const emit = (event: InvitationRunnerEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Every listener still hears it.
      }
    }
  };

  async function pass(trigger: Trigger): Promise<InvitationPassResult | null> {
    if (disposed || !deps.keySessionActive()) return null;
    const timed = trigger === 'tick' || trigger === 'visible';
    if (timed) {
      const now = deps.now();
      if (!deps.visible() || now < nextAllowedAt) return null;
      if (gates === false || eligible === false) return null;
      if (
        trigger === 'visible' &&
        now - lastPassAt < INVITATION_RUNNER_INTERVAL_MS
      )
        return null;
    }
    if (trigger === 'manual') {
      // Someone is looking: ask again rather than trust a closed answer.
      if (gates === false) gates = null;
      if (eligible === false) eligible = null;
    }
    lastPassAt = deps.now();
    try {
      if (gates === null) {
        // Only an answer is kept: a check that failed throws, backs the
        // timer off and asks again (below), never reading as closed.
        gates = await deps.gatesOpen();
        if (disposed) return null;
      }
      if (!gates) return null;
      const module = await deps.load();
      if (disposed) return null;
      if (eligible === null) {
        eligible = await module.eligible(userId);
        if (disposed) return null;
      }
      if (!eligible) return null;
      const renew = deps.now() - lastRenewAt >= INVITATION_RENEWAL_CHECK_MS;
      const outcome = await module.runInvitationPass(userId, { renew });
      if (disposed) return null;
      if (outcome.kind === 'closed') {
        gates = false;
        return null;
      }
      if (outcome.kind === 'ineligible') {
        eligible = false;
        return null;
      }
      if (renew) lastRenewAt = deps.now();
      const { kind: _ran, ...result } = outcome;
      failures = result.errors.length ? failures + 1 : 0;
      nextAllowedAt = deps.now() + invitationRunnerBackoff(failures);
      latest = result;
      for (const invitation of result.completed) {
        emit({
          kind: 'added',
          projectId: invitation.record.projectId,
          invitationId: invitation.record.invitationId,
          email: invitation.email ?? invitation.acceptor?.email ?? null
        });
      }
      for (const projectId of result.joined)
        emit({ kind: 'joined', projectId });
      for (const invitation of result.outgoing) {
        const { invitationId, projectId } = invitation.record;
        if (invitation.state !== 'confirm-new' || asked.has(invitationId))
          continue;
        asked.add(invitationId);
        emit({ kind: 'confirm', projectId, invitationId });
      }
      for (const listener of passListeners) {
        try {
          listener(result);
        } catch {
          // Every listener still hears it.
        }
      }
      return result;
    } catch {
      // A chunk that did not load or a check that failed: the timer backs
      // off, and the next state change or request asks again.
      if (disposed) return null;
      failures += 1;
      nextAllowedAt = deps.now() + invitationRunnerBackoff(failures);
      return null;
    }
  }

  function request(trigger: Trigger): Promise<InvitationPassResult | null> {
    if (disposed) return Promise.resolve(null);
    if (!inFlight) {
      const running = pass(trigger).finally(() => {
        if (inFlight === running) inFlight = null;
      });
      inFlight = running;
      return running;
    }
    if (queuedTrigger === null || STRENGTH[trigger] > STRENGTH[queuedTrigger]) {
      queuedTrigger = trigger;
    }
    if (!queued) {
      const after = inFlight;
      queued = after
        .catch(() => null)
        .then(() => {
          const next = queuedTrigger ?? trigger;
          queued = null;
          queuedTrigger = null;
          return request(next);
        });
    }
    return queued;
  }

  const changed = () => {
    // Set before the pass, so a panel's request right after this change
    // asks again too.
    gates = null;
    eligible = null;
    void request('event');
  };
  const stopTimer = deps.every(INVITATION_RUNNER_INTERVAL_MS, () => {
    void request('tick');
  });
  const stopWatching = deps.watch(changed, () => {
    void request('visible');
  });
  void request('event');

  return {
    sync: () => request('manual'),
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onPass(listener) {
      passListeners.add(listener);
      return () => passListeners.delete(listener);
    },
    dispose() {
      disposed = true;
      stopTimer();
      stopWatching();
      listeners.clear();
      passListeners.clear();
    }
  };
}

/**
 * Whether the server opens the gates invitations need: an answer, or a
 * throw for a check that could not be made (offline, a server error, a
 * rate limit, a body that does not parse), which the runner retries. A
 * route the Worker does not have (404, an older one) reads as closed.
 */
export async function invitationGatesOpen(
  fetcher: typeof desktopFetch = desktopFetch
): Promise<boolean> {
  const response = await fetcher('/api/e2ee/config', {
    credentials: 'same-origin'
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `The encryption gates could not be read (${response.status}).`
    );
  }
  let config: Partial<E2eeConfigResponse> | null;
  try {
    config = (await response.json()) as Partial<E2eeConfigResponse> | null;
  } catch {
    // An answer cut short or garbled: asked again after the backoff.
    throw new Error('The encryption gates answered with no readable body.');
  }
  return config?.enabled === true && config.projectsEnabled === true;
}

function pageDeps(userId: string): InvitationRunnerDeps {
  return {
    gatesOpen: () => invitationGatesOpen(),
    load: () => import('./invitationPass'),
    now: () => Date.now(),
    visible: () =>
      typeof document === 'undefined' || document.visibilityState === 'visible',
    keySessionActive: isKeySessionActive,
    every(ms, tick) {
      const timer = setInterval(tick, ms);
      return () => clearInterval(timer);
    },
    watch(changed, shown) {
      const stops = [
        subscribeEncryptionState(userId, changed),
        subscribeKeySession((event) => {
          if (event.phase === 'ready') changed();
        })
      ];
      if (typeof window !== 'undefined') {
        window.addEventListener('online', changed);
        stops.push(() => window.removeEventListener('online', changed));
      }
      if (typeof document !== 'undefined') {
        const visibility = () => {
          if (document.visibilityState === 'visible') shown();
        };
        document.addEventListener('visibilitychange', visibility);
        stops.push(() =>
          document.removeEventListener('visibilitychange', visibility)
        );
      }
      return () => {
        for (const stop of stops) stop();
      };
    }
  };
}

// --- The page's runner -------------------------------------------------------

let page: { userId: string; runner: InvitationRunner } | null = null;
const pageListeners = new Set<() => void>();

/**
 * Starts the page's runner for `userId` (the app shell, once per signed-in
 * account). Returns the stop; a later start for another account replaces
 * it.
 */
export function startInvitationRunner(
  userId: string,
  deps: InvitationRunnerDeps = pageDeps(userId)
): () => void {
  page?.runner.dispose();
  const runner = createInvitationRunner(userId, deps);
  const started = { userId, runner };
  page = started;
  for (const listener of pageListeners) listener();
  return () => {
    runner.dispose();
    if (page === started) {
      page = null;
      for (const listener of pageListeners) listener();
    }
  };
}

/**
 * One pass now, through the page's runner (single-flight with its own):
 * what the panels call instead of syncing themselves. Null when no runner
 * runs, the gates are closed or this device has no unlocked keys.
 */
export function syncInvitationsNow(): Promise<InvitationPassResult | null> {
  return page ? page.runner.sync() : Promise.resolve(null);
}

/** The page runner's newest result; null before one ran. */
export function latestInvitationPass(): InvitationPassResult | null {
  return page?.runner.latest() ?? null;
}

/**
 * Hears the page runner's notices (someone added, a project joined), and
 * keeps hearing them across a restart for another account.
 */
export function subscribeInvitationRunner(
  listener: (event: InvitationRunnerEvent) => void
): () => void {
  let stop = page?.runner.subscribe(listener) ?? (() => undefined);
  const restart = () => {
    stop();
    stop = page?.runner.subscribe(listener) ?? (() => undefined);
  };
  pageListeners.add(restart);
  return () => {
    pageListeners.delete(restart);
    stop();
  };
}

/** Hears every pass of the page's runner that ran, across restarts. */
export function subscribeInvitationPasses(
  listener: (result: InvitationPassResult) => void
): () => void {
  let stop = page?.runner.onPass(listener) ?? (() => undefined);
  const restart = () => {
    stop();
    stop = page?.runner.onPass(listener) ?? (() => undefined);
  };
  pageListeners.add(restart);
  return () => {
    pageListeners.delete(restart);
    stop();
  };
}
