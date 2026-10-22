/** Cross-tab notices contain only random operation IDs and lifecycle phases. */
type Notice = {
  id: string;
  operation: string;
  phase: 'prepare' | 'ended' | 'retry' | 'changed';
};

export interface KeySessionEvent {
  phase: Notice['phase'] | 'ready' | 'blocked';
  remote: boolean;
  revision: number;
}

interface Transport {
  id(): string;
  post(notice: Notice): void;
  subscribe(receive: (notice: unknown) => void): void;
}

function isNotice(value: unknown): value is Notice {
  if (!value || typeof value !== 'object') return false;
  const n = value as Partial<Notice>;
  return (
    typeof n.id === 'string' &&
    n.id.length <= 128 &&
    typeof n.operation === 'string' &&
    n.operation.length <= 128 &&
    ['prepare', 'ended', 'retry', 'changed'].includes(n.phase ?? '')
  );
}

/** Injectable transport exercises independent realms without sharing caches. */
export function createKeySessionSignals(transport: Transport) {
  let revision = 0;
  let version = 0;
  let blocked = false;
  const seen = new Set<string>();
  const completed = new Set<string>();
  const listeners = new Set<(event: KeySessionEvent) => void>();
  const boundedAdd = (set: Set<string>, id: string) => {
    set.add(id);
    if (set.size > 256) set.delete(set.values().next().value!);
  };
  const notify = (phase: KeySessionEvent['phase'], remote: boolean) => {
    version++;
    for (const listener of listeners) {
      try {
        listener({ phase, remote, revision });
      } catch {
        /* Every other subscriber must still discard its keys/state. */
      }
    }
  };
  const receive = (value: unknown, remote: boolean) => {
    if (!isNotice(value) || seen.has(value.id)) return;
    boundedAdd(seen, value.id);
    // Storage and BroadcastChannel may deliver the same operation in a
    // different order. A delayed prepare cannot undo its terminal notice.
    if (value.phase === 'prepare' && completed.has(value.operation)) return;
    if (value.phase !== 'prepare') boundedAdd(completed, value.operation);
    revision++;
    blocked = true;
    notify(value.phase, remote);
  };
  transport.subscribe((value) => receive(value, true));
  const publish = (phase: Notice['phase'], operation = transport.id()) => {
    const notice: Notice = { id: transport.id(), operation, phase };
    receive(notice, false);
    transport.post(notice);
    return { operation, revision };
  };
  return {
    begin: () => publish('prepare'),
    finish: (operation: string, success: boolean) =>
      publish(success ? 'ended' : 'retry', operation),
    changed: () => publish('changed'),
    retry: () => publish('retry'),
    block: () => {
      revision++;
      blocked = true;
      notify('blocked', false);
    },
    allow: (expected: number) => {
      if (revision !== expected) return false;
      if (blocked) {
        blocked = false;
        notify('ready', false);
      }
      return true;
    },
    current: (expected: number) => !blocked && revision === expected,
    active: () => !blocked,
    revision: () => revision,
    version: () => version,
    subscribe: (listener: (event: KeySessionEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

const CHANNEL = 'openzcad:e2ee-key-session:v1';
let singleton: ReturnType<typeof createKeySessionSignals> | undefined;

function signals() {
  if (singleton) return singleton;
  let channel: BroadcastChannel | undefined;
  singleton = createKeySessionSignals({
    id: () => crypto.randomUUID(),
    subscribe: (receive) => {
      if (typeof window === 'undefined') return;
      try {
        if (typeof window.BroadcastChannel === 'function') {
          channel = new window.BroadcastChannel(CHANNEL);
          channel.addEventListener('message', (event: MessageEvent<unknown>) =>
            receive(event.data)
          );
        }
      } catch {
        /* The storage event is an independent fallback. */
      }
      window.addEventListener('storage', (event) => {
        if (event.key !== CHANNEL || !event.newValue) return;
        try {
          receive(JSON.parse(event.newValue) as unknown);
        } catch {
          /* Unrelated or malformed storage is not a session notice. */
        }
      });
    },
    post: (notice) => {
      try {
        channel?.postMessage(notice);
      } catch {
        /* Try storage even if the channel has closed. */
      }
      try {
        if (typeof window !== 'undefined')
          window.localStorage.setItem(CHANNEL, JSON.stringify(notice));
      } catch {
        /* BroadcastChannel remains usable when storage is blocked. */
      }
    }
  });
  return singleton;
}

export const beginKeySessionTeardown = () => signals().begin();
export const finishKeySessionTeardown = (operation: string, success: boolean) =>
  signals().finish(operation, success);
export const confirmKeySessionEnded = () =>
  signals().finish(crypto.randomUUID(), true);
export const announceKeySessionChange = () => signals().changed().revision;
export const requestKeySessionRecheck = () => {
  signals().retry();
};
export const blockKeySession = () => signals().block();
export const allowKeySession = (revision: number) => signals().allow(revision);
export const getKeySessionRevision = () => signals().revision();
export const getKeySessionVersion = () => signals().version();
export const isKeySessionActive = () => signals().active();
export const isCurrentKeySession = (revision: number) =>
  signals().current(revision);
export const subscribeKeySession = (
  listener: (event: KeySessionEvent) => void
) => signals().subscribe(listener);
export const subscribeKeySessionVersion = (listener: () => void) =>
  subscribeKeySession(() => listener());
