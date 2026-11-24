/**
 * Editing follows the tab you use.
 *
 * Exactly one tab writes a project's device storage (`projectTabOwnership.ts`).
 * That stays true here; what changes is who it is. A tab that is not the owner
 * asks for the project over a BroadcastChannel when the user starts working in
 * it. The owner stops taking edits, writes what it has, lets the lock go, and
 * the asking tab — holding the handoff ticket, so no other waiting tab can
 * take its place — is promoted and continues from the stored copy.
 *
 * Nothing leaves the browser: the lock and the channel are both same-origin,
 * so this costs no server round-trip. Messages carry no document either. An
 * owner announces that it saved, and other tabs re-read storage, so a stale
 * or reordered message can never put an older document on screen.
 *
 * A request is only ever answered by the owner, and never forced: an owner
 * that does not answer in time (a frozen tab) keeps the project, because a
 * write it still has queued could land on top of the new owner's. Only the
 * user can force it ({@link ProjectEditingTracker.takeOverEditing}), once
 * told that what the other tab has not saved is lost. A tab that loses the
 * project that way hears of it from the lock itself (`onTakenOver`), with
 * or without a channel; a build from before handoff cannot, and keeps
 * acting as the owner until it is closed.
 */

import {
  projectHandoffTicketName,
  trackProjectStorage,
  type ProjectStorageOwnership
} from './projectTabOwnership';

export const PROJECT_HANDOFF_CHANNEL = 'openzcad:project-tabs:v1';
/**
 * How long a tab waits for the owner to hand over. Long enough for the owner
 * to write a pending autosave and drain its account push; a background tab's
 * timers are clamped, but its message and storage callbacks are not.
 */
export const PROJECT_HANDOFF_TIMEOUT_MS = 8_000;

export type ProjectHandoffMessage =
  | {
      type: 'request';
      projectId: string;
      requestId: string;
      from: string;
      /** Epoch ms after which the asking tab has stopped waiting. */
      deadline: number;
    }
  | { type: 'declined'; projectId: string; requestId: string }
  | { type: 'saved'; projectId: string; from: string };

export function isProjectHandoffMessage(
  value: unknown
): value is ProjectHandoffMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (typeof message.projectId !== 'string') return false;
  switch (message.type) {
    case 'request':
      return (
        typeof message.requestId === 'string' &&
        typeof message.from === 'string' &&
        typeof message.deadline === 'number'
      );
    case 'declined':
      return typeof message.requestId === 'string';
    case 'saved':
      return typeof message.from === 'string';
    default:
      return false;
  }
}

export interface ProjectHandoffTransport {
  post(message: ProjectHandoffMessage): void;
  subscribe(listener: (message: ProjectHandoffMessage) => void): () => void;
  close(): void;
}

/** The browser's channel between this origin's tabs; null without one. */
export function browserProjectHandoffTransport(): ProjectHandoffTransport | null {
  if (typeof globalThis.BroadcastChannel !== 'function') return null;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(PROJECT_HANDOFF_CHANNEL);
  } catch {
    return null;
  }
  return {
    post(message) {
      try {
        channel.postMessage(message);
      } catch {
        /* A closed channel has no one left to tell. */
      }
    },
    subscribe(listener) {
      const receive = (event: MessageEvent) => {
        if (isProjectHandoffMessage(event.data)) listener(event.data);
      };
      channel.addEventListener('message', receive);
      return () => channel.removeEventListener('message', receive);
    },
    close() {
      channel.close();
    }
  };
}

export type ProjectEditingRequestResult =
  /** This tab owns the project now. */
  | 'owner'
  /** The owner said no (busy: a save, a conversion, a migration). */
  | 'declined'
  /** The owner did not answer in time. */
  | 'timeout'
  /** Another tab is already asking, or this browser cannot hand over. */
  | 'unavailable';

export interface ProjectEditingHandlers {
  /** The first answer to this tab's claim. */
  onAnswered(owned: boolean): void;
  /** This tab took the project over (handoff, or the owner went away). */
  onPromoted(): void;
  /**
   * The owner was asked to hand over. Stop taking edits and write everything
   * pending; true when the project can be let go now. A false answer must
   * leave the tab as it was.
   */
  prepareYield(): Promise<boolean>;
  /**
   * The yield prepared for will not happen (the asking tab stopped waiting
   * meanwhile): take edits again.
   */
  cancelYield(): void;
  /** Another tab saved this project; a tab that does not own it re-reads. */
  onRemoteSaved(): void;
  /**
   * Another tab took the project from this one without asking. Ownership
   * is already false, so no write starts; stop editing, and keep what was
   * not saved apart from the project. This tab follows the new owner once
   * what it returns settles.
   */
  onTakenOver?(): unknown;
}

export interface ProjectEditingTracker {
  readonly ownership: ProjectStorageOwnership;
  /** Asks the owner for the project. Concurrent calls share one request. */
  requestEditing(): Promise<ProjectEditingRequestResult>;
  /**
   * Takes the project from an owner that does not answer, without its
   * consent: whatever that tab has not saved is lost. True once this tab
   * owns it (promoted through `onPromoted`, as for a handoff).
   */
  takeOverEditing(): Promise<boolean>;
  /** Tells the other tabs this one has saved the project. */
  announceSaved(): void;
  /** Leaves the project: releases the claim and stops listening. */
  giveUp(): void;
}

export interface ProjectEditingOptions {
  /** Identifies this tab in messages; its own are ignored. */
  tabId: string;
  /** Null when the browser has no channel: tabs keep today's lock. */
  transport: ProjectHandoffTransport | null;
  timeoutMs?: number;
  now?: () => number;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

/**
 * Tracks this tab's claim on `projectId` ({@link trackProjectStorage}) and
 * lets it hand the project to, or take it from, another tab of this browser.
 */
export function trackProjectEditing(
  projectId: string,
  handlers: ProjectEditingHandlers,
  {
    tabId,
    transport,
    timeoutMs = PROJECT_HANDOFF_TIMEOUT_MS,
    now = Date.now
  }: ProjectEditingOptions
): ProjectEditingTracker {
  const locks = globalThis.navigator?.locks as LockManager | undefined;
  let given = false;
  let holdsTicket = false;
  let serving = false;
  let inFlight: Promise<ProjectEditingRequestResult> | null = null;
  let waiting: {
    requestId: string;
    settle(result: ProjectEditingRequestResult): void;
  } | null = null;

  const storage = trackProjectStorage(
    projectId,
    {
      onAnswered: (owned) => handlers.onAnswered(owned),
      onPromoted: () => {
        handlers.onPromoted();
        waiting?.settle('owner');
      },
      onLost: () => handlers.onTakenOver?.()
    },
    { ticketHeldHere: () => holdsTicket }
  );
  const { ownership } = storage;

  async function serve(
    message: Extract<ProjectHandoffMessage, { type: 'request' }>
  ) {
    const stillWanted = () => !given && now() < message.deadline;
    if (serving || !ownership.owned || !stillWanted()) return;
    serving = true;
    try {
      let ready = false;
      try {
        ready = await handlers.prepareYield();
      } catch {
        ready = false;
      }
      if (ready && (!stillWanted() || !ownership.owned)) {
        handlers.cancelYield();
        ready = false;
      }
      if (!ready) {
        transport?.post({
          type: 'declined',
          projectId,
          requestId: message.requestId
        });
        return;
      }
      await storage.yieldOwnership();
    } finally {
      serving = false;
    }
  }

  const unsubscribe =
    transport?.subscribe((message) => {
      if (given || message.projectId !== projectId) return;
      switch (message.type) {
        case 'request':
          if (message.from !== tabId) void serve(message);
          return;
        case 'declined':
          if (waiting?.requestId === message.requestId) {
            waiting.settle('declined');
          }
          return;
        case 'saved':
          if (message.from !== tabId) handlers.onRemoteSaved();
          return;
      }
    }) ?? (() => undefined);

  async function askOwner(): Promise<ProjectEditingRequestResult> {
    if (!locks || !transport) return 'unavailable';
    try {
      return await locks.request(
        projectHandoffTicketName(projectId),
        { ifAvailable: true },
        async (ticket): Promise<ProjectEditingRequestResult> => {
          // Another tab is already asking; it will be the next owner.
          if (!ticket) return 'unavailable';
          holdsTicket = true;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            if (ownership.owned) return 'owner';
            const requestId = randomId();
            const answer = new Promise<ProjectEditingRequestResult>(
              (resolve) => {
                waiting = { requestId, settle: resolve };
                timer = setTimeout(() => resolve('timeout'), timeoutMs);
              }
            );
            transport.post({
              type: 'request',
              projectId,
              requestId,
              from: tabId,
              deadline: now() + timeoutMs
            });
            return await answer;
          } finally {
            if (timer !== undefined) clearTimeout(timer);
            waiting = null;
            holdsTicket = false;
          }
        }
      );
    } catch {
      return 'unavailable';
    }
  }

  return {
    ownership,
    requestEditing() {
      if (given) return Promise.resolve('unavailable');
      if (ownership.owned) return Promise.resolve('owner');
      inFlight ??= askOwner().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    takeOverEditing() {
      if (given || !locks) return Promise.resolve(false);
      return storage.takeOver();
    },
    announceSaved() {
      if (given || !ownership.owned) return;
      transport?.post({ type: 'saved', projectId, from: tabId });
    },
    giveUp() {
      if (given) return;
      given = true;
      unsubscribe();
      waiting?.settle('unavailable');
      storage.giveUp();
    }
  };
}
