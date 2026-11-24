import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isProjectHandoffMessage,
  trackProjectEditing,
  type ProjectEditingHandlers,
  type ProjectHandoffMessage,
  type ProjectHandoffTransport
} from './projectTabHandoff';
import { writeOwnedProjectStorage } from './projectTabOwnership';
import { withLockManager } from '../test/fakeLockManager';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** BroadcastChannel between tabs: asynchronous, never echoed to the sender. */
class FakeBus {
  private readonly members = new Set<{
    listeners: Set<(message: ProjectHandoffMessage) => void>;
  }>();
  readonly sent: ProjectHandoffMessage[] = [];

  transport(): ProjectHandoffTransport {
    const member = {
      listeners: new Set<(message: ProjectHandoffMessage) => void>()
    };
    this.members.add(member);
    return {
      post: (message) => {
        this.sent.push(message);
        const copy = structuredClone(message);
        for (const other of this.members) {
          if (other === member) continue;
          for (const listener of other.listeners) {
            setTimeout(() => listener(copy), 0);
          }
        }
      },
      subscribe: (listener) => {
        member.listeners.add(listener);
        return () => member.listeners.delete(listener);
      },
      close: () => this.members.delete(member)
    };
  }
}

interface Tab {
  id: string;
  tracker: ReturnType<typeof trackProjectEditing>;
  handlers: {
    [K in keyof ProjectEditingHandlers]: ReturnType<typeof vi.fn>;
  };
  /** Resolves `prepareYield`'s answer; defaults to true at once. */
  prepare: { answer: () => Promise<boolean> };
}

function openTab(
  bus: FakeBus,
  id: string,
  options: { timeoutMs?: number; transport?: ProjectHandoffTransport } = {}
): Tab {
  const prepare = { answer: () => Promise.resolve(true) };
  const handlers = {
    onAnswered: vi.fn(),
    onPromoted: vi.fn(),
    prepareYield: vi.fn(() => prepare.answer()),
    cancelYield: vi.fn(),
    onRemoteSaved: vi.fn(),
    onTakenOver: vi.fn()
  };
  const tracker = trackProjectEditing('project_a', handlers, {
    tabId: id,
    transport: options.transport ?? bus.transport(),
    timeoutMs: options.timeoutMs ?? 1_000
  });
  return { id, tracker, handlers, prepare };
}

async function answered(tab: Tab) {
  await tab.tracker.ownership.settled;
  return tab.tracker.ownership.owned;
}

describe('project tab handoff', () => {
  it('hands the project to the tab that asks', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    expect(await answered(a)).toBe(true);
    expect(await answered(b)).toBe(false);

    await expect(b.tracker.requestEditing()).resolves.toBe('owner');

    expect(a.handlers.prepareYield).toHaveBeenCalledTimes(1);
    expect(b.tracker.ownership.owned).toBe(true);
    expect(b.handlers.onPromoted).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(a.tracker.ownership.owned).toBe(false));
    a.tracker.giveUp();
    b.tracker.giveUp();
  });

  it('lets the project travel back and forth', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(b);

    await expect(b.tracker.requestEditing()).resolves.toBe('owner');
    await expect(a.tracker.requestEditing()).resolves.toBe('owner');
    await expect(b.tracker.requestEditing()).resolves.toBe('owner');

    expect(b.tracker.ownership.owned).toBe(true);
    await vi.waitFor(() => expect(a.tracker.ownership.owned).toBe(false));
    expect(a.handlers.onPromoted).toHaveBeenCalledTimes(1);
    expect(b.handlers.onPromoted).toHaveBeenCalledTimes(2);
    a.tracker.giveUp();
    b.tracker.giveUp();
  });

  it('gives the project to the asking tab even when another queued first', async () => {
    const locks = withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const c = openTab(bus, 'c');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(c);
    await answered(b);
    expect(locks.pendingCount('openzcad-project:project_a')).toBe(2);

    await expect(b.tracker.requestEditing()).resolves.toBe('owner');

    expect(c.tracker.ownership.owned).toBe(false);
    expect(c.handlers.onPromoted).not.toHaveBeenCalled();
    // The bystander gave its grant back and is waiting again, as is the
    // tab that yielded.
    await vi.waitFor(() =>
      expect(locks.pendingCount('openzcad-project:project_a')).toBe(2)
    );
    a.tracker.giveUp();
    b.tracker.giveUp();
    c.tracker.giveUp();
  });

  it('keeps the lock until the yielding tab has written', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(b);
    let finishWrite: (() => void) | null = null;
    const write = writeOwnedProjectStorage(
      () => a.tracker.ownership,
      'project_a',
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );
    await vi.waitFor(() => expect(finishWrite).not.toBeNull());

    const request = b.tracker.requestEditing();
    await vi.waitFor(() =>
      expect(a.handlers.prepareYield).toHaveBeenCalledTimes(1)
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(b.tracker.ownership.owned).toBe(false);

    finishWrite!();
    await expect(write).resolves.toBe(true);
    await expect(request).resolves.toBe('owner');
    a.tracker.giveUp();
    b.tracker.giveUp();
  });

  it('refuses writes from the tab that yielded', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(b);

    await b.tracker.requestEditing();
    const write = vi.fn(() => Promise.resolve());

    await expect(
      writeOwnedProjectStorage(() => a.tracker.ownership, 'project_a', write)
    ).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    a.tracker.giveUp();
    b.tracker.giveUp();
  });

  it('stays read-only when the owner declines', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(b);
    a.prepare.answer = () => Promise.resolve(false);

    await expect(b.tracker.requestEditing()).resolves.toBe('declined');

    expect(a.tracker.ownership.owned).toBe(true);
    expect(b.tracker.ownership.owned).toBe(false);
    a.tracker.giveUp();
    b.tracker.giveUp();
  });

  it('times out on an owner that does not answer, and never takes the project by force', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b', { timeoutMs: 50 });
    await answered(a);
    await answered(b);
    let ready: (ok: boolean) => void = () => undefined;
    a.prepare.answer = () =>
      new Promise<boolean>((resolve) => {
        ready = resolve;
      });

    await expect(b.tracker.requestEditing()).resolves.toBe('timeout');
    expect(b.tracker.ownership.owned).toBe(false);

    // The frozen owner wakes after the deadline: it keeps editing.
    ready(true);
    await vi.waitFor(() =>
      expect(a.handlers.cancelYield).toHaveBeenCalledTimes(1)
    );
    expect(a.tracker.ownership.owned).toBe(true);
    expect(b.tracker.ownership.owned).toBe(false);

    // Leaving still promotes the waiting tab the ordinary way.
    a.tracker.giveUp();
    await vi.waitFor(() => expect(b.tracker.ownership.owned).toBe(true));
    b.tracker.giveUp();
  });

  it('ignores a request whose deadline has passed', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    await answered(a);
    const outsider = bus.transport();

    outsider.post({
      type: 'request',
      projectId: 'project_a',
      requestId: 'late',
      from: 'z',
      deadline: Date.now() - 1
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(a.handlers.prepareYield).not.toHaveBeenCalled();
    expect(a.tracker.ownership.owned).toBe(true);
    a.tracker.giveUp();
  });

  it('lets only one of two asking tabs proceed', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    const c = openTab(bus, 'c');
    await answered(a);
    await answered(b);
    await answered(c);

    const results = await Promise.all([
      b.tracker.requestEditing(),
      c.tracker.requestEditing()
    ]);

    expect(results.sort()).toEqual(['owner', 'unavailable']);
    expect(a.handlers.prepareYield).toHaveBeenCalledTimes(1);
    a.tracker.giveUp();
    b.tracker.giveUp();
    c.tracker.giveUp();
  });

  it('shares one request between repeated asks', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(b);

    const first = b.tracker.requestEditing();
    const second = b.tracker.requestEditing();

    expect(second).toBe(first);
    await expect(first).resolves.toBe('owner');
    expect(bus.sent.filter((m) => m.type === 'request')).toHaveLength(1);
    a.tracker.giveUp();
    b.tracker.giveUp();
  });

  it('promotes the asking tab when the owner leaves mid-handoff', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(b);
    a.prepare.answer = () => new Promise<boolean>(() => undefined);

    const request = b.tracker.requestEditing();
    await vi.waitFor(() =>
      expect(a.handlers.prepareYield).toHaveBeenCalledTimes(1)
    );
    a.tracker.giveUp();

    await expect(request).resolves.toBe('owner');
    b.tracker.giveUp();
  });

  it('passes the project on normally when the asking tab leaves mid-handoff', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const c = openTab(bus, 'c');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(c);
    await answered(b);
    a.prepare.answer = () => new Promise<boolean>(() => undefined);

    const request = b.tracker.requestEditing();
    await vi.waitFor(() =>
      expect(a.handlers.prepareYield).toHaveBeenCalledTimes(1)
    );
    b.tracker.giveUp();
    await expect(request).resolves.toBe('unavailable');
    a.tracker.giveUp();

    await vi.waitFor(() => expect(c.tracker.ownership.owned).toBe(true));
    c.tracker.giveUp();
  });

  it('tells the other tabs when the owner saves, and only the owner', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(b);

    a.tracker.announceSaved();
    b.tracker.announceSaved();

    await vi.waitFor(() =>
      expect(b.handlers.onRemoteSaved).toHaveBeenCalledTimes(1)
    );
    expect(a.handlers.onRemoteSaved).not.toHaveBeenCalled();
    a.tracker.giveUp();
    b.tracker.giveUp();
  });

  it('ignores messages about other projects', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    await answered(a);
    const outsider = bus.transport();

    outsider.post({ type: 'saved', projectId: 'project_b', from: 'z' });
    outsider.post({
      type: 'request',
      projectId: 'project_b',
      requestId: 'r',
      from: 'z',
      deadline: Date.now() + 1_000
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(a.handlers.onRemoteSaved).not.toHaveBeenCalled();
    expect(a.handlers.prepareYield).not.toHaveBeenCalled();
    a.tracker.giveUp();
  });

  it('cannot hand over without a channel, and keeps the lock', async () => {
    withLockManager();
    const a = trackProjectEditing(
      'project_a',
      {
        onAnswered: vi.fn(),
        onPromoted: vi.fn(),
        prepareYield: vi.fn(() => Promise.resolve(true)),
        cancelYield: vi.fn(),
        onRemoteSaved: vi.fn()
      },
      { tabId: 'a', transport: null }
    );
    const b = trackProjectEditing(
      'project_a',
      {
        onAnswered: vi.fn(),
        onPromoted: vi.fn(),
        prepareYield: vi.fn(() => Promise.resolve(true)),
        cancelYield: vi.fn(),
        onRemoteSaved: vi.fn()
      },
      { tabId: 'b', transport: null }
    );
    await a.ownership.settled;
    await b.ownership.settled;

    await expect(b.requestEditing()).resolves.toBe('unavailable');
    expect(a.ownership.owned).toBe(true);
    a.giveUp();
    b.giveUp();
  });

  it('treats every tab as owner without the lock API', async () => {
    vi.stubGlobal('navigator', {});
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');

    expect(await answered(a)).toBe(true);
    expect(await answered(b)).toBe(true);
    await expect(b.tracker.requestEditing()).resolves.toBe('owner');
    a.tracker.giveUp();
    b.tracker.giveUp();
  });

  it('validates messages from the channel', () => {
    expect(
      isProjectHandoffMessage({ type: 'saved', projectId: 'p', from: 't' })
    ).toBe(true);
    expect(
      isProjectHandoffMessage({ type: 'request', projectId: 'p', from: 't' })
    ).toBe(false);
    expect(isProjectHandoffMessage({ type: 'other', projectId: 'p' })).toBe(
      false
    );
    expect(isProjectHandoffMessage(null)).toBe(false);
  });

  it('takes editing from an owner that never answers', async () => {
    withLockManager();
    const bus = new FakeBus();
    // The owner has no channel: it never hears the request.
    const a = openTab(bus, 'a', { transport: noChannel() });
    const b = openTab(bus, 'b', { timeoutMs: 20 });
    await answered(a);
    await answered(b);
    await expect(b.tracker.requestEditing()).resolves.toBe('timeout');

    await expect(b.tracker.takeOverEditing()).resolves.toBe(true);

    expect(b.tracker.ownership.owned).toBe(true);
    expect(b.handlers.onPromoted).toHaveBeenCalledTimes(1);
    expect(a.handlers.prepareYield).not.toHaveBeenCalled();
    // The owner learns from the lock, with no channel to tell it.
    await vi.waitFor(() =>
      expect(a.handlers.onTakenOver).toHaveBeenCalledTimes(1)
    );
    expect(a.tracker.ownership.owned).toBe(false);
    a.tracker.giveUp();
    b.tracker.giveUp();
  });

  it('lets the tab it was taken from ask for it back', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(b);
    await b.tracker.takeOverEditing();
    await vi.waitFor(() =>
      expect(a.handlers.onTakenOver).toHaveBeenCalledTimes(1)
    );

    await expect(a.tracker.requestEditing()).resolves.toBe('owner');

    expect(a.tracker.ownership.owned).toBe(true);
    expect(a.handlers.onPromoted).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(b.tracker.ownership.owned).toBe(false));
    a.tracker.giveUp();
    b.tracker.giveUp();
  });

  it('takes nothing once the tab has left the project', async () => {
    withLockManager();
    const bus = new FakeBus();
    const a = openTab(bus, 'a');
    const b = openTab(bus, 'b');
    await answered(a);
    await answered(b);
    b.tracker.giveUp();

    await expect(b.tracker.takeOverEditing()).resolves.toBe(false);
    expect(a.tracker.ownership.owned).toBe(true);
    expect(a.handlers.onTakenOver).not.toHaveBeenCalled();
    a.tracker.giveUp();
  });
});

/** A tab whose browser has no channel (or never reads it). */
function noChannel(): ProjectHandoffTransport {
  return {
    post: () => undefined,
    subscribe: () => () => undefined,
    close: () => undefined
  };
}
