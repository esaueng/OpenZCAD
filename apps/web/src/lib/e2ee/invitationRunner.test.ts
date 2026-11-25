import { describe, expect, it, vi } from 'vitest';
import {
  INVITATION_RENEWAL_CHECK_MS,
  INVITATION_RUNNER_INTERVAL_MS,
  INVITATION_RUNNER_MAX_BACKOFF_MS,
  createInvitationRunner,
  invitationRunnerBackoff,
  type InvitationPassModule,
  type InvitationPassOutcome,
  type InvitationRunnerDeps,
  type InvitationRunnerEvent
} from './invitationRunner';
import type { OwnerInvitation } from './invitations';

/**
 * The app-level invitation runner (L11 plan of 2026-11-25, §3.3): when it
 * runs a pass, that passes never overlap, that it stays quiet behind closed
 * gates, without keys and while hidden, that failures back it off, that
 * pending statements are renewed hourly, and what it announces.
 */

const ran = (
  overrides: Partial<Extract<InvitationPassOutcome, { kind: 'ran' }>> = {}
): InvitationPassOutcome => ({
  kind: 'ran',
  incoming: [],
  outgoing: [],
  joined: [],
  completed: [],
  failed: [],
  renewed: [],
  errors: [],
  ...overrides
});

/** Lets every settled promise's continuations run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness({
  gates = true,
  eligible = true,
  outcome = () => ran()
}: {
  gates?: boolean | (() => Promise<boolean>);
  eligible?: boolean;
  outcome?: (options: { renew: boolean }) => InvitationPassOutcome;
} = {}) {
  let now = 1_000_000;
  let visible = true;
  let active = true;
  let tick: () => void = () => undefined;
  let changed: () => void = () => undefined;
  let shown: () => void = () => undefined;
  const module = {
    eligible: vi.fn(async () => eligible),
    runInvitationPass: vi.fn(
      async (_userId: string, options: { readonly renew: boolean }) =>
        outcome(options)
    )
  } satisfies InvitationPassModule;
  const gatesOpen = vi.fn(
    typeof gates === 'function' ? gates : async () => gates
  );
  const load = vi.fn(async () => module);
  const stopTimer = vi.fn();
  const stopWatching = vi.fn();
  const deps: InvitationRunnerDeps = {
    gatesOpen,
    load,
    now: () => now,
    visible: () => visible,
    keySessionActive: () => active,
    every(ms, fn) {
      expect(ms).toBe(INVITATION_RUNNER_INTERVAL_MS);
      tick = fn;
      return stopTimer;
    },
    watch(onChanged, onShown) {
      changed = onChanged;
      shown = onShown;
      return stopWatching;
    }
  };
  const runner = createInvitationRunner('user_1', deps);
  const events: InvitationRunnerEvent[] = [];
  runner.subscribe((event) => events.push(event));
  return {
    runner,
    module,
    gatesOpen,
    load,
    events,
    stopTimer,
    stopWatching,
    advance(ms: number) {
      now += ms;
    },
    setVisible(value: boolean) {
      visible = value;
    },
    setActive(value: boolean) {
      active = value;
    },
    tick: () => tick(),
    changed: () => changed(),
    shown: () => shown()
  };
}

describe('the invitation runner', () => {
  it('runs a pass at startup, then once a minute while visible', async () => {
    const h = harness();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(1);
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(2);
    // Hidden, the timer asks nothing.
    h.setVisible(false);
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(2);
    // Shown again after a minute or more: one pass at once.
    h.setVisible(true);
    h.shown();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(3);
    // Shown again soon after: nothing new.
    h.advance(5_000);
    h.shown();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(3);
  });

  it('runs one pass at a time, and one more for every request made meanwhile', async () => {
    let release: () => void = () => undefined;
    const h = harness();
    await flush();
    h.module.runInvitationPass.mockImplementation(
      () =>
        new Promise<InvitationPassOutcome>((resolve) => {
          release = () => resolve(ran());
        })
    );
    const first = h.runner.sync();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(2);
    // Three more requests while it runs: they share one follow-up pass.
    const second = h.runner.sync();
    const third = h.runner.sync();
    h.changed();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(2);
    release();
    await first;
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(3);
    release();
    const [a, b] = await Promise.all([second, third]);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(3);
  });

  it('loads nothing while the rollout gates are closed, and asks again on a state change', async () => {
    let open = false;
    const h = harness({ gates: async () => open });
    await flush();
    expect(h.gatesOpen).toHaveBeenCalledTimes(1);
    expect(h.load).not.toHaveBeenCalled();
    // The timer does not even ask the server again.
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.gatesOpen).toHaveBeenCalledTimes(1);
    // A failed check reads as closed.
    h.gatesOpen.mockRejectedValueOnce(new Error('offline'));
    h.changed();
    await flush();
    expect(h.load).not.toHaveBeenCalled();
    open = true;
    h.changed();
    await flush();
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(1);
  });

  it('does nothing without unlocked keys until the encryption state changes', async () => {
    const h = harness({ eligible: false });
    await flush();
    expect(h.module.eligible).toHaveBeenCalledTimes(1);
    expect(h.module.runInvitationPass).not.toHaveBeenCalled();
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.module.eligible).toHaveBeenCalledTimes(1);
    h.module.eligible.mockResolvedValue(true);
    h.changed();
    await flush();
    expect(h.module.eligible).toHaveBeenCalledTimes(2);
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(1);
    // The pass itself finds the keys locked: quiet again.
    h.module.runInvitationPass.mockResolvedValueOnce({ kind: 'ineligible' });
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(2);
  });

  it('runs nothing while no key session is active', async () => {
    const h = harness();
    h.setActive(false);
    await flush();
    h.changed();
    await flush();
    expect(await h.runner.sync()).toBeNull();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(1);
    expect(h.gatesOpen).toHaveBeenCalledTimes(1);
  });

  it('backs the timer off after failures, but not a request', async () => {
    expect(invitationRunnerBackoff(0)).toBe(0);
    expect(invitationRunnerBackoff(1)).toBe(INVITATION_RUNNER_INTERVAL_MS);
    expect(invitationRunnerBackoff(2)).toBe(2 * INVITATION_RUNNER_INTERVAL_MS);
    expect(invitationRunnerBackoff(30)).toBe(INVITATION_RUNNER_MAX_BACKOFF_MS);
    const h = harness({ outcome: () => ran({ errors: [new Error('500')] }) });
    await flush();
    h.module.runInvitationPass.mockClear();
    // Two failures in a row (startup and this one): two minutes to wait.
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(1);
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(1);
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(2);
    // A panel's request runs regardless; a clean pass ends the backoff.
    h.module.runInvitationPass.mockResolvedValue(ran());
    await h.runner.sync();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(3);
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(4);
    // A chunk that does not load counts as a failure too.
    h.load.mockRejectedValueOnce(new Error('chunk'));
    expect(await h.runner.sync()).toBeNull();
    h.advance(INVITATION_RUNNER_INTERVAL_MS / 2);
    h.tick();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(4);
  });

  it('asks for renewals at startup and then at most hourly', async () => {
    const h = harness();
    await flush();
    const renewals = () =>
      h.module.runInvitationPass.mock.calls.map(([, options]) => options.renew);
    expect(renewals()).toEqual([true]);
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(renewals()).toEqual([true, false]);
    h.advance(INVITATION_RENEWAL_CHECK_MS);
    h.tick();
    await flush();
    expect(renewals()).toEqual([true, false, true]);
  });

  it('announces who was added and what this device joined', async () => {
    const completed = {
      record: { projectId: 'proj_1', invitationId: 'inv_1' },
      email: 'alex@example.com',
      acceptor: null
    } as unknown as OwnerInvitation;
    const fromContacts = {
      record: { projectId: 'proj_2', invitationId: 'inv_2' },
      email: null,
      acceptor: { email: 'sam@example.com' }
    } as unknown as OwnerInvitation;
    const h = harness({
      outcome: () =>
        ran({ completed: [completed, fromContacts], joined: ['proj_9'] })
    });
    await flush();
    expect(h.events).toEqual([
      {
        kind: 'added',
        projectId: 'proj_1',
        invitationId: 'inv_1',
        email: 'alex@example.com'
      },
      {
        kind: 'added',
        projectId: 'proj_2',
        invitationId: 'inv_2',
        email: 'sam@example.com'
      },
      { kind: 'joined', projectId: 'proj_9' }
    ]);
    expect(h.runner.latest()?.joined).toEqual(['proj_9']);
  });

  it('stops for good when disposed', async () => {
    const h = harness();
    await flush();
    h.runner.dispose();
    expect(h.stopTimer).toHaveBeenCalled();
    expect(h.stopWatching).toHaveBeenCalled();
    h.changed();
    expect(await h.runner.sync()).toBeNull();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(1);
  });

  it('closes when the routes say the feature is closed', async () => {
    const h = harness({ outcome: () => ({ kind: 'closed' }) });
    await flush();
    h.advance(INVITATION_RUNNER_INTERVAL_MS);
    h.tick();
    await flush();
    expect(h.module.runInvitationPass).toHaveBeenCalledTimes(1);
    expect(h.gatesOpen).toHaveBeenCalledTimes(1);
    // Someone opening the panel asks again.
    await h.runner.sync();
    expect(h.gatesOpen).toHaveBeenCalledTimes(2);
  });
});
